import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bell, BellOff, BookOpen, CheckCheck, ChevronDown, Clock3, Copy, ExternalLink, LogOut, MessageSquare, Plus, Settings2, Share2, Target, Users } from 'lucide-react';
import { api, copyText, messageOf } from '../../api';
import type { CircleAIAction, CircleDetail, CircleMessage, CirclePhase } from '../../../shared/circles-types';
import { CircleDiscussion, clearCircleDrafts } from './CircleDiscussion';
import { FacilitationDialog, HostSettingsDialog, MembershipDialog, NewRoundDialog } from './CircleForms';
import { CircleMembers } from './CircleMembers';
import { CircleOutcomes, CircleSources } from './CircleResources';
import { circlePath, CircleModal, ConfirmDialog, dateTime, durationNames, ErrorNote, isAbort, isMembershipError, Loading, MutationErrorContext, Notice, PhaseBadge, phaseNames, safeUrl, useAlive, useTask, type Notify } from './CirclesCommon';

type Tab = 'discussion' | 'sources' | 'outcomes' | 'members';
type Modal = 'membership' | 'newRound' | 'host' | 'share' | null;
const transitions: Record<CirclePhase, CirclePhase[]> = { recruiting: ['discussing', 'dormant', 'archived'], discussing: ['reviewing', 'dormant', 'archived'], reviewing: ['completed', 'discussing', 'dormant', 'archived'], completed: ['archived'], archived: [], dormant: ['discussing', 'archived'] };

export function CircleRoom({ circleId, version, onNavigate, onConversation, notify }: { circleId: string; version: number; onNavigate: (page: string) => void; onConversation?: (id: string) => void; notify: Notify }) {
  const [requestedRound, setRequestedRound] = useState(''), [revision, setRevision] = useState(0), [tab, setTab] = useState<Tab>('discussion');
  const [data, setData] = useState<{ scope: string; circle: CircleDetail } | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [modal, setModal] = useState<Modal>(null), [aiAction, setAIAction] = useState<CircleAIAction | null>(null), [leaving, setLeaving] = useState(false), [nextPhase, setNextPhase] = useState<CirclePhase | ''>(''), [confirmPhase, setConfirmPhase] = useState<CirclePhase | null>(null);
  const scope = `${circleId}:${requestedRound || 'current'}`, scopeRef = useRef(scope), generation = useRef(0), alive = useAlive(), readKey = useRef('');
  scopeRef.current = scope;
  const circle = data?.scope === scope ? data.circle : null;
  function onChanged() { if (alive.current && scopeRef.current === scope) setRevision(value => value + 1); }
  function onMutationError(err: unknown) {
    if (isMembershipError(err) && alive.current && scopeRef.current === scope) { setData(null); setModal(null); setAIAction(null); setConfirmPhase(null); setLeaving(false); setRevision(value => value + 1); notify(messageOf(err), 'error'); }
  }
  useEffect(() => {
    const controller = new AbortController(), run = ++generation.current;
    setLoading(true); setError('');
    const params = requestedRound ? `?roundId=${encodeURIComponent(requestedRound)}` : '';
    void api<{ circle: CircleDetail }>(`${circlePath(circleId)}${params}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted && run === generation.current && scopeRef.current === scope) {
        setData({ scope, circle: result.circle }); setLoading(false);
        if (!result.circle.joined) { setModal(current => current === 'membership' || current === 'share' ? current : null); setAIAction(null); setLeaving(false); setConfirmPhase(null); }
      }
    }).catch(err => {
      if (!controller.signal.aborted && !isAbort(err) && run === generation.current && scopeRef.current === scope) { setError(messageOf(err)); setLoading(false); if (isMembershipError(err)) setData(null); }
    });
    return () => controller.abort();
  }, [circleId, requestedRound, revision, version, scope]);
  useEffect(() => {
    if (!circle?.membership?.expiresAt) return;
    const expiry = new Date(circle.membership.expiresAt).getTime();
    if (!Number.isFinite(expiry)) return;
    const timer = window.setTimeout(() => { if (scopeRef.current === scope) { setData(null); setRevision(value => value + 1); } }, Math.min(2147483647, Math.max(0, expiry - Date.now()) + 50));
    return () => window.clearTimeout(timer);
  }, [circle?.membership?.expiresAt, scope]);
  useEffect(() => {
    if (!circle?.joined || tab !== 'discussion' || document.visibilityState !== 'visible') return;
    const latest = circle.messages.at(-1)?.id;
    const key = `${circle.membership?.userId}:${circle.selectedRoundId}:${latest || 'empty'}`;
    if (readKey.current === key) return;
    readKey.current = key;
    void api<{ ok: boolean; unreadCount: number }>(`${circlePath(circleId)}/read`, { method: 'POST', json: { roundId: circle.selectedRoundId, messageId: latest } }).then(result => {
      if (alive.current && scopeRef.current === scope) setData(current => current?.scope === scope ? { ...current, circle: { ...current.circle, unreadCount: result.unreadCount } } : current);
    }).catch(err => { if (alive.current && scopeRef.current === scope) { readKey.current = ''; if (isMembershipError(err)) { setData(null); setRevision(value => value + 1); } } });
  }, [circleId, circle?.joined, circle?.selectedRoundId, circle?.messages.at(-1)?.id, circle?.membership?.userId, tab, scope, alive]);
  async function loadOlder() {
    if (!circle?.nextBefore) return;
    const expectedRound = circle.selectedRoundId, cursor = circle.nextBefore, expectedGeneration = generation.current;
    const result = await api<{ messages: CircleMessage[]; hasMore: boolean; nextBefore: string | null }>(`${circlePath(circleId)}/messages?roundId=${encodeURIComponent(expectedRound)}&before=${encodeURIComponent(cursor)}`);
    if (alive.current && scopeRef.current === scope && generation.current === expectedGeneration) setData(current => {
      if (!current || current.scope !== scope || current.circle.selectedRoundId !== expectedRound) return current;
      const known = new Set(current.circle.messages.map(message => message.id));
      return { ...current, circle: { ...current.circle, messages: [...result.messages.filter(message => !known.has(message.id)), ...current.circle.messages], hasMoreMessages: result.hasMore, nextBefore: result.nextBefore } };
    });
  }
  function saveMembership(result: CircleDetail) {
    if (!alive.current || scopeRef.current !== scope) return;
    const joinedNow = !circle?.joined;
    setModal(null);
    if (joinedNow) { setRequestedRound(''); setData({ scope: `${circleId}:current`, circle: result }); }
    onChanged(); notify(joinedNow ? '已加入小组，开始这一轮讨论吧。' : '参与设置已保存。', 'success');
  }
  function changeRound(roundId: string) { setRequestedRound(roundId); setModal(null); setAIAction(null); setNextPhase(''); setConfirmPhase(null); }
  if (!circle) return <section className="cz-room-loading"><button className="cz-text-button" onClick={() => onNavigate('discover')}><ArrowLeft size={16}/>返回发现小组</button>{loading ? <Loading text="正在打开问题小组…"/> : <><ErrorNote text={error || '小组暂时无法打开。'}/><button className="cz-button" onClick={onChanged}>重新加载</button></>}</section>;
  const selectedRound = circle.rounds.find(round => round.id === circle.selectedRoundId) || circle.currentRound;
  const current = selectedRound.id === circle.currentRound.id;
  const writable = circle.joined && current && ['recruiting', 'discussing', 'reviewing'].includes(selectedRound.status);
  const host = circle.membership?.role === 'host';
  const roundIndex = selectedRound.status === 'recruiting' ? 0 : selectedRound.status === 'discussing' || selectedRound.status === 'dormant' ? 1 : selectedRound.status === 'reviewing' ? 2 : 3;
  return <MutationErrorContext.Provider value={onMutationError}>
    <div className="cz-room-top"><button className="cz-text-button" onClick={() => onNavigate('discover')}><ArrowLeft size={16}/>发现小组</button><div>{loading && <span className="cz-muted" role="status">更新中…</span>}<button className="cz-button cz-small" onClick={() => setModal('share')}><Share2 size={15}/>邀请伙伴</button>{circle.joined && <button className="cz-button cz-small" onClick={() => setModal('membership')}><Settings2 size={15}/>参与设置</button>}</div></div>
    <ErrorNote text={error}/>
    <header className="cz-room-heading"><div className="cz-card-meta"><PhaseBadge phase={selectedRound.status}/><span>第 {selectedRound.number} 轮</span><span><Users size={14}/>{circle.memberCount} / {circle.capacity} 位成员</span>{circle.membership && <span><Clock3 size={14}/>{durationNames[circle.membership.duration]}</span>}</div><h1>{circle.title}</h1>{circle.description && <p>{circle.description}</p>}{circle.tags.length > 0 && <div className="cz-tags">{circle.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}</header>
    <section className="cz-question-card" aria-label="本轮问题与目标"><div className="cz-question-symbol">Q</div><div><span className="cz-eyebrow">第 {selectedRound.number} 轮 · 我们正在探索</span><h2>{selectedRound.question}</h2><div className="cz-question-goal"><Target size={17}/><p><strong>本轮目标</strong>{selectedRound.goal}</p></div>{circle.questionUrl && <a className="cz-text-button" href={safeUrl(circle.questionUrl)} target="_blank" rel="noreferrer">查看关联的知乎问题<ExternalLink size={14}/></a>}</div></section>
    {!circle.joined ? <div className="cz-public-join"><div><span className="cz-side-icon"><Users size={23}/></span><h2>带着你的经验，加入这一轮</h2><p>选择参与期限和权限后，就能阅读组内讨论、了解成员、补充资料并一起整理成果。</p><p className="cz-muted">目前仅展示公开问题和目标。打开邀请链接不会自动加入。</p><button className="cz-button cz-primary" disabled={circle.memberCount >= circle.capacity || circle.currentRound.status === 'archived'} onClick={() => setModal('membership')}>{circle.currentRound.status === 'archived' ? '本轮已归档，等待新一轮' : circle.memberCount >= circle.capacity ? '小组人数已满' : '选择期限并加入'}<ArrowRight size={16}/></button></div><aside><h3>加入后可以做什么</h3><ul><li>围绕本轮问题发言、回复与引用</li><li>共同维护资料和成果版本</li><li>自主选择提醒、私聊邀请和 AI 处理</li><li>按期参与，随时退出</li></ul></aside></div> : <div className="cz-room-layout"><section className="cz-room-main" aria-label="小组内容">
      <div className="cz-room-tabs" role="tablist" aria-label="小组内容">{([{ id: 'discussion', label: '讨论', icon: MessageSquare, count: null }, { id: 'sources', label: '资料', icon: BookOpen, count: circle.sources.length }, { id: 'outcomes', label: '成果', icon: CheckCheck, count: circle.outcomes.length }, { id: 'members', label: '成员', icon: Users, count: circle.memberCount }] as const).map((item, index, items) => <button id={`cz-tab-${item.id}`} key={item.id} role="tab" aria-selected={tab === item.id} aria-controls="cz-tab-panel" tabIndex={tab === item.id ? 0 : -1} className={tab === item.id ? 'is-active' : ''} onClick={() => setTab(item.id)} onKeyDown={event => { let next: number | undefined; if (event.key === 'ArrowRight') next = (index + 1) % items.length; if (event.key === 'ArrowLeft') next = (index + items.length - 1) % items.length; if (event.key === 'Home') next = 0; if (event.key === 'End') next = items.length - 1; if (next !== undefined) { event.preventDefault(); setTab(items[next].id); document.getElementById(`cz-tab-${items[next].id}`)?.focus(); } }}><item.icon size={16}/>{item.label}{item.count !== null && <span>{item.count}</span>}</button>)}</div>
      <div id="cz-tab-panel" role="tabpanel" aria-labelledby={`cz-tab-${tab}`} tabIndex={0} key={selectedRound.id}>
        {tab === 'discussion' && <CircleDiscussion circle={circle} writable={writable} onChanged={onChanged} onOlder={loadOlder} onFacilitate={setAIAction} notify={notify}/>}
        {tab === 'sources' && <CircleSources circle={circle} writable={writable} onChanged={onChanged} notify={notify}/>}
        {tab === 'outcomes' && <CircleOutcomes circle={circle} writable={writable} onChanged={onChanged} onFacilitate={() => setAIAction('outcome')} notify={notify}/>}
        {tab === 'members' && <CircleMembers circle={circle} onChanged={onChanged} onPreferences={() => setModal('membership')} onNavigate={onNavigate} onConversation={onConversation} notify={notify}/>}
      </div>
    </section><aside className="cz-room-aside"><section className="cz-side-card cz-round-card"><label className="cz-field">查看讨论轮次<div className="cz-round-select"><select value={selectedRound.id} onChange={event => changeRound(event.target.value)} aria-label="查看讨论轮次">{circle.rounds.map(round => <option key={round.id} value={round.id}>第 {round.number} 轮 · {phaseNames[round.status]}{round.id === circle.currentRound.id ? '（当前）' : ''}</option>)}</select><ChevronDown size={15}/></div></label><ol className="cz-progress">{['问题召集', '经验与资料讨论', '成果整理与核对', '完成这一轮'].map((text, index) => <li className={index < roundIndex ? 'is-done' : index === roundIndex ? 'is-current' : ''} key={text}><span>{index < roundIndex ? '✓' : index + 1}</span>{text}</li>)}</ol>{selectedRound.status === 'dormant' && <p className="cz-muted">本轮暂时休眠，不表示问题已经解决。</p>}{!current && <button className="cz-text-button" onClick={() => changeRound(circle.currentRound.id)}>回到当前轮次<ArrowRight size={14}/></button>}{host && current && <div className="cz-host-phase">{transitions[selectedRound.status].length > 0 && <><label className="cz-field">推进本轮<select aria-label="新的轮次阶段" value={nextPhase} onChange={event => setNextPhase(event.target.value as CirclePhase | '')}><option value="">选择下一阶段</option>{transitions[selectedRound.status].map(phase => <option key={phase} value={phase}>{phaseNames[phase]}</option>)}</select></label><button className="cz-button cz-small" disabled={!nextPhase} onClick={() => nextPhase && setConfirmPhase(nextPhase)}>更新阶段</button></>}{['completed', 'archived'].includes(selectedRound.status) && <button className="cz-button cz-primary cz-small" onClick={() => setModal('newRound')}><Plus size={15}/>开启新一轮</button>}</div>}</section>
      <section className="cz-side-card"><div className="cz-side-title">{circle.membership?.subscribed ? <Bell size={17}/> : <BellOff size={17}/>}<h3>我的参与</h3></div><p>{circle.membership?.expiresAt ? `本次参与至 ${dateTime(circle.membership.expiresAt)}` : '持续参与，由你决定何时离开。'}</p><p className="cz-muted">{circle.membership?.subscribed ? '已订阅小组提醒' : '已关闭小组提醒'} · {circle.membership?.role === 'host' ? '小组主持' : '小组成员'}</p><button className="cz-text-button" onClick={() => setModal('membership')}>管理期限与权限<ArrowRight size={14}/></button><div className="cz-side-divider"/>{host && <button className="cz-text-button" onClick={() => setModal('host')}><Settings2 size={14}/>主持设置</button>}<button className="cz-text-button cz-leave-button" onClick={() => setLeaving(true)}><LogOut size={14}/>退出小组</button></section>
      <section className="cz-side-card cz-side-soft"><h3>讨论协助，有迹可循</h3><p>AI 和站内摘录都会标明整理方式，引用可回到原发言或来源。成果需要成员核对。</p><p className="cz-muted">{circle.autoSummary ? '主持已开启自动阶段整理。' : '阶段整理由成员主动发起。'}</p></section>
    </aside></div>}
    {modal === 'membership' && <MembershipDialog circle={circle} onClose={() => setModal(null)} onSaved={saveMembership}/>}
    {modal === 'share' && <ShareDialog circle={circle} onClose={() => setModal(null)} notify={notify}/>}
    {modal === 'newRound' && host && <NewRoundDialog circle={circle} onClose={() => setModal(null)} onSaved={() => { setModal(null); setRequestedRound(''); setNextPhase(''); setRevision(value => value + 1); setTab('discussion'); notify('新一轮已开启，上一轮的内容已保留。', 'success'); }}/>}
    {modal === 'host' && host && <HostSettingsDialog circle={circle} onClose={() => setModal(null)} onSaved={() => { setModal(null); onChanged(); notify('主持设置已保存。', 'success'); }}/>}
    {aiAction && writable && <FacilitationDialog circle={circle} initialAction={aiAction} onClose={() => setAIAction(null)} onSaved={result => { setAIAction(null); onChanged(); notify(result.notice || (result.mode === 'model' ? 'AI 整理已完成，请对照引用核对。' : '站内摘录已整理，请继续核对。'), 'success'); if (result.outcome) setTab('outcomes'); }}/>}
    {confirmPhase && host && current && <ConfirmDialog title={`将本轮设为${phaseNames[confirmPhase]}`} buttonText="确认更新" onClose={() => setConfirmPhase(null)} onConfirm={async () => { await api(`${circlePath(circle.id)}/rounds/${encodeURIComponent(selectedRound.id)}`, { method: 'PATCH', json: { status: confirmPhase } }); setNextPhase(''); onChanged(); }}><p>{confirmPhase === 'completed' ? '请确认本轮已形成可带走的成果。完成后，本轮讨论变为只读，可以开启新一轮。' : confirmPhase === 'archived' ? '归档后本轮讨论只读，已有资料与成果会保留。你可以再开启新一轮。' : confirmPhase === 'dormant' ? '暂时休眠会暂停发言，之后可以恢复讨论。休眠不会把问题标为已解决。' : `将第 ${selectedRound.number} 轮推进到「${phaseNames[confirmPhase]}」，成员会看到新的阶段。`}</p></ConfirmDialog>}
    {leaving && circle.joined && <ConfirmDialog title="退出这个小组" buttonText="确认退出" danger onClose={() => setLeaving(false)} onConfirm={async () => { const result = await api<{ circle: CircleDetail }>(`${circlePath(circle.id)}/leave`, { method: 'POST', json: {} }); if (alive.current && scopeRef.current === scope) { if (circle.membership) clearCircleDrafts(circle.membership.userId, circle.id); setLeaving(false); setModal(null); setRequestedRound(''); setData({ scope: `${circleId}:current`, circle: result.circle }); notify('已退出小组，后续提醒已停止。', 'success'); } }}><p>退出后将停止提醒，并失去组内讨论、资料、成员与成果的阅读权限。</p>{host && <p>主持身份会交给最早加入的有效成员。</p>}</ConfirmDialog>}
  </MutationErrorContext.Provider>;
}

function ShareDialog({ circle, onClose, notify }: { circle: CircleDetail; onClose: () => void; notify: Notify }) {
  const task = useTask(), link = `${window.location.origin}/#circles/${encodeURIComponent(circle.id)}`;
  return <CircleModal title="邀请伙伴来看看这个问题" onClose={onClose} busy={task.busy}><div className="cz-form"><h3>{circle.title}</h3><label className="cz-field">公开邀请链接<input readOnly value={link} onFocus={event => event.target.select()}/></label><Notice><p>链接仅展示小组的公开问题、目标与人数。对方须自行选择期限与权限，并确认加入后，才能阅读组内内容。</p></Notice><ErrorNote text={task.error}/><div className="cz-form-actions"><button className="cz-button" disabled={task.busy} onClick={onClose}>关闭</button><button className="cz-button cz-primary" disabled={task.busy} onClick={() => task.run(() => copyText(link), () => notify('公开邀请链接已复制。', 'success'))}><Copy size={15}/>复制链接</button></div></div></CircleModal>;
}
