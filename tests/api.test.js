import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hashToken } from '../server/store.js';
import { DEFAULT_INPUT } from '../shared/catalog.js';
import { startService } from './helpers.js';

test('anonymous sessions isolate private profiles, saves and exports; cookies store opaque identifiers', async t => {
  const service = await startService(t), a = service.client(), b = service.client();
  assert.equal((await a.request('/api/matches')).status, 401);
  const first = await a.bootstrap(), second = await b.bootstrap();
  assert.notEqual(first.user.id, second.user.id);
  assert.notEqual(first.csrf, second.csrf);
  assert.equal(first.profile, null);
  const token = a.jar.get('soul_session');
  const row = service.store.db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(first.user.id);
  assert.equal(row.token_hash, hashToken(token)); assert.notEqual(row.token_hash, token);
  const fresh = service.client();
  const bootstrap = await fresh.request('/api/bootstrap');
  assert.match(bootstrap.headers.getSetCookie()[0], /HttpOnly/);
  assert.match(bootstrap.headers.getSetCookie()[0], /SameSite=Lax/);
  await a.profile('独立昵称', false);
  assert.equal((await b.bootstrap()).profile, null);
  assert.equal((await b.request(`/api/people/${first.user.id}`)).status, 404);
  await a.request('/api/saved/demo-yu', { method: 'PUT', body: { saved: true } });
  assert.deepEqual((await b.bootstrap()).savedIds, []);
  const mine = await a.request(`/api/account/export?userId=${second.user.id}`);
  assert.equal(mine.data.user.id, first.user.id);
  assert.equal(mine.data.profile.input.name, '独立昵称');
  assert.equal((await b.request('/api/account/export')).data.profile, null);
  assert.equal(mine.headers.get('cache-control'), 'no-store');
  assert.match(mine.headers.get('content-disposition'), /attachment/);
});

test('origin, fetch-site and CSRF checks reject forged requests and malformed Unicode tokens without server errors', async t => {
  const service = await startService(t), client = service.client();
  assert.equal((await client.request('/api/bootstrap', { headers: { origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await client.request('/api/bootstrap', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const bootstrap = await client.bootstrap();
  const body = { input: DEFAULT_INPUT, revision: 0, useAI: false };
  for (const token of ['', 'incorrect', 'é'.repeat(bootstrap.csrf.length)]) {
    const response = await client.request('/api/profile', { method: 'POST', body, headers: { 'x-csrf-token': token } });
    assert.equal(response.status, 403); assert.equal(response.data.error.code, 'csrf_mismatch');
  }
  assert.equal((await client.request('/api/profile', { method: 'POST', body, headers: { origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await client.bootstrap()).profile, null);
});

test('invalid JSON, missing bodies and invalid profile fields return controlled validation errors', async t => {
  const { client: createClient } = await startService(t);
  const malformed = [
    { raw: '{broken' }, { body: [] }, {},
    { body: { input: { ...DEFAULT_INPUT, topicIds: ['ai', 'ai', 'reading'] }, revision: 0 } },
    { body: { input: { ...DEFAULT_INPUT, topicIds: ['ai', 'reading', 'unknown'] }, revision: 0 } },
    { body: { input: { ...DEFAULT_INPUT, goals: ['conversation', 'conversation'] }, revision: 0 } },
    { body: { input: { ...DEFAULT_INPUT, styleId: 'other' }, revision: 0 } },
    { body: { input: { ...DEFAULT_INPUT, name: ' ' }, revision: 0 } },
    { body: { input: { ...DEFAULT_INPUT, about: 'a'.repeat(361) }, revision: 0 } },
    { body: { input: DEFAULT_INPUT, revision: '0' } },
    { body: { input: DEFAULT_INPUT, revision: 0, useAI: 'false' } },
  ];
  for (const request of malformed) {
    const client = createClient(); await client.bootstrap();
    const response = await client.request('/api/profile', { method: 'POST', ...request });
    assert.equal(response.status, 400, JSON.stringify(response.data));
    assert.equal((await client.bootstrap()).profile, null);
  }
});

test('profile revisions require fresh publication consent and cancel pending invitations after rebuilding', async t => {
  const { client: makeClient, store } = await startService(t), a = makeClient(), b = makeClient();
  const aBoot = await a.bootstrap(), bBoot = await b.bootstrap();
  const draft = await a.profile('甲', false);
  assert.equal(draft.revision, 1); assert.equal(draft.discoverable, false);
  assert.deepEqual((await b.request('/api/matches?pool=people')).data.matches, []);
  assert.equal((await a.request('/api/profile/visibility', { method: 'POST', body: { discoverable: true } })).status, 409);
  assert.equal((await a.request('/api/profile/visibility', { method: 'POST', body: { discoverable: true, revision: 1 } })).status, 200);
  await b.profile('乙');
  const invited = await a.request('/api/invitations', { method: 'POST', body: { targetId: bBoot.user.id, message: '一起聊聊读过的书吧' } });
  assert.equal(invited.status, 201);
  const stale = await a.request('/api/profile', { method: 'POST', body: { input: DEFAULT_INPUT, revision: 0, useAI: false } });
  assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'profile_changed');
  const rebuilt = await a.request('/api/profile', { method: 'POST', body: { input: { ...DEFAULT_INPUT, name: '新甲' }, revision: 1, useAI: false } });
  assert.equal(rebuilt.status, 200); assert.equal(rebuilt.data.profile.revision, 2); assert.equal(rebuilt.data.profile.discoverable, false);
  assert.equal(store.db.prepare('SELECT status FROM invitations WHERE id = ?').get(invited.data.id).status, 'cancelled');
  assert.equal((await b.request('/api/matches?pool=people')).data.matches.some(p => p.id === aBoot.user.id), false);
  assert.equal((await a.request('/api/profile/visibility', { method: 'POST', body: { discoverable: true, revision: 1 } })).status, 409);
  assert.equal((await a.request('/api/profile/visibility', { method: 'POST', body: { discoverable: true, revision: 2 } })).status, 200);
});

test('matches keep the real pool empty until people join, label demo people and explain every displayed score', async t => {
  const { client: makeClient } = await startService(t), client = makeClient(); await client.bootstrap();
  const empty = await client.request('/api/matches?pool=people');
  assert.equal(empty.data.total, 0); assert.deepEqual(empty.data.matches, []);
  for (const mode of ['resonance', 'complement']) {
    const response = await client.request(`/api/matches?mode=${mode}`);
    assert.equal(response.status, 200); assert.equal(response.data.preview, true); assert.equal(response.data.algorithm, 'topics');
    assert.equal(response.data.matches.length, 8);
    for (const match of response.data.matches) {
      assert.equal(match.demo, true); assert.equal(match.provider, 'demo');
      assert.ok(match.score >= 0 && match.score <= 100);
      assert.equal(match.breakdown.reduce((sum, p) => sum + p.weight, 0), 100);
      assert.equal(match.score, Math.round(match.breakdown.reduce((sum, p) => sum + p.weight * p.value, 0) / 100));
      assert.equal(match.reasons.length, 3);
    }
  }
  const invalid = await client.request('/api/matches?pool=untrusted'); assert.equal(invalid.status, 400);
  const unknown = await client.request('/api/matches?q=not-a-real-name'); assert.deepEqual(unknown.data.matches, []);
  await client.request('/api/saved/demo-yu', { method: 'PUT', body: { saved: true } });
  assert.deepEqual((await client.request('/api/matches?saved=true')).data.matches.map(p => p.id), ['demo-yu']);
  assert.equal((await client.request('/api/invitations', { method: 'POST', body: { targetId: 'demo-yu', message: '你好呀' } })).data.error.code, 'demo_person');
});

test('two users must accept an invitation before chatting; third parties cannot read or write and pagination is stable', async t => {
  const { client: makeClient, store } = await startService(t), a = makeClient(), b = makeClient(), c = makeClient();
  const aBoot = await a.bootstrap(), bBoot = await b.bootstrap(); await c.bootstrap();
  await a.profile('甲'); await b.profile('乙');
  const invitation = await a.request('/api/invitations', { method: 'POST', body: { targetId: bBoot.user.id, message: '从一本喜欢的书开始聊吧' } });
  assert.equal(invitation.status, 201); const id = invitation.data.id;
  assert.equal((await a.request(`/api/conversations/${id}`)).status, 404);
  assert.equal((await c.request(`/api/invitations/${id}/respond`, { method: 'POST', body: { action: 'accept' } })).status, 404);
  assert.equal((await a.request(`/api/invitations/${id}/respond`, { method: 'POST', body: { action: 'accept' } })).status, 404);
  assert.equal((await b.request(`/api/invitations/${id}/respond`, { method: 'POST', body: { action: 'accept' } })).status, 200);
  assert.equal((await b.request(`/api/invitations/${id}/respond`, { method: 'POST', body: { action: 'accept' } })).status, 409);
  assert.equal((await b.request('/api/invitations', { method: 'POST', body: { targetId: aBoot.user.id, message: '再邀请一次' } })).status, 409);
  const sent = await a.request(`/api/conversations/${id}/messages`, { method: 'POST', body: { text: '你好，我最近在读庄子。', authorId: bBoot.user.id } });
  assert.equal(sent.status, 201); assert.equal(sent.data.authorId, aBoot.user.id);
  assert.equal((await b.request(`/api/conversations/${id}`)).data.items[0].text, sent.data.text);
  assert.equal((await c.request(`/api/conversations/${id}`)).status, 404);
  assert.equal((await c.request(`/api/conversations/${id}/messages`, { method: 'POST', body: { text: '试图越权' } })).status, 404);
  assert.equal((await a.request(`/api/conversations/${id}/messages`, { method: 'POST', body: { text: ' ' } })).status, 400);
  assert.equal((await a.request(`/api/conversations/${id}/messages`, { method: 'POST', body: { text: 'x'.repeat(2001) } })).status, 400);
  const inserted = [sent.data.id];
  for (let i = 0; i < 105; i++) inserted.push(store.sendMessage(aBoot.user.id, id, `第 ${i} 条`).message.id);
  const latest = (await b.request(`/api/conversations/${id}`)).data;
  assert.equal(latest.items.length, 100); assert.equal(latest.hasMore, true);
  const earlier = (await b.request(`/api/conversations/${id}?before=${latest.nextBefore}`)).data;
  assert.equal(earlier.items.length, 6); assert.equal(earlier.hasMore, false);
  assert.deepEqual([...earlier.items, ...latest.items].map(m => m.id), inserted);
  assert.equal((await b.request(`/api/conversations/${id}?before=unknown`)).status, 400);
  await a.request('/api/profile/visibility', { method: 'POST', body: { discoverable: false } });
  assert.equal((await b.request(`/api/conversations/${id}`)).status, 200);
});

test('blocking removes both-way saves and connection access; unblocking does not resurrect consent; deletion cascades', async t => {
  const { client: makeClient, store } = await startService(t), a = makeClient(), b = makeClient();
  const aBoot = await a.bootstrap(), bBoot = await b.bootstrap();
  await a.profile('甲'); await b.profile('乙');
  for (const [client, targetId] of [[a, bBoot.user.id], [b, aBoot.user.id]]) await client.request(`/api/saved/${targetId}`, { method: 'PUT', body: { saved: true } });
  const invited = await a.request('/api/invitations', { method: 'POST', body: { targetId: bBoot.user.id, message: '一起分享新发现吧' } });
  const id = invited.data.id;
  await b.request(`/api/invitations/${id}/respond`, { method: 'POST', body: { action: 'accept' } });
  await a.request(`/api/conversations/${id}/messages`, { method: 'POST', body: { text: '留下测试消息' } });
  assert.equal((await a.request(`/api/blocked/${bBoot.user.id}`, { method: 'POST' })).status, 200);
  for (const client of [a, b]) {
    assert.equal((await client.request(`/api/conversations/${id}`)).status, 404);
    assert.deepEqual((await client.bootstrap()).savedIds, []);
    assert.deepEqual((await client.request('/api/connections')).data.invitations, []);
  }
  assert.equal((await b.request(`/api/people/${aBoot.user.id}`)).status, 404);
  await a.request(`/api/blocked/${bBoot.user.id}`, { method: 'DELETE' });
  assert.equal((await a.request(`/api/conversations/${id}`)).status, 404);
  await b.request(`/api/saved/${aBoot.user.id}`, { method: 'PUT', body: { saved: true } });
  store.saveImports(aBoot.user.id, [{ title: '仅甲的导入', summary: '不应保留', kind: 'contents' }]);
  store.block(bBoot.user.id, aBoot.user.id);
  store.createSession(aBoot.user.id);
  assert.equal((await a.request('/api/account', { method: 'DELETE', body: { confirm: 'no' } })).status, 400);
  assert.equal((await a.request('/api/account', { method: 'DELETE', body: { confirm: 'delete' } })).status, 200);
  assert.equal(store.user(aBoot.user.id), null);
  for (const table of ['sessions', 'profiles', 'imports', 'saved', 'blocked']) assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(aBoot.user.id).count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM invitations WHERE id = ?').get(id).count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').get(id).count, 0);
  assert.deepEqual(store.blocked(bBoot.user.id), []);
  assert.deepEqual(store.savedIds(bBoot.user.id), []);
  assert.equal((await a.request('/api/account/export')).status, 401);
  assert.notEqual((await a.bootstrap()).user.id, aBoot.user.id);
});

test('per-user profile limit returns Retry-After while preserving the last saved revision', async t => {
  const { client: makeClient } = await startService(t), client = makeClient(); await client.bootstrap();
  for (let revision = 0; revision < 8; revision++) {
    const response = await client.request('/api/profile', { method: 'POST', body: { input: DEFAULT_INPUT, revision, useAI: false } });
    assert.equal(response.status, 200);
  }
  const limited = await client.request('/api/profile', { method: 'POST', body: { input: DEFAULT_INPUT, revision: 8, useAI: false } });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await client.bootstrap()).profile.revision, 8);
});

test('chat retries with the same clientMessageId return the original message once and keep legacy sends compatible', async t => {
  const { client: makeClient, store } = await startService(t), a = makeClient(), b = makeClient();
  const aBoot = await a.bootstrap(), bBoot = await b.bootstrap(); await a.profile('甲'); await b.profile('乙');
  const conversation = store.invite(aBoot.user.id, bBoot.user.id, '讨论消息幂等'); store.respond(bBoot.user.id, conversation, 'accept');
  const path = `/api/conversations/${conversation}/messages`, body = { text: '网络重试也只保留一条。', clientMessageId: randomUUID() };
  const first = await a.request(path, { method: 'POST', body });
  const retry = await a.request(path, { method: 'POST', body: { ...body, clientMessageId: body.clientMessageId.toUpperCase() } });
  assert.equal(first.status, 201); assert.equal(retry.status, 201); assert.deepEqual(retry.data, first.data);
  assert.deepEqual(Object.keys(first.data).sort(), ['authorId', 'createdAt', 'id', 'text']);
  assert.equal((await b.request(`/api/conversations/${conversation}`)).data.items.length, 1);
  const legacy = await a.request(path, { method: 'POST', body: { text: '兼容未附带重试标识的客户端。' } });
  assert.equal(legacy.status, 201); assert.notEqual(legacy.data.id, first.data.id);
});

test('chat rejects conflicting or malformed retry IDs and scopes retries to the conversation author', async t => {
  const { client: makeClient, store } = await startService(t), a = makeClient(), b = makeClient(), outsider = makeClient();
  const aBoot = await a.bootstrap(), bBoot = await b.bootstrap(); await outsider.bootstrap(); await a.profile('甲'); await b.profile('乙');
  const conversation = store.invite(aBoot.user.id, bBoot.user.id, '测试重试边界'); store.respond(bBoot.user.id, conversation, 'accept');
  const path = `/api/conversations/${conversation}/messages`, clientMessageId = randomUUID();
  const first = await a.request(path, { method: 'POST', body: { text: '第一条正文', clientMessageId } });
  const conflicting = await a.request(path, { method: 'POST', body: { text: '另一段正文', clientMessageId } });
  assert.equal(conflicting.status, 409); assert.equal(conflicting.data.error.code, 'client_message_conflict');
  const authorScoped = await b.request(path, { method: 'POST', body: { text: '另一位作者的消息', clientMessageId } });
  assert.equal(authorScoped.status, 201); assert.equal(authorScoped.data.authorId, bBoot.user.id); assert.notEqual(authorScoped.data.id, first.data.id);
  assert.equal((await outsider.request(path, { method: 'POST', body: { text: '第一条正文', clientMessageId } })).status, 404);
  for (const invalid of ['not-a-uuid', 'a'.repeat(500), null, 42]) {
    const response = await a.request(path, { method: 'POST', body: { text: '坏标识', clientMessageId: invalid } });
    assert.equal(response.status, 400); assert.equal(response.data.error.code, 'invalid_message_id');
  }
  assert.equal((await b.request(`/api/conversations/${conversation}`)).data.items.length, 2);
  await a.request(`/api/blocked/${bBoot.user.id}`, { method: 'POST' });
  assert.equal((await a.request(path, { method: 'POST', body: { text: '第一条正文', clientMessageId } })).status, 404);
});
