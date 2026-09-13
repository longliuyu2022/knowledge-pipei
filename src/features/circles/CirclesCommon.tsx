import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Check, ExternalLink, LoaderCircle, X } from 'lucide-react';
import { APIError, messageOf } from '../../api';
import type { CircleCitation, CircleDuration, CirclePhase, CircleSource } from '../../../shared/circles-types';

export type Notify = (message: string, kind?: 'success' | 'error') => void;
export const MutationErrorContext = createContext<(error: unknown) => void>(() => {});
export const phaseNames: Record<CirclePhase, string> = { recruiting: '召集中', discussing: '讨论中', reviewing: '待核对', completed: '本轮完成', archived: '已归档', dormant: '暂时休眠' };
export const durationNames: Record<CircleDuration, string> = { '24h': '24 小时', '7d': '7 天', ongoing: '持续参与' };
export const scopeNames: Record<CircleSource['scope'], string> = { link: '仅链接', excerpt: '成员提供的原文摘录', 'zhihu-search': '知乎搜索摘要' };
export const scopeNotes: Record<CircleSource['scope'], string> = { link: '只保存网址，未读取正文。', excerpt: '由成员手动提供的原文片段，请对照来源核实。', 'zhihu-search': '来自知乎搜索返回的摘要，不代表全文。' };
export const circlePath = (id: string) => `/circles/${encodeURIComponent(id)}`;
export const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
export const dateTime = (value: string | null | undefined) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
};
export function safeUrl(value: string) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

export function useAlive() {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return alive;
}

export function useTask() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const busyRef = useRef(false), alive = useAlive(), onFailure = useContext(MutationErrorContext);
  async function run<T>(job: () => Promise<T>, onSuccess?: (value: T) => void, onError?: (error: unknown) => void) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const result = await job();
      if (alive.current) { onSuccess?.(result); return result; }
    } catch (err) {
      if (alive.current && !isAbort(err)) { setError(messageOf(err)); onError?.(err); onFailure(err); }
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  return { busy, error, setError, run };
}

export function CircleModal({ title, children, onClose, busy = false, wide = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  const opener = useRef(typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null);
  useEffect(() => {
    const dialog = ref.current;
    const oldOverflow = document.body.style.overflow;
    if (dialog && !dialog.open) dialog.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      dialog?.close(); document.body.style.overflow = oldOverflow;
      requestAnimationFrame(() => { if (opener.current?.isConnected && !document.querySelector('dialog[open]')) opener.current.focus({ preventScroll: true }); });
    };
  }, []);
  return <dialog ref={ref} className={`cz-dialog ${wide ? 'cz-dialog-wide' : ''}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="cz-modal-shell"><header className="cz-modal-heading"><h2 id={titleId}>{title}</h2><button type="button" className="cz-icon" aria-label="关闭弹窗" onClick={onClose} disabled={busy}><X size={20}/></button></header>{children}</div>
  </dialog>;
}

export function Loading({ text = '正在加载…' }: { text?: string }) { return <div className="cz-loading" role="status"><LoaderCircle size={18} className="cz-spin"/>{text}</div>; }
export function ErrorNote({ text }: { text: string }) { return text ? <div className="cz-error" role="alert"><AlertCircle size={17}/><p>{text}</p></div> : null; }
export function Notice({ children }: { children: ReactNode }) { return <div className="cz-notice">{children}</div>; }
export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <div className="cz-empty"><div className="cz-empty-mark">？</div><h3>{title}</h3><p>{children}</p>{action}</div>; }
export function PhaseBadge({ phase }: { phase: CirclePhase }) { return <span className={`cz-badge cz-phase-${phase}`}>{phaseNames[phase]}</span>; }
export function SubmitButton({ busy, children, disabled = false }: { busy: boolean; children: ReactNode; disabled?: boolean }) { return <button type="submit" className="cz-button cz-primary" disabled={busy || disabled}>{busy ? <LoaderCircle size={16} className="cz-spin"/> : null}{busy ? '正在处理…' : children}</button>; }

export function Citations({ citations, sourceIds, sources, onMessage }: { citations: CircleCitation[]; sourceIds: string[]; sources: CircleSource[]; onMessage?: (id: string) => void }) {
  if (!citations.length && !sourceIds.length) return null;
  return <details className="cz-citations"><summary>查看依据 · {citations.length} 条发言 · {sourceIds.length} 份资料</summary><div>
    {citations.map((citation, index) => <blockquote key={`${citation.messageId}-${index}`}><p>“{citation.quote}”</p><footer>{citation.name}{onMessage && <button type="button" className="cz-text-button" onClick={() => onMessage(citation.messageId)}>定位发言</button>}</footer></blockquote>)}
    {sourceIds.map(id => { const source = sources.find(item => item.id === id); return source ? <div className="cz-cited-source" key={id}><span className="cz-source-label">{scopeNames[source.scope]}</span><a href={safeUrl(source.url)} target="_blank" rel="noreferrer">{source.title}<ExternalLink size={13}/></a></div> : <p key={id} className="cz-muted">相关资料目前不可见。</p>; })}
  </div></details>;
}

export function ConfirmDialog({ title, children, buttonText, onConfirm, onClose, danger = false }: { title: string; children: ReactNode; buttonText: string; onConfirm: () => Promise<unknown>; onClose: () => void; danger?: boolean }) {
  const task = useTask();
  return <CircleModal title={title} onClose={onClose} busy={task.busy}><div className="cz-form"><div className="cz-dialog-copy">{children}</div><ErrorNote text={task.error}/><div className="cz-form-actions"><button className="cz-button" disabled={task.busy} onClick={onClose}>取消</button><button className={`cz-button ${danger ? 'cz-danger' : 'cz-primary'}`} disabled={task.busy} onClick={() => task.run(onConfirm, onClose)}>{task.busy ? <LoaderCircle size={16} className="cz-spin"/> : <Check size={16}/>} {buttonText}</button></div></div></CircleModal>;
}

export function isMembershipError(error: unknown) { return error instanceof APIError && [401, 403].includes(error.status); }
