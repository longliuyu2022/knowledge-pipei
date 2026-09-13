import { useEffect, useRef, useState } from 'react';
import { Flag } from 'lucide-react';
import { api, messageOf } from '../../api';
import { Dialog, Spinner } from '../../components';
import type { Message } from '../../types';

export function ReportDialog({ conversationId, message, personName, onClose, onSent }: { conversationId: string; message: Message; personName: string; onClose: () => void; onSent: (notice: string) => void }) {
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), lock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function report() {
    if (lock.current || reason.trim().length < 3) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await api<{ id: string; notice: string }>('/reports', { method: 'POST', json: { scope: 'conversation', scopeId: conversationId, messageId: message.id, reason: reason.trim() } });
      if (alive.current) onSent(result.notice || '举报已提交，等待复核。');
    } catch (cause) { if (alive.current) setError(messageOf(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <Dialog title="举报这条消息" onClose={onClose} busy={busy}><form className="tz-form tz-report-dialog-body" data-testid="conversation-report-dialog" onSubmit={event => { event.preventDefault(); void report(); }}><p className="tz-muted">请说明 {personName} 的这条发言存在什么问题，工作人员会结合讨论语境复核。</p><blockquote className="tz-report-quote">{message.text}</blockquote><label>举报原因<textarea data-testid="conversation-report-reason" value={reason} onChange={event => setReason(event.target.value)} required minLength={3} maxLength={1000} rows={4} placeholder="请说明骚扰、威胁、广告或其他具体问题" autoFocus/></label>{error && <p className="tz-error" role="alert">{error}</p>}<p className="tz-caption">提交举报后，你仍可使用屏蔽功能立即停止联系。</p><div className="tz-actions"><button className="button primary" data-testid="conversation-report-submit" disabled={busy || reason.trim().length < 3}>{busy ? <Spinner text="正在提交…"/> : <><Flag size={15}/>提交举报</>}</button><button className="button secondary" type="button" disabled={busy} onClick={onClose}>取消</button></div></form></Dialog>;
}
