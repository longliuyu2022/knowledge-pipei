import test from 'node:test';
import assert from 'node:assert/strict';
import { Zhihu, parseZhihuJSON, safeZhihuUrl } from '../server/zhihu.js';
import { testConfig, startService, json } from './helpers.js';

const config = () => testConfig({
  ZHIHU_OAUTH_APP_ID: 'test-app', ZHIHU_OAUTH_APP_KEY: 'test-app-key',
  ZHIHU_OAUTH_REDIRECT_URI: 'https://app.invalid/api/auth/zhihu/callback', ZHIHU_ACCESS_SECRET: 'test-access-secret',
});
const tokenResponse = () => json({ code: 20000, data: { access_token: 'test-user-oauth-token', expires_in: 3600 } });
const identityResponse = () => new Response('{"code":20000,"data":{"uid":969570047710216201,"fullname":"授权用户","avatar_path":"https://picx.zhimg.com/u.png","email":"private@example.invalid","phone_no":"private-phone"}}', { headers: { 'content-type': 'application/json' } });
const defaultFetch = async url => new URL(url).pathname === '/access_token' ? tokenResponse() : new URL(url).pathname === '/user' ? identityResponse() : json({ Code: 0, Data: { Items: [] } });

async function authorize(client, extra = '') {
  const start = await client.request('/api/auth/zhihu/start', { method: 'POST' });
  assert.equal(start.status, 200); const url = new URL(start.data.url);
  const callback = await client.request(`/api/auth/zhihu/callback?state=${encodeURIComponent(url.searchParams.get('state'))}&authorization_code=test-code${extra}`);
  return { start, url, callback };
}

test('Zhihu response parsing preserves 64-bit UID exactly and restricts returned URLs to official HTTPS hosts', () => {
  const value = parseZhihuJSON('{"uid":969570047710216201,"other":42}');
  assert.equal(value.uid, '969570047710216201'); assert.equal(value.other, 42);
  assert.equal(safeZhihuUrl('https://www.zhihu.com/question/1'), 'https://www.zhihu.com/question/1');
  assert.equal(safeZhihuUrl('https://picx.zhimg.com/u.png', true), 'https://picx.zhimg.com/u.png');
  for (const url of ['http://www.zhihu.com/question/1', 'https://zhihu.com.evil.invalid/a', 'https://evil.invalid/zhihu.com', 'https://user:password@www.zhihu.com/a', 'javascript:alert(1)']) assert.equal(safeZhihuUrl(url), '');
  assert.throws(() => parseZhihuJSON('{broken'), error => error.code === 'zhihu_response_invalid');
});

test('OAuth uses form exchange and the user OAuth credential for /user; business imports use both credentials', async () => {
  const calls = [];
  const zhihu = new Zhihu(config(), { fetchImpl: async (url, options) => { calls.push({ url: new URL(url), options }); return defaultFetch(url); } });
  const connected = await zhihu.exchange('provided-code');
  assert.equal(connected.identity.subject, '969570047710216201');
  assert.equal(connected.identity.name, '授权用户');
  assert.equal(calls[0].url.href, 'https://openapi.zhihu.com/access_token');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(calls[0].options.body);
  assert.equal(body.get('app_id'), 'test-app'); assert.equal(body.get('app_key'), 'test-app-key');
  assert.equal(body.get('code'), 'provided-code'); assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('redirect_uri'), config().zhihu.oauth.redirectUri);
  assert.equal(calls[1].url.href, 'https://openapi.zhihu.com/user');
  assert.deepEqual(calls[1].options.headers, { Authorization: 'Bearer test-user-oauth-token' });
  zhihu.setToken('test-user', connected.token, connected.expiresIn);
  await zhihu.import('test-user', ['contents']);
  const business = calls[2];
  assert.equal(business.url.pathname, '/api/v1/user/contents');
  assert.equal(business.url.searchParams.get('Limit'), '10'); assert.equal(business.url.searchParams.get('ContentType'), 'all');
  assert.equal(business.options.headers.Authorization, 'Bearer test-access-secret');
  assert.equal(business.options.headers['X-OAuth-Token'], 'test-user-oauth-token');
  assert.ok(Math.abs(Number(business.options.headers['X-Request-Timestamp']) - Date.now() / 1000) < 3);
  for (const call of calls) assert.equal(call.options.redirect, 'error');
});

test('OAuth handles historical success codes, prefers hash identity, and rejects error or missing identity payloads', async () => {
  const hashed = new Zhihu(config(), { fetchImpl: async url => new URL(url).pathname === '/access_token' ? json({ access_token: 'test-token' }) : json({ code: 0, data: { hash_id: 'stable-hash-id', uid: 123, fullname: '<b>昵称</b>', avatar_path: 'https://evil.invalid/u.png' } }) });
  assert.deepEqual((await hashed.exchange('code')).identity, { subject: 'stable-hash-id', subjectKind: 'hash', name: '昵称', avatar: '' });
  for (const payload of [{ code: 404, data: "User don't exist" }, { data: {} }, { uid: 0 }, { uid: 'not-an-id' }]) {
    const zhihu = new Zhihu(config(), { fetchImpl: async url => new URL(url).pathname === '/access_token' ? tokenResponse() : json(payload) });
    await assert.rejects(zhihu.exchange('code'), error => error.status === 401);
  }
});

test('expired, missing and rejected OAuth tokens never fall back to Access Secret owner data', async () => {
  let calls = 0;
  const zhihu = new Zhihu(config(), { fetchImpl: async () => { calls++; return json({ Code: 0, Data: { Items: [] } }); } });
  await assert.rejects(zhihu.import('missing', ['contents']), error => error.code === 'zhihu_expired');
  zhihu.setToken('expired', 'expired-token', 0);
  await assert.rejects(zhihu.import('expired', ['contents']), error => error.code === 'zhihu_expired');
  assert.equal(calls, 0);
  for (const [response, status] of [[{ Code: 20001 }, 200], [{ error: 'expired' }, 401]]) {
    const rejected = new Zhihu(config(), { fetchImpl: async (_url, options) => { calls++; assert.equal(options.headers['X-OAuth-Token'], 'rejected-token'); return json(response, status); } });
    rejected.setToken('user', 'rejected-token');
    await assert.rejects(rejected.import('user', ['contents']), error => error.status === 401);
    assert.equal(rejected.token('user'), null);
    const previous = calls;
    await assert.rejects(rejected.import('user', ['contents']), error => error.status === 401);
    assert.equal(calls, previous);
  }
});

test('rate and quota errors keep identity tokens, stop retry storms, and do not become empty-data successes', async () => {
  for (const code of [30001, 30002]) {
    let calls = 0;
    const zhihu = new Zhihu(config(), { fetchImpl: async () => { calls++; return json({ Code: code }); } });
    zhihu.setToken('user', 'retained-token');
    await assert.rejects(zhihu.import('user', ['contents']), error => error.status === 429 && error.code === 'zhihu_rate_limited');
    assert.equal(zhihu.token('user'), 'retained-token');
    await assert.rejects(zhihu.import('user', ['contents']), error => error.status === 429);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const zhihu = new Zhihu(config(), { fetchImpl: async () => { calls++; return json({ Code: 0, Data: { Items: [] } }); } });
  zhihu.setToken('user', 'test-token');
  for (let i = 0; i < 5; i++) await zhihu.business('/api/v1/user/contents', { Limit: 1, Offset: i }, 'user');
  await assert.rejects(zhihu.business('/api/v1/user/contents', { Limit: 1 }, 'user'), error => error.status === 429);
  assert.equal(calls, 5); assert.equal(zhihu.token('user'), 'test-token');
});

test('identical imports deduplicate and forget invalidates pending responses instead of refilling private caches', async () => {
  let release, entered, calls = 0;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const zhihu = new Zhihu(config(), { fetchImpl: async () => { calls++; entered(); await gate; return json({ Code: 0, Data: { Items: [{ Title: '私人摘要', Summary: '测试内容', Url: 'https://www.zhihu.com/question/1' }] } }); } });
  zhihu.setToken('user', 'test-token');
  const first = zhihu.import('user', ['contents']), second = zhihu.import('user', ['contents']);
  await started; assert.equal(calls, 1);
  zhihu.forget('user'); release();
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'zhihu_expired'));
  assert.equal(zhihu.cache.size, 0); assert.equal(zhihu.pending.size, 0);
});

test('OAuth callback requires original session, one-time state and browser cookie; malformed state stays a controlled redirect', async t => {
  let calls = 0;
  const service = await startService(t, { config: config(), fetchImpl: async url => { calls++; return defaultFetch(url); } });
  const a = service.client(), b = service.client(); await a.bootstrap(); await b.bootstrap();
  const start = await a.request('/api/auth/zhihu/start', { method: 'POST' });
  const url = new URL(start.data.url), state = url.searchParams.get('state');
  assert.equal(url.origin, 'https://openapi.zhihu.com'); assert.equal(url.searchParams.get('app_id'), 'test-app');
  assert.equal(url.searchParams.get('redirect_uri'), config().zhihu.oauth.redirectUri);
  assert.equal(url.searchParams.has('app_key'), false);
  const unicode = await a.request(`/api/auth/zhihu/callback?code=some-code&state=${encodeURIComponent('中'.repeat(state.length))}`);
  assert.equal(unicode.status, 302); assert.match(unicode.headers.get('location'), /auth=state_error/); assert.equal(calls, 0);
  const replay = await a.request(`/api/auth/zhihu/callback?code=some-code&state=${state}`);
  assert.match(replay.headers.get('location'), /auth=state_error/);
  const again = await a.request('/api/auth/zhihu/start', { method: 'POST' });
  b.jar.set('tongzhi_oauth', a.jar.get('tongzhi_oauth'));
  const wrongBrowser = await b.request(`/api/auth/zhihu/callback?code=some-code&state=${new URL(again.data.url).searchParams.get('state')}`);
  assert.match(wrongBrowser.headers.get('location'), /auth=state_error/); assert.equal(calls, 0);
});

test('OAuth state expires after ten minutes without exchanging credentials', async t => {
  let calls = 0;
  const service = await startService(t, { config: config(), fetchImpl: async url => { calls++; return defaultFetch(url); } });
  const client = service.client(); await client.bootstrap();
  const start = await client.request('/api/auth/zhihu/start', { method: 'POST' });
  const future = Date.now() + 600001;
  t.mock.method(Date, 'now', () => future);
  const result = await client.request(`/api/auth/zhihu/callback?code=code&state=${new URL(start.data.url).searchParams.get('state')}`);
  t.mock.restoreAll();
  assert.equal(result.status, 302); assert.match(result.headers.get('location'), /auth=state_error/); assert.equal(calls, 0);
});

test('successful OAuth rotates sessions, imports only chosen data, and clears imports without changing account identity', async t => {
  const calls = [];
  const service = await startService(t, { config: config(), fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (new URL(url).hostname === 'openapi.zhihu.com') return defaultFetch(url);
    return json({ Code: 0, Data: { Items: [{ Title: '<b>关于 AI 的提问</b>', Summary: '人工智能与学习的摘要', Url: 'https://www.zhihu.com/question/1' }] } });
  } });
  const client = service.client(); const before = await client.bootstrap(); await client.profile('我的画像');
  const oldSession = client.jar.get('tongzhi_session');
  const { callback } = await authorize(client);
  assert.equal(callback.status, 302); assert.match(callback.headers.get('location'), /auth=success/);
  const after = await client.bootstrap();
  assert.equal(after.user.id, before.user.id); assert.equal(after.user.provider, 'zhihu'); assert.equal(after.zhihuConnected, true);
  assert.notEqual(client.jar.get('tongzhi_session'), oldSession); assert.notEqual(after.csrf, before.csrf);
  assert.equal(service.store.session(oldSession), null);
  assert.equal(service.store.db.prepare('SELECT subject FROM users WHERE id = ?').get(after.user.id).subject, 'uid:969570047710216201');
  for (const secret of ['test-user-oauth-token', 'test-access-secret', 'test-app-key', 'private@example.invalid', 'private-phone']) assert.equal(JSON.stringify(after).includes(secret), false);
  const imported = await client.request('/api/zhihu/import', { method: 'POST', body: { sources: ['contents'], useAI: false } });
  assert.equal(imported.status, 200); assert.equal(imported.data.count, 1); assert.deepEqual(imported.data.counts, { contents: 1 });
  assert.equal(imported.data.profile.discoverable, false); assert.equal(imported.data.profile.revision, 2);
  assert.equal(imported.data.profile.evidence.some(e => e.kind === 'contents' && e.label === '关于 AI 的提问'), true);
  assert.equal(calls.filter(call => call.url.hostname === 'developer.zhihu.com').length, 1);
  const cleared = await client.request('/api/zhihu/import', { method: 'DELETE' });
  assert.equal(cleared.status, 200); assert.equal(cleared.data.profile.revision, 3);
  const final = await client.bootstrap();
  assert.equal(final.imports.count, 0); assert.equal(final.zhihuConnected, false); assert.equal(final.user.provider, 'zhihu');
  assert.equal(final.profile.evidence.some(e => e.kind === 'contents'), false);
});

test('OAuth upstream auth errors leave the existing session intact and import quotas do not downgrade signed-in users', async t => {
  let authFail = true, businessCalls = 0;
  const service = await startService(t, { config: config(), fetchImpl: async url => {
    if (new URL(url).pathname === '/user' && authFail) return json({ code: 404, data: "User don't exist" });
    if (new URL(url).hostname === 'openapi.zhihu.com') return defaultFetch(url);
    businessCalls++; return json({ Code: 30001 });
  } });
  const client = service.client(); const original = await client.bootstrap(); const token = client.jar.get('tongzhi_session');
  assert.match((await authorize(client)).callback.headers.get('location'), /auth=failed/);
  assert.equal(client.jar.get('tongzhi_session'), token); assert.equal((await client.bootstrap()).user.provider, 'guest');
  authFail = false; assert.match((await authorize(client)).callback.headers.get('location'), /auth=success/); await client.bootstrap();
  const limited = await client.request('/api/zhihu/import', { method: 'POST', body: { sources: ['contents'] } });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  const after = await client.bootstrap(); assert.equal(after.user.provider, 'zhihu'); assert.equal(after.zhihuConnected, true); assert.equal(after.user.id, original.user.id);
  service.zhihu.tokens.get(after.user.id).expiresAt = Date.now() - 1;
  const expired = await client.request('/api/zhihu/import', { method: 'POST', body: { sources: ['contents'] } });
  assert.equal(expired.status, 401); assert.equal(businessCalls, 1);
  assert.equal((await client.bootstrap()).user.provider, 'zhihu');
});

test('logging out during OAuth exchange prevents a late response from restoring the old session', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const service = await startService(t, { config: config(), fetchImpl: async url => {
    if (new URL(url).pathname === '/access_token') { entered(); await gate; }
    return defaultFetch(url);
  } });
  const client = service.client(); const before = await client.bootstrap();
  const start = await client.request('/api/auth/zhihu/start', { method: 'POST' });
  const callback = client.request(`/api/auth/zhihu/callback?code=code&state=${new URL(start.data.url).searchParams.get('state')}`);
  await started;
  assert.equal((await client.request('/api/logout', { method: 'POST' })).status, 200);
  release(); const response = await callback;
  assert.match(response.headers.get('location'), /auth=state_error/);
  assert.equal(service.store.user(before.user.id).provider, 'guest'); assert.equal(service.zhihu.token(before.user.id), null);
  assert.equal(client.jar.has('tongzhi_session'), false);
});

test('signing into an existing identity selects its own data and retires the previous guest listing', async t => {
  const service = await startService(t, { config: config(), fetchImpl: defaultFetch });
  const existing = service.client(), guest = service.client();
  const existingBoot = await existing.bootstrap(); await authorize(existing); await existing.bootstrap(); await existing.profile('已有账号');
  const guestBoot = await guest.bootstrap(); await guest.profile('临时画像');
  const result = await authorize(guest); assert.match(result.callback.headers.get('location'), /auth=success/);
  const connected = await guest.bootstrap();
  assert.equal(connected.user.id, existingBoot.user.id); assert.equal(connected.profile.input.name, '已有账号');
  assert.equal(service.store.profile(guestBoot.user.id).discoverable, false);
  assert.notEqual(connected.user.id, guestBoot.user.id);
});

test('HTTPS deployment issues secure cookies and disabled OAuth never calls remote APIs', async t => {
  let calls = 0;
  const service = await startService(t, { config: testConfig({ SOUL_PUBLIC_ORIGIN: 'https://example.invalid' }), fetchImpl: async () => { calls++; throw new Error(); } });
  const client = service.client();
  const boot = await client.request('/api/bootstrap'); assert.match(boot.headers.getSetCookie()[0], /Secure/);
  const start = await client.request('/api/auth/zhihu/start', { method: 'POST' });
  assert.equal(start.status, 503); assert.equal(start.data.error.code, 'oauth_unconfigured'); assert.equal(calls, 0);
});

test('public /auth/callback forwards the original query and preserves strict state and browser-cookie checks', async t => {
  let calls = 0;
  const settings = config(); settings.zhihu.oauth.redirectUri = 'https://app.invalid/auth/callback';
  const service = await startService(t, { config: settings, fetchImpl: async url => { calls++; return defaultFetch(url); } });
  const client = service.client(); await client.bootstrap();
  const started = await client.request('/api/auth/zhihu/start', { method: 'POST' });
  const state = new URL(started.data.url).searchParams.get('state');
  assert.equal(new URL(started.data.url).searchParams.get('redirect_uri'), 'https://app.invalid/auth/callback');
  const query = `?authorization_code=test%2Bcode&state=${state}&unused=keep%2Bencoding`;
  const bridge = await client.request(`/auth/callback${query}`, { headers: { cookie: `tongzhi_session=${client.jar.get('tongzhi_session')}` } });
  assert.equal(bridge.status, 302); assert.equal(bridge.headers.get('location'), `/api/auth/zhihu/callback${query}`);
  assert.equal(bridge.headers.get('cache-control'), 'no-store'); assert.equal(calls, 0);
  const completed = await client.request(bridge.headers.get('location'));
  assert.match(completed.headers.get('location'), /auth=success/); assert.equal(calls, 2);
  const missing = await client.request('/auth/callback?authorization_code=test&state=missing');
  const rejected = await client.request(missing.headers.get('location'));
  assert.match(rejected.headers.get('location'), /auth=state_error/); assert.equal(calls, 2);
});

test('verified migrated identities are selected by exact kind without merging equal raw values', async t => {
  const service = await startService(t), store = service.store;
  const hashUser = store.createUser('迁入的哈希身份'), uidUser = store.createUser('迁入的 UID 身份');
  store.db.prepare('INSERT INTO identities VALUES (?,?,?,?)').run('zhihu','hash:123456',hashUser.id,new Date().toISOString());
  store.db.prepare('INSERT INTO identities VALUES (?,?,?,?)').run('zhihu','uid:123456',uidUser.id,new Date().toISOString());
  const a=store.createUser(),b=store.createUser();
  assert.equal(store.oauthUser(a.id,{subjectKind:'hash',subject:'123456'}).id,hashUser.id);
  assert.equal(store.oauthUser(b.id,{subjectKind:'uid',subject:'123456'}).id,uidUser.id);
  assert.notEqual(hashUser.id,uidUser.id);
});
