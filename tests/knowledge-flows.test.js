import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startService } from './helpers.js';

const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function setup(t, { model } = {}) {
  const calls = [];
  const ai = {
    enrichProfile: async profile => profile, clearCache() {}, semanticScores: async () => null,
    json: async (system, payload) => {
      calls.push({ system, payload });
      return model ? model(system, payload) : { text: '可以先区分事实、适用条件和待验证的假设，再设计一个小实验。', topicIds: ['ai'] };
    },
  };
  return { ...await startService(t, { ai, matchingOptions: { intervalMs: 3600000 } }), calls };
}
async function preferences(client, patch) {
  const current = await client.request('/api/preferences'); assert.equal(current.status, 200);
  const response = await client.request('/api/preferences', { method: 'PUT', body: { revision: current.data.revision, preferences: patch } });
  assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data;
}
async function circle(client) {
  const response = await client.request('/api/circles', { method: 'POST', body: { title: '知识建议权限验证', question: '如何验证本人发言到画像建议的授权？', goal: '明确权限与材料来源' } });
  assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data.circle;
}
async function circleMessage(client, id, text) {
  const response = await client.request(`/api/circles/${id}/messages`, { method: 'POST', body: { text, clientMessageId: randomUUID() } });
  assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data.message;
}
async function companionSession(client, mode = 'partner') {
  const response = await client.request('/api/companion/sessions', { method: 'POST', body: { mode, consent: true } });
  assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data.id;
}
async function modelStarted(entered, pending) {
  await Promise.race([entered.promise, pending.then(result => { throw new Error(`Expected a pending model request, received HTTP ${result.status}: ${JSON.stringify(result.data)}`); })]);
}

test('email registration binds the current identity, rotates real session/CSRF and login does not merge another guest', async t => {
  const service = await setup(t), owner = service.client(), other = service.client(), stale = service.client();
  const before = await owner.bootstrap(), oldToken = owner.jar.get('tongzhi_session'), oldCSRF = owner.csrf;
  const group = await circle(owner);
  stale.jar.set('tongzhi_session', oldToken); stale.csrf = oldCSRF;
  const registered = await owner.request('/api/auth/email/register', { method: 'POST', body: { name: '站内求知者', email: '  Owner@Example.org  ', password: 'test-password-123' } });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  assert.notEqual(owner.jar.get('tongzhi_session'), oldToken); assert.notEqual(owner.csrf, oldCSRF);
  assert.match(registered.headers.get('set-cookie'), /HttpOnly/i); assert.match(registered.headers.get('set-cookie'), /SameSite=Lax/i);
  assert.equal((await stale.request('/api/account')).status, 401);
  assert.equal((await owner.request('/api/preferences', { method: 'PUT', body: { revision: 0, preferences: { chatAnalysis: true } }, headers: { 'x-csrf-token': oldCSRF } })).status, 403);
  const account = await owner.request('/api/account'); assert.equal(account.data.email, 'owner@example.org'); assert.equal(account.data.emailVerified, false);
  assert.equal((await owner.bootstrap()).user.id, before.user.id); assert.equal((await owner.request(`/api/circles/${group.id}`)).data.circle.joined, true);
  const guest = await other.bootstrap(); await other.profile('另一个访客的画像', false);
  const wrong = await other.request('/api/auth/email/login', { method: 'POST', body: { email: 'owner@example.org', password: 'incorrect-password' } }); assert.equal(wrong.status, 401);
  const login = await other.request('/api/auth/email/login', { method: 'POST', body: { email: 'OWNER@example.org', password: 'test-password-123' } }); assert.equal(login.status, 200);
  assert.equal((await other.bootstrap()).user.id, before.user.id);
  assert.equal(service.store.profile(guest.user.id).input.name, '另一个访客的画像'); assert.equal(service.store.profile(before.user.id), null);
  assert.equal(JSON.stringify(account.data).includes('password'), false);
});

test('changing an email password revokes other devices and the old password', async t => {
  const service = await setup(t), owner = service.client(), device = service.client(), retry = service.client();
  await owner.bootstrap(); await device.bootstrap(); await retry.bootstrap();
  assert.equal((await owner.request('/api/auth/email/register', { method: 'POST', body: { name: '密码测试者', email: 'password@example.org', password: 'old-password-123' } })).status, 201);
  assert.equal((await device.request('/api/auth/email/login', { method: 'POST', body: { email: 'password@example.org', password: 'old-password-123' } })).status, 200);
  const changed = await owner.request('/api/auth/email/password', { method: 'POST', body: { currentPassword: 'old-password-123', newPassword: 'new-password-456' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.data)); assert.equal((await owner.request('/api/account')).status, 200);
  assert.equal((await device.request('/api/account')).status, 401);
  assert.equal((await retry.request('/api/auth/email/login', { method: 'POST', body: { email: 'password@example.org', password: 'old-password-123' } })).status, 401);
  assert.equal((await retry.request('/api/auth/email/login', { method: 'POST', body: { email: 'password@example.org', password: 'new-password-456' } })).status, 200);
});

test('knowledge suggestions require separate consent and only the selected owners material may update a profile', async t => {
  const service = await setup(t), owner = service.client(), peer = service.client(), outsider = service.client();
  await owner.bootstrap(); await peer.bootstrap(); await outsider.bootstrap();
  const profile = await owner.profile('本人材料作者', false), group = await circle(owner);
  assert.equal((await peer.request(`/api/circles/${group.id}/join`, { method: 'POST', body: {} })).status, 200);
  const own = await circleMessage(owner, group.id, '我在做人工智能检索实验。\n> PRIVATE_QUOTED_OTHER_TEXT\n我想验证检索召回条件。');
  const other = await circleMessage(peer, group.id, '这属于另一位参与者的发言。');
  const payload = { sourceType: 'circle', sourceId: group.id, messageIds: [own.id] };
  assert.equal((await owner.request('/api/knowledge/suggestions', { method: 'POST', body: payload })).status, 403);
  await preferences(owner, { chatAnalysis: true }); await preferences(peer, { chatAnalysis: true }); await preferences(outsider, { chatAnalysis: true });
  assert.equal((await owner.request('/api/knowledge/suggestions', { method: 'POST', body: { ...payload, messageIds: [other.id] } })).status, 403);
  assert.equal((await outsider.request('/api/knowledge/suggestions', { method: 'POST', body: payload })).status, 403);
  const unrelated = await circle(owner);
  assert.equal((await owner.request('/api/knowledge/suggestions', { method: 'POST', body: { ...payload, sourceId: unrelated.id } })).status, 403);
  const suggested = await owner.request('/api/knowledge/suggestions', { method: 'POST', body: payload });
  assert.equal(suggested.status, 201, JSON.stringify(suggested.data)); assert.equal(suggested.data.status, 'pending'); assert.equal(suggested.data.mode, 'rules');
  assert.equal(suggested.data.sourceText.includes('PRIVATE_QUOTED_OTHER_TEXT'), false);
  assert.equal((await owner.bootstrap()).profile.revision, profile.revision, 'generating a suggestion must not publish a profile');
  assert.deepEqual((await peer.request('/api/knowledge/suggestions')).data.items, []);
  assert.equal((await peer.request(`/api/knowledge/suggestions/${suggested.data.id}/accept`, { method: 'POST', body: { revision: 0 } })).status, 409);
  const accepted = await owner.request(`/api/knowledge/suggestions/${suggested.data.id}/accept`, { method: 'POST', body: { revision: profile.revision } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.profile.revision, profile.revision + 1); assert.equal(accepted.data.profile.discoverable, false);
  assert.equal(JSON.stringify(accepted.data.profile).includes('PRIVATE_QUOTED_OTHER_TEXT'), false);
  const report = await owner.request('/api/knowledge/report'); assert.equal(report.status, 200); assert.equal(report.data.report.revision, profile.revision + 1); assert.equal(report.data.history.length, 2);
});

test('revoking chat analysis deletes stored suggestions and prevents stale acceptance', async t => {
  const service = await setup(t), client = service.client(); await client.bootstrap(); const profile = await client.profile('撤回者', false);
  await preferences(client, { chatAnalysis: true }); const group = await circle(client), message = await circleMessage(client, group.id, '我想继续探索人工智能的知识检索方法。');
  const response = await client.request('/api/knowledge/suggestions', { method: 'POST', body: { sourceType: 'circle', sourceId: group.id, messageIds: [message.id] } }); assert.equal(response.status, 201);
  await preferences(client, { chatAnalysis: false });
  assert.deepEqual((await client.request('/api/knowledge/suggestions')).data, { items: [], enabled: false });
  assert.equal((await client.request(`/api/knowledge/suggestions/${response.data.id}/accept`, { method: 'POST', body: { revision: profile.revision } })).status, 403);
  const exported = await client.request('/api/account/export'); assert.deepEqual(exported.data.knowledge.suggestions, []);
});

test('hidden source messages invalidate stored suggestion text in both list and personal export', async t => {
  const service = await setup(t), client = service.client(); await client.bootstrap(); await preferences(client, { chatAnalysis: true });
  const group = await circle(client), marker = 'ERASE_HIDDEN_SUGGESTION_CONTEXT', message = await circleMessage(client, group.id, `我在研究人工智能 ${marker}`);
  const result = await client.request('/api/knowledge/suggestions', { method: 'POST', body: { sourceType: 'circle', sourceId: group.id, messageIds: [message.id] } }); assert.equal(result.status, 201);
  assert.equal((await client.request(`/api/circles/${group.id}/messages/${message.id}/hide`, { method: 'POST', body: {} })).status, 200);
  const listed = await client.request('/api/knowledge/suggestions'), exported = await client.request('/api/account/export');
  assert.equal(listed.status, 200); assert.equal(exported.status, 200);
  assert.equal(JSON.stringify(listed.data).includes(marker), false, 'a hidden source must not remain readable through a cached suggestion');
  assert.equal(JSON.stringify(exported.data.knowledge).includes(marker), false, 'personal export must apply the same source access checks');
});

test('in-flight suggestion generation cannot save after its explicit authorization is withdrawn', { timeout: 15000 }, async t => {
  const entered = defer(), release = defer(), service = await setup(t, { model: async () => { entered.resolve(); return release.promise; } });
  const client = service.client(), initial = await client.bootstrap(); await preferences(client, { chatAnalysis: true, aiAnalysis: true });
  const group = await circle(client), message = await circleMessage(client, group.id, '本人选中的人工智能实验记录。');
  const pending = client.request('/api/knowledge/suggestions', { method: 'POST', body: { sourceType: 'circle', sourceId: group.id, messageIds: [message.id] } });
  await modelStarted(entered, pending); await preferences(client, { chatAnalysis: false });
  release.resolve({ text: '这段材料可能说明你愿意继续探索人工智能。', topicIds: ['ai'] });
  const result = await pending; assert.ok([403, 409].includes(result.status), JSON.stringify(result.data));
  assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM profile_suggestions WHERE user_id=?').get(initial.user.id).n, 0);
});

test('conversation evidence enforces both current participation and authorship', async t => {
  const service = await setup(t), owner = service.client(), peer = service.client(), outsider = service.client();
  const a = await owner.bootstrap(), b = await peer.bootstrap(); await outsider.bootstrap();
  await owner.profile('私聊甲', false); await peer.profile('私聊乙', false);
  service.matching.start(a.user.id, { revision: 1 }); const proposal = service.matching.start(b.user.id, { revision: 1 }).proposal;
  service.matching.respond(a.user.id, proposal.id, 'accept'); const conversationId = service.matching.respond(b.user.id, proposal.id, 'accept').conversationId;
  const own = service.store.sendMessage(a.user.id, conversationId, '我想研究人工智能的解释方法。', randomUUID()).message;
  const other = service.store.sendMessage(b.user.id, conversationId, '这是另一方独立的观点。', randomUUID()).message;
  await preferences(owner, { chatAnalysis: true }); await preferences(outsider, { chatAnalysis: true });
  const body = { sourceType: 'conversation', sourceId: conversationId, messageIds: [own.id] };
  assert.equal((await outsider.request('/api/knowledge/suggestions', { method: 'POST', body })).status, 404);
  assert.equal((await owner.request('/api/knowledge/suggestions', { method: 'POST', body: { ...body, messageIds: [other.id] } })).status, 403);
  assert.equal((await owner.request('/api/knowledge/suggestions', { method: 'POST', body })).status, 201);
  service.store.block(a.user.id, b.user.id);
  assert.equal((await owner.request('/api/knowledge/suggestions', { method: 'POST', body })).status, 404);
});

test('AI companion sessions require explicit consent, isolate users and persist exactly one exchange per retry key', async t => {
  const service = await setup(t), owner = service.client(), peer = service.client(); const a = await owner.bootstrap(); await peer.bootstrap();
  const profile = await owner.profile('知识伙伴测试者', false);
  service.store.saveImports(a.user.id, [{ title: 'PRIVATE_IMPORTED_TITLE', summary: 'PRIVATE_IMPORTED_SUMMARY', url: 'https://example.org/private' }]);
  assert.equal((await owner.request('/api/companion/sessions', { method: 'POST', body: { mode: 'partner' } })).status, 400);
  const sessionId = await companionSession(owner);
  assert.equal((await peer.request(`/api/companion/sessions/${sessionId}`)).status, 404);
  assert.equal((await peer.request(`/api/companion/sessions/${sessionId}`, { method: 'DELETE', body: {} })).status, 404);
  const body = { text: '如何设计一个能区分两种解释的小实验？', clientMessageId: randomUUID(), consent: true };
  assert.equal((await peer.request(`/api/companion/sessions/${sessionId}/messages`, { method: 'POST', body })).status, 404);
  assert.equal((await owner.request(`/api/companion/sessions/${sessionId}/messages`, { method: 'POST', body: { ...body, consent: false } })).status, 400);
  const sent = await owner.request(`/api/companion/sessions/${sessionId}/messages`, { method: 'POST', body });
  assert.equal(sent.status, 201, JSON.stringify(sent.data)); assert.deepEqual(sent.data.messages.map(m => m.role), ['user', 'assistant']); assert.equal(sent.data.mode, 'model');
  const retry = await owner.request(`/api/companion/sessions/${sessionId}/messages`, { method: 'POST', body });
  assert.equal(retry.status, 200); assert.deepEqual(retry.data.messages.map(m => m.id), sent.data.messages.map(m => m.id)); assert.equal(service.calls.length, 1);
  assert.equal((await owner.request(`/api/companion/sessions/${sessionId}/messages`, { method: 'POST', body: { ...body, text: '同一凭据不能写成另一条消息。' } })).status, 409);
  assert.equal(JSON.stringify(service.calls).includes('PRIVATE_IMPORTED_'), false);
  assert.equal((await owner.bootstrap()).profile.revision, profile.revision, 'AI discussion is separate from profile publication');
});

test('companion material suggestions reject assistant text and another users session', async t => {
  const service = await setup(t), owner = service.client(), peer = service.client(); await owner.bootstrap(); await peer.bootstrap();
  await preferences(owner, { chatAnalysis: true }); await preferences(peer, { chatAnalysis: true });
  const sessionId = await companionSession(owner, 'self');
  const response = await owner.request(`/api/companion/sessions/${sessionId}/messages`, { method: 'POST', body: { text: '我对人工智能检索有实际实验兴趣。', clientMessageId: randomUUID(), consent: true } }); assert.equal(response.status, 201);
  const own = response.data.messages.find(m => m.role === 'user'), assistant = response.data.messages.find(m => m.role === 'assistant');
  const body = { sourceType: 'companion', sourceId: sessionId, messageIds: [own.id] };
  assert.equal((await peer.request('/api/knowledge/suggestions', { method: 'POST', body })).status, 404);
  assert.equal((await owner.request('/api/knowledge/suggestions', { method: 'POST', body: { ...body, messageIds: [assistant.id] } })).status, 403);
  assert.equal((await owner.request('/api/knowledge/suggestions', { method: 'POST', body })).status, 201);
  assert.equal((await owner.request(`/api/companion/sessions/${sessionId}`, { method: 'DELETE', body: {} })).status, 200);
  assert.deepEqual((await owner.request('/api/knowledge/suggestions')).data.items, []);
});

for (const revoke of ['preferences', 'delete', 'logout', 'profile']) test(`pending AI companion output is discarded after ${revoke} changes`, { timeout: 15000 }, async t => {
  const entered = defer(), release = defer(), service = await setup(t, { model: async () => { entered.resolve(); return release.promise; } });
  const client = service.client(); await client.bootstrap(); await client.profile('等待回答的本人', false);
  const sessionId = await companionSession(client);
  const pending = client.request(`/api/companion/sessions/${sessionId}/messages`, { method: 'POST', body: { text: '请帮助我明确一个可检验的知识问题。', clientMessageId: randomUUID(), consent: true } });
  await modelStarted(entered, pending);
  if (revoke === 'preferences') await preferences(client, { aiAnalysis: false });
  if (revoke === 'delete') assert.equal((await client.request(`/api/companion/sessions/${sessionId}`, { method: 'DELETE', body: {} })).status, 200);
  if (revoke === 'logout') assert.equal((await client.request('/api/logout', { method: 'POST', body: {} })).status, 200);
  if (revoke === 'profile') await client.profile('已经改变的知识目标', false, { question: '更新后的具体知识问题是什么？' });
  release.resolve({ text: '这个旧输入产生的回答不能在新授权下保存。' });
  const response = await pending; assert.equal(response.status, revoke === 'delete' ? 404 : revoke === 'logout' ? 401 : 409, JSON.stringify(response.data));
  assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM companion_messages WHERE session_id=?').get(sessionId).n, 0);
  if (revoke === 'preferences') {
    assert.equal((await client.request(`/api/companion/sessions/${sessionId}/messages`, { method: 'POST', body: { text: '旧会话必须重新授权。', clientMessageId: randomUUID(), consent: true } })).status, 409);
    assert.ok(await companionSession(client));
  }
});
