import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildProfile } from '../server/matching.js';
import { ruleIcebreakers } from '../server/ai.js';
import { DEFAULT_INPUT } from '../shared/catalog.js';
import { json, startService, testConfig } from './helpers.js';

const firstInput = { ...DEFAULT_INPUT, name: '虚构观测者', topicIds: ['space', 'physics', 'math'], about: '', question: '观测与解释之间的距离是什么？' };
const secondInput = { ...DEFAULT_INPUT, name: '虚构求证者', topicIds: ['physics', 'math', 'biology'], about: '', question: '一种现象怎样让你改变了最初的猜想？' };
const generatedQuestions = [
  '最近有没有一个与数学或物理有关的小发现，让你很想和别人聊一聊？',
  '面对同一种观测结果，你通常会怎样判断哪一个解释更值得相信？',
  '要不要各自选一篇关于科学思考的文章，交换一个赞同的观点和一个疑问？',
];
const source = { id: 'source-1', title: '从观察到解释', summary: '讨论观察、猜想与验证之间的关系。', author: '虚构作者', url: 'https://www.zhihu.com/question/1', scope: '搜索摘要' };
const modelConfig = () => {
  const config = testConfig();
  config.ai = { configured: true, key: 'fictional-context-model-key', baseUrl: 'https://model.fixture.invalid/v1', model: 'fixture-model', protocol: 'openai', timeoutMs: 1000, jsonMode: true };
  return config;
};
const completion = answer => json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
const messageCount = store => store.db.prepare('SELECT COUNT(*) AS count FROM messages').get().count;

async function participants(service, { inputA = firstInput, inputB = secondInput, accepted = true, visible = false, aiConsent = true } = {}) {
  const a = service.client(), b = service.client();
  const aid = (await a.bootstrap()).user.id, bid = (await b.bootstrap()).user.id;
  service.store.saveProfile(aid, buildProfile(inputA), 0); service.store.saveProfile(bid, buildProfile(inputB), 0);
  if (visible || !accepted) { service.store.setDiscoverable(aid, true); service.store.setDiscoverable(bid, true); }
  const id = accepted ? service.store.connectPairing(randomUUID(), aid, bid, 1, 1) : service.store.invite(aid, bid, '一个虚构的待处理邀请');
  if (aiConsent) for (const uid of [aid,bid]) service.store.db.prepare('INSERT INTO conversation_ai_consents VALUES (?,?,1,1,?)').run(id,uid,new Date().toISOString());
  return { a, b, aid, bid, id, get: `/api/conversations/${id}/context`, post: `/api/conversations/${id}/icebreakers` };
}

function deferred() {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  return { started, release, async wait() { entered(); await gate; } };
}

test('opening a private accepted conversation returns three real-profile suggestions without model, search or message writes', async t => {
  let externalCalls = 0, modelCalls = 0, searchCalls = 0;
  const service = await startService(t, { fetchImpl: async () => { externalCalls++; throw new Error('No external calls are permitted in this test'); } });
  t.mock.method(service.ai, 'icebreakers', async () => { modelCalls++; throw new Error('GET must be offline'); });
  t.mock.method(service.zhihu, 'search', async () => { searchCalls++; throw new Error('GET must be offline'); });
  const peers = await participants(service);
  for (const userId of [peers.aid, peers.bid]) {
    const profile = service.store.profile(userId);
    profile.evidence = [{ id: 'private', text: 'CANARY_CONTEXT_RAW_EVIDENCE' }];
    profile.input.hidden = 'CANARY_CONTEXT_INPUT_EXTRA';
    service.store.db.prepare('UPDATE profiles SET data = ? WHERE user_id = ?').run(JSON.stringify(profile), userId);
    service.store.saveImports(userId, [{ title: 'CANARY_CONTEXT_RAW_IMPORT', summary: 'CANARY_CONTEXT_RAW_IMPORT' }]);
  }
  const replies = [];
  for (let i = 0; i < 4; i++) replies.push(await peers.a.request(peers.get));
  for (const response of replies) {
    assert.equal(response.status, 200); assert.equal(response.data.mode, 'rules'); assert.equal(response.data.questions.length, 3);
    assert.deepEqual(Object.keys(response.data).sort(), ['mode', 'questions', 'reasons', 'shared', 'aiConsent', 'generated', 'autoGenerate', 'generationKey'].sort());
    assert.deepEqual(response.data.shared.map(item => item.id).sort(), ['math', 'physics']);
    assert.ok(response.data.shared.every(item => Object.keys(item).sort().join(',') === 'id,label'));
    assert.equal(response.data.reasons.length, 3); assert.ok(response.data.questions[1].includes(secondInput.question));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const serialized = JSON.stringify(response.data);
    for (const value of ['CANARY_CONTEXT_RAW_EVIDENCE', 'CANARY_CONTEXT_INPUT_EXTRA', 'CANARY_CONTEXT_RAW_IMPORT', '"vector"', '"evidence"', DEFAULT_INPUT.question]) assert.ok(!serialized.includes(value));
  }
  assert.deepEqual(replies[0].data, replies[3].data);
  const other = await peers.b.request(peers.get);
  assert.equal(other.status, 200); assert.ok(other.data.questions[1].includes(firstInput.question));
  assert.equal(service.store.profile(peers.aid).discoverable, false); assert.equal(service.store.profile(peers.bid).discoverable, false);
  assert.equal(externalCalls, 0); assert.equal(modelCalls, 0); assert.equal(searchCalls, 0); assert.equal(messageCount(service.store), 0);
});

test('disjoint interests remain an empty intersection with three honest fallback questions', async t => {
  const service = await startService(t);
  const peers = await participants(service, {
    inputA: { ...firstInput, topicIds: ['ai', 'coding', 'product'], question: '' },
    inputB: { ...secondInput, topicIds: ['music', 'film', 'design'], question: '' },
  });
  const response = await peers.a.request(peers.get);
  assert.equal(response.status, 200); assert.deepEqual(response.data.shared, []); assert.equal(response.data.questions.length, 3);
  assert.match(response.data.reasons[0], /具体兴趣不同/); assert.match(response.data.questions[0], /^看到你对/);
  assert.doesNotMatch(response.data.questions[0], /也对/);
  const generated = await peers.a.request(peers.post, { method: 'POST' });
  assert.equal(generated.status, 200); assert.equal(generated.data.mode, 'rules'); assert.equal(generated.data.questions.length, 3);
  assert.deepEqual(generated.data.questions, response.data.questions); assert.deepEqual(generated.data.sources, []);
  assert.equal(messageCount(service.store), 0);
});

test('both endpoints reject strangers, pending invitations, missing conversations, blocked users and expired sessions', async t => {
  const service = await startService(t), peers = await participants(service, { accepted: false });
  let searchCalls = 0, modelCalls = 0;
  t.mock.method(service.zhihu, 'search', async () => { searchCalls++; return { items: [], notice: null }; });
  t.mock.method(service.ai, 'icebreakers', async () => { modelCalls++; return { mode: 'rules', questions: generatedQuestions, sourceIds: [] }; });
  const anonymous = service.client(), stranger = service.client(); await stranger.bootstrap();
  for (const [path, method] of [[peers.get, 'GET'], [peers.post, 'POST']]) {
    assert.equal((await anonymous.request(path, { method })).status, 401);
    assert.equal((await stranger.request(path, { method })).status, 404);
    assert.equal((await peers.a.request(path, { method })).status, 404);
    assert.equal((await peers.b.request(path, { method })).status, 404);
  }
  assert.equal((await peers.a.request('/api/conversations/demo-yu/context')).status, 404);
  assert.equal((await peers.a.request('/api/conversations/missing/icebreakers', { method: 'POST' })).status, 404);
  service.store.respond(peers.bid, peers.id, 'accept');
  assert.equal((await peers.a.request(peers.get)).status, 200);
  assert.equal((await peers.a.request(peers.post, { method: 'POST', headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await peers.a.request(peers.post, { method: 'POST', headers: { origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await peers.a.request(peers.get, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  service.store.block(peers.bid, peers.aid);
  for (const client of [peers.a, peers.b]) {
    assert.equal((await client.request(peers.get)).status, 404);
    assert.equal((await client.request(peers.post, { method: 'POST' })).status, 404);
  }
  service.store.endSession(peers.a.jar.get('tongzhi_session'));
  assert.equal((await peers.a.request(peers.get)).status, 401);
  assert.equal((await peers.a.request(peers.post, { method: 'POST' })).status, 401);
  assert.equal(searchCalls, 0); assert.equal(modelCalls, 0); assert.equal(messageCount(service.store), 0);
});

test('missing real profiles return a controlled error instead of substituting a sample profile', async t => {
  const service = await startService(t), peers = await participants(service);
  service.store.db.prepare('DELETE FROM profiles WHERE user_id = ?').run(peers.bid);
  for (const [path, method] of [[peers.get, 'GET'], [peers.post, 'POST']]) {
    const response = await peers.a.request(path, { method });
    assert.equal(response.status, 409); assert.equal(response.data.error.code, 'conversation_profile_required');
    assert.equal(response.data.questions, undefined);
  }
  service.store.deleteAccount(peers.bid);
  assert.equal((await peers.a.request(peers.get)).status, 404);
});

test('explicit icebreakers call search and the model with selected context and return the existing source contract', async t => {
  const requests = [], searches = [];
  const service = await startService(t, { config: modelConfig(), fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return completion({ questions: generatedQuestions, sourceIds: [source.id] });
  } });
  t.mock.method(service.zhihu, 'search', async query => {
    searches.push(query);
    return { items: [{ ...source, privateExtra: 'CANARY_PROVIDER_EXTRA' }, { ...source, id: 'bad', url: 'https://untrusted.invalid/data' }], notice: null };
  });
  const peers = await participants(service);
  for (const userId of [peers.aid, peers.bid]) {
    const profile = service.store.profile(userId);
    profile.evidence = [{ text: 'CANARY_POST_RAW_EVIDENCE' }]; profile.input.hidden = 'CANARY_POST_RAW_INPUT';
    service.store.db.prepare('UPDATE profiles SET data = ? WHERE user_id = ?').run(JSON.stringify(profile), userId);
  }
  assert.equal((await peers.a.request(peers.get)).status, 200); assert.equal(requests.length, 0); assert.equal(searches.length, 0);
  const response = await peers.a.request(peers.post, { method: 'POST' });
  assert.equal(response.status, 200); assert.equal(response.data.mode, 'model'); assert.deepEqual(response.data.questions, generatedQuestions);
  assert.deepEqual(response.data.sourceIds, [source.id]); assert.deepEqual(response.data.sources, [source]); assert.equal(response.data.sourceNotice, null);
  assert.equal(requests.length, 1); assert.equal(searches.length, 1); assert.match(searches[0], /数学之美/); assert.match(searches[0], /物理学/);
  const payload = JSON.parse(requests[0].messages[1].content);
  assert.deepEqual(payload.commonInterests.map(item => item.id).sort(), ['math', 'physics']);
  assert.equal(payload.myQuestion, firstInput.question); assert.equal(payload.partner.question, secondInput.question);
  for (const marker of ['CANARY_POST_RAW_EVIDENCE', 'CANARY_POST_RAW_INPUT', 'CANARY_PROVIDER_EXTRA', '"vector"', DEFAULT_INPUT.question]) {
    assert.ok(!JSON.stringify(payload).includes(marker)); assert.ok(!JSON.stringify(response.data).includes(marker));
  }
  assert.equal(messageCount(service.store), 0);
});

test('model and search failures provide three usable rule questions without leaking provider errors', async t => {
  const service = await startService(t, { config: modelConfig(), fetchImpl: async () => json({ error: 'CANARY_MODEL_CREDENTIAL' }, 502) });
  t.mock.method(service.zhihu, 'search', async () => { throw new Error('CANARY_SEARCH_CREDENTIAL'); });
  const peers = await participants(service);
  const defaults = (await peers.a.request(peers.get)).data;
  const response = await peers.a.request(peers.post, { method: 'POST' });
  assert.equal(response.status, 200); assert.equal(response.data.mode, 'rules'); assert.deepEqual(response.data.questions, defaults.questions);
  assert.deepEqual(response.data.sources, []); assert.deepEqual(response.data.sourceIds, []);
  assert.match(response.data.notice, /暂时不可用/); assert.match(response.data.sourceNotice, /暂时不可用/);
  assert.ok(!JSON.stringify(response.data).includes('CANARY_'));
  t.mock.method(service.ai, 'icebreakers', async () => { throw new Error('CANARY_UNEXPECTED_MODEL_FAILURE'); });
  const unexpected = await peers.a.request(peers.post, { method: 'POST' });
  assert.equal(unexpected.status, 200); assert.equal(unexpected.data.questions.length, 3); assert.ok(!JSON.stringify(unexpected.data).includes('CANARY_'));
  assert.equal(messageCount(service.store), 0);
});

test('invalid model output is disclosed as rules and never introduces unverified source IDs', async t => {
  const service = await startService(t, { config: modelConfig(), fetchImpl: async () => completion({ questions: generatedQuestions, sourceIds: ['not-a-given-source'] }) });
  t.mock.method(service.zhihu, 'search', async () => ({ items: [source], notice: null }));
  const peers = await participants(service);
  const response = await peers.a.request(peers.post, { method: 'POST' });
  assert.equal(response.status, 200); assert.equal(response.data.mode, 'rules'); assert.equal(response.data.questions.length, 3);
  assert.deepEqual(response.data.sourceIds, []); assert.match(response.data.notice, /校验/);
  assert.equal(messageCount(service.store), 0);
});

test('manual icebreakers use the shared per-user limiter without limiting passive context reads', async t => {
  const service = await startService(t), peers = await participants(service); let searches = 0, models = 0;
  t.mock.method(service.zhihu, 'search', async () => { searches++; return { items: [], notice: null }; });
  t.mock.method(service.ai, 'icebreakers', async () => { models++; return { mode: 'rules', questions: generatedQuestions, sourceIds: [] }; });
  for (let i = 0; i < 12; i++) {
    assert.equal((await peers.a.request(peers.post, { method: 'POST' })).status, 200);
    service.store.db.prepare('DELETE FROM conversation_icebreakers WHERE conversation_id=?').run(peers.id);
  }
  const limited = await peers.a.request(peers.post, { method: 'POST' });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(searches, 12); assert.equal(models, 12);
  assert.equal((await peers.a.request(peers.get)).status, 200);
  assert.equal((await peers.b.request(peers.post, { method: 'POST' })).status, 200);
  assert.equal(searches, 13); assert.equal(models, 13); assert.equal(messageCount(service.store), 0);
});

const revocations = [
  { name: 'logout', status: 401, code: 'session_expired', async apply(_service, peers) {
    assert.equal((await peers.a.request('/api/logout', { method: 'POST' })).status, 200);
  } },
  { name: 'own account deletion', status: 401, code: 'session_expired', async apply(_service, peers) {
    assert.equal((await peers.a.request('/api/account', { method: 'DELETE', body: { confirm: 'delete' } })).status, 200);
  } },
  { name: 'partner account deletion', status: 404, code: 'conversation_missing', async apply(_service, peers) {
    assert.equal((await peers.b.request('/api/account', { method: 'DELETE', body: { confirm: 'delete' } })).status, 200);
  } },
  { name: 'partner blocking', status: 404, code: 'conversation_missing', async apply(_service, peers) {
    assert.equal((await peers.b.request(`/api/blocked/${peers.aid}`, { method: 'POST' })).status, 200);
  } },
  { name: 'accepted relationship cancellation', status: 404, code: 'conversation_missing', async apply(service, peers) {
    service.store.db.prepare("UPDATE invitations SET status = 'cancelled' WHERE id = ?").run(peers.id);
  } },
  { name: 'own profile revision', status: 409, code: 'conversation_profile_changed', async apply(service, peers) {
    const profile = service.store.profile(peers.aid);
    assert.equal((await peers.a.request('/api/profile', { method: 'POST', body: { input: { ...profile.input, question: '关于新问题，我想听到什么解释？' }, revision: profile.revision, useAI: false } })).status, 200);
  } },
  { name: 'partner profile revision', status: 409, code: 'conversation_profile_changed', async apply(service, peers) {
    const profile = service.store.profile(peers.bid);
    assert.equal((await peers.b.request('/api/profile', { method: 'POST', body: { input: { ...profile.input, question: '观察一件新事物时应该先问什么？' }, revision: profile.revision, useAI: false } })).status, 200);
  } },
];

for (const stage of ['search', 'model']) {
  test(`permissions and both profile revisions are rechecked after awaited ${stage}`, async t => {
    for (const revoke of revocations) await t.test(revoke.name, async t => {
      const service = await startService(t), peers = await participants(service), pause = deferred();
      t.after(pause.release);
      let modelCalls = 0;
      t.mock.method(service.zhihu, 'search', async () => {
        if (stage === 'search') await pause.wait();
        return { items: [source], notice: null };
      });
      t.mock.method(service.ai, 'icebreakers', async () => {
        modelCalls++;
        if (stage === 'model') await pause.wait();
        return { mode: 'model', questions: generatedQuestions, sourceIds: [source.id] };
      });
      const pending = peers.a.request(peers.post, { method: 'POST' });
      await pause.started;
      await revoke.apply(service, peers);
      pause.release();
      const response = await pending;
      assert.equal(response.status, revoke.status); assert.equal(response.data.error.code, revoke.code);
      assert.equal(response.data.questions, undefined); assert.equal(response.data.sources, undefined);
      assert.equal(modelCalls, stage === 'search' ? 0 : 1); assert.equal(messageCount(service.store), 0);
    });
  });
}

test('a discovery visibility change during generation does not revoke an already accepted connection', async t => {
  const service = await startService(t), peers = await participants(service, { visible: true }), pause = deferred();
  t.after(pause.release);
  t.mock.method(service.zhihu, 'search', async () => ({ items: [], notice: null }));
  t.mock.method(service.ai, 'icebreakers', async (_own, match) => { await pause.wait(); return { mode: 'rules', questions: ruleIcebreakers(match), sourceIds: [] }; });
  const pending = peers.a.request(peers.post, { method: 'POST' });
  await pause.started;
  assert.equal((await peers.a.request('/api/profile/visibility', { method: 'POST', body: { discoverable: false } })).status, 200);
  assert.equal((await peers.b.request('/api/profile/visibility', { method: 'POST', body: { discoverable: false } })).status, 200);
  pause.release();
  const response = await pending;
  assert.equal(response.status, 200); assert.equal(response.data.questions.length, 3); assert.equal(messageCount(service.store), 0);
});

test('AI context requires both individual consents and caches results without sending messages', async t => {
  const service = await startService(t), peers = await participants(service,{aiConsent:false});
  let calls = 0;
  t.mock.method(service.zhihu,'search',async () => ({items:[source]}));
  t.mock.method(service.ai,'icebreakers',async () => { calls++; return {mode:'model',questions:generatedQuestions,sourceIds:[source.id]}; });
  const before = await peers.a.request(peers.get);
  assert.deepEqual(before.data.aiConsent,{mine:false,other:false});
  assert.equal(before.data.autoGenerate,false);
  assert.equal((await peers.a.request(peers.post,{method:'POST'})).status,403);
  const path = `/api/conversations/${peers.id}/ai-consent`;
  assert.equal((await peers.a.request(path,{method:'POST',body:{enabled:true}})).data.autoGenerate,false);
  assert.equal((await peers.a.request(peers.post,{method:'POST'})).status,403);
  assert.equal((await peers.b.request(path,{method:'POST',body:{enabled:true}})).data.autoGenerate,true);
  const result = await peers.a.request(peers.post,{method:'POST'});
  assert.equal(result.status,200); assert.equal(result.data.mode,'model');
  assert.deepEqual((await peers.a.request(peers.post,{method:'POST'})).data,result.data);
  assert.deepEqual((await peers.a.request(peers.get)).data.generated,result.data);
  assert.equal(calls,1); assert.equal(messageCount(service.store),0);
  assert.equal((await peers.b.request(path,{method:'POST',body:{enabled:false}})).status,200);
  assert.equal((await peers.a.request(peers.get)).data.generated,null);
  assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM conversation_icebreakers').get().n,0);
});

for (const stage of ['search','model']) test(`AI context discards pending ${stage} after either participant withdraws`, async t => {
  const service = await startService(t), peers = await participants(service), gate = deferred();
  t.after(gate.release);
  t.mock.method(service.zhihu,'search',async () => { if (stage==='search') await gate.wait(); return {items:[source]}; });
  t.mock.method(service.ai,'icebreakers',async () => { if (stage==='model') await gate.wait(); return {mode:'model',questions:generatedQuestions,sourceIds:[source.id]}; });
  const pending = peers.a.request(peers.post,{method:'POST'}); await gate.started;
  assert.equal((await peers.b.request(`/api/conversations/${peers.id}/ai-consent`,{method:'POST',body:{enabled:false}})).status,200);
  gate.release();
  const result = await pending;
  assert.equal(result.status,409); assert.equal(result.data.error.code,'conversation_consent_changed');
  assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM conversation_icebreakers').get().n,0);
});

test('accepted group peers without knowledge profiles use only their recorded common question', async t => {
  const service = await startService(t), peers = await participants(service,{aiConsent:false});
  service.store.db.prepare('INSERT INTO connection_context VALUES (?,?,?,?,?)').run(peers.id,'circle','fictional-previous-group','如何比较两种学习方法的效果？',new Date().toISOString());
  service.store.db.prepare('DELETE FROM profiles WHERE user_id IN (?,?)').run(peers.aid,peers.bid);
  const result = await peers.a.request(peers.get);
  assert.equal(result.status,200); assert.deepEqual(result.data.shared,[]);
  assert.match(result.data.questions[1],/如何比较两种学习方法/);
  assert.doesNotMatch(JSON.stringify(result.data),/CANARY|体验人物|示例画像/);
});
