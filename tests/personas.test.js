import test from 'node:test';
import assert from 'node:assert/strict';
import { PERSONAS, PERSONA_DRIVES, PERSONA_CONNECTIONS, personaFor, personaAnalysis } from '../shared/personas.js';
import { DEFAULT_INPUT } from '../shared/catalog.js';
import { buildProfile, publicProfile, compareProfiles } from '../server/matching.js';
import { validateProfile } from '../server/app.js';
import { Intelligence } from '../server/ai.js';
import { startService, testConfig } from './helpers.js';

test('all twelve explicit combinations generate distinct titles without changing match scores', () => {
  const base = buildProfile(DEFAULT_INPUT), partner = publicProfile(base, { id: 'partner' });
  const names = new Set();
  for (const drive of PERSONA_DRIVES) for (const connection of PERSONA_CONNECTIONS) {
    const input = { ...DEFAULT_INPUT, personaDrive: drive.id, personaConnection: connection.id };
    const profile = buildProfile(validateProfile(input));
    const persona = personaFor(input);
    names.add(profile.title);
    assert.equal(profile.title, persona.name);
    assert.equal(persona.keywords.length, 3);
    assert.equal(personaAnalysis(input).length, 6);
    assert.equal(compareProfiles(profile, partner).score, compareProfiles(base, partner).score);
    assert.equal(publicProfile(profile, { id: 'owner' }).title, persona.name);
  }
  assert.equal(names.size, 12);
  assert.equal(PERSONAS.length, 12);
});

test('legacy and partial profiles do not silently infer a persona; invalid selections are rejected', () => {
  assert.equal(personaFor(DEFAULT_INPUT), null);
  assert.equal(personaFor({ personaDrive: 'truth' }), null);
  assert.deepEqual(personaAnalysis({}), []);
  assert.deepEqual(validateProfile(DEFAULT_INPUT), DEFAULT_INPUT);
  for (const value of ['unknown', '', null, [], {}, 42]) {
    assert.throws(() => validateProfile({ ...DEFAULT_INPUT, personaDrive: value }), error => error.code === 'invalid_persona');
    assert.throws(() => validateProfile({ ...DEFAULT_INPUT, personaConnection: value }), error => error.code === 'invalid_persona');
  }
});

test('AI narrative preserves an explicitly selected persona title', async () => {
  const ai = new Intelligence(testConfig());
  ai.generate = async () => ({ title: '模型自拟的探索者', summary: '这是依据用户主动提供的兴趣整理的具体观察，保留真实的交流期待。', highlights: ['喜欢人工智能相关的讨论', '愿意在阅读里发现新的问题'], evidenceIds: ['topic:ai', 'topic:reading'] });
  const profile = buildProfile({ ...DEFAULT_INPUT, personaDrive: 'empathy', personaConnection: 'duo' });
  const enriched = await ai.enrichProfile(profile);
  assert.equal(enriched.analysis.mode, 'model');
  assert.equal(enriched.title, '深夜接话人');
});

test('persona selection persists through the API, can be changed and can be cleared', async t => {
  const service = await startService(t), client = service.client();
  const first = await client.profile('人格测试', false, { personaDrive: 'empathy', personaConnection: 'duo' });
  assert.equal(first.title, '深夜接话人');
  assert.equal((await client.bootstrap()).profile.input.personaDrive, 'empathy');
  const next = await client.profile('人格测试', false, { personaDrive: 'create', personaConnection: 'solo' });
  assert.equal(next.title, '平行宇宙设计师');
  assert.equal(next.revision, first.revision + 1);
  const cleared = await client.profile('人格测试', false);
  assert.equal(personaFor(cleared.input), null);
  assert.equal(cleared.input.personaDrive, undefined);
});
