import { useState, type FormEvent } from 'react';
import { BookOpen, CornerDownRight, Flag, MessageSquare, MoreHorizontal, Send, Sparkles, Trash2, WandSparkles, X } from 'lucide-react';
import { api } from '../../api';
import { Avatar } from '../../components';
import type { CircleAIAction, CircleDetail, CircleMessage } from '../../../shared/circles-types';
import { circlePath, Citations, CircleModal, ConfirmDialog, dateTime, EmptyState, ErrorNote, Notice, SubmitButton, useTask, type Notify } from './CirclesCommon';

type Draft = { text: string; replyTo: string | null; clientMessageId: string };
const drafts = new Map<string, Draft>();
const newMessageId = () => globalThis.crypto?.randomUUID?.() || `circle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export function clearCircleDrafts(userId: string, circleId: string) { for (const key of drafts.keys()) if (key.startsWith(`${userId}:${circleId}:`)) drafts.delete(key); }

export function CircleDiscussion({ circle, writable, onChanged, onOlder, onFacilitate, notify }: { circle: CircleDetail; writable: boolean; onChanged: () => void; onOlder: () => Promise<unknown>; onFacilitate: (action: CircleAIAction) => void; notify: Notify }) {
  const draftKey = `${circle.membership?.userId}:${circle.id}:${circle.selectedRoundId}`;
  const [draft, setDraft] = useState<Draft>(() => drafts.get(draftKey) || { text: '', replyTo: null, clientMessageId: newMessageId() });
  const [reporting, setReporting] = useState<CircleMessage | null>(null), [removing, setRemoving] = useState<{ message: CircleMessage; hide: boolean } | null>(null);
  const task = useTask(), olderTask = useTask();
  const host = circle.membership?.role === 'host';
  const reply = draft.replyTo ? circle.messages.find(message => message.id === draft.replyTo && !message.hidden && !message.redacted) : null;
  function change(value: Partial<Draft>) {
    setDraft(current => { const next = { ...current, ...value, clientMessageId: newMessageId() }; drafts.set(draftKey, next); return next; });
  }
  function send(event?: FormEvent) {
    event?.preventDefault();
    if (!draft.text.trim() || !writable || (draft.replyTo && !reply)) return;
    const current = { ...draft };
    drafts.set(draftKey, current);
    task.run(() => api<{ message: CircleMessage; deduplicated: boolean }>(`${circlePath(circle.id)}/messages`, { method: 'POST', json: { text: current.text.trim(), replyTo: current.replyTo || undefined, clientMessageId: current.clientMessageId } }), () => {
      if (drafts.get(draftKey)?.clientMessageId === current.clientMessageId) { const cleared = { text: '', replyTo: null, clientMessageId: newMessageId() }; drafts.set(draftKey, cleared); setDraft(cleared); }
      onChanged();
    });
  }
  function locate(id: string) {
    const element = document.getElementById(`cz-message-${id}`);
    if (element) { element.scrollIntoView({ behavior: 'smooth', block: 'center' }); element.focus({ preventScroll: true }); }
    else notify('这条发言在较早的讨论中，请先加载更早的发言。');
  }
  return <section className="cz-discussion" aria-label="本轮讨论">
    <div className="cz-panel-heading"><div><h2>让每一次发言，都推动一点进展</h2><p>分享经验，也欢迎提出不同的看法。引用资料时请保留来源。</p></div></div>
    {writable && <div className="cz-ai-toolbar"><span><Sparkles size={16}/>讨论协助</span><button className="cz-button cz-small" disabled={circle.aiStatus.pending} onClick={() => onFacilitate('opener')}><WandSparkles size={14}/>破冰提问</button><button className="cz-button cz-small" disabled={circle.aiStatus.pending} onClick={() => onFacilitate('summary')}><MessageSquare size={14}/>梳理讨论</button><button className="cz-button cz-small" disabled={circle.aiStatus.pending} onClick={() => onFacilitate('outcome')}><BookOpen size={14}/>整理成果</button>{circle.aiStatus.pending && <span className="cz-muted" role="status">正在整理中…</span>}</div>}
    {circle.hasMoreMessages && <div className="cz-load-earlier"><button className="cz-button cz-small" disabled={olderTask.busy} onClick={() => olderTask.run(onOlder)}>{olderTask.busy ? '加载中…' : '加载更早的发言'}</button><ErrorNote text={olderTask.error}/></div>}
    {!circle.messages.length ? <EmptyState title="第一条想法，从你开始">可以介绍自己正在面对的困惑、已经尝试过的方法，或想让大家一起核对的资料。</EmptyState> : <div className="cz-messages">{circle.messages.map(message => {
      const unavailable = message.hidden || message.redacted;
      if (message.kind === 'system') return <p key={message.id} className="cz-system-message">{message.text}<time dateTime={message.createdAt}>{dateTime(message.createdAt)}</time></p>;
      const ai = message.kind === 'ai';
      const own = message.authorId === circle.membership?.userId;
      return <article id={`cz-message-${message.id}`} tabIndex={-1} className={`cz-message ${ai ? 'cz-ai-message' : ''} ${unavailable ? 'cz-message-hidden' : ''}`} key={message.id}>
        <div className="cz-message-avatar">{ai ? <span className="cz-ai-avatar"><Sparkles size={18}/></span> : <Avatar name={message.author?.name || '成员'} seed={message.author?.id || message.id} src={message.author?.avatar || undefined} size={36}/>}</div>
        <div className="cz-message-body"><header><strong>{ai ? message.action === 'opener' ? '破冰提问' : message.action === 'outcome' ? '成果草稿' : '阶段梳理' : message.author?.name || '成员'}</strong>{own && <span className="cz-small-badge">我</span>}{ai && <span className="cz-small-badge">{message.aiMode === 'model' ? 'AI 整理 · 待核对' : '站内摘录 · 待核对'}</span>}<time dateTime={message.createdAt}>{dateTime(message.createdAt)}</time>
          {!unavailable && (!ai || host) && <details className="cz-message-menu"><summary aria-label={`${ai ? '整理内容' : message.author?.name || '成员'}的发言操作`}><MoreHorizontal size={18}/></summary><div>{!own && !ai && <button onClick={() => setReporting(message)}><Flag size={14}/>举报</button>}{(own || host) && <button onClick={() => setRemoving({ message, hide: false })}><Trash2 size={14}/>删除发言</button>}{host && !own && !ai && <button onClick={() => setRemoving({ message, hide: true })}>隐藏此发言</button>}</div></details>}
        </header>
        {unavailable ? <p className="cz-muted">{message.redacted ? '这份整理的部分依据已撤回或不可见，需要重新整理。' : '这条发言当前不可见。'}</p> : <>{message.reply && <button className="cz-reply-reference" onClick={() => locate(message.reply!.id)}><CornerDownRight size={14}/><span><strong>{message.reply.authorName}</strong>：{message.reply.text}</span></button>}<div className="cz-message-text">{message.text}</div>{ai && <Citations citations={message.citations} sourceIds={message.sourceIds} sources={circle.sources} onMessage={locate}/>}{writable && <button className="cz-text-button cz-reply-button" onClick={() => { change({ replyTo: message.id }); document.getElementById('cz-composer-input')?.focus(); }}><CornerDownRight size={14}/>回复</button>}</>}
        </div>
      </article>;
    })}</div>}
    {writable ? <form className="cz-composer" onSubmit={send}>{draft.replyTo && <div className="cz-composer-reply"><CornerDownRight size={15}/><span>{reply ? `回复 ${reply.author?.name || '讨论协助'}：${reply.text.slice(0, 100)}` : '原发言当前不可见，请取消回复后发送。'}</span><button type="button" className="cz-icon" aria-label="取消回复" onClick={() => change({ replyTo: null })}><X size={15}/></button></div>}<label htmlFor="cz-composer-input" className="cz-sr-only">写下你的讨论发言</label><textarea id="cz-composer-input" value={draft.text} onChange={event => change({ text: event.target.value })} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} placeholder="我遇到的情况是…… / 我找到一份相关资料……" maxLength={4000} rows={4}/><div className="cz-composer-footer"><span>{draft.text.length} / 4000<span className="cz-keyboard-hint"> · Ctrl / ⌘ + Enter 发送</span></span><button type="submit" className="cz-button cz-primary" disabled={task.busy || !draft.text.trim() || !!(draft.replyTo && !reply)}><Send size={15}/>{task.busy ? '发送中…' : '发送发言'}</button></div><ErrorNote text={task.error}/>{task.error && <p className="cz-muted cz-draft-note">草稿已保留。直接重试会使用同一发送标识，避免重复投递。</p>}<p className="cz-composer-consent">{circle.membership?.aiConsent ? '你已允许本组发言与资料用于外部 AI 整理，可在参与设置中关闭。' : '你尚未允许外部 AI 处理；发言仍可供组内成员阅读和站内整理。'}</p></form> : <Notice><p>{circle.selectedRoundId !== circle.currentRound.id ? '这是历史轮次，讨论已只读。切换到当前轮次可继续参与。' : '本轮暂不接受新发言。主持可以恢复讨论或完成后开启新一轮。'}</p></Notice>}
    {reporting && <ReportDialog circleId={circle.id} message={reporting} onClose={() => setReporting(null)} onSent={() => { setReporting(null); notify('举报已提交给小组主持。', 'success'); }}/>}
    {removing && <ConfirmDialog title={removing.hide ? '隐藏这条发言' : '删除这条发言'} buttonText={removing.hide ? '确认隐藏' : '确认删除'} danger onClose={() => setRemoving(null)} onConfirm={async () => { await api(`${circlePath(circle.id)}/messages/${encodeURIComponent(removing.message.id)}${removing.hide ? '/hide' : ''}`, { method: removing.hide ? 'POST' : 'DELETE', ...(removing.hide ? { json: {} } : {}) }); onChanged(); }}><p>{removing.hide ? '这条发言将不再向成员展示。' : '删除后无法恢复这条发言。'}依赖它的 AI 整理与成果需要重新核对。</p></ConfirmDialog>}
  </section>;
}

function ReportDialog({ circleId, message, onClose, onSent }: { circleId: string; message: CircleMessage; onClose: () => void; onSent: () => void }) {
  const task = useTask(), [reason, setReason] = useState('');
  return <CircleModal title="举报发言" onClose={onClose} busy={task.busy}><form className="cz-form" onSubmit={event => { event.preventDefault(); task.run(() => api(`${circlePath(circleId)}/reports`, { method: 'POST', json: { messageId: message.id, reason: reason.trim() } }), onSent); }}><blockquote className="cz-report-quote">{message.text.slice(0, 400)}</blockquote><label className="cz-field">请说明原因<textarea autoFocus value={reason} onChange={event => setReason(event.target.value)} required minLength={2} maxLength={1000} rows={4}/></label><ErrorNote text={task.error}/><div className="cz-form-actions"><button type="button" className="cz-button" disabled={task.busy} onClick={onClose}>取消</button><SubmitButton busy={task.busy}>提交举报</SubmitButton></div></form></CircleModal>;
}
