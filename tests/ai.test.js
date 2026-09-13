import test from 'node:test';
import assert from 'node:assert/strict';
import { Intelligence, parseModelJSON } from '../server/ai.js';
import { SAMPLE_PROFILE, DEMO_PROFILES, compareProfiles } from '../server/matching.js';
import { testConfig, json, startService } from './helpers.js';

const profileAnswer = () => ({
  title: '跨界知识探索者', summary: '你同时关注技术的变化与人的思考，喜欢从阅读和哲学中寻找可以继续追问的线索，也期待有耐心的知识交流。',
  highlights: ['关注人工智能与提问的关系', '把阅读和哲学作为新的观察角度'], evidenceIds: ['topic:ai', 'topic:reading'],
});
const completion = answer => json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] });
const configured = ({ embedding = false, ...ai } = {}) => {
  const config = testConfig();
  config.ai = { configured: true, key: 'test-model-key', baseUrl: 'https://model.invalid', model: 'test-model', protocol: 'openai', timeoutMs: 1000, jsonMode: true, disableThinking: true, ...ai };
  if (embedding) config.embedding = { configured: true, key: 'test-vector-key', baseUrl: 'https://model.invalid/v1', model: 'test-embedding' };
  return config;
};
const match = compareProfiles(SAMPLE_PROFILE, DEMO_PROFILES[0]);

test('model JSON parser accepts a single fenced object and rejects malformed, non-object or oversized output', () => {
  assert.deepEqual(parseModelJSON('```json\n{"value":1}\n```'), { value: 1 });
  for (const value of ['[]', 'null', 'true', '{broken', 'before {"value":1}', 'x'.repeat(24001), undefined]) {
    assert.throws(() => parseModelJSON(value), error => error.reason === 'invalid_output');
  }
});

test('OpenAI-compatible requests use configured JSON/thinking options and preserve validated evidence', async () => {
  const requests = [];
  const intelligence = new Intelligence(configured(), { fetchImpl: async (url, options) => { requests.push({ url: String(url), options }); return completion(profileAnswer()); } });
  const profile = await intelligence.enrichProfile(SAMPLE_PROFILE);
  assert.equal(profile.analysis.mode, 'model'); assert.deepEqual(profile.evidenceIds, ['topic:ai', 'topic:reading']);
  assert.equal(requests[0].url, 'https://model.invalid/v1/chat/completions');
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body.response_format, { type: 'json_object' }); assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.stream, false); assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-model-key');
  assert.equal(JSON.stringify(profile).includes('test-model-key'), false);
  const skipped = await intelligence.enrichProfile(SAMPLE_PROFILE, false);
  assert.equal(skipped.analysis.mode, 'rules'); assert.equal(requests.length, 1);
});

test('profile generation rejects unknown or duplicate-only references, invented links and empty model claims', async () => {
  for (const change of [
    { evidenceIds: ['topic:ai', 'not-provided'] }, { evidenceIds: ['topic:ai', 'topic:ai'] },
    { highlights: ['AI 兴趣', ''] }, { summary: `${profileAnswer().summary} https://invented.invalid/article` },
  ]) {
    const intelligence = new Intelligence(configured(), { fetchImpl: async () => completion({ ...profileAnswer(), ...change }) });
    const profile = await intelligence.enrichProfile(SAMPLE_PROFILE);
    assert.equal(profile.analysis.mode, 'rules'); assert.match(profile.analysis.notice, /校验/);
    assert.equal(profile.title, SAMPLE_PROFILE.title);
  }
});

test('explanations and icebreakers reject forged topic/source references and preserve honest fallback content', async () => {
  const validExplanation = { reasons: ['你们都在追问人工智能与人的关系', '你们偏好让问题慢慢展开的交流方式', '产品角度能让哲学问题落到一个具体场景'], bridge: '如果一个工具能回答所有问题，你会如何判断它是否真的理解了你的期待？', sharedTopicIds: match.shared.map(p => p.id) };
  const good = new Intelligence(configured(), { fetchImpl: async () => completion(validExplanation) });
  assert.equal((await good.explain(SAMPLE_PROFILE, match)).mode, 'model');
  const bad = new Intelligence(configured(), { fetchImpl: async () => completion({ ...validExplanation, sharedTopicIds: ['invented'] }) });
  const explained = await bad.explain(SAMPLE_PROFILE, match);
  assert.equal(explained.mode, 'rules'); assert.deepEqual(explained.reasons, match.reasons);
  const sources = [{ id: 'source-1', title: '提问为什么重要', summary: '关于技术与人如何提出问题的搜索摘要', url: 'https://www.zhihu.com/question/1' }];
  const questions = ['最近你遇见过一个让自己很想继续探索的问题吗？', '如果让你设计一个真正理解提问者的工具，你会从哪个场景开始？', '要不要各自选一篇关于人工智能的文章，交换一个还没想通的问题？'];
  const validIce = new Intelligence(configured(), { fetchImpl: async () => completion({ questions, sourceIds: ['source-1'] }) });
  assert.deepEqual((await validIce.icebreakers(SAMPLE_PROFILE, match, sources)).sourceIds, ['source-1']);
  const invalidIce = new Intelligence(configured(), { fetchImpl: async () => completion({ questions, sourceIds: ['source-2'] }) });
  const fallback = await invalidIce.icebreakers(SAMPLE_PROFILE, match, sources);
  assert.equal(fallback.mode, 'rules'); assert.deepEqual(fallback.sourceIds, []); assert.equal(fallback.questions.length, 3);
  const noShared = await new Intelligence(testConfig()).icebreakers(SAMPLE_PROFILE, { ...match, shared: [] });
  assert.match(noShared.questions[0], /^看到你对/);
  assert.doesNotMatch(noShared.questions[0], /也对/);
});

test('unconfigured, upstream errors, timeout and invalid output are disclosed as rules; 429 triggers cooldown', async () => {
  let calls = 0;
  const absent = new Intelligence(testConfig(), { fetchImpl: async () => { calls++; throw new Error(); } });
  assert.match((await absent.enrichProfile(SAMPLE_PROFILE)).analysis.notice, /没有调用/); assert.equal(calls, 0);
  for (const [fetchImpl, notice] of [
    [async () => json({ error: { message: 'test-model-key' } }, 502), /暂时不可用/],
    [async () => { throw new DOMException('slow', 'TimeoutError'); }, /超时/],
    [async () => new Response('{invalid', { status: 200 }), /校验/],
    [async () => json({ choices: [{ message: { content: 'not json' } }] }), /校验/],
  ]) {
    const result = await new Intelligence(configured(), { fetchImpl }).enrichProfile(SAMPLE_PROFILE);
    assert.equal(result.analysis.mode, 'rules'); assert.match(result.analysis.notice, notice);
    assert.equal(JSON.stringify(result).includes('test-model-key'), false);
  }
  const limited = new Intelligence(configured(), { fetchImpl: async () => { calls++; return json({}, 429); } });
  assert.match((await limited.enrichProfile(SAMPLE_PROFILE)).analysis.notice, /繁忙/);
  assert.equal((await limited.explain(SAMPLE_PROFILE, match)).mode, 'rules'); assert.equal(calls, 1);
});

test('model calls deduplicate concurrent identical requests and privacy cache clearing survives an in-flight result', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const intelligence = new Intelligence(configured(), { fetchImpl: async () => { calls++; await gate; return completion(profileAnswer()); } });
  const first = intelligence.enrichProfile(SAMPLE_PROFILE), second = intelligence.enrichProfile(SAMPLE_PROFILE);
  assert.equal(calls, 1);
  intelligence.clearCache(); release();
  assert.equal((await first).analysis.mode, 'model'); assert.deepEqual(await first, await second);
  assert.equal(intelligence.cache.size, 0);
  await intelligence.enrichProfile(SAMPLE_PROFILE); assert.equal(calls, 2);
  await intelligence.enrichProfile(SAMPLE_PROFILE); assert.equal(calls, 2);
});

test('model requests enforce both two active calls and five requests per rolling minute', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const intelligence = new Intelligence(configured(), { fetchImpl: async () => { calls++; await gate; return completion({ ok: true }); } });
  const a = intelligence.generate('system', { id: 1 }), b = intelligence.generate('system', { id: 2 });
  await assert.rejects(intelligence.generate('system', { id: 3 }), error => error.reason === 'busy');
  assert.equal(calls, 2); release(); await Promise.all([a, b]);
  for (let i = 0; i < 3; i++) await intelligence.generate('system', { id: i + 3 });
  await assert.rejects(intelligence.generate('system', { id: 6 }), error => error.reason === 'busy');
  assert.equal(calls, 5); assert.equal(intelligence.active, 0);
});

test('Anthropic and complete OpenAI endpoints retain their protocol and accept text blocks', async () => {
  const calls = [];
  const anthropic = new Intelligence(configured({ protocol: 'anthropic', baseUrl: 'https://model.invalid/anthropic' }), { fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return json({ content: [{ type: 'text', text: JSON.stringify(profileAnswer()) }] }); } });
  assert.equal((await anthropic.enrichProfile(SAMPLE_PROFILE)).analysis.mode, 'model');
  assert.equal(calls[0].url, 'https://model.invalid/anthropic/v1/messages');
  assert.equal(calls[0].options.headers['x-api-key'], 'test-model-key'); assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(JSON.parse(calls[0].options.body).response_format, undefined);
  const full = new Intelligence(configured({ baseUrl: 'https://model.invalid/v1/chat/completions' }), { fetchImpl: async (url) => { assert.equal(String(url), 'https://model.invalid/v1/chat/completions'); return completion(profileAnswer()); } });
  assert.equal((await full.enrichProfile(SAMPLE_PROFILE)).analysis.mode, 'model');
});

test('optional embeddings stay off unless explicitly configured and deduplicate text across concurrent pools', async () => {
  let calls = 0, release; const gate = new Promise(resolve => { release = resolve; });
  const disabled = new Intelligence(configured(), { fetchImpl: async () => { calls++; } });
  assert.equal(await disabled.semanticScores(SAMPLE_PROFILE, DEMO_PROFILES), null); assert.equal(calls, 0);
  const seen = [];
  const intelligence = new Intelligence(configured({ embedding: true }), { fetchImpl: async (url, options) => {
    calls++; const body = JSON.parse(options.body); seen.push(...body.input);
    assert.equal(String(url), 'https://model.invalid/v1/embeddings');
    assert.equal(options.headers.Authorization, 'Bearer test-vector-key');
    await gate; return json({ data: body.input.map((text, index) => ({ index, embedding: [text.length, 1, text.includes('AI') ? 4 : 2] })) });
  } });
  const a = intelligence.semanticScores(SAMPLE_PROFILE, [DEMO_PROFILES[0], DEMO_PROFILES[0]]);
  const same = intelligence.semanticScores(SAMPLE_PROFILE, [DEMO_PROFILES[0]]);
  const overlap = intelligence.semanticScores(SAMPLE_PROFILE, [DEMO_PROFILES[1]]);
  assert.equal(calls, 2); assert.equal(seen.length, 3); assert.equal(new Set(seen).size, 3);
  release(); const [first, again, other] = await Promise.all([a, same, overlap]);
  assert.equal(first[0], first[1]); assert.equal(first[0], again[0]); assert.ok(other[0] >= 0 && other[0] <= 1);
  await intelligence.semanticScores(SAMPLE_PROFILE, [DEMO_PROFILES[0]]); assert.equal(calls, 2);
});

test('embeddings reject incomplete, duplicate-index, zero or inconsistent vectors and honor the shared request limit', async () => {
  const invalid = [
    [{ index: 0, embedding: [1, 2] }],
    [{ index: 0, embedding: [1, 2] }, { index: 0, embedding: [2, 3] }],
    [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [0, 0] }],
    [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [2, 3, 4] }],
    [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [2, null] }],
  ];
  for (const data of invalid) {
    const intelligence = new Intelligence(configured({ embedding: true }), { fetchImpl: async () => json({ data }) });
    assert.equal(await intelligence.semanticScores(SAMPLE_PROFILE, [DEMO_PROFILES[0]]), null);
    assert.equal(intelligence.embeddingCache.size, 0);
  }
  let calls = 0;
  const intelligence = new Intelligence(configured({ embedding: true }), { fetchImpl: async (_url, options) => { calls++; return json({ data: JSON.parse(options.body).input.map((_text, index) => ({ index, embedding: [1, 2] })) }); } });
  for (let i = 0; i < 5; i++) assert.ok(await intelligence.semanticScores(SAMPLE_PROFILE, [{ ...DEMO_PROFILES[0], about: `不同测试文本 ${i}` }]));
  assert.equal(await intelligence.semanticScores(SAMPLE_PROFILE, [{ ...DEMO_PROFILES[0], about: '第六次请求' }]), null);
  await assert.rejects(intelligence.generate('system', {}), error => error.reason === 'busy');
  assert.equal(calls, 5);
});

test('matching API reports the actual embedding algorithm and falls back to topics with a notice on failure', async t => {
  let fail = false;
  const service = await startService(t, { config: configured({ embedding: true }), fetchImpl: async (_url, options) => fail ? json({}, 502) : json({ data: JSON.parse(options.body).input.map((_text, index) => ({ index, embedding: [index + 1, 2] })) }) });
  const client = service.client(); await client.bootstrap();
  const actual = await client.request('/api/matches');
  assert.equal(actual.data.algorithm, 'embedding'); assert.ok(actual.data.matches.every(p => p.algorithm === 'embedding'));
  service.ai.clearCache(); fail = true;
  const fallback = await client.request('/api/matches');
  assert.equal(fallback.data.algorithm, 'topics'); assert.ok(fallback.data.matches.every(p => p.algorithm === 'topics')); assert.match(fallback.data.notice, /暂时不可用/);
});
