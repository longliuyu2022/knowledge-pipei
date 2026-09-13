export const DOMAINS = [
  { id: 'tech', label: '科技探索', color: '#8981dd' },
  { id: 'humanities', label: '人文思辨', color: '#d5947c' },
  { id: 'arts', label: '艺术审美', color: '#cf99b6' },
  { id: 'science', label: '科学好奇', color: '#82abb5' },
  { id: 'life', label: '生活观察', color: '#8ba88a' },
  { id: 'growth', label: '成长实践', color: '#c3aa76' },
];

export const TOPICS = [
  { id: 'ai', label: '人工智能', domain: 'tech', keywords: ['人工智能', '大模型', '机器学习', 'ai', 'agent', '智能体'], vector: [1, .2, .25, .45, 0, .35] },
  { id: 'coding', label: '编程技术', domain: 'tech', keywords: ['编程', '开发', '代码', '软件', '计算机', '算法'], vector: [1, 0, 0, .45, 0, .4] },
  { id: 'product', label: '产品设计', domain: 'tech', keywords: ['产品', '交互', '用户体验', '设计思维', '原型'], vector: [.8, .25, .6, 0, .25, .6] },
  { id: 'games', label: '游戏世界', domain: 'tech', keywords: ['游戏', '玩家', '独立游戏', '关卡'], vector: [.6, .3, .65, .15, .3, .1] },
  { id: 'psychology', label: '心理学', domain: 'humanities', keywords: ['心理学', '认知', '情绪', '行为', '心理'], vector: [.15, 1, 0, .45, .65, .2] },
  { id: 'philosophy', label: '哲学思辨', domain: 'humanities', keywords: ['哲学', '思辨', '存在', '意义', '伦理', '自由意志'], vector: [.1, 1, .2, .2, .35, 0] },
  { id: 'society', label: '社会观察', domain: 'humanities', keywords: ['社会', '人类学', '社会学', '观察', '文化'], vector: [0, 1, .2, 0, .65, .15] },
  { id: 'history', label: '历史', domain: 'humanities', keywords: ['历史', '古代', '文明', '考古', '史学'], vector: [0, 1, .35, .15, .3, 0] },
  { id: 'reading', label: '阅读与写作', domain: 'arts', keywords: ['阅读', '读书', '写作', '文学', '小说', '诗歌'], vector: [0, .75, 1, 0, .4, .15] },
  { id: 'film', label: '电影', domain: 'arts', keywords: ['电影', '导演', '影像', '纪录片', '影评'], vector: [.15, .45, 1, 0, .35, 0] },
  { id: 'photography', label: '摄影', domain: 'arts', keywords: ['摄影', '相机', '拍照', '镜头'], vector: [.35, .1, 1, .15, .65, 0] },
  { id: 'music', label: '音乐', domain: 'arts', keywords: ['音乐', '唱片', '乐器', '古典乐', '爵士'], vector: [.1, .25, 1, .2, .5, 0] },
  { id: 'design', label: '艺术与设计', domain: 'arts', keywords: ['艺术', '美术', '建筑', '平面设计', '审美'], vector: [.2, .35, 1, 0, .45, .2] },
  { id: 'space', label: '宇宙与天文', domain: 'science', keywords: ['宇宙', '天文', '星空', '太空', '航天', '星球'], vector: [.45, .3, .2, 1, .05, 0] },
  { id: 'physics', label: '物理学', domain: 'science', keywords: ['物理', '量子', '相对论', '力学', '粒子'], vector: [.5, .2, 0, 1, 0, .1] },
  { id: 'biology', label: '生命科学', domain: 'science', keywords: ['生物', '生命科学', '演化', '基因', '生态'], vector: [.2, .3, 0, 1, .5, 0] },
  { id: 'math', label: '数学之美', domain: 'science', keywords: ['数学', '概率', '统计', '几何', '逻辑'], vector: [.6, .2, .2, 1, 0, .2] },
  { id: 'travel', label: '旅行与城市', domain: 'life', keywords: ['旅行', '城市', '旅游', '徒步', '地理'], vector: [0, .45, .4, .2, 1, .1] },
  { id: 'nature', label: '自然与户外', domain: 'life', keywords: ['自然', '户外', '山野', '植物', '观鸟'], vector: [0, .1, .35, .65, 1, 0] },
  { id: 'sports', label: '运动', domain: 'life', keywords: ['运动', '跑步', '骑行', '游泳', '篮球'], vector: [0, 0, .1, .25, 1, .5] },
  { id: 'food', label: '食物与生活', domain: 'life', keywords: ['食物', '美食', '烹饪', '咖啡', '生活'], vector: [0, .15, .35, .15, 1, .2] },
  { id: 'career', label: '职业成长', domain: 'growth', keywords: ['职业', '成长', '实习', '工作', '职场', '就业'], vector: [.2, .35, 0, 0, .5, 1] },
  { id: 'business', label: '商业与经济', domain: 'growth', keywords: ['商业', '经济', '创业', '管理', '市场'], vector: [.3, .45, .1, .15, .35, 1] },
  { id: 'education', label: '学习与教育', domain: 'growth', keywords: ['学习', '教育', '教学', '知识', '课程'], vector: [.25, .65, .15, .25, .35, 1] },
];

export const GOALS = [
  { id: 'conversation', label: '来一场深度对话', short: '深度交流', description: '从一个问题出发，认真交换看法' },
  { id: 'learning', label: '一起学习新东西', short: '共同学习', description: '分享好内容，也交换不一样的视角' },
  { id: 'building', label: '一起做点有趣的事', short: '合作创造', description: '把共同的好奇心变成一个小作品' },
];

export const STYLES = [
  { id: 'deep', label: '慢慢聊，往深处想', short: '深度慢聊', description: '愿意花时间，把一个问题聊透', values: [90, 75, 60, 40] },
  { id: 'spark', label: '脑洞碰撞，轻松交流', short: '灵感碰撞', description: '喜欢新视角，随时打开一个新话题', values: [55, 45, 95, 75] },
  { id: 'hands-on', label: '从例子出发，边做边聊', short: '实践交流', description: '带着具体经历，一起找到下一步', values: [65, 85, 70, 90] },
];

export const STYLE_AXES = ['思考深度', '实证偏好', '探索广度', '行动倾向'];
export const TOPIC_MAP = new Map(TOPICS.map(topic => [topic.id, topic]));
export const DEFAULT_INPUT = {
  name: '好奇的你',
  topicIds: ['ai', 'psychology', 'reading', 'product', 'philosophy'],
  about: '好奇技术如何改变人的思考，也想在阅读和日常里找到新的灵感。',
  question: '当 AI 能替我们回答问题，什么样的提问才更有价值？',
  styleId: 'deep',
  goals: ['conversation', 'learning'],
};
