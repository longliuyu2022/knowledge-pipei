import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Bot, Check, MessageCircle, Plus, RefreshCw, Send, Sparkles, Trash2 } from 'lucide-react';
import { api, formatTime, messageOf } from '../../api';
import { Dialog, Empty, PageTitle, Spinner } from '../../components';
import type { PageActions } from '../../types';

type CompanionMode = 'self' | 'partner';
export interface CompanionSession { id: string; mode: CompanionMode; title: string; updatedAt: string }
export interface CompanionMessage { id: string; role: 'user' | 'assistant' | 'system'; mode?: 'user' | 'model' | 'rules'; text: string; createdAt: string }
interface SessionDetail { session: CompanionSession; messages: CompanionMessage[] }
interface SendResponse { messages: CompanionMessage[]; mode: 'model' | 'rules' | 'existing'; notice?: string }
const modeLabels: Record<CompanionMode, string> = { self: '与自己对话', partner: '一起探索问题' };
const mergeMessages = (first: CompanionMessage[], second: CompanionMessage[]) => [...new Map([...first, ...second].map(item => [item.id, item])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export function CompanionPage({ actions, version, onNavigate }: { actions: PageActions; version: number; onNavigate: (page: string) => void }) {
  const [sessions, setSessions] = useState<CompanionSession[]>([]), [listLoading, setListLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null), [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false), [loadError, setLoadError] = useState('');
  const [mode, setMode] = useState<CompanionMode>('self'), [consent, setConsent] = useState(false);
  const [creating, setCreating] = useState(false), [reload, setReload] = useState(0), [detailReload, setDetailReload] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({}), [sendErrors, setSendErrors] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<CompanionSession | null>(null), [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState('');
  const alive = useRef(true), createLock = useRef(false), sendLocks = useRef(new Set<string>());
  const detailSequence = useRef(0), selectedRef = useRef(selectedId), draftsRef = useRef(drafts);
  const attempts = useRef(new Map<string, { text: string; clientMessageId: string }>());
  const messagesEnd = useRef<HTMLDivElement>(null);
  selectedRef.current = selectedId; draftsRef.current = drafts;
  useEffect(() => { alive.current = true; return () => { alive.current = false; detailSequence.current++; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: CompanionSession[] }>('/companion/sessions', { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setSessions(result.items); setLoadError(''); } })
      .catch(cause => { if (!controller.signal.aborted) setLoadError(messageOf(cause)); })
      .finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [version, reload]);
  useEffect(() => {
    setDetail(null); setLoadError('');
    if (!selectedId) return;
    const controller = new AbortController(), sequence = ++detailSequence.current;
    setDetailLoading(true);
    void api<SessionDetail>(`/companion/sessions/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && sequence === detailSequence.current) setDetail(result); })
      .catch(cause => { if (!controller.signal.aborted && sequence === detailSequence.current) setLoadError(messageOf(cause)); })
      .finally(() => { if (!controller.signal.aborted && sequence === detailSequence.current) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedId, detailReload]);
  useEffect(() => { const viewport = messagesEnd.current?.parentElement; if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }, [detail?.messages.length]);

  function selectSession(id: string | null) {
    if (id === selectedRef.current) return;
    detailSequence.current++; selectedRef.current = id; setSelectedId(id); setConsent(false); setLoadError('');
  }
  async function createSession() {
    if (!consent || createLock.current) return;
    createLock.current = true; setCreating(true); setLoadError('');
    try {
      const result = await api<{ id: string }>('/companion/sessions', { method: 'POST', json: { mode, consent: true } });
      if (!alive.current) return;
      selectedRef.current = result.id; setSelectedId(result.id); setReload(value => value + 1);
    } catch (cause) { if (alive.current) setLoadError(messageOf(cause)); }
    finally { createLock.current = false; if (alive.current) setCreating(false); }
  }
  async function send() {
    const id = selectedId, raw = id ? draftsRef.current[id] || '' : '', text = raw.trim();
    if (!id || !text || !consent || !detail || sendLocks.current.has(id)) return;
    const previous = attempts.current.get(id), attempt = previous?.text === text ? previous : { text, clientMessageId: crypto.randomUUID() };
    attempts.current.set(id, attempt); sendLocks.current.add(id);
    setSending(value => ({ ...value, [id]: true })); setSendErrors(value => ({ ...value, [id]: '' }));
    try {
      const result = await api<SendResponse>(`/companion/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', json: { ...attempt, consent: true } });
      if (!alive.current) return;
      if (selectedRef.current === id) setDetail(value => value?.session.id === id ? { ...value, messages: mergeMessages(value.messages, result.messages) } : value);
      if (draftsRef.current[id] === raw) setDrafts(value => ({ ...value, [id]: '' }));
      setNotices(value => ({ ...value, [id]: result.mode === 'existing' ? value[id] || '' : result.notice || (result.mode === 'rules' ? '本次使用本地规则回应，未生成模型回复。' : '') }));
      attempts.current.delete(id); setReload(value => value + 1);
    } catch (cause) { if (alive.current) setSendErrors(value => ({ ...value, [id]: messageOf(cause) })); }
    finally { sendLocks.current.delete(id); if (alive.current) setSending(value => ({ ...value, [id]: false })); }
  }
  async function deleteSession() {
    if (!deleteTarget || deleting) return;
    const id = deleteTarget.id; setDeleting(true); setDeleteError('');
    try {
      await api(`/companion/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!alive.current) return;
      selectSession(null); setDeleteTarget(null); setReload(value => value + 1); attempts.current.delete(id);
      setDrafts(value => { const next = { ...value }; delete next[id]; return next; });
      actions.notify('这段 AI 对话已删除。');
    } catch (cause) { if (alive.current) setDeleteError(messageOf(cause)); }
    finally { if (alive.current) setDeleting(false); }
  }
  const currentMode = detail?.session.mode || sessions.find(item => item.id === selectedId)?.mode || mode;
  const consentInput = <label className="tz-consent"><input type="checkbox" checked={consent} data-testid="companion-consent" onChange={event => setConsent(event.target.checked)} disabled={creating}/><span>我同意将已确认的知识画像、本次输入与这段 AI 对话的上下文发送给本站配置的模型，用于本次回应。</span></label>;

  return <div className="tz-feature" data-testid="companion-page"><PageTitle eyebrow="SPACE TO THINK, ROOM TO TALK" title="给思考留一个回声" description="梳理问题，尝试新视角，再把想法带回真实的交流。"/>
    <div className="tz-info"><Bot size={20}/><p>这里是 AI 陪伴。回答由 AI 或本地规则生成，不代表任何真实用户；内容不会自动进入知识画像。</p></div>
    <div className={`tz-companion-layout ${selectedId ? 'has-selection' : ''}`}><aside className="tz-card tz-session-sidebar"><div className="tz-section-heading"><h2><MessageCircle size={18}/>我的对话</h2><button className="icon-button" aria-label="刷新 AI 对话" onClick={() => setReload(value => value + 1)}><RefreshCw size={16}/></button></div><button className="button secondary tz-full-width" data-testid="companion-new" disabled={creating} onClick={() => selectSession(null)}><Plus size={16}/>开始新对话</button>
      {listLoading ? <Spinner text="正在读取对话…"/> : sessions.length ? <nav className="tz-session-list" aria-label="AI 对话记录">{sessions.map(session => <button key={session.id} className={session.id === selectedId ? 'active' : ''} onClick={() => selectSession(session.id)} disabled={creating} data-testid="companion-session"><span>{session.title || modeLabels[session.mode]}</span><small>{modeLabels[session.mode]} · {formatTime(session.updatedAt)}</small></button>)}</nav> : <p className="tz-caption tz-top-gap">还没有对话。选择一种方式，从一个问题开始。</p>}
      <button className="text-button tz-top-gap" onClick={() => onNavigate('profile')}>把收获整理进知识画像<ArrowUpRight size={14}/></button>
    </aside><section className="tz-card tz-companion-chat">
      {loadError && <p className="tz-error" role="alert">{loadError}</p>}
      {!selectedId ? <div className="tz-companion-welcome"><span className="tz-ai-emblem"><Sparkles size={30}/></span><span className="tz-ai-badge"><Bot size={13}/>AI 陪伴</span><h2>今天，想把什么想清楚？</h2><p className="tz-muted">选择一种对话方式。你的表达会保留在这段对话中，可随时回来继续。</p><div className="tz-mode-grid"><button type="button" className={mode === 'self' ? 'active' : ''} aria-pressed={mode === 'self'} onClick={() => setMode('self')}><strong>与自己对话</strong><span>梳理兴趣、疑问和下一步</span></button><button type="button" className={mode === 'partner' ? 'active' : ''} aria-pressed={mode === 'partner'} onClick={() => setMode('partner')}><strong>一起探索问题</strong><span>拆解疑问，试试另一种视角</span></button></div>{consentInput}<button className="button primary" data-testid="companion-create" onClick={() => void createSession()} disabled={!consent || creating}>{creating ? <Spinner text="正在创建…"/> : <><Plus size={16}/>创建对话</>}</button></div> : <>
        <button className="text-button redesign-ai-back" onClick={() => selectSession(null)}>返回对话列表</button><div className="tz-section-heading tz-chat-heading"><div><span className="tz-ai-badge"><Bot size={13}/>AI 陪伴</span><h2>{detail?.session.title || modeLabels[currentMode]}</h2></div><div className="tz-actions"><span className="tz-caption">{modeLabels[currentMode]}</span><button className="icon-button" aria-label="刷新这段 AI 对话" disabled={detailLoading || sending[selectedId]} onClick={() => setDetailReload(value => value + 1)}><RefreshCw size={16}/></button><button className="icon-button" aria-label="删除这段 AI 对话" disabled={!detail || sending[selectedId]} onClick={() => { setDeleteError(''); setDeleteTarget(detail!.session); }}><Trash2 size={16}/></button></div></div>
        <div className="tz-companion-messages" aria-label="AI 对话内容" aria-live="polite" aria-busy={detailLoading} data-testid="companion-messages">{detailLoading ? <Spinner text="正在打开对话…"/> : detail?.messages.length ? detail.messages.map(item => <article key={item.id} className={`tz-ai-message ${item.role === 'user' ? 'is-mine' : ''}`} data-testid="companion-message"><div className="tz-message-label">{item.role === 'user' ? '我' : item.role === 'system' ? '系统提示' : <><Bot size={13}/>{item.mode === 'rules' ? '本地规则提示' : 'AI 陪伴'}</>}<time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time></div><p>{item.text}</p></article>) : !loadError && <Empty title={currentMode === 'self' ? '从一个还没有答案的问题开始' : '带着一个具体问题，开始探索'} text={currentMode === 'self' ? '可以聊聊最近的兴趣、一个困惑，或刚刚改变的想法。' : '可以一起梳理解释、寻找反例，或设计一个小实验。'}/>}<div ref={messagesEnd}/></div>
        {notices[selectedId] && <p className="tz-inline-note" role="status"><Check size={14}/>{notices[selectedId]}</p>}
        {sendErrors[selectedId] && <p className="tz-error" role="alert">{sendErrors[selectedId]} 你的输入已保留。</p>}
        <form className="tz-form tz-chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>{consentInput}<label className="tz-sr-only" htmlFor="companion-input">想对 AI 说的话</label><textarea id="companion-input" data-testid="companion-input" rows={3} maxLength={2000} value={drafts[selectedId] || ''} onChange={event => { const text = event.target.value; setDrafts(value => ({ ...value, [selectedId]: text })); }} placeholder="慢慢说，你正在想什么？" disabled={!detail || detailLoading}/><div className="tz-composer-bottom"><p className="tz-caption">AI 的回应供你参考。你可以在知识画像中选择本人发言，再确认要保留的收获。</p><button className="button primary" data-testid="companion-send" disabled={!consent || !detail || !drafts[selectedId]?.trim() || sending[selectedId]}>{sending[selectedId] ? <Spinner text="正在回应…"/> : <><Send size={15}/>发送</>}</button></div></form>
      </>}
    </section></div>
    {deleteTarget && <Dialog title="删除这段 AI 对话？" onClose={() => setDeleteTarget(null)} busy={deleting}><div className="tz-card"><p className="tz-muted">“{deleteTarget.title}”及其关联的知识建议将被删除，此操作无法撤销。</p>{deleteError && <p className="tz-error tz-top-gap" role="alert">{deleteError}</p>}<div className="tz-actions tz-top-gap"><button className="button secondary" disabled={deleting} onClick={() => setDeleteTarget(null)}>保留对话</button><button className="button danger" data-testid="companion-delete-confirm" disabled={deleting} onClick={() => void deleteSession()}>{deleting ? '正在删除…' : '确认删除'}</button></div></div></Dialog>}
    {!actions.data.profile && <p className="tz-caption tz-top-gap">还没有知识画像也可以开始对话。<button className="text-button" onClick={actions.onCreate}>介绍自己的兴趣</button></p>}
  </div>;
}
