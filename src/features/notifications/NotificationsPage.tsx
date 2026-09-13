import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Bell, CheckCheck, RefreshCw } from 'lucide-react';
import { api, formatTime, messageOf } from '../../api';
import { Empty, Spinner } from '../../components';

export interface NoticeItem { id: string; kind: string; title: string; body: string; href: string; read: boolean; createdAt: string }
export interface NoticeResponse { items: NoticeItem[]; unread: number }
export function NotificationsPage({ version, onNavigate, onUnread }: { version: number; onNavigate: (href: string) => void; onUnread: (count: number) => void }) {
  const [data, setData] = useState<NoticeResponse | null>(null), [error, setError] = useState('');
  const [reload, setReload] = useState(0), [busy, setBusy] = useState(false);
  const lock = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<NoticeResponse>('/notifications', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setData(result); onUnread(result.unread); setError(''); } }).catch(cause => { if (!controller.signal.aborted) setError(messageOf(cause)); });
    return () => controller.abort();
  }, [version, reload, onUnread]);
  async function read(ids?: string[]) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await api('/notifications/read', { method: 'POST', json: ids ? { ids } : {} }); if (!alive.current) return; const result = await api<NoticeResponse>('/notifications'); if (alive.current) { setData(result); onUnread(result.unread); } }
    catch (cause) { if (alive.current) setError(messageOf(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="tz-card" data-testid="notifications-page"><div className="tz-section-heading"><div><h2><Bell size={19}/>给你的消息</h2><p>{data?.unread ? `${data.unread} 条未读提醒` : '同题、匹配和知识更新会出现在这里。'}</p></div><div className="tz-actions"><button className="icon-button" aria-label="刷新通知" onClick={() => setReload(value => value + 1)}><RefreshCw size={16}/></button><button className="text-button" disabled={busy || !data?.unread} onClick={() => void read()}><CheckCheck size={15}/>全部已读</button></div></div>
    {error && <p className="tz-error" role="alert">{error}</p>}
    {!data && !error ? <Spinner text="正在读取消息…"/> : data?.items.length ? <ul className="tz-notification-list">{data.items.map(item => <li key={item.id} className={item.read ? '' : 'is-unread'} data-testid="notification-item"><span className="tz-notice-dot"/><div><h3>{item.title}</h3><p>{item.body}</p><time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time></div><button className="text-button" disabled={busy} onClick={() => { void read([item.id]).then(() => { if (item.href) onNavigate(item.href); }); }}>{item.href ? <>查看<ArrowUpRight size={14}/></> : '标为已读'}</button></li>)}</ul> : <Empty title="暂时没有新的提醒" text="去发现一个好问题，或留下你想认识的伙伴方向。" action="发现问题" onAction={() => onNavigate('discover')}/>}
  </section>;
}
