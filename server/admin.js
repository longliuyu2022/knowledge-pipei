import express from 'express';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError, fail } from './errors.js';
import { DOMAINS, GOALS, STYLES, TOPICS, TOPIC_MAP } from '../shared/catalog.js';

const deriveKey = promisify(scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 2000;
const MAX_BUCKETS = 10000;
const COOKIE = 'soul_admin';
const usernamePattern = /^[a-zA-Z0-9_.-]{3,64}$/;
const tokenHash = value => createHash('sha256').update(value).digest('hex');
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
};

// A fixed, recognized work factor prevents a corrupt configuration from causing
// either cheap password checks or unbounded allocations during authentication.
function parsePasswordHash(value) {
  if (typeof value !== 'string') return null;
  const parts = /^scrypt\$32768\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/.exec(value);
  if (!parts) return null;
  const salt = Buffer.from(parts[1], 'base64url'), digest = Buffer.from(parts[2], 'base64url');
  if (salt.length !== 16 || digest.length !== 64 || salt.toString('base64url') !== parts[1] || digest.toString('base64url') !== parts[2]) return null;
  return { salt, digest };
}

export async function hashAdminPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('管理员密码需要 12–256 个字符');
  const salt = randomBytes(16);
  const digest = await deriveKey(password, salt, 64, SCRYPT);
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

function cookieToken(header = '') {
  if (typeof header !== 'string' || header.length > 16384) return null;
  const matches = header.split(';').map(pair => pair.trim()).filter(pair => pair.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

const text = value => typeof value === 'string' ? value : '';
function arrayJson(value) {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
function objectJson(value) {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}
function interestsFrom(value) {
  const ids = [...new Set(arrayJson(value).map(item => item?.id).filter(id => TOPIC_MAP.has(id)))];
  return ids.map(id => ({ id, label: TOPIC_MAP.get(id).label }));
}
const profileData = "CASE WHEN json_valid(p.data) THEN p.data ELSE '{}' END";
const topicObject = "CASE WHEN topic.type = 'object' THEN topic.value ELSE '{}' END";
const profileColumns = `u.id, u.name, u.avatar, u.provider, u.created_at, u.registered_at, u.last_seen_at,
  p.user_id AS profile_id, p.revision, p.discoverable, p.updated_at AS profile_updated_at,
  json_extract(${profileData}, '$.title') AS profile_title,
  json_extract(${profileData}, '$.interests') AS profile_interests,
  json_extract(${profileData}, '$.analysis.mode') AS analysis_mode`;

export function createAdminRouter(config, { store, pairing, onlineIds = () => new Set() }) {
  const router = express.Router();
  const verifier = parsePasswordHash(config.admin?.passwordHash);
  const username = config.admin?.username;
  const configured = Boolean(config.admin?.configured && verifier && typeof username === 'string' && usernamePattern.test(username));
  const sessions = new Map(), failures = new Map(), issuance = new Map();
  let globalFailures = { count: 0, pending: 0, until: 0 };
  let hashing = 0, closed = false;
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: Boolean(config.secureCookies), path: '/api/admin' };

  function sweep(now = Date.now()) {
    for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key);
    for (const buckets of [failures, issuance]) for (const [key, value] of buckets) if (value.until <= now && !value.pending) buckets.delete(key);
  }
  const timer = setInterval(sweep, 60000); timer.unref();
  function close() { closed = true; clearInterval(timer); sessions.clear(); failures.clear(); issuance.clear(); }
  function available() { if (!configured || closed) fail(503, 'admin_unconfigured', '管理员账号尚未配置，请联系部署负责人'); }
  function limited(res, until) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((until - Date.now()) / 1000))));
    fail(429, 'admin_rate_limited', '登录请求过于频繁，请稍后再试');
  }
  function bucket(map, key, res) {
    const now = Date.now();
    let current = map.get(key);
    if (current && current.until > now) return current;
    if (map.size >= MAX_BUCKETS) sweep(now);
    if (!current && map.size >= MAX_BUCKETS) limited(res, now + 60000);
    current = { count: 0, pending: 0, until: now + LOGIN_WINDOW_MS };
    map.set(key, current); return current;
  }
  function readSession(req) {
    const token = cookieToken(req.headers.cookie);
    if (!token) return null;
    const key = tokenHash(token), session = sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) { sessions.delete(key); return null; }
    return { key, session };
  }
  function mint(req, res, authenticated) {
    const now = Date.now();
    sweep(now);
    if (!authenticated) {
      const issued = bucket(issuance, req.ip || req.socket.remoteAddress || 'unknown', res);
      if (issued.count >= 30) limited(res, issued.until);
      issued.count++;
    }
    if (sessions.size >= MAX_SESSIONS) limited(res, now + 60000);
    const token = randomBytes(32).toString('base64url');
    const session = { csrf: randomBytes(32).toString('base64url'), authenticated, expiresAt: now + (authenticated ? SESSION_MS : LOGIN_WINDOW_MS) };
    sessions.set(tokenHash(token), session);
    res.cookie(COOKIE, token, { ...cookieOptions, maxAge: session.expiresAt - now });
    return session;
  }
  function sessionResult(session = null) {
    return {
      configured: configured && !closed, authenticated: Boolean(session?.authenticated),
      username: session?.authenticated ? username : null, csrf: session?.csrf || null,
      expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
    };
  }
  function writeAccess(req, _res, next) {
    available();
    const current = readSession(req);
    if (!current || !safeEqual(req.get('x-csrf-token'), current.session.csrf)) fail(403, 'admin_csrf_mismatch', '管理页面凭证已更新，请刷新后重试');
    if (req.body === undefined) req.body = {};
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) fail(400, 'admin_invalid_input', '请求内容需要是 JSON 对象');
    req.adminSession = current;
    next();
  }
  function authenticated(req, _res, next) {
    available();
    if (!readSession(req)?.session.authenticated) fail(401, 'admin_auth_required', '请先登录管理后台');
    next();
  }
  function onlineSnapshot() {
    const online = onlineIds();
    return online instanceof Set ? online : new Set();
  }
  function pairingStatus(id) {
    const status = pairing?.states?.get(id)?.status;
    return ['searching', 'proposed', 'connected'].includes(status) ? status : 'idle';
  }
  function userRow(row, online) {
    return {
      id: row.id, name: row.name, avatar: row.avatar, provider: row.provider,
      createdAt: row.created_at, registeredAt: row.registered_at || null, lastSeenAt: row.last_seen_at || null,
      online: online.has(row.id),
      profile: row.profile_id ? {
        title: text(row.profile_title), interests: interestsFrom(row.profile_interests),
        discoverable: Boolean(row.discoverable), analysisMode: row.analysis_mode === 'model' ? 'model' : 'rules',
        updatedAt: row.profile_updated_at,
      } : null,
      pairingStatus: pairingStatus(row.id),
    };
  }

  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    const origin = req.get('origin'), site = req.get('sec-fetch-site');
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if ((origin && !config.allowedOrigins.has(origin)) || (write && !origin) || (site && !['same-origin', 'none'].includes(site))) fail(403, 'admin_origin_mismatch', '请从本站管理页面操作');
    next();
  });

  router.get('/session', (req, res) => {
    if (!configured || closed) return res.json(sessionResult());
    res.json(sessionResult(readSession(req)?.session || mint(req, res, false)));
  });
  router.post('/login', writeAccess, async (req, res) => {
    const { username: suppliedUsername, password } = req.body;
    if (typeof suppliedUsername !== 'string' || !suppliedUsername.length || suppliedUsername.length > 64 || typeof password !== 'string' || !password.length || password.length > 256) fail(400, 'admin_invalid_input', '用户名或密码格式不正确');
    const now = Date.now();
    const attempts = bucket(failures, req.ip || req.socket.remoteAddress || 'unknown', res);
    if (attempts.count + attempts.pending >= 5) limited(res, attempts.until);
    if (globalFailures.until <= now) globalFailures = { count: 0, pending: 0, until: now + LOGIN_WINDOW_MS };
    const globalAttempts = globalFailures;
    if (globalAttempts.count + globalAttempts.pending >= 50) limited(res, globalAttempts.until);
    if (hashing >= 2) limited(res, now + 1000);
    attempts.pending++; globalAttempts.pending++; hashing++;
    let correct;
    try {
      const digest = await deriveKey(password, verifier.salt, verifier.digest.length, SCRYPT);
      const passwordMatches = timingSafeEqual(digest, verifier.digest);
      correct = safeEqual(suppliedUsername, username) && passwordMatches;
    } finally { attempts.pending--; globalAttempts.pending--; hashing--; }
    if (!correct) { attempts.count++; globalAttempts.count++; fail(401, 'admin_invalid_credentials', '用户名或密码不正确'); }
    // A concurrent logout or successful login must not resurrect its old session.
    const current = req.adminSession;
    if (closed || current.session.expiresAt <= Date.now() || sessions.get(current.key) !== current.session) fail(403, 'admin_csrf_mismatch', '管理页面凭证已更新，请刷新后重试');
    sessions.delete(current.key);
    res.json(sessionResult(mint(req, res, true)));
  });
  router.post('/logout', writeAccess, (req, res) => {
    sessions.delete(req.adminSession.key);
    res.clearCookie(COOKIE, cookieOptions);
    res.json(sessionResult(mint(req, res, false)));
  });

  router.get('/overview', authenticated, (_req, res) => {
    const now = Date.now();
    const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    const midnight = Date.parse(`${today}T00:00:00.000Z`);
    const registrations = Array.from({ length: 7 }, (_, i) => ({ date: new Date(midnight - (6 - i) * 86400000).toISOString().slice(0, 10), zhihu: 0, guest: 0 }));
    const dayRows = store.db.prepare(`SELECT date(created_at, '+8 hours') AS date, provider, COUNT(*) AS count FROM users
      WHERE date(created_at, '+8 hours') BETWEEN ? AND ? GROUP BY date, provider`).all(registrations[0].date, today);
    for (const row of dayRows) {
      const day = registrations.find(item => item.date === row.date);
      if (day && ['zhihu', 'guest'].includes(row.provider)) day[row.provider] = row.count;
    }
    const counts = store.db.prepare(`SELECT COUNT(*) AS totalUsers,
      COALESCE(SUM(u.provider = 'zhihu'), 0) AS zhihuUsers, COALESCE(SUM(u.provider = 'guest'), 0) AS guestUsers,
      COUNT(p.user_id) AS profileUsers, COALESCE(SUM(p.discoverable = 1), 0) AS discoverableUsers
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id`).get();
    const online = onlineSnapshot(), states = pairing?.states || new Map();
    const currentIds = new Set([...online, ...states.keys()].filter(id => typeof id === 'string'));
    const existing = new Set(store.db.prepare('SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify([...currentIds])).map(row => row.id));
    counts.onlineUsers = [...online].filter(id => existing.has(id)).length;
    counts.newUsersToday = registrations[6].zhihu + registrations[6].guest;
    counts.connections = store.db.prepare("SELECT COUNT(*) AS count FROM invitations WHERE status = 'accepted'").get().count;
    counts.messages = store.db.prepare('SELECT COUNT(*) AS count FROM messages').get().count;
    const queue = { searching: 0, proposed: 0 };
    for (const [id, state] of states) if (existing.has(id) && ['searching', 'proposed'].includes(state.status)) queue[state.status]++;
    const topicRows = store.db.prepare(`SELECT json_extract(${topicObject}, '$.id') AS id, COUNT(DISTINCT p.user_id) AS count
      FROM profiles p, json_each(${profileData}, '$.interests') AS topic GROUP BY json_extract(${topicObject}, '$.id')`).all();
    const topicCounts = new Map(topicRows.map(row => [row.id, row.count]));
    const interests = TOPICS.map(topic => ({ id: topic.id, label: topic.label, count: topicCounts.get(topic.id) || 0 }))
      .filter(topic => topic.count > 0).sort((a, b) => b.count - a.count);
    res.json({ generatedAt: new Date(now).toISOString(), counts: { ...counts }, pairing: queue, interests, registrations });
  });

  router.get('/users', authenticated, (req, res) => {
    const read = (name, fallback) => {
      const value = req.query[name];
      if (value === undefined) return fallback;
      if (typeof value !== 'string') fail(400, 'admin_invalid_filter', '用户筛选条件格式不正确');
      return value;
    };
    const provider = read('provider', 'all'), profile = read('profile', 'all'), visibility = read('visibility', 'all'), topic = read('topic', 'all');
    if (!['all', 'zhihu', 'guest'].includes(provider) || !['all', 'ready', 'empty'].includes(profile) || !['all', 'public', 'private'].includes(visibility) || (topic !== 'all' && !TOPIC_MAP.has(topic))) fail(400, 'admin_invalid_filter', '请选择有效的用户筛选条件');
    const q = read('q', '').trim();
    if (q.length > 100) fail(400, 'admin_invalid_filter', '搜索内容不能超过 100 个字符');
    const positive = (name, fallback, max) => {
      const value = read(name, String(fallback));
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) fail(400, 'admin_invalid_filter', '分页参数超出范围');
      return Number(value);
    };
    const page = positive('page', 1, 1000000), pageSize = positive('pageSize', 20, 100);
    const filters = [], args = [];
    if (provider !== 'all') { filters.push('u.provider = ?'); args.push(provider); }
    if (profile !== 'all') filters.push(`p.user_id IS ${profile === 'ready' ? 'NOT ' : ''}NULL`);
    if (visibility !== 'all') filters.push(visibility === 'public' ? 'p.discoverable = 1' : '(p.user_id IS NULL OR p.discoverable = 0)');
    if (topic !== 'all') {
      filters.push(`EXISTS (SELECT 1 FROM json_each(${profileData}, '$.interests') AS topic WHERE json_extract(${topicObject}, '$.id') = ?)`);
      args.push(topic);
    }
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      filters.push(`(u.name LIKE ? ESCAPE '\\' OR u.id LIKE ? ESCAPE '\\'
        OR json_extract(${profileData}, '$.title') LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM json_each(${profileData}, '$.interests') AS topic
          WHERE json_extract(${topicObject}, '$.id') LIKE ? ESCAPE '\\' OR json_extract(${topicObject}, '$.label') LIKE ? ESCAPE '\\'))`);
      args.push(like, like, like, like, like);
    }
    const from = `FROM users u LEFT JOIN profiles p ON p.user_id = u.id${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''}`;
    const total = store.db.prepare(`SELECT COUNT(*) AS count ${from}`).get(...args).count;
    const rows = store.db.prepare(`SELECT ${profileColumns} ${from} ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    const online = onlineSnapshot();
    res.json({ items: rows.map(row => userRow(row, online)), total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  });

  router.get('/users/:id', authenticated, (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string' || !id.length || id.length > 100) fail(400, 'admin_invalid_filter', '用户标识格式不正确');
    const row = store.db.prepare(`SELECT ${profileColumns},
      json_extract(${profileData}, '$.summary') AS summary, json_extract(${profileData}, '$.highlights') AS highlights,
      json_extract(${profileData}, '$.dimensions') AS dimensions, json_extract(${profileData}, '$.style') AS style,
      json_extract(${profileData}, '$.input.goals') AS goals, json_extract(${profileData}, '$.input.about') AS about,
      json_extract(${profileData}, '$.input.question') AS question
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`).get(id);
    if (!row) fail(404, 'admin_user_missing', '该用户不存在或已注销');
    const user = userRow(row, onlineSnapshot());
    let profile = null;
    if (row.profile_id) {
      const dimensionValues = new Map(arrayJson(row.dimensions).map(item => [item?.id, item?.value]));
      const rawStyle = objectJson(row.style), style = STYLES.find(item => item.id === rawStyle.id) || STYLES[0];
      profile = {
        title: user.profile.title, summary: text(row.summary), highlights: arrayJson(row.highlights).filter(item => typeof item === 'string'),
        interests: user.profile.interests,
        dimensions: DOMAINS.map(domain => ({ id: domain.id, label: domain.label, color: domain.color,
          value: Number.isFinite(dimensionValues.get(domain.id)) ? Math.max(0, Math.min(100, dimensionValues.get(domain.id))) : 0 })),
        style: { id: style.id, label: style.short, values: style.values.map((fallback, i) => Number.isFinite(rawStyle.values?.[i]) ? Math.max(0, Math.min(100, rawStyle.values[i])) : fallback) },
        goals: arrayJson(row.goals).filter(id => GOALS.some(goal => goal.id === id)),
        about: text(row.about), question: text(row.question), analysisMode: user.profile.analysisMode,
        revision: row.revision, discoverable: user.profile.discoverable, updatedAt: row.profile_updated_at,
      };
    }
    const activity = store.db.prepare(`SELECT
      (SELECT COUNT(*) FROM invitations WHERE (sender_id = ? OR recipient_id = ?) AND status = 'accepted') AS connections,
      (SELECT COUNT(*) FROM invitations WHERE (sender_id = ? OR recipient_id = ?) AND status = 'pending') AS pendingInvitations,
      (SELECT COUNT(*) FROM messages WHERE author_id = ?) AS messages,
      (SELECT COUNT(*) FROM saved WHERE user_id = ?) AS saved`).get(id, id, id, id, id, id);
    const imports = store.db.prepare(`SELECT CASE WHEN json_valid(data) THEN
      CASE WHEN json_type(data) = 'array' THEN json_array_length(data) ELSE 0 END ELSE 0 END AS count,
      fetched_at AS fetchedAt FROM imports WHERE user_id = ?`).get(id);
    res.json({ user, profile, zhihuValidation: store.zhihuValidation(id), activity: { ...activity, importedItems: imports?.count || 0, importedAt: imports?.fetchedAt || null } });
  });

  // Always terminate here: unknown admin paths must not reach visitor middleware.
  router.use((_req, _res) => fail(404, 'admin_not_found', '管理接口不存在'));
  router.use((error, _req, res, _next) => {
    const known = error instanceof AppError;
    res.status(known ? error.status : 500).json({ error: {
      code: known ? error.code : 'admin_internal_error',
      message: known ? error.message : '管理服务暂时不可用，请稍后重试',
    } });
  });
  return { router, close };
}
