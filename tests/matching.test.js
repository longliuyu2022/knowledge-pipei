import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, publicProfile, compareProfiles, cosine, SAMPLE_PROFILE } from '../server/matching.js';
import { DEFAULT_INPUT, TOPIC_MAP } from '../shared/catalog.js';
import { capabilities } from '../server/config.js';
import { testConfig } from './helpers.js';

test('topic evidence retains declared selections and only counts whole English keyword matches', () => {
  const profile = buildProfile({ ...DEFAULT_INPUT, topicIds: ['reading', 'history', 'food'], about: 'Taking the train to Spain.', question: '' });
  assert.equal(profile.interests.some(t => t.id === 'ai'), false);
  const imported = buildProfile({ ...DEFAULT_INPUT, topicIds: ['reading', 'history', 'food'], about: '', question: '' }, [{ title: '人工智能怎样影响学习', summary: '关于 AI 和教育的摘要', kind: 'contents', url: 'https://www.zhihu.com/question/1' }]);
  assert.ok(imported.interests.some(t => t.id === 'ai'));
  assert.equal(imported.evidence.find(e => e.id === 'import:0').kind, 'contents');
  assert.ok(imported.evidenceIds.every(id => imported.evidence.some(e => e.id === id)));
  assert.ok(imported.interests.every(t => TOPIC_MAP.has(t.id)));
});

test('matching weights have reproducible contributions and complement mode values an anchored new perspective', () => {
  const mine = buildProfile({ ...DEFAULT_INPUT, about: '', question: '', topicIds: ['ai', 'reading', 'philosophy'] });
  const identical = publicProfile(mine, { id: 'same' });
  const different = publicProfile(buildProfile({ ...mine.input, topicIds: ['ai', 'design', 'product'] }), { id: 'new' });
  const sameResonance = compareProfiles(mine, identical), sameComplement = compareProfiles(mine, identical, 'complement');
  const newComplement = compareProfiles(mine, different, 'complement');
  assert.equal(sameResonance.score, 100);
  assert.equal(sameResonance.shared.length, 3);
  assert.ok(newComplement.breakdown[0].value > sameComplement.breakdown[0].value);
  assert.ok(newComplement.shared.some(t => t.id === 'ai'));
  assert.ok(newComplement.newTopics.length > 0);
  for (const match of [sameResonance, sameComplement, newComplement]) {
    assert.equal(match.score, Math.round(match.breakdown.reduce((sum, p) => sum + p.value * p.weight, 0) / 100));
    assert.equal(match.breakdown.reduce((sum, p) => sum + p.weight, 0), 100);
  }
});

test('cosine safely handles invalid, negative, zero and very large vectors without NaN scores', () => {
  assert.equal(cosine([], []), 0); assert.equal(cosine([1], [1, 2]), 0);
  assert.equal(cosine([NaN, 1], [1, 2]), 0); assert.equal(cosine([0, 0], [1, 2]), 0);
  assert.equal(cosine([1, 1], [-1, -1]), 0);
  assert.ok(Math.abs(cosine([1e308, 1e308], [1e308, 1e308]) - 1) < 1e-12);
});

test('public profiles omit imported evidence and private revisions; capability flags never disclose credentials', () => {
  const profile = publicProfile(SAMPLE_PROFILE, { id: 'test', subject: 'secret-identity', provider: 'zhihu' });
  for (const field of ['input', 'evidence', 'evidenceIds', 'subject', 'revision', 'discoverable']) assert.equal(profile[field], undefined);
  const config = testConfig({ SOUL_AI_ENABLED: 'true', SOUL_AI_API_KEY: 'test-key', SOUL_AI_MODEL: 'test-model', SOUL_AI_BASE_URL: 'https://model.invalid/v1', SOUL_AI_JSON_MODE: 'true', SOUL_AI_DISABLE_THINKING: 'true' });
  const flags = capabilities(config);
  assert.equal(flags.ai, true); assert.equal(flags.embedding, false); assert.equal(flags.oauth, false);
  assert.ok(Object.values(flags).every(v => typeof v === 'boolean'));
  assert.equal(config.ai.jsonMode, true); assert.equal(config.ai.disableThinking, true);
});
