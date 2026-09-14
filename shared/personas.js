// Explicit self-description, separate from interest weights and matching scores.
export const PERSONA_DRIVES = [
  { id: 'truth', label: '求真', description: '理解世界如何运转', value: '你选择把理解原因放在前面。一个说得通的解释，可能比一个现成结论更让你满足。', strength: '把模糊的问题拆成可以讨论的部分，并愿意核对依据。', blindSpot: '想把事情彻底想清楚时，会不会错过先试一步的机会？', action: '选一个最近反复思考的问题，写下已知、未知，以及今天能验证的一件事。' },
  { id: 'explore', label: '探索', description: '发现未知与可能', value: '你选择为未知留出空间。比起重复熟悉的路线，你可能更愿意看看还有没有别的可能。', strength: '发现不显眼的新线索，让讨论走向意料之外的方向。', blindSpot: '新鲜感退去后，你是否仍愿意给一个方向足够的时间？', action: '从最近收藏的内容中只选一条，花二十分钟深入了解，并记录一个新发现。' },
  { id: 'empathy', label: '共情', description: '理解人与感受', value: '你选择把理解人的处境放在前面。对你而言，一件事如何发生，也包括其中的人如何感受。', strength: '给不同经历留出解释空间，注意到结论背后的具体处境。', blindSpot: '理解他人时，你有没有把自己的需要也说出来？', action: '下次交流时，先问对方想被倾听还是一起找办法，再表达一个自己的需要。' },
  { id: 'create', label: '创造', description: '把想法变成现实', value: '你选择让想法落地。一个可以试用的小作品，可能比长久停留在讨论里更让你有获得感。', strength: '把抽象的设想变成具体的尝试，让别人也能参与和反馈。', blindSpot: '急着推进时，有没有先确认大家想解决的是同一个问题？', action: '把一个想法缩小成一小时能完成的版本，邀请一位伙伴试用并提出一个改进。' },
];

export const PERSONA_CONNECTIONS = [
  { id: 'solo', label: '独立沉淀', description: '先自己想一想，再分享发现', relation: '你选择先留出独处与整理的空间。可以让伙伴知道，你需要一些时间再回应。', tension: '既想保留自己的节奏，又希望被理解时，可以先分享尚未完善的一小段想法。' },
  { id: 'duo', label: '深度交流', description: '在认真来回的对话里靠近', relation: '你选择在有来有回的交流中展开想法。约定一个具体话题，可能更容易进入状态。', tension: '期待聊得深入时，也可以确认对方此刻是否有精力，不必把一次简短回应理解为疏远。' },
  { id: 'group', label: '群体联结', description: '让更多不同的视角相遇', relation: '你选择让多种声音相遇。给安静的伙伴留一点准备时间，有助于听到更多不同的想法。', tension: '照顾讨论气氛与表达自己的意见并不总是同步，可以先明确这一次你最想说的一件事。' },
];

/** @type {Array<[string, string, string, string, string[]]>} */
const definitions = [
  ['truth', 'solo', '人间观察员', '习惯退后一步，研究人间怎么运转。', ['留心日常', '独立思考', '追问原因']],
  ['truth', 'duo', '问题拆解师', '你说“好复杂”，我说“我们拆开看”。', ['拆解问题', '认真求证', '一起想透']],
  ['truth', 'group', '观点切磋家', '好聊的标准，是彼此都有新发现。', ['交换观点', '欢迎追问', '越聊越明白']],
  ['explore', 'solo', '冷门收藏家', '越少人知道，越想一探究竟。', ['小众好奇', '自行寻宝', '慢慢深挖']],
  ['explore', 'duo', '脑洞搭子', '你说“有没有可能”，我说“走，试试”。', ['接住脑洞', '结伴探索', '不设剧本']],
  ['explore', 'group', '新世界体验官', '人生这么大，总得多开几张地图。', ['尝试新鲜', '分享见闻', '打开地图']],
  ['empathy', 'solo', '情绪显微镜', '别人略过的那句话，我会多想一会儿。', ['留意感受', '在意细节', '慢慢消化']],
  ['empathy', 'duo', '深夜接话人', '你的长篇大论，我真的会看完。', ['认真听完', '在意细节', '慢热但走心']],
  ['empathy', 'group', '人间连接器', '总能发现，你俩应该认识一下。', ['看见彼此', '牵起话题', '让人靠近']],
  ['create', 'solo', '平行宇宙设计师', '现实只有一版，我脑子里还有七版。', ['独立构想', '细节想象', '另一个可能']],
  ['create', 'duo', '灵感合伙人', '你带来半个想法，我们一起把它做出来。', ['一起打磨', '灵感接力', '动手试试']],
  ['create', 'group', '开坑召集人', '有个想法，就差几个一起动手的人。', ['发起尝试', '邀请共创', '边做边学']],
];

export const PERSONAS = definitions.map(([driveId, connectionId, name, tagline, keywords]) => ({
  id: `${driveId}-${connectionId}`, driveId, connectionId, name, tagline, keywords,
}));

/** @param {{ personaDrive?: string, personaConnection?: string }} input */
export function personaFor(input) {
  return PERSONAS.find(item => item.driveId === input.personaDrive && item.connectionId === input.personaConnection) || null;
}

/** @param {{ personaDrive?: string, personaConnection?: string }} input */
export function personaAnalysis(input) {
  const drive = PERSONA_DRIVES.find(item => item.id === input.personaDrive);
  const connection = PERSONA_CONNECTIONS.find(item => item.id === input.personaConnection);
  if (!drive || !connection) return [];
  return [
    { title: '我在乎什么', text: drive.value },
    { title: '我如何建立关系', text: connection.relation },
    { title: '可以发挥的优势', text: `这个方向值得你对照自己的经历：${drive.strength}` },
    { title: '值得留意的盲点', text: drive.blindSpot },
    { title: '可能的内在拉扯', text: connection.tension },
    { title: '这周试一件小事', text: drive.action },
  ];
}
