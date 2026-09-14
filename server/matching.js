import { DOMAINS, TOPICS, TOPIC_MAP, STYLES, GOALS, DEFAULT_INPUT } from '../shared/catalog.js';
import { personaFor } from '../shared/personas.js';

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let scaleA = 0, scaleB = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return 0;
    scaleA = Math.max(scaleA, Math.abs(a[i])); scaleB = Math.max(scaleB, Math.abs(b[i]));
  }
  if (!scaleA || !scaleB) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] / scaleA, y = b[i] / scaleB;
    dot += x * y; aa += x ** 2; bb += y ** 2;
  }
  return aa && bb ? Math.max(0, Math.min(1, dot / Math.sqrt(aa * bb))) : 0;
}

export function buildProfile(input, imports = []) {
  const evidence = input.topicIds.map(id => ({ id: `topic:${id}`, label: TOPIC_MAP.get(id).label, kind: 'selected', text: `你主动选择了「${TOPIC_MAP.get(id).label}」`, topicIds: [id] }));
  const weights = Object.fromEntries(input.topicIds.map(id => [id, 3]));
  const texts = [
    ...(input.about ? [{ id: 'about', title: '你的一句话介绍', text: input.about, kind: 'written' }] : []),
    ...(input.question ? [{ id: 'question', title: '你正在好奇的问题', text: input.question, kind: 'written' }] : []),
    ...imports.map((item, index) => ({ id: `import:${index}`, title: item.title, text: `${item.title} ${item.summary}`, url: item.url, kind: item.kind })),
  ];
  for (const item of texts) {
    const text = item.text.toLowerCase();
    const hits = TOPICS.filter(topic => topic.keywords.some(keyword => {
      if (/^[a-z]+$/i.test(keyword)) return new RegExp(`(?:^|[^a-z])${keyword}(?:$|[^a-z])`, 'i').test(text);
      return text.includes(keyword);
    }));
    for (const topic of hits) weights[topic.id] = Math.min(6, (weights[topic.id] || 0) + (item.kind === 'written' ? 1 : .65));
    evidence.push({ id: item.id, label: item.title, text: item.text.slice(0, 420), kind: item.kind, url: item.url, topicIds: hits.map(topic => topic.id) });
  }
  const interests = Object.entries(weights).map(([id, weight]) => ({ id, label: TOPIC_MAP.get(id).label, weight })).sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const vector = DOMAINS.map((_, axis) => interests.reduce((sum, topic) => sum + TOPIC_MAP.get(topic.id).vector[axis] * topic.weight, 0));
  const max = Math.max(...vector, 1);
  const dimensions = DOMAINS.map((domain, axis) => ({ ...domain, value: Math.round(vector[axis] / max * 100) }));
  const topDomains = [...dimensions].sort((a, b) => b.value - a.value);
  const titleMap = { tech: '未来的跨界探索者', humanities: '日常里的深度思考者', arts: '捕捉灵感的观察者', science: '追问万物的好奇家', life: '热爱日常的发现者', growth: '把好奇变成行动的人' };
  const title = personaFor(input)?.name || titleMap[topDomains[0].id];
  const labels = interests.slice(0, 3).map(t => t.label);
  const style = STYLES.find(s => s.id === input.styleId) || STYLES[0];
  return {
    input: { ...input }, title,
    summary: `你的好奇心连接着${labels.join('、')}。比起匆匆交换结论，你更期待${style.id === 'deep' ? '沿着一个好问题，慢慢理解彼此的想法' : style.id === 'spark' ? '让不同的脑洞相遇，发现意料之外的联系' : '从具体的经历出发，把想法变成可以尝试的行动'}。`,
    highlights: [`${labels[0]}是你主动选择的探索方向`, `偏好${style.short}，期待${input.goals.map(id => GOALS.find(g => g.id === id)?.short).join('与')}`],
    interests, dimensions, vector, style: { id: style.id, label: style.short, values: [...style.values] },
    evidence, evidenceIds: evidence.filter(e => e.kind === 'selected').slice(0, 3).map(e => e.id),
    analysis: { mode: 'rules', notice: '依据你选择的兴趣和主动提供的文字整理。' },
  };
}

export function publicProfile(profile, identity) {
  const { input, title, summary, highlights, interests, dimensions, vector, style, analysis } = profile;
  return {
    id: identity.id, name: input.name, provider: identity.provider || 'guest',
    avatar: identity.avatar || '', avatarSeed: identity.avatarSeed || identity.id,
    about: input.about, question: input.question, goals: input.goals,
    selectedTopicIds: input.topicIds, title, summary, highlights, interests, dimensions, vector, style,
    analysis: { mode: analysis.mode }, demo: Boolean(identity.demo),
  };
}

export function compareProfiles(own, candidate, mode = 'resonance', semanticScore = null) {
  const mine = new Set(own.interests.map(t => t.id));
  const theirs = new Set(candidate.interests.map(t => t.id));
  const shared = own.interests.filter(topic => theirs.has(topic.id)).map(topic => ({ id: topic.id, label: topic.label }));
  const all = new Set([...mine, ...theirs]);
  let numerator = 0, denominator = 0;
  for (const id of all) {
    const a = own.interests.find(t => t.id === id)?.weight || 0;
    const b = candidate.interests.find(t => t.id === id)?.weight || 0;
    numerator += Math.min(a, b); denominator += Math.max(a, b);
  }
  const overlap = denominator ? numerator / denominator : 0;
  const topicScore = semanticScore === null ? cosine(own.vector, candidate.vector) : semanticScore;
  const styleScore = 1 - own.style.values.reduce((sum, n, i) => sum + Math.abs(n - candidate.style.values[i]), 0) / (4 * 100);
  const ownGoals = own.input?.goals || own.goals;
  const commonGoals = ownGoals.filter(goal => candidate.goals.includes(goal));
  const goalScore = commonGoals.length / Math.max(ownGoals.length, candidate.goals.length, 1);
  const complementScore = shared.length ? Math.min(1, (1 - overlap) * .65 + topicScore * .35) : (1 - topicScore) * .4;
  const breakdown = mode === 'complement' ? [
    { id: 'perspective', label: '视角互补', value: complementScore, weight: .35 },
    { id: 'anchor', label: '共同兴趣', value: overlap, weight: .25 },
    { id: 'style', label: '交流节奏', value: styleScore, weight: .25 },
    { id: 'goal', label: '交流期待', value: goalScore, weight: .15 },
  ] : [
    { id: 'topic', label: semanticScore === null ? '知识领域' : '语义共鸣', value: topicScore, weight: .45 },
    { id: 'interest', label: '具体兴趣', value: overlap, weight: .20 },
    { id: 'style', label: '交流节奏', value: styleScore, weight: .20 },
    { id: 'goal', label: '交流期待', value: goalScore, weight: .15 },
  ];
  const displayedBreakdown = breakdown.map(p => ({ ...p, value: Math.round(p.value * 100), weight: p.weight * 100 }));
  const score = Math.round(displayedBreakdown.reduce((sum, part) => sum + part.value * part.weight, 0) / 100);
  const newTopics = candidate.interests.filter(t => !mine.has(t.id)).slice(0, 2);
  const sharedText = shared.slice(0, 2).map(t => t.label).join('与');
  const reasons = [
    shared.length ? `你们的好奇心在${sharedText}交汇` : '你们的具体兴趣不同，可以先从各自最近的发现聊起',
    own.style.id === candidate.style.id ? `都喜欢${candidate.style.label}，给想法留一点展开的空间` : `对方偏好${candidate.style.label}，可以试着交换一种讨论方式`,
    newTopics.length ? `TA 的${newTopics.map(t => t.label).join('、')}视角，可能为你打开一扇新窗口` : '共同的兴趣比较多，适合围绕一个具体问题深入交流',
  ];
  return { ...candidate, score, shared, newTopics, reasons, breakdown: displayedBreakdown, matchingMode: mode, algorithm: semanticScore === null ? 'topics' : 'embedding' };
}

export const demoInputs = [
  { id: 'demo-yu', name: '林屿', topicIds: ['ai', 'psychology', 'product', 'reading', 'philosophy'], about: '做产品，也读心理学。最近在研究 AI 时代，人怎样保留自己的判断。', question: 'AI 可以模仿共情，但它真的理解人吗？', styleId: 'deep', goals: ['conversation', 'learning'], title: '理性里的浪漫主义者' },
  { id: 'demo-wan', name: '许晚', topicIds: ['psychology', 'reading', 'philosophy', 'society', 'film'], about: '相信每个普通人的日常，都藏着值得认真听的故事。读书时习惯追问一句为什么。', question: '我们喜欢一本书，是在理解作者，还是在寻找自己？', styleId: 'deep', goals: ['conversation', 'learning'], title: '人间故事的收藏家' },
  { id: 'demo-zhou', name: '周予安', topicIds: ['ai', 'coding', 'product', 'games', 'design'], about: '把脑洞写成代码。喜欢独立游戏，也在尝试做有温度的 AI 小工具。', question: '如果只做一个功能，什么样的工具会让你每天打开？', styleId: 'hands-on', goals: ['building', 'learning'], title: '把脑洞变成现实的人' },
  { id: 'demo-tang', name: '唐小满', topicIds: ['space', 'physics', 'philosophy', 'reading', 'photography'], about: '白天研究粒子，晚上拍星星。着迷于科学解释不了一切，却总能提出更好的问题。', question: '知道宇宙有多大之后，日常的小烦恼会变小吗？', styleId: 'deep', goals: ['conversation', 'learning'], title: '仰望星空的提问者' },
  { id: 'demo-qiao', name: '乔木', topicIds: ['design', 'product', 'psychology', 'photography', 'travel'], about: '设计学生，城市漫游爱好者。习惯从路牌、长椅和咖啡杯里发现被忽略的细节。', question: '一座让人愿意停留的城市，应该长什么样？', styleId: 'spark', goals: ['conversation', 'building'], title: '捕捉日常的灵感雷达' },
  { id: 'demo-shen', name: '沈知行', topicIds: ['education', 'career', 'business', 'ai', 'psychology'], about: '在实习和学习之间寻找自己的节奏。喜欢拆解复杂问题，也分享真实的踩坑经历。', question: '比起学更多东西，我们怎样判断什么值得学？', styleId: 'hands-on', goals: ['learning', 'building'], title: '知行合一的探索者' },
  { id: 'demo-lu', name: '陆青禾', topicIds: ['nature', 'biology', 'travel', 'reading', 'society'], about: '在山野里认识植物，在书里认识世界。相信有些答案，走出去才会遇见。', question: '城市生活里，我们还能怎样重新认识自然？', styleId: 'spark', goals: ['conversation', 'learning'], title: '走进世界的观察者' },
  { id: 'demo-gu', name: '顾弦', topicIds: ['music', 'film', 'reading', 'history', 'philosophy'], about: '在电影和音乐里寻找时代的回声。想和人认真聊一张专辑，也愿意从零了解你的热爱。', question: '一段没有歌词的音乐，为什么也能讲好一个故事？', styleId: 'deep', goals: ['conversation'], title: '听见弦外之音的人' },
];

export const DEMO_PROFILES = demoInputs.map(({ id, title, ...input }) => {
  const profile = buildProfile(input); profile.title = title;
  return publicProfile(profile, { id, demo: true, provider: 'demo' });
});
export const SAMPLE_PROFILE = buildProfile(DEFAULT_INPUT);
