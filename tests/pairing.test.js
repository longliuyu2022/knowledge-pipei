import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { Pairing } from '../server/pairing.js';
import { buildProfile } from '../server/matching.js';
import { DEFAULT_INPUT } from '../shared/catalog.js';
import { startService } from './helpers.js';

function harness(t, options = {}) {
  const store = new Store(':memory:'); let now = Date.now(); const changes = [];
  const pairing = new Pairing(store, { now: () => now, onChange: id => changes.push(id), ...options });
  t.after(() => { pairing.close(); store.close(); });
  function user(name, input = {}, published = false) {
    const person = store.createUser(name);
    store.saveProfile(person.id, buildProfile({ ...DEFAULT_INPUT, name, about: '', question: '', ...input }), 0);
    if (published) store.setDiscoverable(person.id, true);
    return person.id;
  }
  return { store, pairing, user, changes, advance(ms) { now += ms; pairing.tick(); } };
}
const start = (pairing, userId, changes = {}) => pairing.start(userId, { revision: 1, mode: 'resonance', ...changes });

test('online pairing stays idle until explicit start and only proposes another active real participant', t => {
  const { store, pairing, user, changes } = harness(t), a = user('甲'), b = user('乙'), c = user('丙');
  assert.equal(pairing.state(a).status, 'idle'); assert.equal(pairing.states.size, 0);
  const waiting = start(pairing, a);
  assert.equal(waiting.status, 'searching'); assert.equal(waiting.pair, null);
  assert.equal(pairing.state(b).status, 'idle'); assert.equal(pairing.state(c).pair, null);
  const found = start(pairing, b);
  assert.equal(found.status, 'proposed'); assert.equal(found.pair.person.id, a); assert.equal(found.pair.person.demo, false);
  assert.equal(found.pair.person.saved, false); assert.equal(found.pair.person.algorithm, 'topics'); assert.equal(found.pair.person.reasons.length, 3);
  assert.equal(pairing.state(a).pair.person.id, b);
  assert.equal(pairing.state(c).status, 'idle'); assert.equal(pairing.state(c).pair, null);
  assert.equal(store.profile(a).discoverable, false); assert.equal(store.profile(b).discoverable, false);
  assert.equal(store.people(c).length, 0); assert.equal(store.publicUser(a, c), null);
  assert.ok(changes.includes(a) && changes.includes(b)); assert.equal(changes.includes(c), false);
});

test('start validates profile/revision/filter, is idempotent while active and does not extend queue duration', t => {
  const { store, pairing, user, advance } = harness(t), a = user('甲');
  const blank = store.createUser('没有画像').id;
  assert.throws(() => start(pairing, blank), error => error.code === 'profile_required');
  assert.throws(() => start(pairing, a, { revision: 2 }), error => error.code === 'profile_changed');
  assert.throws(() => start(pairing, a, { revision: '1' }), error => error.code === 'invalid_revision');
  assert.throws(() => start(pairing, a, { mode: 'unknown' }), error => error.code === 'invalid_mode');
  assert.throws(() => start(pairing, a, { topic: 'fake-topic' }), error => error.code === 'invalid_topic');
  const first = start(pairing, a); advance(1000);
  const retry = start(pairing, a);
  assert.equal(retry.attemptId, first.attemptId); assert.equal(retry.expiresAt, first.expiresAt);
  assert.throws(() => start(pairing, a, { mode: 'complement' }), error => error.code === 'pairing_active');
  const b = user('乙'); const proposal = start(pairing, b);
  assert.equal(start(pairing, a).pair.id, proposal.pair.id);
  assert.equal(pairing.pairs.size, 1);
});

test('preferences filter both ways and choose the highest mutual knowledge score from eligible waiters', t => {
  const { pairing, user, advance } = harness(t, { avoidMs: 1000 });
  const closer = user('读书伙伴', { topicIds: ['reading', 'philosophy', 'psychology'] });
  const farther = user('自然伙伴', { topicIds: ['food', 'nature', 'travel'] });
  const me = user('技术与阅读', { topicIds: ['ai', 'reading', 'philosophy'] });
  start(pairing, me); advance(1);
  const first = start(pairing, farther, { topic: 'ai', mode: 'complement' });
  pairing.respond(me, first.pair.id, 'skip'); advance(1);
  const second = start(pairing, closer, { topic: 'ai' });
  pairing.respond(me, second.pair.id, 'skip');
  assert.ok([me, closer, farther].every(id => pairing.state(id).status === 'searching'));
  // Both avoided candidates become eligible in the same sweep. The oldest
  // waiter now has two actual choices, so this checks score ordering, not UUID order.
  advance(1001);
  const found = pairing.state(me);
  assert.equal(found.pair.person.id, closer);
  assert.equal(pairing.state(farther).status, 'searching');
  assert.equal(pairing.state(closer).pair.person.matchingMode, 'resonance');
});

test('blocked pairs, existing pending invitations and accepted connections are excluded from the queue', t => {
  for (const relation of ['blocked', 'pending', 'accepted']) {
    const { store, pairing, user } = harness(t), a = user('甲', {}, true), b = user('乙', {}, true);
    if (relation === 'blocked') store.block(a, b);
    else { const invitation = store.invite(a, b, '已有的邀请'); if (relation === 'accepted') store.respond(b, invitation, 'accept'); }
    start(pairing, a); start(pairing, b);
    assert.equal(pairing.state(a).status, 'searching'); assert.equal(pairing.state(b).status, 'searching');
    assert.equal(pairing.pairs.size, 0);
  }
});

test('both confirmations are required, private users gain a single accepted chat and repeated accepts are idempotent', t => {
  const { store, pairing, user } = harness(t), a = user('甲'), b = user('乙'), outsider = user('旁观者');
  start(pairing, a); const proposed = start(pairing, b), id = proposed.pair.id;
  assert.equal(store.activeInvitationBetween(a, b), null);
  assert.throws(() => pairing.respond(outsider, id, 'accept'), error => error.code === 'pairing_missing');
  const first = pairing.respond(a, id, 'accept');
  assert.equal(first.status, 'proposed'); assert.equal(first.pair.acceptedByMe, true); assert.equal(first.pair.acceptedByOther, false);
  assert.equal(pairing.state(b).pair.acceptedByOther, true); assert.equal(store.activeInvitationBetween(a, b), null);
  assert.equal(pairing.respond(a, id, 'accept').conversationId, null);
  const connected = pairing.respond(b, id, 'accept');
  assert.equal(connected.status, 'connected'); assert.equal(connected.pair.acceptedByMe, true); assert.equal(connected.pair.acceptedByOther, true);
  assert.equal(pairing.respond(a, id, 'accept').conversationId, connected.conversationId);
  assert.equal(pairing.respond(b, id, 'accept').conversationId, connected.conversationId);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, 1);
  assert.equal(store.conversation(a, connected.conversationId).status, 'accepted');
  store.sendMessage(a, connected.conversationId, '从共同兴趣开始聊吧');
  assert.equal(store.messages(b, connected.conversationId).items.length, 1);
  assert.throws(() => store.messages(outsider, connected.conversationId), error => error.status === 404);
  assert.equal(store.profile(a).discoverable, false);
  assert.notEqual(start(pairing, a).attemptId, first.attemptId);
  assert.equal(start(pairing, b).status, 'searching'); assert.equal(pairing.state(a).status, 'searching');
  assert.equal(store.conversation(a, connected.conversationId).status, 'accepted');
});

test('skip avoids immediate rematches and delayed responses cannot accept or skip a newer proposal', t => {
  const { pairing, user } = harness(t), a = user('甲'), b = user('乙'), c = user('丙');
  start(pairing, a); const original = start(pairing, b).pair.id;
  pairing.respond(a, original, 'skip');
  assert.equal(pairing.state(a).status, 'searching'); assert.equal(pairing.state(b).status, 'searching');
  const replacement = start(pairing, c), matched = replacement.pair.person.id;
  assert.ok([a, b].includes(matched)); assert.notEqual(replacement.pair.id, original);
  const retry = pairing.respond(matched, original, 'skip');
  assert.equal(retry.status, 'proposed'); assert.equal(retry.pair.id, replacement.pair.id);
  const lateAccept = pairing.respond(matched, original, 'accept');
  assert.equal(lateAccept.pair.acceptedByMe, false); assert.equal(lateAccept.pair.person.id, c);
});

test('attempt IDs make delayed cancel and heartbeat harmless to a newer round', t => {
  const { pairing, user, advance } = harness(t), a = user('甲');
  const old = start(pairing, a); pairing.cancel(a, old.attemptId);
  const current = start(pairing, a); assert.notEqual(current.attemptId, old.attemptId);
  assert.equal(pairing.cancel(a, old.attemptId).status, 'searching');
  advance(20000);
  assert.equal(pairing.heartbeat(a, old.attemptId).heartbeatExpiresAt, current.heartbeatExpiresAt);
  assert.notEqual(pairing.heartbeat(a, current.attemptId).heartbeatExpiresAt, current.heartbeatExpiresAt);
  assert.equal(pairing.cancel(a, current.attemptId).status, 'idle');
  assert.equal(pairing.heartbeat(a, current.attemptId).status, 'idle');
});

test('45-second offline expiry removes one participant and never silently rejoins them', t => {
  const { pairing, user, advance } = harness(t), a = user('甲'), b = user('乙');
  const first = start(pairing, a); start(pairing, b);
  advance(44000); pairing.heartbeat(b); advance(1001);
  assert.equal(pairing.state(a).status, 'idle'); assert.equal(pairing.state(a).reason, 'offline');
  assert.equal(pairing.state(b).status, 'searching'); assert.equal(pairing.state(b).reason, 'peer_left');
  assert.equal(pairing.heartbeat(a, first.attemptId).status, 'idle');
  assert.equal(pairing.state(b).pair, null);
});

test('queue expiry is three minutes despite heartbeats; a live proposal expires after sixty seconds and returns to queue', t => {
  const queue = harness(t), only = queue.user('独自等待'); const original = start(queue.pairing, only);
  for (let i = 0; i < 5; i++) { queue.advance(30000); queue.pairing.heartbeat(only); }
  assert.equal(queue.pairing.state(only).expiresAt, original.expiresAt);
  queue.advance(30000); assert.equal(queue.pairing.state(only).reason, 'queue_expired');
  const proposed = harness(t), a = proposed.user('甲'), b = proposed.user('乙');
  start(proposed.pairing, a); const id = start(proposed.pairing, b).pair.id;
  proposed.advance(30000); proposed.pairing.heartbeat(a); proposed.pairing.heartbeat(b); proposed.advance(30001);
  assert.equal(proposed.pairing.state(a).status, 'searching'); assert.equal(proposed.pairing.state(a).reason, 'proposal_expired');
  assert.equal(proposed.pairing.state(b).status, 'searching'); assert.equal(proposed.pairing.state(b).pair, null);
  assert.equal(proposed.pairing.respond(a, id, 'accept').conversationId, null);
  assert.equal(proposed.store.activeInvitationBetween(a, b), null);
});

test('profile revisions and direct relationship changes invalidate incomplete pairing before a late accept', t => {
  const { store, pairing, user } = harness(t), a = user('甲', {}, true), b = user('乙', {}, true);
  start(pairing, a); const first = start(pairing, b).pair.id; pairing.respond(a, first, 'accept');
  store.saveProfile(a, buildProfile({ ...DEFAULT_INPUT, name: '新画像' }), 1);
  assert.equal(pairing.state(a).reason, 'profile_changed'); assert.equal(pairing.respond(b, first, 'accept').status, 'searching');
  assert.equal(store.activeInvitationBetween(a, b), null);
  const c = user('丙', {}, true); const pair = start(pairing, c).pair;
  assert.equal(pair.person.id, b);
  const ordinary = store.invite(b, c, '从另一页面发来的普通邀请');
  assert.equal(pairing.respond(b, pair.id, 'accept').status, 'searching');
  assert.equal(store.activeInvitationBetween(b, c).id, ordinary); assert.equal(store.activeInvitationBetween(b, c).status, 'pending');
});

test('capacity limits reject extra starts without manufacturing an online participant', t => {
  const { pairing, user } = harness(t, { maxParticipants: 1 }), a = user('甲'), b = user('乙');
  start(pairing, a);
  assert.throws(() => start(pairing, b), error => error.status === 429 && error.code === 'pairing_full');
  assert.equal(pairing.state(b).status, 'idle');
});

test('API pairing enforces origin/CSRF, private-candidate isolation and atomically pairs concurrent starts once', async t => {
  const service = await startService(t), clients = Array.from({ length: 5 }, () => service.client());
  const users = [];
  for (const [index, client] of clients.entries()) { users.push((await client.bootstrap()).user.id); await client.profile(`参与者 ${index}`, false); }
  const body = { revision: 1, mode: 'resonance' };
  assert.equal((await clients[0].request('/api/pairing/start', { method: 'POST', body, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await clients[0].request('/api/pairing/start', { method: 'POST', body, headers: { origin: 'https://foreign.invalid' } })).status, 403);
  await Promise.all(clients.slice(0, 4).map(client => client.request('/api/pairing/start', { method: 'POST', body })));
  const states = await Promise.all(clients.slice(0, 4).map(async client => (await client.request('/api/pairing')).data));
  assert.ok(states.every(state => state.status === 'proposed'));
  assert.equal(new Set(states.map(state => state.pair.id)).size, 2);
  for (let i = 0; i < 4; i++) {
    const state = states[i], other = users.indexOf(state.pair.person.id);
    assert.notEqual(other, i); assert.equal(states[other].pair.person.id, users[i]);
    assert.equal((await clients[i].request(`/api/people/${state.pair.person.id}`)).status, 404);
  }
  const outsider = await clients[4].request(`/api/pairing?userId=${users[0]}`);
  assert.equal(outsider.data.status, 'idle'); assert.equal(outsider.data.pair, null);
  assert.equal((await clients[4].request('/api/pairing/respond', { method: 'POST', body: { pairId: states[0].pair.id, decision: 'accept' } })).status, 404);
  const accepted = await Promise.all(clients.slice(0, 4).map((client, i) => client.request('/api/pairing/respond', { method: 'POST', body: { pairId: states[i].pair.id, decision: 'accept' } })));
  assert.ok(accepted.every(response => response.status === 200));
  assert.equal(service.store.db.prepare("SELECT COUNT(*) AS count FROM invitations WHERE status = 'accepted'").get().count, 2);
  const connected = (await clients[0].request('/api/pairing')).data;
  assert.equal((await clients[0].request(`/api/conversations/${connected.conversationId}`)).status, 200);
  assert.equal((await clients[4].request(`/api/conversations/${connected.conversationId}`)).status, 404);
});

test('blocking a private proposed partner is allowed, ends that proposal and creates no connection', async t => {
  const service = await startService(t), a = service.client(), b = service.client(), stranger = service.client();
  const aId = (await a.bootstrap()).user.id, bId = (await b.bootstrap()).user.id; await stranger.bootstrap();
  await a.profile('甲', false); await b.profile('乙', false);
  await a.request('/api/pairing/start', { method: 'POST', body: { revision: 1 } });
  const found = (await b.request('/api/pairing/start', { method: 'POST', body: { revision: 1 } })).data;
  assert.equal((await stranger.request(`/api/blocked/${bId}`, { method: 'POST' })).status, 404);
  assert.equal((await a.request(`/api/blocked/${bId}`, { method: 'POST' })).status, 200);
  assert.equal((await a.request('/api/pairing')).data.reason, 'blocked');
  assert.equal((await b.request('/api/pairing')).data.status, 'searching');
  assert.equal((await b.request('/api/pairing/respond', { method: 'POST', body: { pairId: found.pair.id, decision: 'accept' } })).data.conversationId, null);
  assert.equal(service.store.activeInvitationBetween(aId, bId), null);
});

test('logout, deletion, clearing imports and leaving discovery immediately end unfinished API pairing', async t => {
  for (const action of ['logout', 'delete', 'clear-imports', 'leave-pool']) {
    const service = await startService(t), a = service.client(), b = service.client();
    const aId = (await a.bootstrap()).user.id; await b.bootstrap(); await a.profile('甲', false); await b.profile('乙', false);
    await a.request('/api/pairing/start', { method: 'POST', body: { revision: 1 } });
    const found = (await b.request('/api/pairing/start', { method: 'POST', body: { revision: 1 } })).data;
    await a.request('/api/pairing/respond', { method: 'POST', body: { pairId: found.pair.id, decision: 'accept' } });
    const [path, method, body] = action === 'logout' ? ['/api/logout', 'POST', {}] : action === 'delete' ? ['/api/account', 'DELETE', { confirm: 'delete' }] : action === 'clear-imports' ? ['/api/zhihu/import', 'DELETE', {}] : ['/api/profile/visibility', 'POST', { discoverable: false }];
    assert.equal((await a.request(path, { method, body })).status, 200);
    const remaining = (await b.request('/api/pairing')).data;
    assert.equal(remaining.status, 'searching'); assert.equal(remaining.pair, null); assert.equal(remaining.conversationId, null);
    assert.equal(service.pairing.state(aId).status, 'idle');
    assert.equal(service.store.db.prepare('SELECT COUNT(*) AS count FROM invitations').get().count, 0);
  }
});

test('starting profile generation revokes a proposal immediately and blocks reentry until the mutation ends', async t => {
  const service = await startService(t), a = service.client(), b = service.client(); await a.bootstrap(); await b.bootstrap();
  await a.profile('甲', false); await b.profile('乙', false);
  await a.request('/api/pairing/start', { method: 'POST', body: { revision: 1 } });
  const proposed = (await b.request('/api/pairing/start', { method: 'POST', body: { revision: 1 } })).data;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  service.ai.enrichProfile = async profile => { entered(); await gate; return profile; };
  const generating = a.request('/api/profile', { method: 'POST', body: { input: { ...DEFAULT_INPUT, name: '更新后的甲' }, revision: 1, useAI: false } });
  await started;
  assert.equal((await a.request('/api/pairing')).data.reason, 'profile_changed');
  const reenter = await a.request('/api/pairing/start', { method: 'POST', body: { revision: 1 } });
  assert.equal(reenter.status, 409); assert.equal(reenter.data.error.code, 'profile_busy');
  assert.equal((await b.request('/api/pairing/respond', { method: 'POST', body: { pairId: proposed.pair.id, decision: 'accept' } })).data.conversationId, null);
  release(); assert.equal((await generating).status, 200);
});
