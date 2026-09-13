import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { capabilities } from './config.js';
import { Store } from './store.js';
import { Intelligence } from './ai.js';
import { Zhihu } from './zhihu.js';
import { Pairing } from './pairing.js';
import { createAdminRouter } from './admin.js';
import { AppError, fail, requiredText, optionalText } from './errors.js';
import { buildProfile, compareProfiles, DEMO_PROFILES, SAMPLE_PROFILE } from './matching.js';
import { TOPIC_MAP, GOALS, STYLES } from '../shared/catalog.js';

const secureEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !a.length || a.length !== b.length) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
function cookies(header = '') {
  const result = {};
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    try { result[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1)); } catch { /* Ignore malformed cookies. */ }
  }
  return result;
}

export function validateProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'invalid_input', '画像内容格式不正确');
  const name = requiredText(input.name, '昵称', 24, 1);
  if (!Array.isArray(input.topicIds) || input.topicIds.length < 3 || input.topicIds.length > 8 || new Set(input.topicIds).size !== input.topicIds.length || input.topicIds.some(id => !TOPIC_MAP.has(id))) fail(400, 'invalid_topics', '请选择 3–8 个不同的兴趣');
  if (!Array.isArray(input.goals) || !input.goals.length || input.goals.length > 3 || new Set(input.goals).size !== input.goals.length || input.goals.some(id => !GOALS.some(g => g.id === id))) fail(400, 'invalid_goals', '请至少选择一种交流期待');
  if (!STYLES.some(s => s.id === input.styleId)) fail(400, 'invalid_style', '请选择一种喜欢的交流方式');
  return { name, topicIds: [...input.topicIds], about: optionalText(input.about, '自我介绍', 360), question: optionalText(input.question, '好奇的问题', 200), goals: [...input.goals], styleId: input.styleId };
}

export function createApp(config, options = {}) {
  const store = options.store || new Store(config.databasePath);
  const ai = options.ai || new Intelligence(config, { fetchImpl: options.fetchImpl });
  const zhihu = options.zhihu || new Zhihu(config, { fetchImpl: options.fetchImpl });
  const app = express();
  const streams = new Map(), oauthRequests = new Map(), limits = new Map(), mutations = new Set();
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/' };
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.zhimg.com; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://openapi.zhihu.com" });
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  function rate(key, max, window = 60000) {
    const current = Date.now();
    let bucket = limits.get(key);
    if (!bucket || bucket.until <= current) bucket = { used: 0, until: current + window };
    bucket.used++; limits.set(key, bucket);
    if (limits.size > 10000) for (const [name, value] of limits) { if (value.until <= current || limits.size > 10000) limits.delete(name); }
    if (bucket.used > max) fail(429, 'rate_limited', '操作有些频繁，请稍后再试');
  }
  function emit(userId, event = 'changed') {
    for (const res of streams.get(userId) || []) res.write(`event: ${event}\ndata: {}\n\n`);
  }
  function broadcast(event = 'pool') { for (const userId of streams.keys()) emit(userId, event); }
  const pairing = new Pairing(store, { ...options.pairingOptions, onChange(userId) { emit(userId, 'pairing'); emit(userId); } });
  const admin = createAdminRouter(config, { store, pairing, onlineIds: () => new Set(streams.keys()) });
  const heartbeat = setInterval(() => { for (const group of streams.values()) for (const res of group) res.write(': heartbeat\n\n'); }, 25000);
  heartbeat.unref();
  const own = req => store.profile(req.viewer.id) || SAMPLE_PROFILE;
  function findPerson(req, personId, allowConnection = true) {
    if (typeof personId !== 'string' || personId.length > 100) fail(400, 'invalid_person', '伙伴标识无效');
    const demo = DEMO_PROFILES.find(p => p.id === personId);
    if (demo && !store.isBlocked(req.viewer.id, personId)) return demo;
    const person = store.publicUser(personId, req.viewer.id, allowConnection);
    if (!person) fail(404, 'person_unavailable', '这位伙伴目前无法查看，可能已退出匹配或删除资料');
    return person;
  }
  function snapshot(req) {
    return { user: req.viewer, csrf: req.csrf, profile: store.profile(req.viewer.id), sampleProfile: SAMPLE_PROFILE,
      capabilities: capabilities(config), zhihuConnected: Boolean(zhihu.token(req.viewer.id)),
      imports: { count: store.imports(req.viewer.id).items.length, fetchedAt: store.imports(req.viewer.id).fetchedAt },
      savedIds: store.savedIds(req.viewer.id), incomingCount: store.invitations(req.viewer.id).filter(i => i.direction === 'incoming' && i.status === 'pending').length };
  }
  async function mutate(userId, job) {
    if (mutations.has(userId)) fail(409, 'profile_busy', '画像正在更新，完成后再试');
    mutations.add(userId);
    try { return await job(); } finally { mutations.delete(userId); }
  }

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', app: '同频 · 知乎灵魂对对碰', version: '1.0.0' }));
  app.get('/auth/callback', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const queryStart = req.originalUrl.indexOf('?');
    res.redirect(302, `/api/auth/zhihu/callback${queryStart < 0 ? '' : req.originalUrl.slice(queryStart)}`);
  });
  app.use('/api/admin', admin.router);
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    req.cookies = cookies(req.headers.cookie);
    rate(`api:${req.ip}`, 360, 60000);
    const callback = req.path === '/auth/zhihu/callback';
    const origin = req.get('origin');
    if (!callback && ((origin && !config.allowedOrigins.has(origin)) || req.get('sec-fetch-site') === 'cross-site')) fail(403, 'origin_mismatch', '请从本站页面操作');
    let session = store.session(req.cookies.soul_session);
    if (!session && req.path === '/bootstrap' && req.method === 'GET') {
      rate(`new:${req.ip}`, 30);
      const user = store.createUser(); const created = store.createSession(user.id);
      res.cookie('soul_session', created.token, { ...cookieOptions, maxAge: 30 * 86400000 });
      session = { user, csrf: created.csrf };
    }
    if (!session && !callback) fail(401, 'session_required', '会话已结束，请刷新页面');
    if (session) { req.viewer = session.user; req.csrf = session.csrf; }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !secureEqual(req.get('x-csrf-token'), req.csrf)) fail(403, 'csrf_mismatch', '页面凭证已更新，请刷新后重试');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.body === undefined) req.body = {};
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) fail(400, 'invalid_input', '请求内容需要是 JSON 对象');
    }
    if (session && !callback) store.touchUser(session.user.id);
    next();
  });
  app.get('/api/bootstrap', (req, res) => res.json(snapshot(req)));
  app.get('/api/events', (req, res) => {
    let group = streams.get(req.viewer.id);
    if (!group) { group = new Set(); streams.set(req.viewer.id, group); }
    if (group.size >= 6) fail(429, 'too_many_tabs', '同时打开的页面过多');
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders(); res.write(': connected\n\n'); group.add(res);
    req.on('close', () => { group.delete(res); if (!group.size) streams.delete(req.viewer.id); });
  });

  app.get('/api/pairing', (req, res) => res.json(pairing.state(req.viewer.id)));
  app.post('/api/pairing/start', (req, res) => {
    rate(`pair-start:${req.viewer.id}`, 12);
    if (mutations.has(req.viewer.id)) fail(409, 'profile_busy', '画像正在更新，完成后再开始匹配');
    res.json(pairing.start(req.viewer.id, req.body));
  });
  app.post('/api/pairing/heartbeat', (req, res) => {
    rate(`pair-heartbeat:${req.viewer.id}`, 30);
    res.json(pairing.heartbeat(req.viewer.id, req.body.attemptId));
  });
  app.post('/api/pairing/respond', (req, res) => {
    rate(`pair-respond:${req.viewer.id}`, 30);
    res.json(pairing.respond(req.viewer.id, req.body.pairId, req.body.decision));
  });
  app.post('/api/pairing/cancel', (req, res) => res.json(pairing.cancel(req.viewer.id, req.body.attemptId)));

  app.post('/api/profile', async (req, res) => {
    rate(`profile:${req.viewer.id}`, 8);
    const input = validateProfile(req.body.input);
    if (req.body.useAI !== undefined && typeof req.body.useAI !== 'boolean') fail(400, 'invalid_input', 'AI 分析选项格式不正确');
    if (!Number.isInteger(req.body.revision) || req.body.revision < 0) fail(400, 'invalid_revision', '画像版本无效，请刷新页面');
    const profile = await mutate(req.viewer.id, async () => {
      const current = store.profile(req.viewer.id);
      if (req.body.revision !== (current?.revision || 0)) fail(409, 'profile_changed', '画像已在其他页面更新，请刷新后再试');
      pairing.invalidate(req.viewer.id, 'profile_changed');
      const generated = await ai.enrichProfile(buildProfile(input, store.imports(req.viewer.id).items), req.body.useAI !== false);
      return store.saveProfile(req.viewer.id, generated, req.body.revision);
    });
    emit(req.viewer.id); broadcast(); res.json({ profile });
  });
  app.post('/api/profile/visibility', (req, res) => {
    if (typeof req.body.discoverable !== 'boolean') fail(400, 'invalid_visibility', '请选择是否参与匹配');
    if (req.body.discoverable && req.body.revision !== store.profile(req.viewer.id)?.revision) fail(409, 'profile_changed', '画像已更新，请查看后再参与匹配');
    const profile = store.setDiscoverable(req.viewer.id, req.body.discoverable);
    if (!req.body.discoverable) pairing.invalidate(req.viewer.id, 'cancelled');
    broadcast(); broadcast('changed'); res.json({ profile });
  });
  app.get('/api/matches', async (req, res) => {
    const pool = req.query.pool || 'demo', mode = req.query.mode || 'resonance';
    if (!['demo', 'people'].includes(pool) || !['resonance', 'complement'].includes(mode)) fail(400, 'invalid_filter', '匹配筛选条件无效');
    const profile = own(req), saved = new Set(store.savedIds(req.viewer.id));
    let people = pool === 'demo' ? DEMO_PROFILES.filter(p => !store.isBlocked(req.viewer.id, p.id)) : store.people(req.viewer.id);
    const semantics = await ai.semanticScores(profile, people);
    let matches = people.map((person, i) => ({ ...compareProfiles(profile, person, mode, semantics?.[i] ?? null), saved: saved.has(person.id) }));
    if (typeof req.query.topic === 'string' && req.query.topic !== 'all') matches = matches.filter(p => p.interests.some(t => t.id === req.query.topic));
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const q = req.query.q.trim().slice(0, 100).toLowerCase();
      matches = matches.filter(p => `${p.name} ${p.about} ${p.question} ${p.title} ${p.interests.map(t => t.label).join(' ')}`.toLowerCase().includes(q));
    }
    if (req.query.saved === 'true') matches = matches.filter(p => p.saved);
    matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    res.json({ matches, pool, mode, preview: !store.profile(req.viewer.id), total: people.length, algorithm: semantics ? 'embedding' : 'topics', notice: config.embedding.configured && !semantics && people.length ? '语义服务暂时不可用，本次使用知识主题向量计算。' : null });
  });
  app.get('/api/people/:id', (req, res) => res.json({ match: compareProfiles(own(req), findPerson(req, req.params.id)) }));
  app.post('/api/people/:id/explain', async (req, res) => {
    rate(`explain:${req.viewer.id}`, 15);
    const match = compareProfiles(own(req), findPerson(req, req.params.id), req.body.mode === 'complement' ? 'complement' : 'resonance');
    res.json(await ai.explain(own(req), match));
  });
  app.post('/api/people/:id/icebreakers', async (req, res) => {
    rate(`ice:${req.viewer.id}`, 12);
    const profile = own(req), match = compareProfiles(profile, findPerson(req, req.params.id));
    const references = await zhihu.search(match.shared.slice(0, 2).map(t => t.label).join(' ') || match.interests[0].label);
    const generated = await ai.icebreakers(profile, match, references.items);
    res.json({ ...generated, sources: references.items, sourceNotice: references.notice });
  });
  app.put('/api/saved/:id', (req, res) => {
    if (typeof req.body.saved !== 'boolean') fail(400, 'invalid_saved', '收藏状态无效');
    if (req.body.saved) findPerson(req, req.params.id);
    store.setSaved(req.viewer.id, req.params.id, req.body.saved);
    emit(req.viewer.id); res.json({ savedIds: store.savedIds(req.viewer.id) });
  });

  app.get('/api/connections', (req, res) => {
    const saved = store.savedIds(req.viewer.id).map(personId => {
      try { return { ...compareProfiles(own(req), findPerson(req, personId)), saved: true }; } catch { return null; }
    }).filter(Boolean);
    res.json({ saved, invitations: store.invitations(req.viewer.id) });
  });
  app.post('/api/invitations', (req, res) => {
    rate(`invite:${req.viewer.id}`, 5);
    const person = findPerson(req, requiredText(req.body.targetId, '伙伴标识', 100));
    if (person.demo) fail(400, 'demo_person', '体验人物是虚构角色，可以收藏和练习破冰；不能向其发送邀请');
    const invitationId = store.invite(req.viewer.id, person.id, requiredText(req.body.message, '邀请内容', 500, 2));
    pairing.tick();
    emit(req.viewer.id); emit(person.id); res.status(201).json({ id: invitationId });
  });
  app.post('/api/invitations/:id/respond', (req, res) => {
    if (!['accept', 'decline'].includes(req.body.action)) fail(400, 'invalid_action', '邀请操作无效');
    const row = store.respond(req.viewer.id, req.params.id, req.body.action);
    pairing.tick();
    emit(row.sender_id); emit(row.recipient_id); res.json({ ok: true });
  });
  app.get('/api/conversations/:id', (req, res) => {
    const conversation = store.conversation(req.viewer.id, req.params.id);
    res.json({ person: store.publicUser(conversation.sender_id === req.viewer.id ? conversation.recipient_id : conversation.sender_id, req.viewer.id, true), invitation: conversation.message, ...store.messages(req.viewer.id, req.params.id, typeof req.query.before === 'string' ? req.query.before : null) });
  });
  app.post('/api/conversations/:id/messages', (req, res) => {
    rate(`message:${req.viewer.id}`, 30);
    const clientMessageId = req.body.clientMessageId;
    if (clientMessageId !== undefined && (typeof clientMessageId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientMessageId))) fail(400, 'invalid_message_id', '消息重试标识格式不正确');
    const result = store.sendMessage(req.viewer.id, req.params.id, requiredText(req.body.text, '消息', 2000), clientMessageId?.toLowerCase());
    emit(req.viewer.id); emit(result.recipientId); res.status(201).json(result.message);
  });
  app.post('/api/blocked/:id', (req, res) => {
    if (!pairing.mayBlock(req.viewer.id, req.params.id)) findPerson(req, req.params.id);
    store.block(req.viewer.id, req.params.id);
    pairing.blocked(req.viewer.id, req.params.id);
    emit(req.viewer.id); emit(req.params.id); broadcast(); res.json({ ok: true });
  });
  app.get('/api/blocked', (req, res) => res.json({ people: store.blocked(req.viewer.id).map(p => ({ id: p.id, name: DEMO_PROFILES.find(d => d.id === p.id)?.name || store.user(p.id)?.name || '已离开的伙伴' })) }));
  app.delete('/api/blocked/:id', (req, res) => { store.unblock(req.viewer.id, req.params.id); pairing.tick(); emit(req.viewer.id); broadcast(); res.json({ ok: true }); });

  app.post('/api/auth/zhihu/start', (req, res) => {
    if (!config.zhihu.oauthConfigured) fail(503, 'oauth_unconfigured', '知乎登录暂未开放，你可以先用兴趣生成画像');
    rate(`oauth:${req.viewer.id}`, 5);
    for (const [key, value] of oauthRequests) if (value.expiresAt < Date.now()) oauthRequests.delete(key);
    if (oauthRequests.size > 1000) fail(429, 'oauth_busy', '连接请求较多，请稍后再试');
    const state = randomBytes(24).toString('base64url'), browser = randomBytes(24).toString('base64url');
    oauthRequests.set(browser, { state, userId: req.viewer.id, expiresAt: Date.now() + 600000 });
    res.cookie('soul_oauth', browser, { ...cookieOptions, path: '/api/auth/zhihu', maxAge: 600000 });
    const url = new URL('https://openapi.zhihu.com/authorize');
    url.searchParams.set('app_id', config.zhihu.oauth.appId); url.searchParams.set('redirect_uri', config.zhihu.oauth.redirectUri);
    url.searchParams.set('response_type', 'code'); url.searchParams.set('state', state);
    res.json({ url: url.href });
  });
  app.get('/api/auth/zhihu/callback', async (req, res) => {
    const browser = req.cookies.soul_oauth, request = oauthRequests.get(browser);
    oauthRequests.delete(browser);
    res.clearCookie('soul_oauth', { ...cookieOptions, path: '/api/auth/zhihu' });
    if (!config.zhihu.oauthConfigured || !request || request.expiresAt < Date.now() || !secureEqual(request.state, req.query.state) || !req.viewer || req.viewer.id !== request.userId) return res.redirect('/?auth=state_error#profile');
    const code = req.query.authorization_code || req.query.code;
    if (typeof code !== 'string' || code.length > 2000 || !code.trim()) return res.redirect('/?auth=cancelled#profile');
    try {
      const connected = await zhihu.exchange(code);
      if (store.session(req.cookies.soul_session)?.user.id !== request.userId) return res.redirect('/?auth=state_error#profile');
      pairing.forget(request.userId, 'account_changed');
      const user = store.oauthUser(request.userId, connected.identity);
      store.touchUser(user.id);
      if (user.id !== request.userId && store.profile(request.userId)) store.setDiscoverable(request.userId, false);
      zhihu.setToken(user.id, connected.token, connected.expiresIn);
      store.endSession(req.cookies.soul_session);
      const session = store.createSession(user.id);
      res.cookie('soul_session', session.token, { ...cookieOptions, maxAge: 30 * 86400000 });
      broadcast(); broadcast('changed');
      res.redirect('/?auth=success#profile');
    } catch { res.redirect('/?auth=failed#profile'); }
  });
  app.post('/api/zhihu/import', async (req, res) => {
    const sources = req.body.sources;
    if (req.body.useAI !== undefined && typeof req.body.useAI !== 'boolean') fail(400, 'invalid_input', 'AI 分析选项格式不正确');
    if (!Array.isArray(sources) || !sources.length || sources.length > 3 || new Set(sources).size !== sources.length || sources.some(s => !['contents', 'followees', 'collections'].includes(s))) fail(400, 'invalid_sources', '请选择要导入的内容类型');
    if (req.viewer.provider !== 'zhihu') fail(401, 'zhihu_required', '请先连接你自己的知乎账号');
    rate(`import:${req.viewer.id}`, 3);
    const result = await mutate(req.viewer.id, async () => {
      pairing.invalidate(req.viewer.id, 'profile_changed');
      const imported = await zhihu.import(req.viewer.id, sources);
      const current = store.profile(req.viewer.id);
      let generated = null;
      if (current) generated = await ai.enrichProfile(buildProfile(current.input, imported.items), req.body.useAI !== false);
      if (!store.user(req.viewer.id)) fail(401, 'session_expired', '会话已经结束');
      store.saveImports(req.viewer.id, imported.items);
      if (generated) store.saveProfile(req.viewer.id, generated, current.revision);
      return { count: imported.items.length, counts: imported.counts, profile: store.profile(req.viewer.id) };
    });
    emit(req.viewer.id); broadcast(); res.json(result);
  });
  app.delete('/api/zhihu/import', async (req, res) => {
    await mutate(req.viewer.id, async () => {
      const current = store.profile(req.viewer.id);
      pairing.invalidate(req.viewer.id, 'profile_changed');
      store.clearImports(req.viewer.id); ai.clearCache(); zhihu.forget(req.viewer.id);
      if (current) store.saveProfile(req.viewer.id, buildProfile(current.input), current.revision);
    });
    emit(req.viewer.id); broadcast(); res.json({ profile: store.profile(req.viewer.id) });
  });
  app.get('/api/account/export', (req, res) => {
    res.set('Content-Disposition', 'attachment; filename="tongpin-my-data.json"');
    res.json({ exportedAt: new Date().toISOString(), user: req.viewer, profile: store.profile(req.viewer.id), imports: store.imports(req.viewer.id), savedIds: store.savedIds(req.viewer.id) });
  });
  app.post('/api/logout', (req, res) => {
    if (mutations.has(req.viewer.id)) fail(409, 'profile_busy', '画像正在更新，完成后再退出');
    pairing.forget(req.viewer.id, 'account_changed');
    if (store.profile(req.viewer.id)) store.setDiscoverable(req.viewer.id, false);
    zhihu.forget(req.viewer.id); ai.clearCache(); store.endSession(req.cookies.soul_session);
    res.clearCookie('soul_session', cookieOptions); broadcast(); broadcast('changed');
    for (const stream of streams.get(req.viewer.id) || []) stream.end();
    res.json({ ok: true });
  });
  app.delete('/api/account', (req, res) => {
    if (mutations.has(req.viewer.id)) fail(409, 'profile_busy', '画像正在更新，完成后再删除');
    if (req.body.confirm !== 'delete') fail(400, 'confirmation_required', '请先确认删除你的全部数据');
    pairing.forget(req.viewer.id, 'account_changed');
    store.deleteAccount(req.viewer.id); zhihu.forget(req.viewer.id); ai.clearCache();
    for (const [key, value] of oauthRequests) if (value.userId === req.viewer.id) oauthRequests.delete(key);
    res.clearCookie('soul_session', cookieOptions); broadcast(); broadcast('changed');
    for (const stream of streams.get(req.viewer.id) || []) stream.end();
    res.json({ ok: true });
  });

  app.use('/api', (_req, _res) => fail(404, 'not_found', '没有找到这个接口'));
  const dist = resolve(config.root, 'dist');
  if (existsSync(resolve(dist, 'index.html'))) {
    app.use('/admin', (_req, res, next) => { res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' }); next(); });
    app.use(express.static(dist, { index: false, maxAge: '1h', dotfiles: 'deny', setHeaders(res, file) { if (file.includes('/assets/')) res.set('Cache-Control', 'public, max-age=31536000, immutable'); } }));
    app.get('/{*path}', (req, res) => {
      if (extname(req.path) || req.path.startsWith('/assets/')) return res.status(404).send('Not found');
      res.set('Cache-Control', /^\/admin(?:\/|$)/.test(req.path) ? 'no-store' : 'no-cache'); res.sendFile(resolve(dist, 'index.html'));
    });
  }
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    const status = error instanceof AppError ? error.status : ['entity.parse.failed', 'entity.too.large'].includes(error.type) ? 400 : 500;
    if (status === 429 && !res.hasHeader('Retry-After')) res.set('Retry-After', '60');
    if (status === 500) console.error('Request failed:', error.name || 'Error');
    res.status(status).json({ error: { code: error instanceof AppError ? error.code : 'request_failed', message: error instanceof AppError ? error.message : status === 400 ? '请求内容无效或过大' : '服务暂时遇到问题，请稍后再试' } });
  });
  return { app, store, ai, zhihu, pairing, close() { clearInterval(heartbeat); admin.close(); pairing.close(); for (const group of streams.values()) for (const res of group) res.end(); store.close(); } };
}
