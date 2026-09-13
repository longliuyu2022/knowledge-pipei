import test from 'node:test';
import assert from 'node:assert/strict';
import { testConfig, startService, json } from './helpers.js';
import { Zhihu } from '../server/zhihu.js';
import { checkZhihuData, zhihuCheckRetryAt, ZHIHU_CHECKS } from '../server/zhihu-validation.js';
import { hashAdminPassword } from '../server/admin.js';

const config = () => testConfig({
  ZHIHU_OAUTH_APP_ID: 'check-app', ZHIHU_OAUTH_APP_KEY: 'check-app-key',
  ZHIHU_OAUTH_REDIRECT_URI: 'https://app.invalid/auth/callback', ZHIHU_ACCESS_SECRET: 'check-secret',
});
const checkRequest = client => client.request('/api/zhihu/validation', { method: 'POST', body: { consent: true } });

function authorizeLocally(service, userId) {
  // A synthetic OAuth identity in the isolated store. No real authorization, credentials, or API calls.
  service.store.oauthUser(userId, { subject: `synthetic-${userId}`, name: '数据检查测试者', avatar: '' });
  service.zhihu.setToken(userId, `synthetic-oauth-${userId}`);
}

test('five OAuth data checks request one item each, preserve 64-bit favorite ID, and persist only check metadata', async t => {
  const calls = [];
  const service = await startService(t, { config: config(), fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), headers: options.headers });
    return new Response('{"Code":0,"Data":{"Items":[{"UrlToken":969570047710216201,"Title":"private-title-never-return","Summary":"private-body-never-return"}]}}');
  } });
  const client = service.client(), stranger = service.client();
  const boot = await client.bootstrap(); await stranger.bootstrap();
  await client.profile('仅自己的兴趣', false);
  const before = service.store.profile(boot.user.id);
  authorizeLocally(service, boot.user.id);
  const passive = await client.request('/api/zhihu/validation');
  assert.equal(passive.status, 200); assert.equal(passive.data.report, null); assert.equal(calls.length, 0);
  const response = await checkRequest(client);
  assert.equal(response.status, 200); assert.equal(response.data.report.status, 'passed');
  assert.equal(response.data.connected, true); assert.ok(response.data.retryAt);
  assert.deepEqual(calls.map(call => call.url.pathname), ZHIHU_CHECKS.map(item => item.path));
  for (const call of calls) {
    assert.equal(call.url.searchParams.get('Limit'), '1');
    assert.equal(call.headers.Authorization, 'Bearer check-secret');
    assert.equal(call.headers['X-OAuth-Token'], `synthetic-oauth-${boot.user.id}`);
    assert.match(call.headers['X-Request-Timestamp'], /^\d+$/);
  }
  assert.equal(calls[3].url.searchParams.get('FavlistUrlToken'), '969570047710216201');
  assert.equal(calls[4].url.searchParams.has('Offset'), false);
  assert.equal(response.data.report.items.every(row => row.status === 'success' && row.count === 1), true);
  const encoded = JSON.stringify(response.data);
  for (const forbidden of ['private-title', 'private-body', '969570047710216201', 'synthetic-oauth', 'check-secret', 'check-app-key', 'FavlistUrlToken']) assert.equal(encoded.includes(forbidden), false);
  assert.deepEqual(service.store.profile(boot.user.id), before);
  assert.equal(service.store.imports(boot.user.id).items.length, 0);
  assert.deepEqual(service.store.zhihuValidation(boot.user.id), response.data.report);
  assert.equal((await stranger.request(`/api/zhihu/validation?userId=${boot.user.id}`)).data.report, null);
  assert.deepEqual((await client.request('/api/account/export')).data.zhihuValidation, response.data.report);
  assert.equal((await client.bootstrap()).imports.checkedAt, response.data.report.checkedAt);
});

test('empty favorite list is a valid empty result and never triggers a fabricated favorite-content request', async t => {
  const calls = [];
  const service = await startService(t, { config: config(), fetchImpl: async url => { calls.push(new URL(url).pathname); return json({ Code: 0, Data: { Items: [] } }); } });
  const client = service.client(); const boot = await client.bootstrap(); authorizeLocally(service, boot.user.id);
  const response = await checkRequest(client);
  assert.equal(response.status, 200); assert.equal(response.data.report.status, 'passed');
  assert.equal(response.data.report.items.length, 5); assert.equal(calls.length, 4);
  assert.equal(calls.includes('/api/v1/user/favlist_contents'), false);
  assert.equal(response.data.report.items.every(row => row.status === 'empty' && row.count === 0), true);
  assert.equal(response.data.report.items[3].code, 'no_favorite_list');
});

test('data checking requires explicit consent, a valid OAuth user, CSRF and the current site origin', async t => {
  let calls = 0;
  const service = await startService(t, { config: config(), fetchImpl: async () => { calls++; return json({ Code: 0, Data: { Items: [] } }); } });
  const client = service.client(); const boot = await client.bootstrap();
  assert.equal((await checkRequest(client)).status, 401);
  authorizeLocally(service, boot.user.id);
  assert.equal((await client.request('/api/zhihu/validation', { method: 'POST' })).status, 400);
  assert.equal((await client.request('/api/zhihu/validation', { method: 'POST', body: { consent: true }, headers: { 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await client.request('/api/zhihu/validation', { method: 'POST', body: { consent: true }, headers: { origin: 'https://elsewhere.invalid' } })).status, 403);
  service.zhihu.forget(boot.user.id);
  assert.equal((await checkRequest(client)).status, 401); assert.equal(calls, 0);
});

test('authorization and quota failures stop remaining requests and never fall back to the owner identity', async () => {
  for (const [upstream, status, code, connected] of [[{ Code: 20001 }, 200, 'zhihu_expired', false], [{ Code: 30001 }, 200, 'zhihu_rate_limited', true], [{ Code: 30002 }, 200, 'zhihu_rate_limited', true], [{}, 401, 'zhihu_expired', false]]) {
    let calls = 0;
    const zhihu = new Zhihu(config(), { fetchImpl: async (_url, options) => {
      calls++; assert.equal(options.headers['X-OAuth-Token'], 'synthetic-oauth'); return json(upstream, status);
    } });
    zhihu.setToken('synthetic-user', 'synthetic-oauth');
    const report = await checkZhihuData(zhihu, 'synthetic-user');
    assert.equal(report.status, 'failed'); assert.equal(calls, 1);
    assert.equal(report.items[0].status, 'error'); assert.equal(report.items[0].code, code);
    assert.equal(report.items.slice(1).every(row => row.status === 'skipped' && row.count === null), true);
    assert.equal(Boolean(zhihu.token('synthetic-user')), connected);
    if (connected) assert.ok(zhihuCheckRetryAt(zhihu));
  }
});

test('upstream failures and invalid favorite IDs are recorded honestly while independent checks can finish', async () => {
  for (const invalid of [0, '-2', '9223372036854775808', 'not-a-token', 'https://evil.invalid']) {
    const paths = [];
    const zhihu = new Zhihu(config(), { fetchImpl: async url => { paths.push(new URL(url).pathname); return json({ Code: 0, Data: { Items: [{ UrlToken: invalid, Summary: 'unreturned' }] } }); } });
    zhihu.setToken('synthetic-user', 'synthetic-oauth');
    const report = await checkZhihuData(zhihu, 'synthetic-user');
    assert.equal(report.status, 'partial'); assert.equal(report.items[3].status, 'error');
    assert.equal(report.items[3].code, 'zhihu_response_invalid');
    assert.equal(paths.includes('/api/v1/user/favlist_contents'), false); assert.equal(paths.length, 4);
  }
  const zhihu = new Zhihu(config(), { fetchImpl: async url => new URL(url).pathname.endsWith('favlists') ? json({ Code: 90001, Message: 'internal secret must not escape' }) : json({ Code: 0, Data: { Items: [] } }) });
  zhihu.setToken('synthetic-user', 'synthetic-oauth');
  const report = await checkZhihuData(zhihu, 'synthetic-user');
  assert.equal(report.items[2].status, 'error'); assert.equal(report.items[3].status, 'skipped'); assert.equal(report.items[4].status, 'empty');
  assert.equal(JSON.stringify(report).includes('internal secret'), false);
});

test('a check waits for a free one-minute request budget without making extra calls or overwriting the last report', async t => {
  let calls = 0;
  const service = await startService(t, { config: config(), fetchImpl: async () => { calls++; return json({ Code: 0, Data: { Items: [] } }); } });
  const client = service.client(); const boot = await client.bootstrap(); authorizeLocally(service, boot.user.id);
  const first = await checkRequest(client); assert.equal(first.status, 200);
  const again = await checkRequest(client); assert.equal(again.status, 429); assert.equal(calls, 4);
  assert.deepEqual(service.store.zhihuValidation(boot.user.id), first.data.report);
  const passive = await client.request('/api/zhihu/validation'); assert.ok(Date.parse(passive.data.retryAt) > Date.now()); assert.equal(calls, 4);
});

test('concurrent checks do not double-read data and a revoked application session cannot save a late result', async t => {
  let entered, release, calls = 0;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const service = await startService(t, { config: config(), fetchImpl: async () => { calls++; entered(); await gate; return json({ Code: 0, Data: { Items: [] } }); } });
  const client = service.client(); const boot = await client.bootstrap(); authorizeLocally(service, boot.user.id);
  const pending = checkRequest(client); await started;
  const second = await checkRequest(client); assert.equal(second.status, 409); assert.equal(second.data.error.code, 'profile_busy');
  service.store.endSession(client.jar.get('soul_session'));
  release(); const response = await pending;
  assert.equal(response.status, 401); assert.equal(calls, 1); assert.equal(service.store.zhihuValidation(boot.user.id), null);
});

test('a stale OAuth business response does not clear a newly connected grant', async () => {
  for (const [replacement, code, status] of [['new-synthetic-oauth', 0, 200], ['old-synthetic-oauth', 0, 200], ['old-synthetic-oauth', 20001, 200], ['old-synthetic-oauth', 0, 401]]) {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const zhihu = new Zhihu(config(), { fetchImpl: async () => { entered(); await gate; return json({ Code: code, Data: { Items: [] } }, status); } });
    zhihu.setToken('synthetic-user', 'old-synthetic-oauth');
    const pending = checkZhihuData(zhihu, 'synthetic-user'); await started;
    zhihu.setToken('synthetic-user', replacement); release();
    await assert.rejects(pending, error => error.code === 'session_changed');
    assert.equal(zhihu.token('synthetic-user'), replacement);
  }
});

test('check metadata is visible through admin authentication, exportable by its owner, and cleared with imported data or account deletion', async t => {
  const settings = config(); settings.admin.passwordHash = await hashAdminPassword('synthetic-password-for-test'); settings.admin.configured = true;
  const service = await startService(t, { config: settings, fetchImpl: async () => json({ Code: 0, Data: { Items: [] } }) });
  const client = service.client(); const boot = await client.bootstrap(); authorizeLocally(service, boot.user.id);
  const checked = await checkRequest(client); assert.equal(checked.status, 200);
  assert.equal((await client.request(`/api/admin/users/${boot.user.id}`)).status, 401);
  const admin = service.client(); const session = await admin.request('/api/admin/session');
  const login = await admin.request('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'synthetic-password-for-test' }, headers: { 'x-csrf-token': session.data.csrf } });
  assert.equal(login.status, 200);
  const detail = await admin.request(`/api/admin/users/${boot.user.id}`); assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.zhihuValidation, checked.data.report);
  assert.equal((await client.request('/api/zhihu/import', { method: 'DELETE' })).status, 200);
  assert.equal(service.store.zhihuValidation(boot.user.id), null);
  service.store.saveZhihuValidation(boot.user.id, checked.data.report);
  service.store.deleteAccount(boot.user.id);
  assert.equal(service.store.zhihuValidation(boot.user.id), null);
});
