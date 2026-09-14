import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Compass, Link2, Plus, Search, SlidersHorizontal, Target, Users } from 'lucide-react';
import { api, messageOf } from '../../api';
import type { CircleDetail, CircleRecommendations, CircleSummary } from '../../../shared/circles-types';
import { CreateCircleDialog } from './CircleForms';
import { dateTime, EmptyState, ErrorNote, isAbort, Loading, PhaseBadge, type Notify } from './CirclesCommon';

type Filters = { query: string; goal: string; stage: string };
export function CircleDirectory({ view, version, onNavigate, onProfile, notify }: { view: 'discover' | 'mine'; version: number; onNavigate: (page: string) => void; onProfile: () => void; notify: Notify }) {
  const [query, setQuery] = useState(''), [goal, setGoal] = useState(''), [stage, setStage] = useState('');
  const [filters, setFilters] = useState<Filters>({ query: '', goal: '', stage: '' });
  const [circles, setCircles] = useState<CircleSummary[]>([]), [recommendations, setRecommendations] = useState<CircleRecommendations | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [recommendationError, setRecommendationError] = useState('');
  const [sort, setSort] = useState<'recommended' | 'all'>('recommended'), [creating, setCreating] = useState(false), [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const questionUrl = /^https?:\/\//i.test(filters.query.trim()) ? filters.query.trim() : '';
  useEffect(() => {
    const controller = new AbortController(), run = ++generation.current;
    setLoading(true); setError(''); setRecommendationError('');
    const params = new URLSearchParams();
    if (view === 'mine') params.set('mine', '1');
    if (questionUrl) params.set('questionUrl', questionUrl); else if (filters.query) params.set('q', filters.query);
    const recommendationParams = new URLSearchParams();
    if (!questionUrl && filters.query) recommendationParams.set('q', filters.query);
    if (filters.goal) recommendationParams.set('goal', filters.goal);
    if (filters.stage) recommendationParams.set('stage', filters.stage);
    const jobs = [api<{ circles: CircleSummary[] }>(`/circles?${params}`, { signal: controller.signal })];
    void jobs[0].then(result => { if (run === generation.current && !controller.signal.aborted) { setCircles(result.circles); setLoading(false); } }).catch(err => { if (!controller.signal.aborted && !isAbort(err) && run === generation.current) { setCircles([]); setError(messageOf(err)); setLoading(false); } });
    if (view === 'discover' && !questionUrl) void api<CircleRecommendations>(`/circles/recommendations?${recommendationParams}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted && run === generation.current) setRecommendations(result); }).catch(err => { if (!controller.signal.aborted && !isAbort(err) && run === generation.current) { setRecommendations(null); setRecommendationError(messageOf(err)); } });
    else setRecommendations(null);
    return () => controller.abort();
  }, [view, filters, questionUrl, version, retry]);
  function search(event: FormEvent) { event.preventDefault(); setFilters({ query: query.trim(), goal: goal.trim(), stage: stage.trim() }); }
  function created(circle: CircleDetail) { setCreating(false); notify('小组已创建，邀请伙伴一起讨论吧。', 'success'); onNavigate(`circles/${circle.id}`); }
  const reasons = new Map(recommendations?.circles.map(circle => [circle.id, circle.reasons]));
  const recommendedOrder = new Map(recommendations?.circles.map((circle, index) => [circle.id, index]));
  const visible = sort === 'recommended' && view === 'discover' ? [...circles].sort((left, right) => (recommendedOrder.get(left.id) ?? 100000) - (recommendedOrder.get(right.id) ?? 100000)) : circles;
  const mine = view === 'mine';
  return <>
    <div className="tz-tabs tz-page-tabs" aria-label="问题小组视图"><button className={!mine ? 'active' : ''} aria-pressed={!mine} onClick={() => onNavigate('discover')}>发现小组</button><button className={mine ? 'active' : ''} aria-pressed={mine} onClick={() => onNavigate('my-circles')}>我的同题</button></div>
    <header className="cz-directory-heading"><div><span className="cz-eyebrow">{mine ? 'MY CIRCLES · 我的参与' : 'QUESTION CIRCLES · 问题小组'}</span><h1>{mine ? '把共同关心的问题，继续聊下去。' : <>一个好问题，<br className="cz-desktop-break"/>值得一起找到答案。</>}</h1><p>{mine ? '查看参与中的小组、未读讨论和每一轮积累下来的成果。' : '带着问题相遇，用经验与资料推进讨论，留下一份能带走的成果。'}</p></div><button className="cz-button cz-primary" onClick={() => setCreating(true)}><Plus size={17}/>发起问题小组</button></header>
    {!mine && <div className="cz-pathway" aria-label="问题小组如何运作"><div><span>01</span><p><strong>一个具体问题</strong><small>找到共同关心的方向</small></p></div><ArrowRight size={16}/><div><span>02</span><p><strong>一轮共同讨论</strong><small>补充经验、资料和不同观点</small></p></div><ArrowRight size={16}/><div><span>03</span><p><strong>一份共同成果</strong><small>整理依据，署名核对</small></p></div></div>}
    <div className="cz-directory-layout"><section className="cz-directory-main" aria-label={mine ? '我的问题小组' : '发现问题小组'}>
      <form className="cz-search-form" onSubmit={search}><div className="cz-search-input"><Search size={19}/><input aria-label="搜索问题小组" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索感兴趣的问题，或粘贴知乎问题链接" maxLength={500}/>{query && <button type="button" className="cz-clear-input" aria-label="清空搜索" onClick={() => { setQuery(''); setFilters(current => ({ ...current, query: '' })); }}>×</button>}</div><button type="submit" className="cz-button cz-primary">搜索</button></form>
      {!mine && <details className="cz-filter-details"><summary><SlidersHorizontal size={15}/>补充我的目标和阶段</summary><form onSubmit={search}><div className="cz-two-fields"><label className="cz-field">这次想获得什么<input value={goal} onChange={event => setGoal(event.target.value)} maxLength={200} placeholder="例如：做出第一个原型"/></label><label className="cz-field">我现在的阶段<input value={stage} onChange={event => setStage(event.target.value)} maxLength={100} placeholder="例如：入门学习 / 项目实践"/></label></div><button type="submit" className="cz-button cz-small">更新推荐</button></form></details>}
      <div className="cz-list-toolbar"><div className="cz-segmented" aria-label="小组排序">{!mine && !questionUrl ? <><button className={sort === 'recommended' ? 'is-active' : ''} aria-pressed={sort === 'recommended'} onClick={() => setSort('recommended')}><Compass size={15}/>为我推荐</button><button className={sort === 'all' ? 'is-active' : ''} aria-pressed={sort === 'all'} onClick={() => setSort('all')}>全部小组</button></> : <strong>{questionUrl ? '同一问题下的小组' : '我加入的小组'}</strong>}</div><span className="cz-muted" aria-live="polite">{loading ? '更新中' : `${visible.length} 个小组`}</span></div>
      {questionUrl && <p className="cz-query-caption"><Link2 size={14}/>按知乎问题链接查找，同一问题可以有不同的讨论目标。</p>}
      <ErrorNote text={error}/>{error && <button className="cz-button cz-small" onClick={() => setRetry(value => value + 1)}>重新加载</button>}
      {loading && !circles.length ? <Loading text="寻找正在讨论的问题…"/> : !error && visible.length === 0 ? <EmptyState title={mine ? '还没有加入的问题小组' : filters.query ? '暂时没有匹配的小组' : '第一场讨论，等你发起'} action={<button className="cz-button cz-primary" onClick={mine ? () => onNavigate('discover') : () => setCreating(true)}>{mine ? '去发现小组' : '发起这个问题'}<ArrowRight size={16}/></button>}>{mine ? '从一个感兴趣的问题出发，选择参与期限后加入。' : '换个关键词看看，或为这个问题设定一个目标，邀请伙伴一起探索。'}</EmptyState> : <div className="cz-circle-list">{visible.map(circle => <CircleCard key={circle.id} circle={circle} reasons={sort === 'recommended' ? reasons.get(circle.id) : undefined} onOpen={() => onNavigate(`circles/${circle.id}`)}/>)}</div>}
    </section><aside className="cz-directory-aside"><section className="cz-side-card"><span className="cz-side-icon"><Target size={21}/></span><h2>{mine ? '每一轮，都有一个落点' : '找到与你目标接近的人'}</h2><p>{mine ? '讨论可以暂时休眠，也可以完成后开启新一轮。已保存的资料和成果始终属于各自的轮次。' : '根据你已确认的兴趣、问题关键词和当前目标，优先展示相关的小组。'}</p>{!mine && <><button className="cz-text-button" onClick={onProfile}>查看我的知识画像<ArrowRight size={15}/></button><div className="cz-local-note">{recommendations?.profileUsed ? '已结合你确认过的知识画像。' : '尚未使用知识画像，也可以直接搜索和加入。'} 推荐在站内计算。</div>{recommendations?.notice && <p className="cz-muted">{recommendations.notice}</p>}{recommendationError && <ErrorNote text={recommendationError}/>}</>}</section><section className="cz-side-card cz-side-soft"><h3>由你决定参与方式</h3><ul><li>选择 24 小时、7 天或持续参与</li><li>提醒、连接邀请和 AI 处理分别选择</li><li>AI 整理有来源，成果由成员核对</li><li>可以随时退出，停止后续提醒</li></ul></section></aside></div>
    {creating && <CreateCircleDialog initialQuestionUrl={questionUrl} onClose={() => setCreating(false)} onCreated={created}/>}
  </>;
}

function CircleCard({ circle, reasons, onOpen }: { circle: CircleSummary; reasons?: string[]; onOpen: () => void }) {
  return <article className="cz-circle-card"><div className="cz-card-meta"><span>第 {circle.currentRound.number} 轮</span><PhaseBadge phase={circle.currentRound.status}/>{circle.joined && <span className="cz-joined-label">已加入</span>}{circle.unreadCount > 0 && <span className="cz-unread">{circle.unreadCount > 99 ? '99+' : circle.unreadCount} 条未读</span>}</div><h2><button onClick={onOpen}>{circle.title}<ArrowRight size={18}/></button></h2><p className="cz-card-question">{circle.currentRound.question}</p><div className="cz-card-goal"><Target size={15}/><p><span>本轮目标</span>{circle.currentRound.goal}</p></div>{circle.tags.length > 0 && <div className="cz-tags">{circle.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}{reasons?.length ? <p className="cz-reason"><Compass size={14}/>{reasons.join(' · ')}</p> : null}<footer><span><Users size={15}/>{circle.memberCount} / {circle.capacity} 位成员</span><span>{dateTime(circle.updatedAt)} 更新</span><button className="cz-text-button" onClick={onOpen}>{circle.joined ? '继续讨论' : '了解小组'}<ArrowRight size={15}/></button></footer></article>;
}
