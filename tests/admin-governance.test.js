import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hashAdminPassword } from '../server/admin.js';
import { startService, testConfig } from './helpers.js';

// Only isolated test credentials; every service uses the full app and a fresh in-memory KnowledgeStore.
const ADMIN_PASSWORD = 'governance-local-fixture-admin-2026';
const ADMIN_HASH = await hashAdminPassword(ADMIN_PASSWORD);
const EMAIL_PASSWORD = 'governance-local-email-fixture-2026';
const post = (client, path, body, headers) => client.request(path, { method: 'POST', body, ...(headers ? { headers } : {}) });
function accepted(response, status = 200) {
  assert.equal(response.status, status, response.data?.error?.message || `expected HTTP ${status}`);
  return response.data;
}
async function fixture(t) {
  const service = await startService(t, { config: testConfig({ SOUL_ADMIN_USERNAME: 'governance', SOUL_ADMIN_PASSWORD_HASH: ADMIN_HASH }), matchingOptions: { intervalMs: 3600000 } });
  const admin = service.client();
  accepted(await admin.request('/api/admin/session'));
  const login = accepted(await post(admin, '/api/admin/login', { username: 'governance', password: ADMIN_PASSWORD }));
  assert.equal(login.authenticated, true); assert.ok(admin.jar.get('tongzhi_admin')); assert.ok(admin.csrf);
  assert.equal(admin.jar.has('tongzhi_session'), false, 'admin login must not create a visitor session');
  assert.equal(service.config.ai.configured, false); assert.equal(service.config.zhihu.oauthConfigured, false);
  return { ...service, admin };
}
async function register(client, email, name = '治理测试用户') {
  const before = await client.bootstrap();
  accepted(await post(client, '/api/auth/email/register', { email, name, password: EMAIL_PASSWORD }), 201);
  const after = await client.bootstrap(); assert.equal(after.user.id, before.user.id);
  return after;
}
function audit(store, action, target) {
  return store.db.prepare('SELECT actor,action,target,detail FROM audit_events WHERE action=? AND target=? ORDER BY rowid').all(action, target);
}
async function connect(service, suffix = '') {
  const owner = service.client(), peer = service.client();
  const own = await owner.bootstrap(), other = await peer.bootstrap();
  const aProfile = await owner.profile(`治理发言者${suffix}`, false), bProfile = await peer.profile(`治理参与者${suffix}`, false);
  accepted(await post(owner, '/api/matching/start', { revision: aProfile.revision, mode: 'resonance', question: '如何结合上下文核对知识讨论？' }));
  const match = accepted(await post(peer, '/api/matching/start', { revision: bProfile.revision, mode: 'resonance', question: '如何结合上下文核对知识讨论？' }));
  assert.ok(match.proposal?.id);
  accepted(await post(owner, '/api/matching/respond', { proposalId: match.proposal.id, decision: 'accept' }));
  const result = accepted(await post(peer, '/api/matching/respond', { proposalId: match.proposal.id, decision: 'accept' }));
  assert.ok(result.conversationId);
  return { owner, peer, own, other, conversationId: result.conversationId };
}
async function send(client, conversationId, text) {
  return accepted(await post(client, `/api/conversations/${conversationId}/messages`, { text, clientMessageId: randomUUID() }), 201);
}
async function report(pair, text = `PRIVATE_REPORTED_MESSAGE_${randomUUID()} 知识讨论中的测试发言。`) {
  const message = await send(pair.owner, pair.conversationId, text);
  accepted(await post(pair.peer, '/api/reports', { scope: 'conversation', scopeId: pair.conversationId, messageId: message.id, reason: '请结合这一条实际发言的上下文复核。' }), 201);
  const cases = accepted(await pair.owner.request('/api/safety')).cases;
  const row = cases.find(item => !pair.caseIds?.has(item.id)); assert.ok(row);
  (pair.caseIds ||= new Set()).add(row.id);
  return { caseId: row.id, message, text };
}
async function group(client) {
  return accepted(await post(client, '/api/circles', { title: '治理依赖检查', question: '如何让隐藏后的内容不再通过引用和导出出现？', goal: '核对原发言、派生材料和个人导出的权限', aiConsent: false }), 201).circle;
}

test('full admin overview and email search include registered and Zhihu-bound email identities without exposing credentials', async t => {
  const service = await fixture(t), { admin, store } = service;
  const emailUser = service.client(), boundUser = service.client(), guest = service.client();
  const first = await register(emailUser, 'Native.Reader@Example.org', '邮箱原生用户');
  const bound = await boundUser.bootstrap();
  // Model a previously authorized Zhihu identity locally; this test never contacts OAuth.
  store.oauthUser(bound.user.id, { subject: `governance-fixture:${bound.user.id}`, name: '不公开的外部显示名', avatar: '' });
  const second = await register(boundUser, 'Bound.Reader@Example.org', '绑定邮箱的站内昵称');
  await guest.bootstrap();
  assert.equal(second.user.provider, 'zhihu');
  const overview = accepted(await admin.request('/api/admin/overview'));
  assert.equal(overview.counts.totalUsers, 3); assert.equal(overview.counts.emailUsers, 2);
  assert.equal(overview.counts.zhihuUsers, 1); assert.equal(overview.counts.guestUsers, 1);
  assert.equal(overview.registrations.reduce((total, day) => total + day.email, 0), 1);
  assert.equal(overview.registrations.reduce((total, day) => total + day.zhihu, 0), 1);
  const emailFilter = accepted(await admin.request('/api/admin/users?provider=email'));
  assert.deepEqual(new Set(emailFilter.items.map(item => item.id)), new Set([first.user.id, second.user.id]));
  for (const [email, id] of [['native.reader@example.org', first.user.id], ['BOUND.READER@example.org', second.user.id]]) {
    const found = accepted(await admin.request(`/api/admin/users?provider=email&q=${encodeURIComponent(email)}`));
    assert.equal(found.total, 1); assert.equal(found.items[0].id, id); assert.equal(found.items[0].hasEmail, true);
    assert.match(found.items[0].emailMasked, /^[nb]\*\*\*@example\.org$/);
    const detail = accepted(await admin.request(`/api/admin/users/${id}`));
    const serialized = JSON.stringify({ found, detail });
    assert.equal(serialized.toLowerCase().includes(email.toLowerCase()), false, 'search may use email, list/detail only display a mask');
    assert.equal(serialized.includes(EMAIL_PASSWORD), false); assert.equal(serialized.includes('password_hash'), false);
    assert.equal(serialized.includes('不公开的外部显示名'), false);
  }
  assert.equal(accepted(await admin.request('/api/admin/users?provider=email&q=%25')).total, 0, 'search wildcard is treated literally');
  assert.equal((await guest.request('/api/admin/overview')).status, 401);
});

test('admin disable is authorized and idempotent, revokes all user devices, and explicit restore requires a fresh login', async t => {
  const service = await fixture(t), { admin, store } = service;
  const owner = service.client(), device = service.client(), disabledLogin = service.client();
  const account = await register(owner, 'disable-fixture@example.org');
  const profile = await owner.profile('停用恢复测试', true);
  accepted(await post(owner, '/api/matching/start', { revision: profile.revision, mode: 'resonance' }));
  await device.bootstrap(); accepted(await post(device, '/api/auth/email/login', { email: 'disable-fixture@example.org', password: EMAIL_PASSWORD }));
  const id = account.user.id, body = { status: 'disabled', reason: '隔离测试：管理员核对后暂时停用。' };
  assert.equal((await post(owner, `/api/admin/users/${id}/status`, body)).status, 401);
  assert.equal((await post(admin, `/api/admin/users/${id}/status`, body, { 'x-csrf-token': '' })).status, 403);
  assert.equal(accepted(await owner.request('/api/account')).email, 'disable-fixture@example.org');
  accepted(await post(admin, `/api/admin/users/${id}/status`, body));
  assert.equal(store.isActive(id), false); assert.equal(store.profile(id).discoverable, false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(id).n, 0);
  assert.ok(!['searching', 'proposed'].includes(store.db.prepare('SELECT status FROM match_requests WHERE user_id=?').get(id).status));
  for (const client of [owner, device]) assert.equal((await client.request('/api/account')).status, 401);
  assert.equal(accepted(await admin.request('/api/admin/overview')).counts.disabledUsers, 1);
  accepted(await post(admin, `/api/admin/users/${id}/status`, body));
  assert.equal(audit(store, 'account:disabled', id).length, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sanctions WHERE user_id=? AND kind='ban' AND revoked_at IS NULL").get(id).n, 1);
  await disabledLogin.bootstrap();
  assert.equal((await post(disabledLogin, '/api/auth/email/login', { email: 'disable-fixture@example.org', password: EMAIL_PASSWORD })).status, 401);
  accepted(await post(admin, `/api/admin/users/${id}/status`, { status: 'active', reason: '管理员复核后恢复账号。' }));
  assert.equal(store.isActive(id), true); assert.equal(audit(store, 'account:active', id).length, 1);
  for (const client of [owner, device]) assert.equal((await client.request('/api/account')).status, 401, 'restore must not resurrect revoked cookies');
  accepted(await post(disabledLogin, '/api/auth/email/login', { email: 'disable-fixture@example.org', password: EMAIL_PASSWORD }));
  assert.equal((await disabledLogin.bootstrap()).user.id, id);
  assert.equal((await disabledLogin.bootstrap()).profile.discoverable, false, 'restore does not publish the profile');
  assert.deepEqual(accepted(await disabledLogin.request('/api/safety')).sanctions, []);
});

test('moderation queues omit private text, opening requires a reason and CSRF audit, and repeated review cannot escalate a resolved case', async t => {
  const service = await fixture(t), { admin, store } = service;
  const pair = await connect(service, '案件'), unrelated = await connect(service, '其他对话');
  const unrelatedText = `UNRELATED_PRIVATE_MESSAGE_${randomUUID()}`;
  await send(unrelated.owner, unrelated.conversationId, unrelatedText);
  for (let i = 0; i < 4; i++) await send(pair.peer, pair.conversationId, `这段对话中第 ${i + 1} 条用于复核的背景材料。`);
  const item = await report(pair);
  const listed = accepted(await admin.request('/api/admin/moderation'));
  assert.equal(listed.items.length, 1); assert.equal(listed.items[0].id, item.caseId);
  assert.equal(Object.hasOwn(listed.items[0], 'text'), false); assert.equal(Object.hasOwn(listed.items[0], 'context'), false);
  for (const path of ['/api/admin/moderation', '/api/admin/overview', `/api/admin/users/${pair.own.user.id}`]) {
    const serialized = JSON.stringify(accepted(await admin.request(path)));
    assert.equal(serialized.includes(item.text), false); assert.equal(serialized.includes(unrelatedText), false);
  }
  const endpoint = `/api/admin/moderation/${item.caseId}/open`, reason = '需要结合被举报发言的局部上下文复核。';
  assert.equal((await post(pair.owner, endpoint, { reason })).status, 401);
  assert.equal((await post(admin, endpoint, {})).status, 400);
  assert.equal((await post(admin, endpoint, { reason }, { 'x-csrf-token': 'invalid-csrf' })).status, 403);
  assert.equal(audit(store, 'moderation:read', item.caseId).length, 0);
  const opened = accepted(await post(admin, endpoint, { reason }));
  assert.equal(opened.case.text, item.text); assert.equal(opened.case.scopeId, pair.conversationId);
  assert.ok(opened.context.length > 0 && opened.context.length <= 4); assert.ok(opened.context.every(row => row.text.length <= 700));
  assert.equal(JSON.stringify(opened).includes(unrelatedText), false);
  const reads = audit(store, 'moderation:read', item.caseId); assert.equal(reads.length, 1); assert.equal(reads[0].actor, 'governance'); assert.equal(JSON.parse(reads[0].detail).reason, reason);
  const review = `/api/admin/moderation/${item.caseId}/review`;
  assert.equal((await post(admin, review, { action: 'warn' }, { 'x-csrf-token': '' })).status, 403);
  accepted(await post(admin, review, { action: 'warn' }));
  const replay = await post(admin, review, { action: 'mute' }); assert.equal(replay.status, 409); assert.equal(replay.data.error.code, 'case_resolved');
  assert.equal(audit(store, 'moderation:warn', item.caseId).length, 1); assert.equal(audit(store, 'moderation:mute', item.caseId).length, 0);
  assert.deepEqual(accepted(await pair.owner.request('/api/safety')).sanctions, []);
  assert.equal(accepted(await admin.request('/api/admin/moderation')).items.length, 0);
});

test('a muted user can read and appeal only their cases; new private/group messages stay blocked until explicit admin restoration', async t => {
  const service = await fixture(t), { admin } = service, pair = await connect(service, '申诉');
  const circle = await group(pair.owner), item = await report(pair);
  accepted(await post(admin, `/api/admin/moderation/${item.caseId}/review`, { action: 'mute' }));
  const safety = accepted(await pair.owner.request('/api/safety')); assert.equal(safety.sanctions.length, 1); assert.equal(safety.sanctions[0].kind, 'mute');
  assert.ok(new Date(safety.sanctions[0].expiresAt).getTime() > Date.now());
  for (const path of [`/api/conversations/${pair.conversationId}/messages`, `/api/circles/${circle.id}/messages`]) {
    const rejected = await post(pair.owner, path, { text: '受限期间不应写入的新消息。', clientMessageId: randomUUID() });
    assert.equal(rejected.status, 403); assert.equal(rejected.data.error.code, 'communication_restricted');
  }
  const appealPath = `/api/safety/${item.caseId}/appeal`, explanation = '请结合正常知识讨论的完整上下文重新核对本案。';
  assert.equal((await post(pair.peer, appealPath, { text: '不能修改其他人的申诉说明。' })).status, 404);
  assert.equal((await post(pair.owner, appealPath, { text: '短' })).status, 400);
  accepted(await post(pair.owner, appealPath, { text: explanation }));
  const updated = accepted(await pair.owner.request('/api/safety')); assert.equal(updated.cases[0].appeal, explanation); assert.equal(updated.cases[0].status, 'pending'); assert.equal(updated.sanctions.length, 1);
  accepted(await post(admin, `/api/admin/users/${pair.own.user.id}/status`, { status: 'active', reason: '明确恢复当前账号的交流限制。' }));
  assert.deepEqual(accepted(await pair.owner.request('/api/safety')).sanctions, []);
  await send(pair.owner, pair.conversationId, '管理员恢复后，可以继续正常知识交流。');
});

test('approving one appeal revokes only that case sanction and preserves restrictions from other unresolved cases', async t => {
  const service = await fixture(t), { admin } = service, pair = await connect(service, '多案件');
  const first = await report(pair, 'MULTI_CASE_ONE 此条需要独立复核。');
  const second = await report(pair, 'MULTI_CASE_TWO 另一条需要独立复核。');
  for (const item of [first, second]) accepted(await post(admin, `/api/admin/moderation/${item.caseId}/review`, { action: 'mute' }));
  assert.equal(accepted(await pair.owner.request('/api/safety')).sanctions.length, 2);
  accepted(await post(pair.owner, `/api/safety/${first.caseId}/appeal`, { text: '仅申诉第一条发言，请单独核对这条内容。' }));
  accepted(await post(admin, `/api/admin/moderation/${first.caseId}/review`, { action: 'allow' }));
  assert.equal(accepted(await pair.owner.request('/api/safety')).sanctions.length, 1, 'allowing the first case must not clear an unrelated sanction');
  const stillMuted = await post(pair.owner, `/api/conversations/${pair.conversationId}/messages`, { text: '另一个案件仍受限时应阻止发送。', clientMessageId: randomUUID() });
  assert.equal(stillMuted.status, 403); assert.equal(stillMuted.data.error.code, 'communication_restricted');
  accepted(await post(pair.owner, `/api/safety/${second.caseId}/appeal`, { text: '第二条也已补充语境，请按本案进行复核。' }));
  accepted(await post(admin, `/api/admin/moderation/${second.caseId}/review`, { action: 'dismiss' }));
  assert.deepEqual(accepted(await pair.owner.request('/api/safety')).sanctions, []);
  await send(pair.owner, pair.conversationId, '所有案件完成复核后恢复正常交流。');
});

test('admin hiding a circle report removes its dependent outcomes, versions and source-based knowledge from readable exports', async t => {
  const service = await fixture(t), { admin, store } = service;
  const host = service.client(), author = service.client(); await host.bootstrap(); await author.bootstrap();
  const circle = await group(host); accepted(await post(author, `/api/circles/${circle.id}/join`, {}));
  const marker = `CIRCLE_PRIVATE_DEPENDENCY_${randomUUID()}`;
  const message = accepted(await post(author, `/api/circles/${circle.id}/messages`, { text: `${marker} 我正在验证人工智能和阅读材料之间的证据关系。`, clientMessageId: randomUUID() }), 201).message;
  const generated = accepted(await post(host, `/api/circles/${circle.id}/ai`, { action: 'outcome', useAI: false })); assert.equal(generated.mode, 'rules');
  const manual = accepted(await post(host, `/api/circles/${circle.id}/outcomes`, { title: '引用原发言的人工核对记录', content: `${marker} 这份成果依据上面的实际发言。`, messageIds: [message.id] }), 201).outcome;
  const reviewed = accepted(await host.request(`/api/circles/${circle.id}/outcomes/${generated.outcome.id}`, { method: 'PATCH', body: { version: generated.outcome.version, status: 'reviewed' } })).outcome;
  const earlierExport = await host.request(`/api/circles/${circle.id}/outcomes/${reviewed.id}/export`); assert.equal(earlierExport.status, 200); assert.ok(earlierExport.data.includes(marker));
  const prefs = accepted(await author.request('/api/preferences'));
  accepted(await author.request('/api/preferences', { method: 'PUT', body: { revision: prefs.revision, preferences: { chatAnalysis: true } } }));
  accepted(await post(author, '/api/knowledge/suggestions', { sourceType: 'circle', sourceId: circle.id, messageIds: [message.id] }), 201);
  assert.ok(JSON.stringify(accepted(await author.request('/api/account/export'))).includes(marker));
  const reportId = accepted(await post(host, `/api/circles/${circle.id}/reports`, { messageId: message.id, reason: '请管理员核对本条测试发言及其派生材料。' }), 201).reportId;
  assert.equal((await host.request('/api/admin/circle-reports')).status, 401);
  const rows = accepted(await admin.request('/api/admin/circle-reports')).items; assert.equal(rows.length, 1); assert.equal(rows[0].id, reportId); assert.ok(audit(store, 'circle_reports:read', 'pending').length > 0);
  const endpoint = `/api/admin/circle-reports/${reportId}/resolve`;
  assert.equal((await post(admin, endpoint, { action: 'hide' }, { 'x-csrf-token': '' })).status, 403);
  accepted(await post(admin, endpoint, { action: 'hide' }));
  assert.equal((await post(admin, endpoint, { action: 'hide' })).status, 409); assert.equal(audit(store, 'circle_report:hide', reportId).length, 1);
  for (const client of [host, author]) {
    const detail = accepted(await client.request(`/api/circles/${circle.id}`)).circle;
    assert.equal(detail.messages.find(item => item.id === message.id).hidden, true);
    assert.equal(detail.messages.find(item => item.id === generated.message.id).redacted, true);
    assert.equal(JSON.stringify(detail).includes(marker), false);
    for (const outcomeId of [reviewed.id, manual.id]) {
      assert.equal(detail.outcomes.find(item => item.id === outcomeId).redacted, true);
      const exported = await client.request(`/api/circles/${circle.id}/outcomes/${outcomeId}/export`);
      assert.equal(exported.status, 409); assert.equal(exported.data.error.code, 'outcome_redacted');
      const versions = accepted(await client.request(`/api/circles/${circle.id}/outcomes/${outcomeId}/versions`)).versions;
      assert.ok(versions.length > 0 && versions.every(item => item.redacted)); assert.equal(JSON.stringify(versions).includes(marker), false);
    }
    const personal = accepted(await client.request('/api/account/export'));
    assert.equal(JSON.stringify(personal.circles).includes(marker), false); assert.equal(JSON.stringify(personal.knowledge).includes(marker), false);
  }
  assert.equal(accepted(await author.request('/api/knowledge/suggestions')).items.length, 0);
});
