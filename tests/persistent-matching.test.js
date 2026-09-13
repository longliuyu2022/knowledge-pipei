import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../server/knowledge-store.js';
import { PersistentMatching } from '../server/persistent-matching.js';
import { buildProfile } from '../server/matching.js';
import { DEFAULT_INPUT } from '../shared/catalog.js';

const code = value => error => error.code === value;
function harness(t, { persistent = false, ...options } = {}) {
  const directory = persistent ? mkdtempSync(join(tmpdir(), 'tongzhi-matching-')) : null;
  const path = directory ? join(directory, 'matching.sqlite') : ':memory:';
  const f = { now: Date.UTC(2026, 0, 1), events: [] };
  const open = () => {
    f.store = new KnowledgeStore(path);
    f.matching = new PersistentMatching(f.store, { now: () => f.now, intervalMs: 3600000, emit: (id, event) => f.events.push({ id, event }), ...options });
    f.store.onUserChanged = (id, reason) => f.matching.invalidate(id, reason);
  };
  open();
  f.reopen = () => { f.matching.close(); f.store.close(); open(); };
  f.advance = ms => { f.now += ms; };
  f.user = (name, input = {}) => {
    const user = f.store.createUser(name);
    f.store.saveProfile(user.id, buildProfile({ ...DEFAULT_INPUT, name, ...input }), 0);
    return user.id;
  };
  f.start = (id, patch = {}) => f.matching.start(id, { revision: f.store.profile(id)?.revision || 0, ...patch });
  t.after(() => { f.matching.close(); f.store.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  return f;
}

test('persistent matching requires explicit participation without requiring a public profile', t => {
  const f = harness(t), a = f.user('主动寻找的甲'), b = f.user('尚未参与的乙'), observer = f.user('仅查看的丙');
  assert.equal(f.matching.state(a).request, null);
  const first = f.start(a); assert.equal(first.request.status, 'searching'); assert.equal(first.proposal, null);
  f.advance(3600000);
  const repeat = f.start(a);
  assert.equal(repeat.request.id, first.request.id); assert.equal(repeat.request.expiresAt, first.request.expiresAt);
  assert.equal(f.matching.state(b).request, null); assert.equal(f.matching.state(observer).proposal, null);
  assert.throws(() => f.start(a, { mode: 'complement' }), code('matching_active'));
  const proposed = f.start(b);
  assert.equal(proposed.request.status, 'proposed'); assert.equal(proposed.proposal.person.id, a);
  assert.equal(f.matching.state(a).proposal.person.id, b);
  assert.equal(f.store.profile(a).discoverable, false); assert.equal(f.store.profile(b).discoverable, false);
  assert.equal(f.store.publicUser(a, observer), null); assert.equal(f.store.people(observer).length, 0);
  assert.equal(f.store.notifications(a).items.length, 1); assert.equal(f.store.notifications(b).items.length, 1); assert.equal(f.store.notifications(observer).items.length, 0);
  const counts = f.matching.state(observer).counts;
  assert.deepEqual(counts, { searching: 0, proposed: 2 }); assert.equal(JSON.stringify(counts).includes(a), false);
});

test('offline requests and the first acceptance survive actual database reopening before the second acceptance', t => {
  const f = harness(t, { persistent: true }), a = f.user('先离线的甲'), b = f.user('稍后上线的乙');
  const original = f.start(a).request;
  f.advance(6 * 3600000); f.reopen();
  assert.equal(f.matching.state(a).request.id, original.id); assert.equal(f.matching.state(a).request.expiresAt, original.expiresAt);
  const proposed = f.start(b).proposal, acceptedOnce = f.matching.respond(a, proposed.id, 'accept');
  assert.equal(acceptedOnce.proposal.acceptedByMe, true); assert.equal(acceptedOnce.conversationId, null);
  assert.equal(f.store.connectionBetween(a, b), null);
  f.advance(8 * 3600000); f.reopen();
  assert.equal(f.matching.state(a).proposal.acceptedByMe, true);
  const connected = f.matching.respond(b, proposed.id, 'accept');
  assert.equal(connected.request.status, 'fulfilled'); assert.ok(connected.conversationId);
  assert.equal(f.store.conversation(a, connected.conversationId).status, 'accepted');
  assert.equal(f.store.conversation(b, connected.conversationId).id, connected.conversationId);
  assert.equal(f.matching.respond(a, proposed.id, 'accept').conversationId, connected.conversationId);
  assert.equal(f.matching.respond(b, proposed.id, 'accept').conversationId, connected.conversationId);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM invitations').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM match_slots').get().n, 0);
  assert.equal(f.store.notifications(a).items.length, 2); assert.equal(f.store.notifications(b).items.length, 2);
});

test('cancel after one acceptance prevents a stale second acceptance and preserves the other request', t => {
  const f = harness(t), a = f.user('取消者'), b = f.user('继续寻找者');
  f.start(a); f.advance(1); const proposed = f.start(b).proposal;
  f.matching.respond(a, proposed.id, 'accept');
  const aRequest = f.matching.state(a).request.id, bRequest = f.matching.state(b).request.id;
  assert.equal(f.matching.control(a, aRequest, 'cancel').request.status, 'cancelled');
  const other = f.matching.state(b); assert.equal(other.request.status, 'searching'); assert.equal(other.request.id, bRequest);
  assert.throws(() => f.matching.respond(b, proposed.id, 'accept'), code('proposal_expired'));
  assert.equal(f.store.connectionBetween(a, b), null);
  const restarted = f.start(a); assert.notEqual(restarted.request.id, aRequest); assert.equal(restarted.proposal, null, 'a just-cancelled pair is not immediately proposed again');
  assert.throws(() => f.matching.control(a, aRequest, 'cancel'), code('matching_changed'));
  assert.equal(f.matching.state(a).request.id, restarted.request.id);
});

test('proposal expiry releases slots, request expiry requires a new explicit start, and reads never renew', t => {
  const f = harness(t, { proposalMs: 60000, requestMs: 120000 }), a = f.user('到期者甲'), b = f.user('到期者乙');
  const first = f.start(a).request; const proposal = f.start(b).proposal;
  f.matching.respond(a, proposal.id, 'accept'); f.advance(60001);
  assert.throws(() => f.matching.respond(b, proposal.id, 'accept'), code('proposal_expired'));
  assert.equal(f.matching.state(a).request.status, 'searching'); assert.equal(f.matching.state(b).proposal, null);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM match_slots').get().n, 0);
  f.advance(60000);
  for (let i = 0; i < 3; i++) {
    const expired = f.matching.state(a);
    assert.equal(expired.request.status, 'expired'); assert.equal(expired.request.id, first.id); assert.equal(expired.request.expiresAt, first.expiresAt);
  }
  assert.equal(f.store.connectionBetween(a, b), null);
  const next = f.start(a); assert.equal(next.request.status, 'searching'); assert.notEqual(next.request.id, first.id);
});

test('pause and resume preserve the request deadline; profile changes invalidate a pending proposal', t => {
  const f = harness(t), a = f.user('更新画像者'), b = f.user('候选伙伴');
  const first = f.start(a).request;
  assert.equal(f.matching.control(a, first.id, 'pause').request.status, 'paused');
  f.advance(3600000);
  const resumed = f.matching.control(a, first.id, 'resume'); assert.equal(resumed.request.id, first.id); assert.equal(resumed.request.expiresAt, first.expiresAt);
  const proposal = f.start(b).proposal;
  f.matching.respond(b, proposal.id, 'accept');
  const current = f.store.profile(a);
  f.store.saveProfile(a, buildProfile({ ...current.input, about: '我主动更新了本轮知识目标。' }), current.revision);
  assert.equal(f.matching.state(a).request.status, 'paused'); assert.equal(f.matching.state(b).request.status, 'searching');
  assert.throws(() => f.matching.respond(a, proposal.id, 'accept'), code('proposal_expired'));
  assert.throws(() => f.matching.start(a, { revision: 1 }), code('profile_changed'));
  const after = f.matching.control(a, first.id, 'resume');
  assert.equal(after.request.status, 'searching'); assert.equal(after.request.expiresAt, first.expiresAt); assert.equal(f.store.connectionBetween(a, b), null);
});

for (const change of ['block', 'disabled']) test(`${change} cancels a pending proposal before the second acceptance`, t => {
  const f = harness(t), a = f.user('甲'), b = f.user('乙');
  f.start(a); const proposal = f.start(b).proposal; f.matching.respond(a, proposal.id, 'accept');
  if (change === 'block') f.store.block(a, b);
  else f.store.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(a);
  f.matching.tick();
  assert.equal(f.matching.state(b).proposal, null);
  assert.throws(() => f.matching.respond(b, proposal.id, 'accept'), code('proposal_expired'));
  assert.equal(f.store.connectionBetween(a, b), null);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM match_slots').get().n, 0);
});

test('declining avoids the same pair while eligible requests can match someone else', t => {
  const f = harness(t), a = f.user('甲'), b = f.user('乙'), c = f.user('丙');
  f.start(a); f.advance(1); const proposal = f.start(b).proposal;
  f.matching.respond(b, proposal.id, 'decline');
  assert.equal(f.matching.state(a).proposal, null); assert.equal(f.matching.state(b).request.status, 'searching');
  f.advance(1); const next = f.start(c).proposal;
  assert.ok(next); assert.notEqual(next.id, proposal.id); assert.ok([a, b].includes(next.person.id));
  assert.equal(f.store.connectionBetween(a, b), null);
});

test('proposal creation rolls back both slots and notifications if one participant cannot be reserved', t => {
  const f = harness(t), a = f.user('原子性甲'), b = f.user('原子性乙');
  f.start(a);
  f.store.db.exec(`CREATE TRIGGER force_second_slot_failure BEFORE INSERT ON match_slots WHEN NEW.user_id='${b}' BEGIN SELECT RAISE(ABORT,'reservation interrupted'); END;`);
  assert.throws(() => f.start(b), /reservation interrupted/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM match_slots').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM match_proposals').get().n, 0);
  assert.equal(f.store.notifications(a).items.length, 0); assert.equal(f.store.notifications(b).items.length, 0);
  f.store.db.exec('DROP TRIGGER force_second_slot_failure');
  f.matching.tick(); const proposed = f.matching.state(a).proposal;
  assert.ok(proposed); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM match_slots').get().n, 2);
  f.matching.tick(); f.matching.tick();
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM match_proposals WHERE status='pending'").get().n, 1);
  assert.equal(f.store.notifications(a).items.length, 1); assert.equal(f.store.notifications(b).items.length, 1);
});

test('only proposal participants can respond and repeated first acceptance cannot open a conversation', t => {
  const f = harness(t), a = f.user('受邀甲'), b = f.user('受邀乙'), outsider = f.user('无关用户');
  f.start(a); const proposal = f.start(b).proposal;
  assert.throws(() => f.matching.respond(outsider, proposal.id, 'accept'), code('proposal_missing'));
  assert.throws(() => f.matching.respond(a, proposal.id, 'yes'), code('invalid_decision'));
  f.matching.respond(a, proposal.id, 'accept'); f.matching.respond(a, proposal.id, 'accept');
  assert.equal(f.matching.state(a).proposal.acceptedByMe, true); assert.equal(f.matching.state(a).proposal.acceptedByOther, false);
  assert.equal(f.store.connectionBetween(a, b), null); assert.equal(f.matching.state(outsider).proposal, null);
});
