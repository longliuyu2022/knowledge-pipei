import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Compass, MessageCircle, Pause, Play, RefreshCw, Sparkles, X } from 'lucide-react';
import { api, formatTime, messageOf } from '../../api';
import { Avatar, Empty, PageTitle, Spinner } from '../../components';
import type { Match, Mode, PageActions } from '../../types';

interface MatchingSnapshot {
  request: null | { id: string; status: string; question: string; mode: Mode; expiresAt: string; createdAt: string };
  proposal: null | { id: string; person: Match; reasons: string[]; acceptedByMe: boolean; acceptedByOther: boolean; expiresAt: string };
  counts: { searching: number; proposed: number };
  notice?: string; conversationId?: string | null;
}
export function MatchingPage({ actions, version, onConnected, onNavigate }: { actions: PageActions; version: number; onConnected: (id: string) => void; onNavigate: (page: string) => void }) {
  const [snapshot, setSnapshot] = useState<MatchingSnapshot | null>(null), [error, setError] = useState('');
  const [reload, setReload] = useState(0), [busy, setBusy] = useState('');
  const [mode, setMode] = useState<Mode>('resonance'), [question, setQuestion] = useState(actions.data.profile?.input.question || '');
  const [connected, setConnected] = useState<string | null>(null), [newRequest, setNewRequest] = useState(false);
  const lock = useRef(false), sequence = useRef(0), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  useEffect(() => {
    const controller = new AbortController(), current = ++sequence.current;
    void api<MatchingSnapshot>('/matching', { signal: controller.signal }).then(result => { if (!controller.signal.aborted && current === sequence.current) { setSnapshot(result); setConnected(result.conversationId || null); setError(''); } }).catch(cause => { if (!controller.signal.aborted && current === sequence.current) setError(messageOf(cause)); });
    return () => controller.abort();
  }, [version, reload]);
  async function mutate(action: string, body: unknown) {
    if (lock.current) return;
    lock.current = true; setBusy(action); setError(''); const current = ++sequence.current;
    try { const next = await api<MatchingSnapshot>(`/matching/${action}`, { method: 'POST', json: body }); if (!alive.current) return; if (current === sequence.current) setSnapshot(next); if (next.conversationId) { setConnected(next.conversationId); actions.notify('双方已确认，可以开始对话。'); } setReload(value => value + 1); }
    catch (cause) { if (alive.current) setError(messageOf(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  const request = snapshot?.request, proposal = newRequest ? null : snapshot?.proposal;
  const active = request && ['searching', 'proposed', 'paused'].includes(request.status);
  const paused = request?.status === 'paused';
  return <div className="tz-feature" data-testid="matching-page"><PageTitle eyebrow="A SHARED QUESTION, A NEW PERSPECTIVE" title="找到愿意把问题聊深的人" description="留下你的问题，让相遇慢慢发生。"/>
    <details className="redesign-details"><summary>匹配规则与有效期</summary><p>匹配请求保留 7 天；遇到候选后，有 48 小时确认。双方确认才建立对话，你可以随时暂停或取消。</p></details>
    {error && <div className="tz-error" role="alert">{error}<button className="text-button" onClick={() => setReload(value => value + 1)}>重新读取</button></div>}
    {!actions.data.profile ? <div className="tz-card"><Empty title="先介绍一下你的好奇心" text="选择兴趣、写下一个问题，让伙伴知道可以和你聊什么。" action="创建知识画像" onAction={actions.onCreate}/></div> : <div className="tz-two-column"><section className="tz-card tz-matching-main">
      <div className="tz-section-heading"><h2><MessageCircle size={18}/>{proposal ? connected ? '你们已经准备好开始对话' : '你们或许有话可聊' : active ? paused ? '这次寻找已暂停' : '让这个问题，等到一位伙伴' : '这次，你想和谁聊聊'}</h2><button className="icon-button" aria-label="刷新匹配状态" onClick={() => setReload(value => value + 1)}><RefreshCw size={16}/></button></div>
      {snapshot === null && !error ? <Spinner text="正在读取匹配状态…"/> : proposal ? <div className="tz-proposal" data-testid="matching-proposal"><div className="tz-person"><Avatar name={proposal.person.name} seed={proposal.person.id} src={proposal.person.avatar} size={64}/><div><h3>{proposal.person.name}</h3><p>{proposal.person.title}</p></div><span className="tz-status">{connected ? '双方已确认' : '等待双方确认'}</span></div><p className="tz-proposal-summary">{proposal.person.summary}</p><div className="tags">{proposal.person.interests.slice(0, 6).map(topic => <span className="tag tag-purple" key={topic.id}>{topic.label}</span>)}</div><ul className="tz-reasons">{proposal.reasons.map((reason, index) => <li key={index}><Sparkles size={14}/><span>{reason}</span></li>)}</ul>{proposal.person.question && <blockquote>{proposal.person.question}</blockquote>}<p className="tz-caption">{connected ? '带着共同的问题，继续你们的交流。' : <>请在 {formatTime(proposal.expiresAt)} 前确认 · {proposal.acceptedByOther ? '对方已确认' : '等待对方决定'}</>}</p>{!connected && <div className="tz-actions"><button className="button primary" data-testid="matching-accept" disabled={Boolean(busy) || proposal.acceptedByMe} onClick={() => void mutate('respond', { proposalId: proposal.id, decision: 'accept' })}><Check size={16}/>{proposal.acceptedByMe ? '已确认，等待对方' : '愿意聊聊'}</button><button className="button secondary" disabled={Boolean(busy)} onClick={() => void mutate('respond', { proposalId: proposal.id, decision: 'decline' })}>暂不连接</button></div>}</div> : active ? <div className="tz-matching-wait" data-testid="matching-wait"><span className="tz-orbit-mark"><Compass size={39} strokeWidth={1.3}/></span><h3>{paused ? '留一点时间，再继续寻找' : '问题已经留下，相遇正在路上'}</h3><p>{request.question || '从双方的兴趣与交流方式，寻找合适的伙伴。'}</p><span className="tz-caption">{paused ? '恢复后继续参与匹配' : `本次请求有效至 ${formatTime(request.expiresAt)}`}</span><div className="tz-actions"><button className="button secondary" disabled={Boolean(busy)} onClick={() => void mutate(paused ? 'resume' : 'pause', { requestId: request.id })}>{paused ? <Play size={15}/> : <Pause size={15}/>}{paused ? '继续寻找' : '暂停匹配'}</button><button className="text-button" disabled={Boolean(busy)} onClick={() => void mutate('cancel', { requestId: request.id })}><X size={14}/>取消请求</button></div></div> : <form className="tz-form" onSubmit={event => { event.preventDefault(); setConnected(null); setNewRequest(false); void mutate('start', { question: question.trim(), mode, revision: actions.data.profile!.revision }); }}><label>想带着什么问题认识伙伴？<textarea data-testid="matching-question" value={question} onChange={event => setQuestion(event.target.value)} maxLength={200} rows={4} placeholder="比如：阅读怎样改变了你做决定的方式？"/></label><div className="tz-mode-grid"><button type="button" className={mode === 'resonance' ? 'active' : ''} aria-pressed={mode === 'resonance'} onClick={() => setMode('resonance')}><strong>共同兴趣</strong><span>从相似的好奇心开始</span></button><button type="button" className={mode === 'complement' ? 'active' : ''} aria-pressed={mode === 'complement'} onClick={() => setMode('complement')}><strong>互补视角</strong><span>在不同经验里找到新线索</span></button></div><p className="tz-caption">你分享的知识画像会向候选伙伴展示。确认连接后，双方可以进入私聊。</p><button className="button primary" data-testid="matching-start" disabled={Boolean(busy)}>{busy === 'start' ? <Spinner text="正在保存请求…"/> : <>开始匹配<ArrowUpRight size={16}/></>}</button></form>}
      {snapshot?.notice && <p className="tz-info tz-top-gap">{snapshot.notice}</p>}{connected && <div className="tz-success" data-testid="matching-connected"><Check size={20}/><div><strong>这段相遇，已经得到双方确认</strong><p>带着共同的问题，开始你们的对话。</p></div><div className="tz-actions"><button className="button primary" onClick={() => onConnected(connected)}>进入聊天</button>{!newRequest && <button className="text-button" onClick={() => setNewRequest(true)}>再认识一位伙伴</button>}</div></div>}
    </section><aside className="tz-stack"><section className="tz-card"><h2>不必同时在线</h2><p className="tz-muted">你可以先去参加同题讨论。匹配进展会出现在消息里，回来后再做决定。</p><div className="tz-stat-pair"><div><strong>{snapshot?.counts.searching ?? '—'}</strong><span>正在寻找的请求</span></div><div><strong>{snapshot?.counts.proposed ?? '—'}</strong><span>等待确认的候选</span></div></div><button className="text-button" onClick={() => onNavigate('notifications')}>查看消息<ArrowUpRight size={14}/></button></section><section className="tz-card tz-soft-card"><h2>先和 AI 理一理</h2><p className="tz-muted">梳理自己的问题，或练习一个有意思的开场。</p><button className="text-button" onClick={() => onNavigate('companion')}>打开 AI 伙伴<ArrowUpRight size={14}/></button></section></aside></div>}
  </div>;
}
