import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Compass, List, MessageCircle, Pause, Play, RefreshCw, Sparkles, X } from 'lucide-react';
import { api, messageOf } from '../../api';
import { Avatar, Empty, PageTitle, Spinner } from '../../components';
import type { Match, Mode, PageActions } from '../../types';

interface MatchingSnapshot {
  request: null | { id: string; status: string; question: string; mode: Mode; expiresAt: string; createdAt: string };
  proposal: null | { id: string; person: Match; reasons: string[]; acceptedByMe: boolean; acceptedByOther: boolean; expiresAt: string };
  counts: { searching: number; proposed: number };
  notice?: string; conversationId?: string | null;
}
interface SeekingItem { requestId: string; person: Match; expiresAt: string }

export function MatchingPage({ actions, version, onConnected }: { actions: PageActions; version: number; onConnected: (id: string) => void; onNavigate: (page: string) => void }) {
  const [snapshot, setSnapshot] = useState<MatchingSnapshot | null>(null), [seeking, setSeeking] = useState<SeekingItem[]>([]);
  const [error, setError] = useState(''), [listError, setListError] = useState(''), [reload, setReload] = useState(0), [busy, setBusy] = useState('');
  const [mode, setMode] = useState<Mode>('resonance'), [view, setView] = useState<'auto' | 'list'>('auto');
  const lock = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<MatchingSnapshot>('/matching', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setSnapshot(result); setError(''); } }).catch(cause => { if (!controller.signal.aborted) setError(messageOf(cause)); });
    return () => controller.abort();
  }, [version, reload]);
  useEffect(() => {
    if (view !== 'list' || !actions.data.profile) return;
    const controller = new AbortController();
    void api<{ items: SeekingItem[] }>(`/matching/searching?mode=${mode}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setSeeking(result.items); setListError(''); } }).catch(cause => { if (!controller.signal.aborted) setListError(messageOf(cause)); });
    return () => controller.abort();
  }, [view, mode, reload, actions.data.profile]);
  async function mutate(action: string, body: unknown) {
    if (lock.current) return;
    lock.current = true; setBusy(action); setError('');
    try {
      const next = await api<MatchingSnapshot>(`/matching/${action}`, { method: 'POST', json: body });
      if (!alive.current) return;
      setSnapshot(next); setReload(value => value + 1);
      if (action === 'apply') { setView('auto'); actions.notify('申请已发出，等待对方确认。'); }
      if (next.conversationId) actions.notify('双方已确认，可以开始对话。');
    } catch (cause) { if (alive.current) setError(messageOf(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  const request = snapshot?.request, proposal = snapshot?.proposal, connected = snapshot?.conversationId;
  const active = request && ['searching', 'proposed', 'paused'].includes(request.status), paused = request?.status === 'paused';
  const start = () => void mutate('start', { mode, revision: actions.data.profile!.revision });
  return <div className="tz-feature" data-testid="matching-page">
    <PageTitle eyebrow="FIND YOUR PEOPLE" title="遇见同频的人" description="根据你的知识人格与兴趣，找到值得继续聊的人。"/>
    <div className="tz-tabs tz-page-tabs matching-view-tabs" aria-label="匹配方式"><button className={view === 'auto' ? 'active' : ''} onClick={() => setView('auto')}><Sparkles size={17}/>智能匹配</button><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><List size={17}/>正在寻找 <span>{snapshot?.counts.searching || 0}</span></button></div>
    {error && <div className="tz-error" role="alert">{error}<button className="text-button" onClick={() => setReload(value => value + 1)}>重新读取</button></div>}
    {!actions.data.profile ? <div className="tz-card"><Empty title="先创建知识人格" text="完成后即可开始匹配。" action="创建知识人格" onAction={actions.onCreate}/></div> : view === 'list' ? <section className="tz-card seeking-section">
      <div className="tz-section-heading"><h2>正在寻找的人</h2><button className="icon-button" aria-label="刷新列表" onClick={() => setReload(value => value + 1)}><RefreshCw size={18}/></button></div>
      {!request || !active ? <div className="seeking-start"><p>开始匹配后，你也会出现在正在寻找列表。</p><button className="button primary" onClick={start} disabled={Boolean(busy)}>开始匹配</button></div> : null}
      {listError ? <p className="tz-error">{listError}</p> : seeking.length ? <div className="seeking-grid">{seeking.map(item => <article className="seeking-card" key={item.requestId}><div className="tz-person"><Avatar name={item.person.name} seed={item.person.id} src={item.person.avatar} size={58}/><div><h3>{item.person.name}</h3><p>{item.person.title}</p></div><span className="tz-status">{item.person.score}%</span></div><div className="tags">{item.person.interests.slice(0, 4).map(topic => <span className="tag tag-purple" key={topic.id}>{topic.label}</span>)}</div><p>{item.person.reasons[0]}</p><button className="button primary" disabled={Boolean(busy) || request?.status !== 'searching'} onClick={() => void mutate('apply', { targetId: item.person.id })}>{busy === 'apply' ? <Spinner text="申请中…"/> : '申请匹配'}</button></article>)}</div> : <Empty title="还没有合适的寻找请求" text="可以先开始智能匹配，有新伙伴时再来看看。"/>}
    </section> : <div className="tz-two-column"><section className="tz-card tz-matching-main">
      <div className="tz-section-heading"><h2><MessageCircle size={20}/>{proposal ? connected ? '可以开始聊天了' : '收到一位匹配伙伴' : active ? paused ? '匹配已暂停' : '正在根据知识画像寻找' : '开始知识画像匹配'}</h2><button className="icon-button" aria-label="刷新匹配状态" onClick={() => setReload(value => value + 1)}><RefreshCw size={18}/></button></div>
      {snapshot === null && !error ? <Spinner text="正在读取匹配状态…"/> : proposal ? <div className="tz-proposal" data-testid="matching-proposal"><div className="tz-person"><Avatar name={proposal.person.name} seed={proposal.person.id} src={proposal.person.avatar} size={68}/><div><h3>{proposal.person.name}</h3><p>{proposal.person.title}</p></div><span className="tz-status">{connected ? '已连接' : proposal.acceptedByOther ? '对方已确认' : '待确认'}</span></div><div className="tags">{proposal.person.interests.slice(0, 5).map(topic => <span className="tag tag-purple" key={topic.id}>{topic.label}</span>)}</div><ul className="tz-reasons">{proposal.reasons.slice(0, 2).map((reason, index) => <li key={index}><Sparkles size={15}/><span>{reason}</span></li>)}</ul>{!connected && <div className="tz-actions"><button className="button primary" data-testid="matching-accept" disabled={Boolean(busy) || proposal.acceptedByMe} onClick={() => void mutate('respond', { proposalId: proposal.id, decision: 'accept' })}><Check size={17}/>{proposal.acceptedByMe ? '已确认，等待对方' : '同意连接'}</button><button className="button secondary" disabled={Boolean(busy)} onClick={() => void mutate('respond', { proposalId: proposal.id, decision: 'decline' })}>暂不连接</button></div>}</div> : active ? <div className="tz-matching-wait" data-testid="matching-wait"><span className="tz-orbit-mark"><Compass size={42}/></span><h3>{paused ? '匹配已暂停' : '正在寻找同频伙伴'}</h3><p>{paused ? '随时可以继续。' : '关闭页面后仍会继续寻找。'}</p><div className="tz-actions"><button className="button secondary" disabled={Boolean(busy)} onClick={() => void mutate(paused ? 'resume' : 'pause', { requestId: request.id })}>{paused ? <Play size={16}/> : <Pause size={16}/>}{paused ? '继续寻找' : '暂停匹配'}</button><button className="text-button" disabled={Boolean(busy)} onClick={() => void mutate('cancel', { requestId: request.id })}><X size={15}/>退出寻找</button></div></div> : <div className="matching-start-card"><div className="tz-mode-grid"><button type="button" className={mode === 'resonance' ? 'active' : ''} onClick={() => setMode('resonance')}><strong>同频共鸣</strong><span>相似兴趣与交流方式</span></button><button type="button" className={mode === 'complement' ? 'active' : ''} onClick={() => setMode('complement')}><strong>互补视角</strong><span>共同话题与新方向</span></button></div><button className="button primary matching-primary" data-testid="matching-start" disabled={Boolean(busy)} onClick={start}>{busy === 'start' ? <Spinner text="正在开始…"/> : <>开始匹配<ArrowUpRight size={18}/></>}</button></div>}
      {connected && <div className="tz-success" data-testid="matching-connected"><Check size={20}/><strong>双方已确认</strong><button className="button primary" onClick={() => onConnected(connected)}>进入聊天</button></div>}
    </section><aside className="tz-card matching-summary"><h2>我的匹配依据</h2><div className="tags">{actions.data.profile.interests.slice(0, 5).map(item => <span className="tag tag-purple" key={item.id}>{item.label}</span>)}</div><button className="text-button" onClick={actions.onCreate}>调整知识人格</button><details className="redesign-details"><summary>匹配规则</summary><p>请求保留 7 天；双方确认后建立聊天。</p></details></aside></div>}
  </div>;
}
