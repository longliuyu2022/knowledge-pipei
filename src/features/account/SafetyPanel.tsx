import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, MessageSquare, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, formatTime, messageOf } from '../../api';
import { Spinner } from '../../components';

interface SafetyCase { id: string; scope: string; reason: string; decision: string; status: string; createdAt: string; resolvedAt: string | null; appeal: string }
interface Sanction { id: string; kind: string; reason: string; expiresAt: string | null }
interface SafetyState { cases: SafetyCase[]; sanctions: Sanction[] }
const statusLabels: Record<string, string> = { pending: '等待复核', allowed: '复核已通过', resolved: '已处理' };
const scopeLabels: Record<string, string> = { conversation: '伙伴私聊', invitation: '交流邀请', circle: '同题讨论' };

export function SafetyPanel({ version, notify }: { version: number; notify: (text: string, error?: boolean) => void }) {
  const [data, setData] = useState<SafetyState | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null), [drafts, setDrafts] = useState<Record<string, string>>({}), [busyId, setBusyId] = useState('');
  const alive = useRef(true), lock = useRef(false), loadSequence = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; loadSequence.current++; }; }, []);
  useEffect(() => {
    const controller = new AbortController(), sequence = ++loadSequence.current;
    void api<SafetyState>('/safety', { signal: controller.signal }).then(result => { if (!controller.signal.aborted && sequence === loadSequence.current) { setData(result); setError(''); } }).catch(cause => { if (!controller.signal.aborted && sequence === loadSequence.current) setError(messageOf(cause)); });
    return () => controller.abort();
  }, [version, reload]);
  async function appeal(item: SafetyCase) {
    const text = (drafts[item.id] ?? item.appeal).trim();
    if (lock.current || text.length < 5) return;
    lock.current = true; setBusyId(item.id); setError('');
    try {
      await api(`/safety/${encodeURIComponent(item.id)}/appeal`, { method: 'POST', json: { text } });
      if (!alive.current) return;
      setEditingId(null); setReload(value => value + 1); notify('申诉说明已提交，等待人工复核。');
    } catch (cause) { if (alive.current) setError(messageOf(cause)); }
    finally { lock.current = false; if (alive.current) setBusyId(''); }
  }
  const active = data?.sanctions.filter(item => !item.expiresAt || new Date(item.expiresAt).getTime() > Date.now()) || [];
  return <section className="tz-card tz-top-gap" data-testid="account-safety"><div className="tz-section-heading"><div><h2><ShieldCheck size={19}/>交流状态与申诉</h2><p>查看处理原因，并补充当时讨论的语境。申诉由人工复核。</p></div><button className="icon-button" aria-label="刷新交流处理记录" onClick={() => setReload(value => value + 1)}><RefreshCw size={16}/></button></div>
    {error && <p className="tz-error" role="alert">{error}</p>}
    {!data && !error ? <Spinner text="正在读取处理记录…"/> : data && <><div className={`tz-safety-state ${active.length ? 'is-restricted' : ''}`}><ShieldCheck size={20}/><div><strong>{active.length ? '交流功能暂时受限' : '当前交流功能正常'}</strong><p>{active.length ? '请查看下面的原因与期限，并通过处理记录提交申诉。' : '你可以正常参与讨论、发起匹配和与伙伴交流。'}</p></div></div>
      {active.map(item => <div className="tz-sanction" key={item.id}><strong>{item.kind === 'mute' ? '暂时限制发言' : '账号交流受限'}</strong><p>{item.reason}</p><span>{item.expiresAt ? `预计结束：${formatTime(item.expiresAt)}` : '处理期限：待人工复核'}</span></div>)}
      {data.cases.length > 0 ? <ul className="tz-safety-list">{data.cases.map(item => <li key={item.id} data-testid="safety-case"><div className="tz-section-heading"><div><h3>{scopeLabels[item.scope] || '交流内容'}处理记录</h3><time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time></div><span className="tz-status">{statusLabels[item.status] || '处理中'}</span></div><p>{item.reason}</p>{item.status === 'allowed' && <p className="tz-caption"><Check size={13}/>本条记录已通过人工复核，请以当前交流状态为准。</p>}{item.appeal && <details className="tz-evidence"><summary><ChevronDown size={13}/>我的申诉说明</summary><blockquote>{item.appeal}</blockquote></details>}
        {editingId === item.id ? <form className="tz-form tz-top-gap" onSubmit={event => { event.preventDefault(); void appeal(item); }}><label>补充讨论语境与申诉原因<textarea data-testid="safety-appeal-text" value={drafts[item.id] ?? item.appeal} onChange={event => setDrafts(value => ({ ...value, [item.id]: event.target.value }))} required minLength={5} maxLength={1000} rows={4} placeholder="比如：这段内容是在讨论什么，为什么希望重新核对？"/></label><div className="tz-actions"><button className="button primary" data-testid="safety-appeal-submit" disabled={Boolean(busyId) || (drafts[item.id] ?? item.appeal).trim().length < 5}>{busyId === item.id ? <Spinner text="正在提交…"/> : item.appeal ? '更新申诉说明' : '提交申诉'}</button><button className="button secondary" type="button" disabled={Boolean(busyId)} onClick={() => setEditingId(null)}>暂不提交</button></div></form> : <button className="text-button tz-top-gap" data-testid="safety-appeal-open" disabled={Boolean(busyId)} onClick={() => setEditingId(item.id)}><MessageSquare size={14}/>{item.appeal ? '更新申诉说明' : '补充说明与申诉'}</button>}
      </li>)}</ul> : <p className="tz-caption tz-top-gap">暂时没有需要处理的记录。</p>}
    </>}
  </section>;
}
