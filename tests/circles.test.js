import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { KnowledgeStore } from '../server/knowledge-store.js';
import { Circles } from '../server/circles/service.js';
import { normalizeQuestionUrl } from '../server/circles/index.js';
import { AppError } from '../server/errors.js';

const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const code = expected => error => error.code === expected;
const validModel = payload => ({ text: payload.messages.length ? '需要保留适用条件与不同意见。【M1】' : '目前尚无已授权真人发言，请先补充具体经历。', title: '本轮成果草稿', citedMessageIds: payload.messages.slice(0, 1).map(m => m.id), citedSourceIds: [] });
function fixture(t, overrides = {}) {
  const StoreClass = overrides.StoreClass || Store, store = new StoreClass(overrides.path || ':memory:');
  let currentTime = Date.UTC(2026, 0, 1), serial = 0;
  const revoked = new Set(), notifications = [], calls = [], events = [];
  const options = { store, intervalMs: 0, clock: () => currentTime,
    assertSession: req => { if (revoked.has(req.viewer.id)) throw new AppError(401, 'session_expired', 'expired'); },
    moderate: async () => ({ allowed: true }),
    ai: { json: async (system, payload) => { calls.push({ system, payload }); return validModel(payload); } },
    zhihu: { search: async () => ({ items: [{ id: 'official-1', title: '知识检索的适用条件', url: 'https://www.zhihu.com/question/123/answer/456', author: '原作者', summary: '这是一段搜索摘要，并非全文。' }], notice: null }) },
    emit: (id, event) => events.push({ id, event }), notify: (id, payload) => notifications.push({ id, ...payload }), ...overrides };
  const circles = new Circles(options);
  t.after(() => { circles.close(); store.close(); });
  const alice = store.createUser('甲同学'), bob = store.createUser('乙同学'), carol = store.createUser('丙同学');
  const req = user => ({ viewer: user });
  const create = (user = alice, data = {}) => circles.create(user.id, { title: '知识产品验证', question: '如何验证知识产品的真实价值？', goal: '完成一轮真实用户实验', aiConsent: true, ...data });
  const add = (circle, user = bob, data = {}) => circles.join(circle.id, user.id, { aiConsent: true, ...data });
  const send = async (circle, user = alice, content = '我的实践经验需要结合场景讨论。', data = {}) => (await circles.sendMessage(req(user), circle.id, { text: content, clientMessageId: `test-message-${++serial}`, ...data })).message;
  const advance = ms => { currentTime += ms; };
  return { store, circles, options, alice, bob, carol, req, create, add, send, advance, revoked, notifications, calls, events };
}

test('question URL normalization preserves long IDs and rejects unrelated hosts/protocols', () => {
  const id = '18446744073709551615';
  assert.deepEqual(normalizeQuestionUrl(`https://m.zhihu.com/question/${id}/answer/222?utm=test#x`), { questionId: id, questionUrl: `https://www.zhihu.com/question/${id}` });
  for (const value of ['http://www.zhihu.com/question/123', 'https://zhihu.com.evil.example/question/123', 'https://user@zhihu.com/question/123', 'https://zhihu.com:8443/question/123', 'https://www.zhihu.com/people/a', 'https://www.zhihu.com/question/0', 'javascript:alert(1)']) assert.throws(() => normalizeQuestionUrl(value), code('invalid_question_url'));
});

test('public readers see only summaries and explicit joins have independent consent defaults', async t => {
  const f = fixture(t), circle = f.create(f.alice, { aiConsent: false });
  const message = await f.send(circle);
  f.circles.addSource(circle.id, f.alice.id, { title: '原文链接', url: 'https://www.zhihu.com/question/123' });
  f.circles.addOutcome(circle.id, f.alice.id, { title: '阶段记录', content: '尚待核对的本人整理内容', messageIds: [message.id] });
  const publicView = f.circles.detail(circle.id, f.bob.id);
  for (const field of ['messages', 'sources', 'outcomes', 'members', 'rounds']) assert.deepEqual(publicView[field], []);
  assert.equal(publicView.joined, false); assert.equal(publicView.memberCount, 1);
  const joined = f.circles.join(circle.id, f.bob.id, {});
  assert.equal(joined.membership.aiConsent, false); assert.equal(joined.membership.allowConnections, false); assert.equal(joined.membership.subscribed, true);
  assert.equal(joined.messages.length, 1); assert.equal(joined.members[0].avatar, ''); assert.equal('provider' in joined.members[0], false);
  assert.equal(f.circles.list(f.carol.id, { mine: '1' }).length, 0);
  assert.equal(f.circles.recommendations(f.carol.id, { q: '知识' }).profileUsed, false);
});

test('temporary membership expires immediately, preserves export and transfers host deterministically', async t => {
  const f = fixture(t), circle = f.create(f.alice, { duration: '24h' });
  await f.send(circle, f.alice, '本人允许导出的参与记录。');
  f.add(circle, f.bob, { duration: '7d' }); f.add(circle, f.carol);
  const expiry = f.circles.detail(circle.id, f.alice.id).membership.expiresAt;
  f.advance(60000); f.circles.join(circle.id, f.alice.id, {});
  assert.equal(f.circles.detail(circle.id, f.alice.id).membership.expiresAt, expiry, 'a repeated join without an explicit duration is not a renewal');
  f.advance(86400000);
  assert.equal(f.circles.detail(circle.id, f.alice.id).joined, false);
  assert.throws(() => f.circles.page(circle.id, f.alice.id), code('membership_required'));
  assert.equal(f.circles.detail(circle.id, f.bob.id).membership.role, 'host');
  assert.equal(f.circles.exportUser(f.alice.id).messages[0].text, '本人允许导出的参与记录。');
  f.circles.leave(circle.id, f.bob.id);
  assert.equal(f.circles.detail(circle.id, f.carol.id).membership.role, 'host');
  assert.equal(f.circles.detail(circle.id, f.bob.id).members.length, 0);
});

test('capacity is enforced and a fresh member becomes host after the last member leaves', t => {
  const f = fixture(t), circle = f.create(f.alice, { capacity: 2 });
  f.add(circle); assert.throws(() => f.add(circle, f.carol), code('circle_full'));
  f.circles.leave(circle.id, f.alice.id); f.circles.leave(circle.id, f.bob.id);
  assert.equal(f.add(circle, f.carol).membership.role, 'host');
});

test('unified account suspension removes effective membership, transfers host and respects global invitation preferences', async t => {
  const f = fixture(t, { StoreClass: KnowledgeStore }), circle = f.create(f.alice, { allowConnections: true });
  f.add(circle, f.bob, { allowConnections: true });
  assert.equal(f.circles.canConnect(f.alice.id, f.bob.id, circle.id), true);
  f.store.setPreferences(f.bob.id, { groupInvites: false }, 0);
  assert.equal(f.circles.canConnect(f.alice.id, f.bob.id, circle.id), false);
  f.store.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(f.alice.id);
  assert.equal(f.circles.rawMember(circle.id, f.alice.id), null);
  assert.equal(f.circles.detail(circle.id, f.bob.id).membership.role, 'host');
  assert.equal(f.circles.detail(circle.id, f.bob.id).memberCount, 1);
  await assert.rejects(() => f.send(circle, f.alice), code('session_expired'));
});

test('new rounds keep old question, messages and outcomes immutable; replies stay in their round', async t => {
  const f = fixture(t), circle = f.create(); f.add(circle);
  const first = await f.send(circle), oldRound = circle.currentRound.id;
  const outcome = f.circles.addOutcome(circle.id, f.alice.id, { title: '第一轮记录', content: '这份成果属于第一轮问题。', messageIds: [first.id] });
  assert.throws(() => f.circles.changePhase(circle.id, f.bob.id, oldRound, 'reviewing'), code('host_required'));
  f.circles.changePhase(circle.id, f.alice.id, oldRound, 'reviewing');
  f.circles.changePhase(circle.id, f.alice.id, oldRound, 'completed');
  const next = f.circles.nextRound(circle.id, f.alice.id, { question: '如何验证第二个不同的假设？', goal: '记录第二轮证据' });
  assert.equal(next.currentRound.number, 2); assert.equal(next.messages.length, 0);
  const previous = f.circles.detail(circle.id, f.bob.id, oldRound);
  assert.equal(previous.rounds[0].question, circle.currentRound.question); assert.equal(previous.messages[0].id, first.id); assert.equal(previous.outcomes[0].id, outcome.id);
  await assert.rejects(() => f.send(next, f.bob, '跨轮回复应被拒绝。', { replyTo: first.id }), code('reply_unavailable'));
  assert.throws(() => f.circles.editOutcome(circle.id, f.alice.id, outcome.id, { version: 1, content: '覆盖旧轮成果不应被允许。' }), code('round_readonly'));
});

test('concurrent message retries create exactly one message and reject changed text', async t => {
  const entered = defer(), release = defer(); let checked = 0;
  const f = fixture(t, { moderate: async () => { if (++checked === 2) entered.resolve(); await release.promise; return { allowed: true }; } });
  const circle = f.create(), data = { clientMessageId: 'same-request-uuid' };
  const a = f.send(circle, f.alice, '同一条发言的并发重试。', data), b = f.send(circle, f.alice, '同一条发言的并发重试。', data);
  await entered.promise; release.resolve(); const result = await Promise.all([a, b]);
  assert.equal(result[0].id, result[1].id); assert.equal(f.circles.page(circle.id, f.alice.id).messages.length, 1);
  await assert.rejects(() => f.send(circle, f.alice, '不同内容不能复用发送凭据。', data), code('client_message_conflict'));
});

for (const scenario of ['leave', 'session', 'round', 'reply']) test(`message write rechecks ${scenario} after moderation waits`, async t => {
  const entered = defer(), release = defer(); let gate = false;
  const f = fixture(t, { moderate: async () => { if (gate) { entered.resolve(); await release.promise; } return { allowed: true }; } });
  const circle = f.create(); f.add(circle); const original = await f.send(circle); gate = true;
  const sending = f.send(circle, f.bob, '审核等待期间不能继续越权。', scenario === 'reply' ? { replyTo: original.id } : {});
  const rejected = assert.rejects(sending, code(scenario === 'leave' ? 'membership_required' : scenario === 'session' ? 'session_expired' : scenario === 'reply' ? 'reply_unavailable' : 'round_readonly'));
  await entered.promise;
  if (scenario === 'leave') f.circles.leave(circle.id, f.bob.id);
  if (scenario === 'session') f.revoked.add(f.bob.id);
  if (scenario === 'reply') f.circles.hideMessage(circle.id, f.alice.id, original.id);
  if (scenario === 'round') { f.circles.changePhase(circle.id, f.alice.id, circle.currentRound.id, 'reviewing'); f.circles.changePhase(circle.id, f.alice.id, circle.currentRound.id, 'completed'); }
  release.resolve(); await rejected;
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM circle_messages').get().count, 1);
});

test('moderation denial or unknown decisions never deliver a human message', async t => {
  const f = fixture(t, { moderate: async () => ({ allowed: false, notice: '等待复核' }) }), circle = f.create();
  await assert.rejects(() => f.send(circle), code('message_not_allowed'));
  f.options.moderate = async () => ({});
  await assert.rejects(() => f.send(circle), code('message_not_allowed'));
  assert.equal(f.circles.page(circle.id, f.alice.id).messages.length, 0);
});

test('official result tokens bind user, circle and round, expire and cannot be replayed or forged', async t => {
  const f = fixture(t), circle = f.create(), other = f.create(); f.add(circle);
  const result = await f.circles.search(f.req(f.alice), circle.id, '知识检索');
  const token = result.items[0].searchResultToken;
  assert.throws(() => f.circles.addSource(circle.id, f.bob.id, { searchResultToken: token }), code('search_result_expired'));
  assert.throws(() => f.circles.addSource(other.id, f.alice.id, { searchResultToken: token }), code('search_result_expired'));
  const source = f.circles.addSource(circle.id, f.alice.id, { searchResultToken: token, title: '伪造标题', summary: '伪造官方正文' });
  assert.equal(source.title, '知识检索的适用条件'); assert.equal(source.scope, 'zhihu-search'); assert.match(source.summary, /摘要/);
  assert.throws(() => f.circles.addSource(circle.id, f.alice.id, { searchResultToken: token }), code('search_result_expired'));
  assert.throws(() => f.circles.addSource(circle.id, f.alice.id, { title: '伪造来源', url: 'https://www.zhihu.com/question/123', scope: 'zhihu-search' }), code('invalid_input'));
  const second = await f.circles.search(f.req(f.alice), circle.id, '知识检索'); f.advance(15 * 60000 + 1);
  assert.throws(() => f.circles.addSource(circle.id, f.alice.id, { searchResultToken: second.items[0].searchResultToken }), code('search_result_expired'));
  const third = await f.circles.search(f.req(f.alice), circle.id, '知识检索');
  f.circles.changePhase(circle.id, f.alice.id, circle.currentRound.id, 'archived'); f.circles.nextRound(circle.id, f.alice.id, { question: '如何开始下一轮不同的问题？', goal: '验证第二轮假设' });
  assert.throws(() => f.circles.addSource(circle.id, f.alice.id, { searchResultToken: third.items[0].searchResultToken }), code('search_result_expired'));
});

test('search rejects stale sessions after the external request without issuing a source receipt', async t => {
  const entered = defer(), release = defer();
  const f = fixture(t, { zhihu: { search: async () => { entered.resolve(); return release.promise; } } }), circle = f.create();
  const pending = f.circles.search(f.req(f.alice), circle.id, '测试搜索'), rejected = assert.rejects(pending, code('session_expired'));
  await entered.promise; f.revoked.add(f.alice.id); release.resolve({ items: [{ title: '未授权资料', url: 'https://www.zhihu.com/question/123' }] }); await rejected;
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM circle_search_receipts').get().count, 0);
});

test('external AI receives only explicitly consenting messages; local rules are labelled', async t => {
  const f = fixture(t), circle = f.create(); f.add(circle, f.bob, { aiConsent: false });
  await f.send(circle, f.alice, '已授权发送给外部 AI 的观点。'); await f.send(circle, f.bob, 'PRIVATE_NONCONSENT_MESSAGE');
  const generated = await f.circles.runAI(f.req(f.alice), circle.id, { action: 'summary' });
  assert.equal(generated.mode, 'model'); assert.equal(f.calls.length, 1); assert.equal(JSON.stringify(f.calls[0].payload).includes('PRIVATE_NONCONSENT_MESSAGE'), false);
  f.advance(30001);
  const local = await f.circles.runAI(f.req(f.bob), circle.id, { action: 'summary' });
  assert.equal(local.mode, 'rules'); assert.equal(f.calls.length, 1); assert.match(local.message.text, /不代表共识/);
});

test('invalid AI citations fall back without passing invented sources to clients', async t => {
  const f = fixture(t, { ai: { json: async () => ({ text: '凭空编出的观点【M99】', citedMessageIds: ['invented-message'], citedSourceIds: [] }) } }), circle = f.create();
  const message = await f.send(circle);
  const generated = await f.circles.runAI(f.req(f.alice), circle.id, { action: 'outcome' });
  assert.equal(generated.mode, 'rules'); assert.ok(generated.notice); assert.equal(generated.outcome.status, 'draft'); assert.equal(generated.message.citations[0].messageId, message.id); assert.equal(JSON.stringify(generated).includes('invented-message'), false);
});

test('uncited context dependencies protect AI message, outcome, revisions, editing and export', async t => {
  const f = fixture(t), circle = f.create(); f.add(circle); f.add(circle, f.carol);
  await f.send(circle, f.alice, '被模型实际引用的发言。'); const uncited = await f.send(circle, f.bob, '虽未引用也进入了模型上下文。');
  const generated = await f.circles.runAI(f.req(f.alice), circle.id, { action: 'outcome' });
  const outcome = f.circles.editOutcome(circle.id, f.alice.id, generated.outcome.id, { version: 1, status: 'reviewed' });
  assert.equal(outcome.reviewedBy, f.alice.id); assert.equal(f.circles.outcomeVersions(circle.id, f.alice.id, outcome.id).length, 2);
  const stored = f.store.db.prepare('SELECT dependency_ids FROM circle_messages WHERE id=?').get(generated.message.id);
  assert.ok(JSON.parse(stored.dependency_ids).includes(uncited.id));
  f.circles.block(circle.id, f.carol.id, f.bob.id);
  assert.equal(f.circles.detail(circle.id, f.carol.id).outcomes[0].redacted, true);
  assert.equal(f.circles.detail(circle.id, f.alice.id).outcomes[0].redacted, false);
  assert.throws(() => f.circles.exportOutcome(circle.id, f.carol.id, outcome.id), code('outcome_redacted'));
  assert.throws(() => f.circles.editOutcome(circle.id, f.carol.id, outcome.id, { version: 2, content: '不能通过编辑解除依赖权限。' }), code('outcome_redacted'));
  assert.ok(f.circles.outcomeVersions(circle.id, f.carol.id, outcome.id).every(version => version.redacted));
  f.circles.hideMessage(circle.id, f.alice.id, uncited.id);
  assert.equal(f.circles.detail(circle.id, f.alice.id).outcomes[0].redacted, true);
  assert.throws(() => f.circles.exportOutcome(circle.id, f.alice.id, outcome.id), code('outcome_redacted'));
});

test('deleting an uncited input source erases derived text and every saved revision', async t => {
  const f = fixture(t), circle = f.create(); await f.send(circle);
  const source = f.circles.addSource(circle.id, f.alice.id, { title: '实验观察', url: 'https://example.org/experiment', summary: '带入模型但未被直接引用的摘录。' });
  const generated = await f.circles.runAI(f.req(f.alice), circle.id, { action: 'outcome' });
  assert.deepEqual(generated.outcome.sourceIds, []);
  f.circles.editOutcome(circle.id, f.alice.id, generated.outcome.id, { version: 1, status: 'reviewed' });
  f.circles.deleteSource(circle.id, f.alice.id, source.id);
  assert.equal(f.store.db.prepare('SELECT text FROM circle_messages WHERE id=?').get(generated.message.id).text, '');
  assert.equal(f.store.db.prepare('SELECT content FROM circle_outcomes WHERE id=?').get(generated.outcome.id).content, '');
  assert.ok(f.store.db.prepare('SELECT snapshot FROM circle_outcome_versions').all().every(v => JSON.parse(v.snapshot).content === ''));
  assert.equal(f.circles.detail(circle.id, f.alice.id).sources.length, 0);
});

for (const revoke of ['consent', 'leave', 'hidden', 'close']) test(`AI rejects ${revoke} races after a model await`, async t => {
  const entered = defer(), release = defer(); let payload;
  const f = fixture(t, { ai: { json: async (system, data) => { payload = data; entered.resolve(); return release.promise; } } }), circle = f.create(); f.add(circle);
  const message = await f.send(circle, f.bob, '进入外部模型上下文的真人观点。');
  const pending = f.circles.runAI(f.req(f.alice), circle.id, { action: 'outcome' });
  const rejected = assert.rejects(pending, code(revoke === 'leave' ? 'membership_required' : revoke === 'close' ? 'circles_closed' : 'ai_context_changed'));
  await entered.promise;
  if (revoke === 'consent') f.circles.preferences(circle.id, f.alice.id, { aiConsent: false });
  if (revoke === 'leave') f.circles.leave(circle.id, f.alice.id);
  if (revoke === 'hidden') f.circles.hideMessage(circle.id, f.alice.id, message.id);
  if (revoke === 'close') f.circles.close();
  release.resolve(validModel(payload)); await rejected;
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM circle_messages WHERE kind='ai'").get().count, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM circle_outcomes').get().count, 0);
});

test('outcome edits use optimistic versions and reviewed means one named reviewer', async t => {
  const f = fixture(t), circle = f.create(); f.add(circle);
  const outcome = f.circles.addOutcome(circle.id, f.alice.id, { title: '可核对的成果', content: '第一版需要核对的内容。' });
  const reviewed = f.circles.editOutcome(circle.id, f.bob.id, outcome.id, { version: 1, status: 'reviewed' });
  assert.equal(reviewed.reviewedBy, f.bob.id); assert.match(f.circles.exportOutcome(circle.id, f.alice.id, outcome.id), /非全员共识/);
  assert.throws(() => f.circles.editOutcome(circle.id, f.alice.id, outcome.id, { version: 1, content: '过期页面提交不覆盖新版本。' }), code('outcome_version_conflict'));
  const edited = f.circles.editOutcome(circle.id, f.alice.id, outcome.id, { version: 2, content: '第二次修改正文后需要重新核对。' });
  assert.equal(edited.status, 'draft'); assert.equal(edited.reviewedBy, null); assert.equal(edited.version, 3);
});

test('host-only report resolution hides all derived content and does not expose reports to members', async t => {
  const f = fixture(t), circle = f.create(); f.add(circle);
  const message = await f.send(circle, f.bob), reportId = f.circles.report(circle.id, f.alice.id, { messageId: message.id, reason: '需要核查的具体举报原因' });
  assert.equal(f.circles.report(circle.id, f.alice.id, { messageId: message.id, reason: '重复举报无需新增记录' }), reportId);
  const generated = await f.circles.runAI(f.req(f.alice), circle.id, { action: 'outcome' });
  assert.throws(() => f.circles.reports(circle.id, f.bob.id), code('host_required'));
  assert.throws(() => f.circles.resolveReport(circle.id, f.bob.id, reportId, 'hide'), code('host_required'));
  f.circles.resolveReport(circle.id, f.alice.id, reportId, 'hide');
  assert.equal(f.circles.reports(circle.id, f.alice.id)[0].status, 'hidden');
  assert.throws(() => f.circles.exportOutcome(circle.id, f.alice.id, generated.outcome.id), code('outcome_redacted'));
});

test('circle connection requires both explicit permissions and delegates to the shared invitation service', async t => {
  const sent = [], f = fixture(t, { connect: async input => { sent.push(input); return { id: 'shared-invitation', status: 'pending', conversationId: null }; } }), circle = f.create(); f.add(circle);
  assert.equal(f.circles.canConnect(f.alice.id, f.bob.id, circle.id), false);
  f.circles.preferences(circle.id, f.alice.id, { allowConnections: true }); f.circles.preferences(circle.id, f.bob.id, { allowConnections: true });
  assert.equal(f.circles.canConnect(f.alice.id, f.bob.id, circle.id), true);
  const result = await f.circles.connect(f.req(f.alice), circle.id, { targetId: f.bob.id, message: '想继续讨论这个问题的适用条件。' });
  assert.equal(result.connection.status, 'pending'); assert.equal(sent.length, 1);
  f.circles.block(circle.id, f.bob.id, f.alice.id);
  assert.equal(f.circles.canConnect(f.alice.id, f.bob.id, circle.id), false);
  assert.equal(f.circles.blocked(circle.id, f.alice.id, f.bob.id), false, 'group visibility remains directed');
  await assert.rejects(() => f.circles.connect(f.req(f.alice), circle.id, { targetId: f.bob.id, message: '屏蔽后不能继续发起邀请。' }), code('connection_not_allowed'));
  f.circles.block(circle.id, f.bob.id, f.alice.id, false); f.store.block(f.alice.id, f.bob.id);
  assert.equal(f.circles.canConnect(f.alice.id, f.bob.id, circle.id), false);
});

test('notifications respect subscription, expiry and cooldown and contain no message text', async t => {
  const f = fixture(t), circle = f.create(); f.add(circle); f.add(circle, f.carol, { subscribed: false });
  await f.send(circle, f.alice, 'DO_NOT_INCLUDE_THIS_PRIVATE_MESSAGE_IN_NOTIFICATIONS'); await f.send(circle);
  assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].id, f.bob.id); assert.equal(JSON.stringify(f.notifications).includes('DO_NOT_INCLUDE'), false);
  assert.equal(f.notifications[0].href, `/#circles/${circle.id}`);
  f.circles.preferences(circle.id, f.bob.id, { subscribed: false }); f.advance(16 * 60000); await f.send(circle);
  assert.equal(f.notifications.length, 1);
});

test('profile evidence allows only active member-owned visible messages without others reply previews', async t => {
  const f = fixture(t), circle = f.create(); f.add(circle);
  const original = await f.send(circle, f.alice, '其他人的原始发言不得被当作本人材料。'), own = await f.send(circle, f.bob, '本人写下的观点。', { replyTo: original.id });
  assert.deepEqual(f.circles.profileEvidence(f.bob.id, circle.id, [own.id]), [{ id: own.id, text: '本人写下的观点。' }]);
  assert.throws(() => f.circles.profileEvidence(f.bob.id, circle.id, [original.id]), code('profile_evidence_unavailable'));
  f.circles.hideMessage(circle.id, f.alice.id, own.id);
  assert.throws(() => f.circles.profileEvidence(f.bob.id, circle.id, [own.id]), code('profile_evidence_unavailable'));
  f.circles.leave(circle.id, f.bob.id);
  assert.throws(() => f.circles.profileEvidence(f.bob.id, circle.id, []), code('membership_required'));
});

test('unread state is scoped to a round and viewing public discovery never marks it read', async t => {
  const f = fixture(t), circle = f.create(); f.add(circle); const message = await f.send(circle);
  assert.equal(f.circles.summary(circle.id, f.bob.id).unreadCount, 1); f.circles.list(f.bob.id);
  assert.equal(f.circles.summary(circle.id, f.bob.id).unreadCount, 1);
  f.circles.markRead(circle.id, f.bob.id, { messageId: message.id }); assert.equal(f.circles.summary(circle.id, f.bob.id).unreadCount, 0);
  await f.send(circle); assert.equal(f.circles.summary(circle.id, f.bob.id).unreadCount, 1);
});

test('deletion scrubs owned messages, source text and dependent snapshots before the user FK disappears', async t => {
  const f = fixture(t), circle = f.create(); f.add(circle);
  const message = await f.send(circle, f.alice, 'SENSITIVE_OWN_CONTENT');
  f.circles.addSource(circle.id, f.alice.id, { title: '本人提供资料', url: 'https://example.org/private', summary: 'SENSITIVE_SOURCE' });
  const output = await f.circles.runAI(f.req(f.bob), circle.id, { action: 'outcome' });
  f.circles.editOutcome(circle.id, f.bob.id, output.outcome.id, { version: 1, status: 'reviewed' });
  f.circles.deleteUser(f.alice.id); f.store.db.prepare('DELETE FROM users WHERE id=?').run(f.alice.id);
  assert.equal(f.store.db.prepare('SELECT text FROM circle_messages WHERE id=?').get(message.id).text, '');
  assert.equal(f.circles.detail(circle.id, f.bob.id).membership.role, 'host');
  assert.equal(f.circles.detail(circle.id, f.bob.id).outcomes[0].redacted, true);
  assert.ok(f.store.db.prepare('SELECT snapshot FROM circle_outcome_versions').all().every(v => !v.snapshot.includes('SENSITIVE_')));
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('automation state survives SQLite reopening and only summarizes 20 new messages at low frequency', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tongzhi-circles-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, { path: join(dir, 'test.sqlite') }), circle = f.create();
  f.circles.settings(circle.id, f.alice.id, { autoSummary: true });
  for (let i = 0; i < 20; i++) await f.send(circle, f.alice, `第 ${i + 1} 条具体实践反馈，需要核对条件。`);
  await f.circles.runMaintenance(); assert.equal(f.calls.length, 1);
  f.circles.close();
  const reopenedStore = new Store(join(dir, 'test.sqlite'));
  const reopened = new Circles({ ...f.options, store: reopenedStore });
  t.after(() => { reopened.close(); reopenedStore.close(); });
  f.advance(31 * 60000); await reopened.runMaintenance(); assert.equal(f.calls.length, 1, 'reopening must not reprocess an already summarized range');
  for (let i = 0; i < 19; i++) await reopened.sendMessage(f.req(f.alice), circle.id, { text: `后续第 ${i + 1} 条新的观察反馈。`, clientMessageId: `second-wave-${i}` });
  await reopened.runMaintenance(); assert.equal(f.calls.length, 1);
  await reopened.sendMessage(f.req(f.alice), circle.id, { text: '第二十条新的观察反馈。', clientMessageId: 'second-wave-final' });
  await reopened.runMaintenance(); assert.equal(f.calls.length, 2);
  reopened.close(); await reopened.runMaintenance(); assert.equal(f.calls.length, 2);
});
