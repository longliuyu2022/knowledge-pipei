import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createAdminRouter, hashAdminPassword } from '../server/admin.js';
import { KnowledgeStore as Store } from '../server/knowledge-store.js';
import { PersistentMatching } from '../server/persistent-matching.js';
import { initializeCircles } from '../server/circles/schema.js';
import { buildProfile } from '../server/matching.js';
import { DEFAULT_INPUT } from '../shared/catalog.js';
import { makeClient, startService, testConfig } from './helpers.js';

// Fictional credentials generated only for isolated, in-memory test services.
const PASSWORD = 'Local-fixture-only-Admin-2026';
const PASSWORD_HASH = await hashAdminPassword(PASSWORD);
const configured = overrides => testConfig({ SOUL_ADMIN_USERNAME: 'admin', SOUL_ADMIN_PASSWORD_HASH: PASSWORD_HASH, ...overrides });
const count = (store, table) => store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;

async function fixture(t, { overrides, pairing = { states: new Map() }, online = new Set() } = {}) {
  const config = configured(overrides), store = new Store(':memory:');
  initializeCircles(store.db);
  const matching = new PersistentMatching(store);
  const admin = createAdminRouter(config, { store, pairing, onlineIds: () => online });
  const app = express(); app.set('trust proxy', 'loopback'); app.use(express.json({ limit: '32kb' }));
  let fallthrough = 0;
  app.use('/api/admin', admin.router);
  app.use((_req, res) => { fallthrough++; res.status(418).json({ error: { code: 'unexpected_fallthrough' } }); });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`; config.allowedOrigins.add(base);
  t.after(async () => {
    admin.close(); matching.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
  });
  return { config, store, admin, pairing, online, base, client: () => makeClient(base), get fallthrough() { return fallthrough; } };
}

async function login(client, headers = {}) {
  assert.equal((await client.request('/api/admin/session', { headers })).status, 200);
  const response = await client.request('/api/admin/login', { method: 'POST', body: { username: 'admin', password: PASSWORD }, headers });
  assert.equal(response.status, 200, response.data?.error?.code || 'administrator fixture login');
  assert.equal(response.data.authenticated, true);
  return response;
}

function seed(store, { name = '虚构伙伴', provider = 'guest', topics, publicProfile = false,
  createdAt = new Date().toISOString(), registeredAt = null, lastSeenAt = null, extra } = {}) {
  let user = store.createUser(name);
  if (provider === 'zhihu') user = store.oauthUser(user.id, { subject: `fixture-subject:${user.id}`, name, avatar: '' });
  store.db.prepare('UPDATE users SET created_at = ?, registered_at = ?, last_seen_at = ? WHERE id = ?').run(createdAt, registeredAt, lastSeenAt, user.id);
  if (topics) {
    const profile = buildProfile({ ...DEFAULT_INPUT, name, topicIds: topics, about: '', question: '' });
    if (extra) extra(profile);
    store.saveProfile(user.id, profile, 0);
    if (publicProfile) store.setDiscoverable(user.id, true);
  }
  return user;
}

test('admin is a separate identity: ordinary and anonymous sessions cannot read it; admin traffic creates no visitors', async t => {
  const service = await startService(t, { config: configured() });
  const admin = service.client(), visitor = service.client();
  for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/users/missing']) {
    const response = await admin.request(path);
    assert.equal(response.status, 401); assert.equal(response.data.error.code, 'admin_auth_required');
  }
  assert.equal(count(service.store, 'users'), 0);
  const boot = await visitor.bootstrap();
  assert.equal((await visitor.request('/api/admin/users')).status, 401);
  const normalSessionCount = count(service.store, 'sessions');
  const seen = service.store.db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(boot.user.id).last_seen_at;
  await login(admin);
  assert.equal(admin.jar.has('tongzhi_session'), false);
  const list = await admin.request('/api/admin/users');
  assert.equal(list.status, 200); assert.equal(list.data.total, 1);
  assert.equal(count(service.store, 'users'), 1); assert.equal(count(service.store, 'sessions'), normalSessionCount);
  assert.equal(service.store.db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(boot.user.id).last_seen_at, seen);
  assert.equal((await admin.request('/api/account/export')).status, 401);
  const forged = service.client(); forged.jar.set('tongzhi_admin', visitor.jar.get('tongzhi_session'));
  assert.equal((await forged.request('/api/admin/users')).status, 401);
  const ordinaryBefore = visitor.jar.get('tongzhi_session');
  await login(visitor);
  assert.ok(visitor.jar.get('tongzhi_session') === ordinaryBefore, 'admin login must preserve the independent visitor session');
  await visitor.request('/api/admin/logout', { method: 'POST' });
  assert.equal((await visitor.bootstrap()).user.id, boot.user.id);
});

test('unknown admin routes return JSON 404 and never reach the visitor API', async t => {
  const service = await fixture(t), client = service.client();
  for (const path of ['/api/admin', '/api/admin/bootstrap', '/api/admin/session/extra', '/api/admin/users/a/extra']) {
    const response = await client.request(path);
    assert.equal(response.status, 404); assert.equal(response.data.error.code, 'admin_not_found');
    assert.match(response.headers.get('content-type'), /application\/json/);
  }
  assert.equal((await client.request('/api/admin/reset', { method: 'POST', body: {} })).status, 404);
  assert.equal(service.fallthrough, 0); assert.equal(count(service.store, 'users'), 0);
});

test('admin cookies are scoped, private and rotated at login; prior sessions and CSRF cannot be reused', async t => {
  const service = await fixture(t, { overrides: { SOUL_PUBLIC_ORIGIN: 'https://admin-fixture.invalid' } });
  const client = service.client();
  const anonymous = await client.request('/api/admin/session');
  assert.equal(anonymous.data.configured, true); assert.equal(anonymous.data.authenticated, false);
  assert.equal(anonymous.data.username, null); assert.ok(anonymous.data.csrf);
  const beforeCookie = client.jar.get('tongzhi_admin'), beforeCsrf = client.csrf;
  const old = service.client(); old.jar.set('tongzhi_admin', beforeCookie); old.csrf = beforeCsrf;
  const authenticated = await login(client);
  assert.ok(client.jar.get('tongzhi_admin') !== beforeCookie, 'login rotates the opaque token');
  assert.ok(client.csrf !== beforeCsrf, 'login rotates CSRF');
  for (const response of [anonymous, authenticated]) {
    const cookie = response.headers.getSetCookie().find(item => item.startsWith('tongzhi_admin='));
    for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Path=/api/admin', 'Secure']) assert.ok(cookie.includes(attribute), `cookie needs ${attribute}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.ok(authenticated.headers.getSetCookie().some(cookie => cookie.includes('Max-Age=28800')));
  assert.equal((await old.request('/api/admin/users')).status, 401);
  assert.equal((await old.request('/api/admin/login', { method: 'POST', body: { username: 'admin', password: PASSWORD } })).status, 403);
  assert.equal((await client.request('/api/admin/logout', { method: 'POST', headers: { 'x-csrf-token': beforeCsrf } })).status, 403);
  const stableCookie = client.jar.get('tongzhi_admin'), stableCsrf = client.csrf;
  const refreshed = await client.request('/api/admin/session');
  assert.ok(client.jar.get('tongzhi_admin') === stableCookie && client.csrf === stableCsrf);
  assert.equal(refreshed.headers.getSetCookie().length, 0); assert.equal(refreshed.data.expiresAt, authenticated.data.expiresAt);
});

test('strict Origin, Fetch-Site and CSRF validation covers login and logout, including malformed Unicode tokens', async t => {
  const service = await fixture(t), client = service.client();
  await client.request('/api/admin/session');
  const body = { username: 'admin', password: PASSWORD };
  for (const headers of [
    { origin: '' }, { origin: 'null' }, { origin: 'https://untrusted.invalid' },
    { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'unexpected' },
  ]) {
    const response = await client.request('/api/admin/login', { method: 'POST', body, headers });
    assert.equal(response.status, 403); assert.equal(response.data.error.code, 'admin_origin_mismatch');
  }
  for (const csrf of ['', 'not-valid', 'é'.repeat(client.csrf.length)]) {
    const response = await client.request('/api/admin/login', { method: 'POST', body, headers: { 'x-csrf-token': csrf } });
    assert.equal(response.status, 403); assert.equal(response.data.error.code, 'admin_csrf_mismatch');
  }
  await login(client, { 'sec-fetch-site': 'same-origin' });
  assert.equal((await client.request('/api/admin/users', { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await client.request('/api/admin/overview', { headers: { origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await client.request('/api/admin/users', { headers: { origin: '', 'sec-fetch-site': 'same-origin' } })).status, 200);
  assert.equal((await client.request('/api/admin/logout', { method: 'POST', headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await client.request('/api/admin/logout', { method: 'POST', headers: { origin: '' } })).status, 403);
  assert.equal((await client.request('/api/admin/session')).data.authenticated, true);
});

test('logout revokes a shared browser session immediately and restarts never accept an old admin token', async t => {
  const service = await fixture(t), client = service.client(); await login(client);
  const otherTab = service.client(); otherTab.jar.set('tongzhi_admin', client.jar.get('tongzhi_admin')); otherTab.csrf = client.csrf;
  const restarted = await fixture(t), replay = restarted.client(); replay.jar.set('tongzhi_admin', client.jar.get('tongzhi_admin'));
  assert.equal((await replay.request('/api/admin/users')).status, 401);
  const loggedOut = await client.request('/api/admin/logout', { method: 'POST' });
  assert.equal(loggedOut.status, 200); assert.equal(loggedOut.data.authenticated, false); assert.equal(loggedOut.data.username, null);
  assert.equal((await otherTab.request('/api/admin/users')).status, 401);
  assert.equal((await otherTab.request('/api/admin/logout', { method: 'POST' })).status, 403);
  assert.equal((await client.request('/api/admin/users')).status, 401);
});

test('admin sessions expire after eight hours without sliding renewal; anonymous login challenges also expire', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const service = await fixture(t), client = service.client();
  const loggedIn = await login(client), expires = Date.parse(loggedIn.data.expiresAt);
  assert.equal(expires - clock, 8 * 3600000);
  clock = expires - 1;
  const recent = await client.request('/api/admin/session');
  assert.equal(recent.data.authenticated, true); assert.equal(recent.data.expiresAt, loggedIn.data.expiresAt);
  assert.equal((await client.request('/api/admin/users')).status, 200);
  clock = expires;
  assert.equal((await client.request('/api/admin/users')).status, 401);
  const next = await client.request('/api/admin/session');
  assert.equal(next.data.authenticated, false); assert.ok(next.data.csrf);
  clock += 15 * 60000;
  const expiredLogin = await client.request('/api/admin/login', { method: 'POST', body: { username: 'admin', password: PASSWORD } });
  assert.equal(expiredLogin.status, 403);
});

test('five failed logins per IP lock subsequent attempts for fifteen minutes with Retry-After', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const service = await fixture(t), client = service.client(); await client.request('/api/admin/session');
  for (let i = 0; i < 5; i++) {
    const response = await client.request('/api/admin/login', { method: 'POST', body: { username: i % 2 ? 'unknown' : 'admin', password: 'Wrong-fixture-password' } });
    assert.equal(response.status, 401); assert.equal(response.data.error.code, 'admin_invalid_credentials');
  }
  const limited = await client.request('/api/admin/login', { method: 'POST', body: { username: 'admin', password: PASSWORD } });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '900');
  const anotherIp = service.client();
  await login(anotherIp, { 'x-forwarded-for': '192.0.2.40' });
  clock += 15 * 60000;
  await login(client);
});

test('global failures and concurrent hashing are bounded even across different IPs', async t => {
  const busyService = await fixture(t), busyClient = busyService.client(); await busyClient.request('/api/admin/session');
  const attempts = await Promise.all(Array.from({ length: 10 }, (_, i) => busyClient.request('/api/admin/login', {
    method: 'POST', body: { username: 'admin', password: 'Wrong-concurrent-password' }, headers: { 'x-forwarded-for': `192.0.2.${i + 1}` },
  })));
  assert.equal(attempts.filter(response => response.status === 401).length, 2);
  assert.equal(attempts.filter(response => response.status === 429).length, 8);
  for (const response of attempts.filter(item => item.status === 429)) assert.equal(response.headers.get('retry-after'), '1');
  const service = await fixture(t), client = service.client(); await client.request('/api/admin/session');
  for (let i = 0; i < 50; i++) {
    const response = await client.request('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'Wrong-global-password' }, headers: { 'x-forwarded-for': `198.51.100.${i + 1}` } });
    assert.equal(response.status, 401);
  }
  const limited = await client.request('/api/admin/login', { method: 'POST', body: { username: 'admin', password: PASSWORD }, headers: { 'x-forwarded-for': '203.0.113.1' } });
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 800);
});

test('malformed password hashes fail closed and password initialization rejects weak lengths', async t => {
  await assert.rejects(hashAdminPassword('too-short'), /12–256/);
  await assert.rejects(hashAdminPassword('x'.repeat(257)), /12–256/);
  await assert.rejects(hashAdminPassword(null), /12–256/);
  for (const hash of ['', 'plain-text-fixture', PASSWORD_HASH.replace('$32768$', '$1024$'), PASSWORD_HASH.slice(0, -1), `${PASSWORD_HASH}=`, PASSWORD_HASH.replace('scrypt$', 'unknown$')]) {
    const service = await fixture(t, { overrides: { SOUL_ADMIN_PASSWORD_HASH: hash } }), client = service.client();
    const session = await client.request('/api/admin/session');
    assert.deepEqual(session.data, { configured: false, authenticated: false, username: null, csrf: null, expiresAt: null });
    assert.equal(session.headers.getSetCookie().length, 0);
    assert.equal((await client.request('/api/admin/users')).status, 503);
    assert.equal((await client.request('/api/admin/login', { method: 'POST', body: { username: 'admin', password: PASSWORD } })).status, 503);
    assert.equal(count(service.store, 'users'), 0);
  }
});

test('malformed login inputs return controlled errors and anonymous session issuance is bounded', async t => {
  const service = await startService(t, { config: configured() }), client = service.client(); await client.request('/api/admin/session');
  for (const request of [{}, { body: null }, { body: [] }, { raw: '{broken-json' },
    { body: {} }, { body: { username: {}, password: PASSWORD } }, { body: { username: 'admin', password: [] } },
    { body: { username: 'a'.repeat(65), password: PASSWORD } }, { body: { username: 'admin', password: 'x'.repeat(257) } }]) {
    assert.equal((await client.request('/api/admin/login', { method: 'POST', ...request })).status, 400);
  }
  assert.equal(count(service.store, 'users'), 0);
  const bounded = await fixture(t), unauthenticated = bounded.client();
  for (let i = 0; i < 30; i++) {
    unauthenticated.jar.clear();
    assert.equal((await unauthenticated.request('/api/admin/session')).status, 200);
  }
  unauthenticated.jar.clear();
  const blocked = await unauthenticated.request('/api/admin/session');
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('user filters, escaped search and pagination combine correctly across both account sources', async t => {
  const service = await fixture(t), client = service.client(); await login(client);
  const a = seed(service.store, { name: '100%_\\探索', provider: 'zhihu', topics: ['ai', 'coding', 'product'], publicProfile: true, createdAt: '2026-09-13T12:00:00.000Z' });
  const b = seed(service.store, { name: '安静读者', provider: 'zhihu', topics: ['history', 'reading', 'philosophy'], createdAt: '2026-09-12T12:00:00.000Z' });
  const c = seed(service.store, { name: '游客账号', createdAt: '2026-09-11T12:00:00.000Z' });
  const all = await client.request('/api/admin/users');
  assert.equal(all.status, 200); assert.equal(all.data.pageSize, 20); assert.equal(all.data.total, 3);
  assert.deepEqual(all.data.items.map(item => item.id), [a.id, b.id, c.id]);
  for (const [query, ids] of [
    ['provider=zhihu', [a.id, b.id]], ['provider=guest', [c.id]], ['profile=ready', [a.id, b.id]],
    ['profile=empty', [c.id]], ['visibility=public', [a.id]], ['visibility=private', [b.id, c.id]],
    ['topic=reading', [b.id]], ['provider=zhihu&profile=ready&visibility=private&topic=reading', [b.id]],
    [`q=${encodeURIComponent('%_\\')}`, [a.id]], [`q=${encodeURIComponent('人工智能')}`, [a.id]],
    [`q=${a.id}`, [a.id]], [`q=${encodeURIComponent("' OR 1=1 --")}`, []], ['q=100_unrelated', []],
  ]) {
    const response = await client.request(`/api/admin/users?${query}`);
    assert.equal(response.status, 200); assert.deepEqual(response.data.items.map(item => item.id), ids, query);
  }
  const titleQuery = encodeURIComponent(all.data.items[0].profile.title);
  assert.deepEqual((await client.request(`/api/admin/users?q=${titleQuery}`)).data.items.map(item => item.id), [a.id]);
  const page1 = (await client.request('/api/admin/users?pageSize=2')).data;
  const page2 = (await client.request('/api/admin/users?pageSize=2&page=2')).data;
  assert.equal(page1.totalPages, 2); assert.deepEqual([...page1.items, ...page2.items].map(item => item.id), [a.id, b.id, c.id]);
  assert.deepEqual((await client.request('/api/admin/users?page=999&pageSize=2')).data.items, []);
  for (const query of ['provider=demo', 'profile=broken', 'visibility=hidden', 'topic=missing', 'page=0', 'page=-1', 'page=1.5', 'page=1e2', 'page=1000001', 'pageSize=101', 'pageSize=0', 'page=1&page=2', 'q=a&q=b', `q=${'x'.repeat(101)}`]) {
    const response = await client.request(`/api/admin/users?${query}`);
    assert.equal(response.status, 400, query); assert.equal(response.data.error.code, 'admin_invalid_filter');
  }
  assert.equal((await client.request('/api/admin/users/missing')).status, 404);
});

test('admin detail exposes only the agreed profile and activity fields, including private profiles', async t => {
  const service = await fixture(t), client = service.client(); await login(client);
  const markers = ['CANARY_OAUTH_SUBJECT', 'CANARY_IMPORTED_RAW', 'CANARY_EVIDENCE', 'CANARY_INPUT_EXTRA', 'CANARY_CHAT_BODY', 'CANARY_NESTED_EXTRA'];
  const a = seed(service.store, { name: '私密画像', provider: 'zhihu', topics: ['ai', 'coding', 'reading'], extra(profile) {
    profile.evidence = [{ text: markers[2] }]; profile.input.secret = markers[3]; profile.input.about = '可展示的自我介绍';
    profile.interests[0].secret = markers[5]; profile.style.secret = markers[5]; profile.dimensions[0].secret = markers[5];
  } });
  const b = seed(service.store, { name: '虚构对话伙伴' }), c = seed(service.store, { name: '虚构邀请伙伴' });
  service.store.db.prepare('UPDATE users SET subject = ? WHERE id = ?').run(markers[0], a.id);
  const normalSession = service.store.createSession(a.id);
  service.store.saveImports(a.id, [{ title: markers[1], summary: markers[1] }, { title: markers[1], summary: markers[1] }]);
  const conversation = randomUUID(), pending = randomUUID(), at = new Date().toISOString();
  const insert = service.store.db.prepare('INSERT INTO invitations (id, sender_id, recipient_id, message, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run(conversation, a.id, b.id, markers[4], 'accepted', at, at);
  insert.run(pending, c.id, a.id, markers[4], 'pending', at, at);
  service.store.sendMessage(a.id, conversation, markers[4]);
  service.store.sendMessage(b.id, conversation, markers[4]);
  service.store.setSaved(a.id, b.id, true);
  const detail = await client.request(`/api/admin/users/${a.id}`);
  assert.equal(detail.status, 200); assert.equal(detail.data.user.profile.discoverable, false);
  assert.equal(detail.data.profile.about, '可展示的自我介绍'); assert.equal(detail.data.profile.revision, 1);
  assert.deepEqual(detail.data.activity, { connections: 1, pendingInvitations: 1, messages: 1, saved: 1, importedItems: 2, importedAt: service.store.imports(a.id).fetchedAt });
  assert.equal(detail.data.user.registeredAt, null); assert.equal(detail.data.user.lastSeenAt, null);
  const serialized = JSON.stringify([detail.data, (await client.request('/api/admin/users')).data, (await client.request('/api/admin/overview')).data]);
  for (const marker of [...markers, normalSession.token, normalSession.csrf, PASSWORD, PASSWORD_HASH]) assert.ok(!serialized.includes(marker), 'admin output must not include private source or authentication material');
  assert.deepEqual(Object.keys(detail.data.profile).sort(), ['title', 'summary', 'highlights', 'interests', 'dimensions', 'style', 'goals', 'about', 'question', 'analysisMode', 'revision', 'discoverable', 'updatedAt'].sort());
  assert.deepEqual(Object.keys(detail.data.user).sort(), ['id', 'name', 'avatar', 'provider', 'status', 'hasEmail', 'emailMasked', 'createdAt', 'registeredAt', 'lastSeenAt', 'online', 'profile', 'pairingStatus'].sort());
  const noProfile = (await client.request(`/api/admin/users/${c.id}`)).data;
  assert.equal(noProfile.profile, null); assert.equal(noProfile.user.profile, null); assert.equal(noProfile.activity.importedItems, 0);
});

test('overview reports empty data, Shanghai join dates, real online users and per-person interests without changing the queue', async t => {
  const clock = Date.parse('2026-09-13T16:30:00.000Z'); t.mock.method(Date, 'now', () => clock);
  const pairing = { states: new Map(), tick() { throw new Error('Admin must not mutate pairing'); }, state() { throw new Error('Admin must not advance pairing'); } };
  const service = await fixture(t, { pairing }), client = service.client(); await login(client);
  const empty = await client.request('/api/admin/overview');
  assert.equal(empty.status, 200); assert.equal(empty.data.counts.totalUsers, 0); assert.deepEqual(empty.data.interests, []);
  assert.deepEqual(empty.data.registrations.map(item => item.date), ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14']);
  const a = seed(service.store, { name: '当天加入', provider: 'zhihu', createdAt: '2026-09-13T16:00:00.000Z', registeredAt: '2026-09-13T16:10:00.000Z', topics: ['ai', 'coding'], publicProfile: true,
    extra(profile) { profile.interests.push({ ...profile.interests.find(item => item.id === 'ai') }); } });
  const b = seed(service.store, { name: '前一天加入', createdAt: '2026-09-13T15:59:59.999Z', topics: ['coding', 'reading'] });
  const c = seed(service.store, { name: '历史授权时间未知', provider: 'zhihu', createdAt: '2026-09-07T16:00:00.000Z' });
  const d = seed(service.store, { name: '近期访问但没有在线连接', createdAt: '2026-09-07T15:59:59.999Z', lastSeenAt: new Date(clock).toISOString() });
  seed(service.store, { name: '早前加入今天才授权', provider: 'zhihu', createdAt: '2026-08-01T00:00:00.000Z', registeredAt: new Date(clock).toISOString(), topics: ['ai', 'reading'] });
  service.online.add(a.id); service.online.add(b.id); service.online.add('deleted-user');
  pairing.states.set(a.id, { status: 'searching', note: 'immutable' }); pairing.states.set(b.id, { status: 'proposed' });
  pairing.states.set(c.id, { status: 'connected' }); pairing.states.set('deleted-user', { status: 'searching' });
  const before = JSON.stringify([...pairing.states]);
  const response = await client.request('/api/admin/overview');
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.counts, { totalUsers: 5, zhihuUsers: 3, guestUsers: 2, emailUsers: 0, disabledUsers: 0, profileUsers: 3, discoverableUsers: 1, onlineUsers: 2, newUsersToday: 1, connections: 0, messages: 0 });
  assert.deepEqual(response.data.pairing, { searching: 1, proposed: 1 });
  assert.deepEqual(response.data.registrations[0], { date: '2026-09-08', zhihu: 1, guest: 0, email: 0 });
  assert.deepEqual(response.data.registrations[5], { date: '2026-09-13', zhihu: 0, guest: 1, email: 0 });
  assert.deepEqual(response.data.registrations[6], { date: '2026-09-14', zhihu: 1, guest: 0, email: 0 });
  assert.deepEqual(Object.fromEntries(response.data.interests.map(item => [item.id, item.count])), { ai: 2, coding: 2, reading: 2 });
  const list = (await client.request('/api/admin/users')).data;
  assert.equal(list.items.find(item => item.id === a.id).online, true);
  assert.equal(list.items.find(item => item.id === b.id).pairingStatus, 'proposed');
  assert.equal(list.items.find(item => item.id === d.id).online, false);
  assert.equal(JSON.stringify([...pairing.states]), before);
});
