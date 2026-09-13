import { useEffect, useRef, useState } from 'react';
import { ChevronDown, CircleHelp, RefreshCw } from 'lucide-react';
import { api, APIError, formatTime, messageOf } from './api';
import { Spinner } from './components';
import { ZhihuCheckReport } from './ZhihuCheckReport';
import type { PageActions, ZhihuValidationState } from './types';

export function ZhihuDataCheck({ actions, disabled, onBusyChange, onReconnect }: {
  actions: PageActions; disabled: boolean; onBusyChange: (value: boolean) => void; onReconnect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<ZhihuValidationState | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true), pending = useRef(false);
  const callbacks = useRef({ onBusyChange, refresh: actions.refresh });
  callbacks.current = { onBusyChange, refresh: actions.refresh };
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); callbacks.current.onBusyChange(false); }; }, []);

  const retryTime = state?.retryAt ? Date.parse(state.retryAt) : 0;
  const waiting = retryTime > now;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  async function load() {
    if (pending.current) return;
    pending.current = true; setLoading(true); setError('');
    const request = new AbortController(); controller.current = request;
    try {
      const response = await api<ZhihuValidationState>('/zhihu/validation', { signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]) });
      if (alive.current) { setState(response); setNow(Date.now()); }
    } catch (cause) { if (alive.current && !request.signal.aborted) setError(messageOf(cause)); }
    finally { pending.current = false; if (alive.current) setLoading(false); }
  }

  async function check() {
    if (pending.current || disabled || !consent || waiting || !state?.connected) return;
    pending.current = true; setBusy(true); setError(''); callbacks.current.onBusyChange(true);
    const request = new AbortController(); controller.current = request;
    try {
      const response = await api<ZhihuValidationState>('/zhihu/validation', { method: 'POST', json: { consent: true }, signal: AbortSignal.any([request.signal, AbortSignal.timeout(85000)]) });
      if (alive.current) { setState(response); setNow(Date.now()); }
      await callbacks.current.refresh();
    } catch (cause) {
      if (alive.current && !request.signal.aborted) {
        setError(messageOf(cause));
        if (cause instanceof APIError && ['zhihu_expired', 'zhihu_required', 'session_changed'].includes(cause.code)) {
          setState(previous => previous ? { ...previous, connected: false } : previous);
          void callbacks.current.refresh().catch(() => {});
        }
        if (cause instanceof APIError && cause.status === 429) {
          try {
            const response = await api<ZhihuValidationState>('/zhihu/validation', { signal: request.signal });
            if (alive.current) { setState({ ...response, retryAt: response.retryAt || new Date(Date.now() + 60000).toISOString() }); setNow(Date.now()); }
          } catch { /* Keep the original, actionable check error. */ }
        }
      }
    } finally {
      pending.current = false; callbacks.current.onBusyChange(false);
      if (alive.current) setBusy(false);
    }
  }

  return <section className="zhihu-data-check" data-testid="zhihu-data-check">
    <button type="button" className="zhihu-check-toggle" aria-expanded={expanded} disabled={busy || disabled} onClick={() => { if (!expanded && !state) void load(); setExpanded(value => !value); }}>
      <span><CircleHelp size={16}/>检查知乎数据连接</span><ChevronDown size={16} className={expanded ? 'expanded' : ''}/>
    </button>
    {expanded && <div className="zhihu-check-body">
      <p>导入遇到问题时，可以检查创作、关注、收藏夹、收藏夹内容和近期收藏是否可用。</p>
      <p>每项最多读取一条，只保存结果、条数和时间。检查内容不会加入画像，结果可在「数据与隐私」中随导入记录清除。</p>
      {loading ? <Spinner text="正在读取上次检查结果…"/> : <>
        {state?.report && <ZhihuCheckReport report={state.report} downloadable/>}
        {(!state?.connected || !actions.data.zhihuConnected) && state && <div className="zhihu-check-reconnect"><p>当前知乎连接已结束。上方如有结果，代表上次检查。</p><button type="button" className="button secondary" onClick={onReconnect} disabled={busy || disabled}>重新连接知乎</button></div>}
        {state?.connected && actions.data.zhihuConnected && <>
          <label className="zhihu-check-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy || disabled}/><span>同意读取上述五类公开数据，每项最多一条</span></label>
          {waiting && <p className="zhihu-check-wait" role="status">{retryTime - now > 90000 ? `可在 ${formatTime(state.retryAt!)} 后再次检查。` : `刚刚读取过知乎数据，${Math.max(1, Math.ceil((retryTime - now) / 1000))} 秒后可再次检查。`}</p>}
          <button type="button" className="button secondary" data-testid="zhihu-check-start" disabled={!consent || busy || disabled || waiting} onClick={() => void check()}>{busy ? <Spinner text="正在逐项检查，最多约 75 秒…"/> : <><RefreshCw size={15}/>{state.report ? '重新检查可用数据' : '检查可用数据'}</>}</button>
        </>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!state && !loading && <button type="button" className="text-button" disabled={busy || disabled} onClick={() => void load()}>重新加载检查状态</button>}
    </div>}
  </section>;
}
