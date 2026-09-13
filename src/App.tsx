import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, BookOpen, Bot, Check, ChevronRight, CircleHelp, Compass, Info, Menu, MessagesSquare, ShieldCheck, Sparkles, UserRound, UsersRound, X } from 'lucide-react';
import { api, messageOf, setCSRF } from './api';
import { Avatar, Empty, PageTitle, Spinner } from './components';
import { ProfileWizard } from './ProfileWizard';
import { ImportDialog, LoginDialog, SettingsDialog } from './AccountDialogs';
import { MatchDialog } from './MatchDialog';
import { ConnectionsPage } from './ConnectionsPage';
import { CirclesPage } from './features/circles/CirclesPage';
import { MatchingPage } from './features/matching/MatchingPage';
import { KnowledgePage } from './features/knowledge/KnowledgePage';
import { CompanionPage } from './features/companion/CompanionPage';
import { AccountPage } from './features/account/AccountPage';
import { NotificationsPage, type NoticeResponse } from './features/notifications/NotificationsPage';
import type { Bootstrap, Match, PageActions, Pool } from './types';

type ShellPage = 'discover' | 'my-circles' | 'matching' | 'profile' | 'connections' | 'notifications' | 'account' | 'companion';
interface Route { page: ShellPage; circleId?: string; conversationId?: string }
type Modal = 'wizard' | 'login' | 'import' | 'settings' | null;
const navigation = [
  { id: 'discover' as const, label: '发现问题', icon: Compass },
  { id: 'my-circles' as const, label: '我的同题', icon: UsersRound },
  { id: 'matching' as const, label: '同频伙伴', icon: Sparkles },
  { id: 'profile' as const, label: '知识画像', icon: BookOpen },
  { id: 'connections' as const, label: '消息', icon: MessagesSquare },
];
const aliases: Record<string, ShellPage> = { discover: 'discover', circles: 'discover', 'my-circles': 'my-circles', matching: 'matching', pairing: 'matching', profile: 'profile', graph: 'profile', knowledge: 'profile', connections: 'connections', notifications: 'notifications', account: 'account', companion: 'companion' };
const safeId = (value: string | undefined | null) => value && /^[a-zA-Z0-9_-]{1,160}$/.test(value) ? value : undefined;
function parseRoute(value = location.hash): Route {
  const local = value.replace(/^#/, '').replace(/^\//, '');
  const [path, query = ''] = local.split('?'), [name, rawId] = path.split('/');
  let id: string | undefined;
  try { id = safeId(rawId ? decodeURIComponent(rawId) : undefined); } catch { id = undefined; }
  const page = aliases[name] || 'discover';
  if (name === 'circles' && id) return { page: 'discover', circleId: id };
  if (page === 'connections') return { page, conversationId: id || safeId(new URLSearchParams(query).get('conversation')) };
  return { page };
}
function routeHash(route: Route) {
  if (route.circleId) return `#circles/${encodeURIComponent(route.circleId)}`;
  if (route.conversationId) return `#connections?conversation=${encodeURIComponent(route.conversationId)}`;
  return `#${route.page}`;
}
function TongzhiBrand() {
  return <span className="tz-brand"><span className="tz-brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40"><path d="M9 11h9a6 6 0 0 1 6 6v13h-9a6 6 0 0 0-6 3V11Zm22 0h-7v19h1a6 6 0 0 1 6 3V11Z"/><path d="M14 17h4m-4 5h4m10-5h-1"/><circle cx="30" cy="6" r="2"/></svg></span><span><strong>同知</strong><small>从一个问题，走向彼此</small></span></span>;
}

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null), [bootError, setBootError] = useState('');
  const [route, setRoute] = useState<Route>(() => parseRoute()), [mobileMenu, setMobileMenu] = useState(false);
  const [modal, setModal] = useState<Modal>(null), [selected, setSelected] = useState<Match | null>(null);
  const [conversationToOpen, setConversationToOpen] = useState<{ userId: string; id: string } | null>(null);
  const [version, setVersion] = useState(0), [unread, setUnread] = useState(0);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const dataRef = useRef(data), alive = useRef(true), refreshSequence = useRef(0);
  const saveLocks = useRef(new Set<string>()), toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  dataRef.current = data;
  const notify = useCallback((text: string, error = false) => {
    if (!alive.current) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, error }); toastTimer.current = setTimeout(() => setToast(null), 5500);
  }, []);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current, result = await api<Bootstrap>('/bootstrap');
    if (!alive.current || sequence !== refreshSequence.current) return;
    if (dataRef.current && result.user.id !== dataRef.current.user.id) {
      setSelected(null); setModal(null); setConversationToOpen(null); setUnread(0); saveLocks.current.clear();
      const next: Route = { page: 'account' }; history.replaceState(null, '', location.pathname + location.search + routeHash(next)); setRoute(next);
    }
    dataRef.current = result; setCSRF(result.csrf); setData(result); setBootError(''); setVersion(value => value + 1);
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh().catch(error => { if (alive.current) setBootError(messageOf(error)); });
    return () => { alive.current = false; refreshSequence.current++; if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, [refresh]);
  useEffect(() => {
    const changed = () => { setRoute(parseRoute()); setMobileMenu(false); setConversationToOpen(null); window.scrollTo({ top: 0, behavior: 'instant' }); };
    window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    if (!mobileMenu) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileMenu(false); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [mobileMenu]);
  useEffect(() => {
    const auth = new URLSearchParams(location.search).get('auth');
    if (!auth) return;
    const texts: Record<string, string> = { success: '知乎已连接，你可以选择要导入的内容。', state_error: '授权请求未能验证，请重新连接知乎。', cancelled: '尚未完成授权，你可以继续参加问题讨论。', failed: '知乎连接未完成，请稍后重试。' };
    notify(texts[auth] || '授权状态已更新', auth === 'failed' || auth === 'state_error');
    const query = new URLSearchParams(location.search); query.delete('auth');
    history.replaceState(null, '', `${location.pathname}${query.size ? `?${query}` : ''}${location.hash}`);
  }, [notify]);
  useEffect(() => {
    if (!data?.user.id) return;
    const events = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | null = null;
    const changed = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { void refresh().catch(() => {}); }, 220); };
    const updated = () => setVersion(value => value + 1);
    events.addEventListener('changed', changed);
    for (const event of ['circles', 'matching', 'notifications', 'pool']) events.addEventListener(event, updated);
    events.addEventListener('open', updated);
    return () => { if (timer) clearTimeout(timer); events.close(); };
  }, [data?.user.id, refresh]);
  useEffect(() => {
    if (!data?.user.id) return;
    const controller = new AbortController();
    void api<NoticeResponse>('/notifications', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setUnread(result.unread); }).catch(() => {});
    return () => controller.abort();
  }, [data?.user.id, version]);
  useEffect(() => {
    if (route.conversationId && data?.user.id) setConversationToOpen({ userId: data.user.id, id: route.conversationId });
    else setConversationToOpen(null);
  }, [route.conversationId, data?.user.id]);

  const navigate = useCallback((destination: string, _pool?: Pool) => {
    const next = parseRoute(destination), hash = routeHash(next);
    setMobileMenu(false);
    if (location.hash === hash) { setRoute(next); window.scrollTo({ top: 0, behavior: 'instant' }); }
    else location.hash = hash;
  }, []);
  const openConversation = useCallback((id: string) => {
    if (!safeId(id) || !dataRef.current) return;
    setSelected(null); setModal(null); setConversationToOpen({ userId: dataRef.current.user.id, id });
    navigate(`connections?conversation=${encodeURIComponent(id)}`);
  }, [navigate]);
  const conversationOpened = useCallback(() => setConversationToOpen(null), []);
  const circlesNotify = useCallback((message: string, kind?: 'success' | 'error') => notify(message, kind === 'error'), [notify]);
  function open(next: Modal) { setSelected(null); setModal(next); setMobileMenu(false); }
  async function onSave(match: Match) {
    const current = dataRef.current;
    if (!current || saveLocks.current.has(match.id)) return;
    saveLocks.current.add(match.id);
    const saved = !current.savedIds.includes(match.id), userId = current.user.id;
    try {
      const result = await api<{ savedIds: string[] }>(`/saved/${encodeURIComponent(match.id)}`, { method: 'PUT', json: { saved } });
      if (!alive.current || dataRef.current?.user.id !== userId) return;
      setData(previous => previous?.user.id === userId ? { ...previous, savedIds: result.savedIds } : previous);
      setVersion(value => value + 1); notify(saved ? `已收藏 ${match.name}。` : '已取消收藏。');
    } catch (error) { if (alive.current && dataRef.current?.user.id === userId) notify(messageOf(error), true); }
    finally { saveLocks.current.delete(match.id); }
  }
  if (!data) return <div className="boot-screen tz-boot"><TongzhiBrand/><div>{bootError ? <Empty title="暂时没有连接上" text={bootError} action="重新连接" onAction={() => { setBootError(''); void refresh().catch(error => setBootError(messageOf(error))); }}/> : <Spinner text="正在打开同知…"/>}</div></div>;
  const actions: PageActions = { data, refresh, notify, onCreate: () => open('wizard'), onLogin: () => open('login'), onImport: () => open(data.zhihuConnected ? 'import' : 'login'), onSelect: match => { setModal(null); setSelected(match); }, onSave, navigate };
  const activePage = route.page === 'notifications' ? 'connections' : route.page;
  const currentNavigation = navigation.find(item => item.id === activePage) || (route.page === 'account' ? { label: '账号与偏好', icon: UserRound } : { label: 'AI 陪伴', icon: Bot });
  const messageCount = unread + data.incomingCount;
  const reset = async () => { setSelected(null); setModal(null); setConversationToOpen(null); await refresh(); navigate('discover'); };
  return <div className="app-shell tongzhi-shell" data-testid="tongzhi-app">
    <a href="#main-content" className="tz-skip-link" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳到主要内容</a>
    {mobileMenu && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setMobileMenu(false)}/>}
    <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}><a href="#discover" className="brand-link" aria-label="同知首页" onClick={() => setMobileMenu(false)}><TongzhiBrand/></a><div className="sidebar-section-label">问题，是相遇的开始</div>
      <nav aria-label="主导航">{navigation.map(item => <a key={item.id} href={`#${item.id}`} className={`nav-item ${activePage === item.id ? 'active' : ''}`} aria-current={activePage === item.id ? 'page' : undefined} onClick={() => setMobileMenu(false)}><item.icon size={19}/><span>{item.label}</span>{item.id === 'connections' && messageCount > 0 && <span className="nav-badge">{messageCount > 99 ? '99+' : messageCount}</span>}{activePage === item.id && <span className="nav-indicator"/>}</a>)}</nav>
      <div className="tz-sidebar-note"><CircleHelp size={25}/><p>带着问题来，<br/>带着新的理解走。</p><span>同题讨论 · 知识成长<br/>与愿意深聊的人相遇</span></div>
      <div className="sidebar-bottom"><a href="#companion" className={`nav-item ${route.page === 'companion' ? 'active' : ''}`} onClick={() => setMobileMenu(false)}><Bot size={18}/><span>AI 陪伴</span><span className="tz-mini-ai">AI</span></a><button className="nav-item privacy-nav" onClick={() => open('settings')}><ShieldCheck size={18}/><span>数据与隐私</span></button><a href="#account" className="sidebar-user" onClick={() => setMobileMenu(false)}><Avatar name={data.profile?.input.name || data.user.name} seed={data.user.id} src={data.user.avatar} size={36}/><div><strong>{data.profile?.input.name || data.user.name}</strong><span>{data.zhihuConnected ? '知乎已连接' : data.user.provider === 'email' ? '邮箱账号' : '账号与偏好'}</span></div><ChevronRight size={16}/></a></div>
    </aside><div className="workspace"><header className="topbar"><div className="topbar-location"><button className="icon-button mobile-menu" aria-label="打开导航" aria-expanded={mobileMenu} onClick={() => setMobileMenu(value => !value)}><Menu size={21}/></button><currentNavigation.icon size={16}/><span>{route.circleId ? '同题讨论' : currentNavigation.label}</span><span className="breadcrumb-divider">/</span><span className="topbar-greeting">和好问题一起生长</span></div><div className="topbar-actions"><span className="hackathon-badge"><i/>知乎黑客松</span><button className="icon-button tz-notification-trigger" aria-label={`通知${unread ? `，${unread}条未读` : ''}`} onClick={() => navigate('notifications')}><Bell size={19}/>{unread > 0 && <i/>}</button><button className="button zhihu-button" onClick={data.zhihuConnected ? actions.onImport : actions.onLogin}><span className="zhihu-mark">知</span><span>{data.zhihuConnected ? '导入内容' : '连接知乎'}</span><ChevronRight size={14}/></button></div></header>
      <main className="main-content" id="main-content" tabIndex={-1}><div key={data.user.id} className="tz-route-content">
        {(route.page === 'discover' || route.page === 'my-circles') && <CirclesPage view={route.page === 'my-circles' ? 'mine' : 'discover'} version={version} initialCircleId={route.circleId} onNavigate={navigate} onProfile={() => navigate('profile')} notify={circlesNotify} onConversation={openConversation}/>}
        {route.page === 'matching' && <MatchingPage actions={actions} version={version} onConnected={openConversation} onNavigate={navigate}/>}
        {route.page === 'profile' && <KnowledgePage actions={actions} version={version} onNavigate={navigate}/>}
        {route.page === 'companion' && <CompanionPage actions={actions} version={version} onNavigate={navigate}/>}
        {route.page === 'account' && <AccountPage actions={actions} version={version} onPrivacy={() => open('settings')}/>}
        {(route.page === 'connections' || route.page === 'notifications') && <><div className="tz-tabs tz-page-tabs" role="group" aria-label="消息类型"><button className={route.page === 'connections' ? 'active' : ''} aria-pressed={route.page === 'connections'} onClick={() => navigate('connections')}><MessagesSquare size={15}/>伙伴私聊{data.incomingCount > 0 && <span className="tz-count">{data.incomingCount}</span>}</button><button className={route.page === 'notifications' ? 'active' : ''} aria-pressed={route.page === 'notifications'} onClick={() => navigate('notifications')}><Bell size={15}/>通知{unread > 0 && <span className="tz-count">{unread}</span>}</button></div>{route.page === 'connections' ? <ConnectionsPage actions={actions} version={version} requestedConversationId={conversationToOpen?.userId === data.user.id ? conversationToOpen.id : undefined} onConversationOpened={conversationOpened}/> : <><PageTitle eyebrow="KEEP THE CONVERSATION GOING" title="每一次回应，都有回音" description="同题讨论、伙伴匹配和知识更新，在这里继续。"/><NotificationsPage version={version} onNavigate={navigate} onUnread={setUnread}/></>}</>}
      </div><footer className="page-footer"><span>同知 · 从问题到理解</span><span>让知识生长，也让彼此看见。</span><span>知乎黑客松参赛作品</span></footer></main>
    </div><nav className="mobile-bottom-nav" aria-label="快捷导航">{navigation.map(item => <a key={item.id} href={`#${item.id}`} className={activePage === item.id ? 'active' : ''} aria-current={activePage === item.id ? 'page' : undefined}><item.icon size={20}/><span>{item.label}</span>{item.id === 'connections' && messageCount > 0 && <i/>}</a>)}</nav>
    {modal === 'wizard' && <ProfileWizard key={data.user.id} data={data} onClose={() => setModal(null)} onComplete={async () => { await refresh(); setModal(null); }} notify={notify}/>}
    {modal === 'login' && <LoginDialog key={data.user.id} actions={actions} onClose={() => setModal(null)}/>}
    {modal === 'import' && <ImportDialog key={data.user.id} actions={actions} onClose={() => setModal(null)}/>}
    {modal === 'settings' && <SettingsDialog key={data.user.id} actions={actions} onClose={() => setModal(null)} onReset={reset}/>}
    {selected && <MatchDialog key={`${data.user.id}:${selected.id}`} match={{ ...selected, saved: data.savedIds.includes(selected.id) }} actions={actions} onClose={() => setSelected(null)}/>}
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <Info size={17}/> : <Check size={17}/>}<span>{toast.text}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={15}/></button></div>}
  </div>;
}
