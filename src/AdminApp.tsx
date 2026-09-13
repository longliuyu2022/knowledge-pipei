import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Activity, ArrowLeft, ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, CircleHelp, Fingerprint, LockKeyhole, LogOut, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Sparkles, UserRoundCheck, UsersRound, X } from 'lucide-react';
import { GOALS, STYLE_AXES, TOPICS } from '../shared/catalog.js';
import { Avatar, Logo, Radar, SourceBadge, Spinner } from './components';
import { AdminAPIError, adminApi, adminMessage, isAdminUnauthorized, setAdminCsrf } from './admin-api';
import type { AdminOverview, AdminSession, AdminUserDetail, AdminUserFilters, AdminUserRow, AdminUsers } from './admin-types';
import './admin.css';

type Gate = 'checking' | 'hidden' | 'login' | 'active' | 'unconfigured' | 'error' | 'logging-out';
const LOGOUT_EVENT = 'tongpin-admin-logout';
const EMPTY_FILTERS: AdminUserFilters = { q: '', provider: 'all', profile: 'all', visibility: 'all', topic: 'all', page: 1 };
const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
const timeFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function dateTime(value: string | null) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '暂无记录';
  return timeFormatter.format(new Date(value));
}

export default function AdminApp() {
  const [gate, setGate] = useState<Gate>('checking');
  const [session, setSession] = useState<AdminSession | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const wasAuthenticated = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const lastSignal = useRef('');
  const logoutPending = useRef(false);

  const clearSession = useCallback(() => {
    generation.current += 1;
    pending.current?.abort();
    pending.current = null;
    setAdminCsrf(null);
    setSession(null);
  }, []);

  const checkSession = useCallback(async (forceLogin = false, message = '') => {
    if (logoutPending.current) return;
    clearSession();
    const id = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    setGate('checking');
    setError('');
    if (message) setNotice(message);
    try {
      const next = await adminApi<AdminSession>('/session', { signal: controller.signal });
      if (id !== generation.current) return;
      setAdminCsrf(next.csrf);
      setSession(next);
      if (!next.configured) setGate('unconfigured');
      else if (next.authenticated && !forceLogin) {
        wasAuthenticated.current = true;
        setNotice('');
        setGate('active');
      } else {
        if (!message && wasAuthenticated.current) setNotice('管理员会话已结束，请重新登录。');
        wasAuthenticated.current = false;
        setGate('login');
      }
    } catch (cause) {
      if (id !== generation.current || controller.signal.aborted) return;
      setError(adminMessage(cause));
      setGate('error');
    }
  }, [clearSession]);

  const requireLogin = useCallback(() => {
    void checkSession(true, '管理员会话已结束，请重新登录。');
  }, [checkSession]);

  useEffect(() => {
    const oldTitle = document.title;
    document.title = '同频 · 管理后台';
    document.body.classList.add('admin-body');
    void checkSession();
    const suspend = () => {
      if (logoutPending.current) return;
      flushSync(() => { clearSession(); setGate('hidden'); });
    };
    const visibility = () => { if (document.visibilityState === 'visible') void checkSession(); else suspend(); };
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) void checkSession(); };
    const receiveLogout = (value: unknown) => {
      if (typeof value !== 'string' || value === lastSignal.current) return;
      lastSignal.current = value;
      wasAuthenticated.current = false;
      void checkSession(true, '管理员已退出登录，请重新登录。');
    };
    const storage = (event: StorageEvent) => { if (event.key === LOGOUT_EVENT && event.newValue) receiveLogout(event.newValue); };
    try {
      channel.current = new BroadcastChannel(LOGOUT_EVENT);
      channel.current.onmessage = event => receiveLogout(event.data);
    } catch { /* Storage events also notify other tabs when BroadcastChannel is unavailable. */ }
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', suspend);
    window.addEventListener('pageshow', pageshow);
    window.addEventListener('storage', storage);
    return () => {
      generation.current += 1;
      pending.current?.abort();
      setAdminCsrf(null);
      document.title = oldTitle;
      document.body.classList.remove('admin-body');
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', suspend);
      window.removeEventListener('pageshow', pageshow);
      window.removeEventListener('storage', storage);
      channel.current?.close();
      channel.current = null;
    };
  }, [checkSession, clearSession]);

  useEffect(() => {
    if (gate !== 'active' || !session?.expiresAt) return;
    const remaining = new Date(session.expiresAt).getTime() - Date.now();
    if (!Number.isFinite(remaining)) return;
    const timer = window.setTimeout(requireLogin, Math.max(0, Math.min(remaining, 2147483647)));
    return () => window.clearTimeout(timer);
  }, [gate, session?.expiresAt, requireLogin]);

  const login = async (username: string, password: string) => {
    pending.current?.abort();
    const id = ++generation.current;
    const controller = new AbortController();
    pending.current = controller;
    try {
      const next = await adminApi<AdminSession>('/login', { method: 'POST', json: { username, password }, signal: controller.signal });
      if (id !== generation.current) return;
      if (!next.authenticated) throw new Error('Login did not establish a session');
      setAdminCsrf(next.csrf);
      setSession(next);
      wasAuthenticated.current = true;
      setNotice('');
      setGate('active');
    } catch (cause) {
      if (id !== generation.current || controller.signal.aborted) return;
      // Refresh only the anonymous administrator credential after an unsuccessful login.
      if (isAdminUnauthorized(cause) || (cause instanceof AdminAPIError && cause.code === 'admin_csrf_mismatch')) {
        setAdminCsrf(null);
        setSession(null);
        try {
          const anonymous = await adminApi<AdminSession>('/session', { signal: controller.signal });
          if (id !== generation.current) return;
          setAdminCsrf(anonymous.csrf);
          setSession(anonymous);
          if (!anonymous.configured) setGate('unconfigured');
        } catch {
          if (id !== generation.current) return;
          setError('无法刷新登录状态，请检查网络后重试。');
          setGate('error');
        }
      }
      if (cause instanceof AdminAPIError && cause.code === 'admin_csrf_mismatch') {
        throw new AdminAPIError('登录状态已更新，请重新输入密码后登录。', cause.code, cause.status);
      }
      throw cause;
    }
  };

  const publishLogout = () => {
    const value = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    lastSignal.current = value;
    channel.current?.postMessage(value);
    try { localStorage.setItem(LOGOUT_EVENT, value); } catch { /* No user data is stored. */ }
  };

  const logout = async () => {
    if (logoutPending.current) return;
    const csrf = session?.csrf;
    logoutPending.current = true;
    clearSession();
    const id = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    wasAuthenticated.current = false;
    setGate('logging-out');
    publishLogout();
    try {
      const next = await adminApi<AdminSession>('/logout', { method: 'POST', json: {}, csrf, signal: controller.signal });
      if (id !== generation.current) return;
      publishLogout();
      logoutPending.current = false;
      setAdminCsrf(next.csrf);
      setSession(next);
      setNotice('已退出管理员登录。');
      if (next.csrf) setGate(next.configured ? 'login' : 'unconfigured');
      else await checkSession(true, '已退出管理员登录。');
    } catch (cause) {
      if (id !== generation.current || controller.signal.aborted) return;
      logoutPending.current = false;
      // Keep protected content unmounted even if the network cannot confirm logout.
      setError(isAdminUnauthorized(cause) ? '' : `页面数据已清除，但退出请求未确认。${adminMessage(cause)}`);
      setNotice('请重新登录以继续管理。');
      if (isAdminUnauthorized(cause)) await checkSession(true, '管理员会话已结束，请重新登录。');
      else setGate('error');
    }
  };

  return <div className="admin-root">
    <header className="admin-header"><a href="/" className="admin-brand" aria-label="同频首页"><Logo/><span className="admin-brand-divider"/><span className="admin-brand-label">管理后台</span></a><div className="admin-header-actions">{gate === 'active' ? <><span className="admin-operator"><ShieldCheck size={15}/>{session?.username}</span><button type="button" className="button secondary" data-testid="admin-logout" onClick={() => void logout()}><LogOut size={15}/>退出登录</button></> : <a className="admin-back" href="/"><ArrowLeft size={15}/>返回同频</a>}</div></header>
    {gate === 'active' && session ? <AdminDashboard onUnauthorized={requireLogin}/> : gate === 'login' ? <AdminLogin onLogin={login} notice={notice} ready={Boolean(session?.csrf)}/> : <main className="admin-gate" data-testid="admin-session-gate" aria-busy={gate === 'checking' || gate === 'logging-out'}>
      {gate === 'checking' || gate === 'hidden' || gate === 'logging-out' ? <><span className="admin-gate-symbol"><ShieldCheck size={29}/></span><Spinner text={gate === 'logging-out' ? '正在退出管理员登录…' : gate === 'hidden' ? '返回页面后将重新验证登录状态' : '正在验证管理员登录状态…'}/></> : <><span className="admin-gate-symbol"><LockKeyhole size={28}/></span><h1>{gate === 'unconfigured' ? '管理后台尚未启用' : '暂时无法打开管理后台'}</h1><p role={gate === 'error' ? 'alert' : undefined}>{gate === 'unconfigured' ? '管理员账号尚未配置。配置完成后，可以在此登录。' : error}</p><button type="button" className="button primary" data-testid="admin-session-retry" onClick={() => void checkSession(gate === 'error')}><RefreshCw size={16}/>重新验证</button></>}
    </main>}
  </div>;
}

function AdminLogin({ onLogin, notice, ready }: { onLogin: (username: string, password: string) => Promise<void>; notice: string; ready: boolean }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true); setError('');
    try { await onLogin(username.trim(), password); }
    catch (cause) { setError(adminMessage(cause)); }
    finally { setPassword(''); setBusy(false); }
  };
  return <main className="admin-login-layout"><section className="admin-login-intro"><span className="admin-intro-label"><Sparkles size={15}/>同频 · 参与者与知识画像</span><h1>看见共同的兴趣，<br/>也看见每一位参与者。</h1><p>从好奇心出发，了解社区的成长，<br/>让每一次相遇都有迹可循。</p><div className="admin-orbit" aria-hidden="true"><span className="admin-orbit-ring"/><span className="admin-orbit-ring inner"/><span className="admin-orbit-core"><Logo small/></span><span className="admin-orbit-node node-one"><BookOpen size={23}/></span><span className="admin-orbit-node node-two"><UsersRound size={25}/></span><span className="admin-orbit-node node-three"><Sparkles size={22}/></span><span className="admin-orbit-dot dot-one"/><span className="admin-orbit-dot dot-two"/></div><span className="admin-intro-footer">KNOWLEDGE BRINGS US TOGETHER</span></section><section className="admin-login-card"><span className="admin-login-icon"><ShieldCheck size={25}/></span><p className="eyebrow">ADMIN CONSOLE</p><h2>管理员登录</h2><p className="admin-login-description">使用管理员账号，查看用户与社区概况。</p>{notice && <p className="admin-login-notice" role="status">{notice}</p>}<form onSubmit={submit} data-testid="admin-login-form"><label className="field" htmlFor="admin-username">管理员用户名<input id="admin-username" name="username" data-testid="admin-username" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={64} disabled={busy} placeholder="请输入管理员用户名"/></label><label className="field" htmlFor="admin-password">密码<input id="admin-password" name="password" data-testid="admin-password" value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" required maxLength={256} disabled={busy} placeholder="请输入密码"/></label>{error && <p className="form-error" role="alert" data-testid="admin-login-error">{error}</p>}<button type="submit" className="button primary admin-login-submit" data-testid="admin-login-submit" disabled={busy || !ready}>{busy ? <RefreshCw className="spin" size={17}/> : <LockKeyhole size={16}/>} {busy ? '正在登录…' : '登录管理后台'}{!busy && <ArrowUpRight size={16}/>}</button></form><p className="admin-login-footnote"><ShieldCheck size={14}/>此入口仅供管理员使用</p></section></main>;
}

function useAdminResource<T>(path: string, refresh: number, onUnauthorized: () => void) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(''); setData(null);
    void adminApi<T>(path, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setData(result);
    }).catch(cause => {
      if (controller.signal.aborted) return;
      if (isAdminUnauthorized(cause)) onUnauthorized();
      else setError(adminMessage(cause));
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [path, refresh, retry, onUnauthorized]);
  return { data, error, busy, retry: () => setRetry(value => value + 1) };
}

function AdminEmpty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return <div className="admin-empty"><span><CircleHelp size={24}/></span><h3>{title}</h3>{text && <p>{text}</p>}{action}</div>;
}

function AdminFailure({ message, onRetry, testId }: { message: string; onRetry: () => void; testId: string }) {
  return <div className="admin-error" role="alert" data-testid={testId}><p>{message}</p><button type="button" className="button secondary" onClick={onRetry}><RefreshCw size={15}/>重试</button></div>;
}

function AdminDashboard({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const overview = useAdminResource<AdminOverview>('/overview', refresh, onUnauthorized);
  return <main className="admin-main"><div className="admin-page-heading"><div><p className="eyebrow">COMMUNITY OVERVIEW</p><h1>社区概况</h1><p>了解参与者，发现正在生长的共同兴趣。</p></div><button type="button" className="button secondary" data-testid="admin-refresh" onClick={() => setRefresh(value => value + 1)} disabled={overview.busy}><RefreshCw size={15} className={overview.busy ? 'spin' : ''}/>刷新数据</button></div><section data-testid="admin-overview" aria-label="社区概况" aria-busy={overview.busy}>{overview.busy ? <div className="admin-loading panel"><Spinner text="正在读取社区概况…"/></div> : overview.error ? <AdminFailure message={overview.error} onRetry={overview.retry} testId="admin-overview-error"/> : overview.data ? <OverviewContent data={overview.data}/> : null}</section><AdminUserList refresh={refresh} onUnauthorized={onUnauthorized}/><footer className="admin-footer"><span>同频 · 用户与知识画像管理</span><span>时间以北京时间展示</span></footer></main>;
}

function OverviewContent({ data }: { data: AdminOverview }) {
  const mainCounts = [
    { key: 'zhihuUsers', label: '知乎注册用户', hint: '已完成知乎授权', icon: UserRoundCheck, tone: 'purple' },
    { key: 'guestUsers', label: '自动创建的访客', hint: '访问站点时自动建立', icon: UsersRound, tone: 'sand' },
    { key: 'profileUsers', label: '已建知识画像', hint: '包含知乎用户与访客', icon: Fingerprint, tone: 'pink' },
    { key: 'onlineUsers', label: '当前在线用户', hint: '当前连接站点的用户', icon: Activity, tone: 'green' },
  ] as const;
  const otherCounts = [ ['totalUsers', '用户总数'], ['newUsersToday', '今日加入'], ['discoverableUsers', '公开画像'], ['connections', '已建立连接'], ['messages', '累计消息'] ] as const;
  return <><div className="admin-metrics">{mainCounts.map(({ key, label, hint, icon: Icon, tone }) => <article key={key} className={`admin-metric panel tone-${tone}`}><div><span>{label}</span><span className="admin-metric-icon"><Icon size={19}/></span></div><strong data-testid={`admin-count-${key}`}>{number(data.counts[key])}</strong><p>{hint}</p></article>)}</div><div className="admin-secondary-metrics panel">{otherCounts.map(([key, label]) => <div key={key}><span>{label}</span><strong data-testid={`admin-count-${key}`}>{number(data.counts[key])}</strong></div>)}</div><div className="admin-charts"><section className="admin-chart-card panel"><div className="admin-section-heading"><div><h2>近 7 天加入</h2><p>按当前账号来源分组</p></div><span className="admin-chart-total">{number(data.registrations.reduce((total, row) => total + row.zhihu + row.guest, 0))}<small> 人</small></span></div><RegistrationChart rows={data.registrations}/><div className="admin-chart-legend"><span><i className="legend-zhihu"/>知乎注册用户</span><span><i className="legend-guest"/>自动创建的访客</span></div></section><section className="admin-chart-card panel"><div className="admin-section-heading"><div><h2>热门兴趣</h2><p>前 8 个兴趣 · 同一用户可计入多个兴趣</p></div><span className="admin-section-icon"><Sparkles size={19}/></span></div><InterestChart rows={data.interests}/></section></div><div className="admin-overview-caption"><span><i className="admin-live-dot"/>匹配中 {number(data.pairing.searching)} 人 · 等待确认 {number(data.pairing.proposed)} 人</span><span>更新于 {dateTime(data.generatedAt)}</span></div></>;
}

function RegistrationChart({ rows }: { rows: AdminOverview['registrations'] }) {
  if (!rows.length || rows.every(row => row.zhihu + row.guest === 0)) return <AdminEmpty title="近 7 天暂无新增用户" text="用户加入后，趋势会显示在这里。"/>;
  const ceiling = Math.max(2, Math.ceil(Math.max(...rows.map(row => row.zhihu + row.guest)) / 2) * 2);
  const width = 560, start = 40, end = 545, baseline = 156, height = 118;
  const slot = (end - start) / rows.length;
  const barWidth = Math.min(26, slot * .38);
  const chartTitle = rows.map(row => `${row.date}：知乎注册用户 ${row.zhihu} 人，自动创建的访客 ${row.guest} 人`).join('；');
  return <svg className="admin-registration-chart" viewBox={`0 0 ${width} 196`} role="img" aria-label={`近7天加入人数。${chartTitle}`} data-testid="admin-registration-chart"><title>{chartTitle}</title>{[0, ceiling / 2, ceiling].map(tick => <g key={tick}><line x1={start} x2={end} y1={baseline - tick / ceiling * height} y2={baseline - tick / ceiling * height} stroke="#ece8f2" strokeDasharray={tick ? '3 5' : undefined}/><text x={start - 11} y={baseline - tick / ceiling * height + 4} textAnchor="end">{number(tick)}</text></g>)}{rows.map((row, index) => {
    const x = start + slot * (index + .5), zhihuHeight = row.zhihu / ceiling * height, guestHeight = row.guest / ceiling * height;
    return <g key={row.date}><title>{`${row.date}：知乎 ${row.zhihu}，访客 ${row.guest}`}</title><rect x={x - barWidth / 2} y={baseline - zhihuHeight} width={barWidth} height={zhihuHeight} fill="#8b7dc5"/><rect x={x - barWidth / 2} y={baseline - zhihuHeight - guestHeight} width={barWidth} height={guestHeight} fill="#dcd4ec"/><text x={x} y={baseline - zhihuHeight - guestHeight - 9} textAnchor="middle" className="admin-chart-value">{number(row.zhihu + row.guest)}</text><text x={x} y={baseline + 24} textAnchor="middle">{row.date.slice(5, 10).replace('-', '/')}</text></g>;
  })}</svg>;
}

function InterestChart({ rows }: { rows: AdminOverview['interests'] }) {
  const interests = rows.filter(row => row.count > 0).slice(0, 8);
  if (!interests.length) return <AdminEmpty title="还没有兴趣分布" text="参与者建立知识画像后，将显示兴趣统计。"/>;
  const ceiling = Math.max(...interests.map(row => row.count), 1);
  return <ol className="admin-interest-chart" data-testid="admin-interest-chart">{interests.map((row, index) => <li key={row.id}><span className="admin-interest-name"><small>{String(index + 1).padStart(2, '0')}</small>{row.label}</span><span className="admin-interest-track"><span style={{ width: `${row.count / ceiling * 100}%` }}/></span><strong>{number(row.count)}<small> 人</small></strong></li>)}</ol>;
}

function ProviderBadge({ provider }: { provider: string }) {
  return <span className={`admin-provider ${provider === 'zhihu' ? 'provider-zhihu' : 'provider-guest'}`}>{provider === 'zhihu' ? '知乎注册用户' : provider === 'guest' ? '自动创建的访客' : '其他用户'}</span>;
}

function OnlineStatus({ online }: { online: boolean }) {
  return <span className={`admin-online ${online ? 'is-online' : ''}`}><i/>{online ? '在线' : '离线'}</span>;
}

function AdminUserList({ refresh, onUnauthorized }: { refresh: number; onUnauthorized: () => void }) {
  const [filters, setFilters] = useState<AdminUserFilters>({ ...EMPTY_FILTERS });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const query = new URLSearchParams({ q: filters.q, provider: filters.provider, profile: filters.profile, visibility: filters.visibility, topic: filters.topic, page: String(filters.page), pageSize: '20' }).toString();
  const users = useAdminResource<AdminUsers>(`/users?${query}`, refresh, onUnauthorized);
  const change = <K extends keyof AdminUserFilters>(key: K, value: AdminUserFilters[K]) => setFilters(current => ({ ...current, [key]: value, page: 1 }));
  const reset = () => { setSearch(''); setFilters({ ...EMPTY_FILTERS }); };
  const filtered = filters.q || filters.provider !== 'all' || filters.profile !== 'all' || filters.visibility !== 'all' || filters.topic !== 'all';
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); change('q', search.trim()); };
  return <section className="admin-users-section panel" aria-label="用户管理"><div className="admin-users-heading"><div className="admin-section-heading"><div><h2>用户与知识画像{users.data && <span className="admin-total-badge">{number(users.data.total)}</span>}</h2><p>知乎注册用户已完成授权；访客是在访问时自动创建的身份。</p></div></div><button type="button" className="button secondary" data-testid="admin-users-refresh" disabled={users.busy} onClick={users.retry}><RefreshCw size={15} className={users.busy ? 'spin' : ''}/>刷新列表</button></div><form className="admin-filters" onSubmit={submit}><div className="admin-search-row"><label className="admin-search"><Search size={17}/><span className="admin-sr-only">搜索用户</span><input type="search" data-testid="admin-user-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索昵称或用户 ID" maxLength={100}/></label><button type="submit" className="button primary" data-testid="admin-search-submit">搜索</button><button type="button" className="button ghost" data-testid="admin-filter-reset" onClick={reset}>清空筛选</button></div><div className="admin-filter-grid"><label>用户身份<select data-testid="admin-filter-provider" value={filters.provider} onChange={event => change('provider', event.target.value as AdminUserFilters['provider'])}><option value="all">全部身份</option><option value="zhihu">知乎注册用户</option><option value="guest">自动创建的访客</option></select></label><label>知识画像<select data-testid="admin-filter-profile" value={filters.profile} onChange={event => change('profile', event.target.value as AdminUserFilters['profile'])}><option value="all">全部画像状态</option><option value="ready">已建画像</option><option value="empty">未建画像</option></select></label><label>可发现状态<select data-testid="admin-filter-visibility" value={filters.visibility} onChange={event => change('visibility', event.target.value as AdminUserFilters['visibility'])}><option value="all">全部公开状态</option><option value="public">画像公开</option><option value="private">画像未公开</option></select></label><label>兴趣主题<select data-testid="admin-filter-topic" value={filters.topic} onChange={event => change('topic', event.target.value)}><option value="all">全部兴趣</option>{TOPICS.map(topic => <option key={topic.id} value={topic.id}>{topic.label}</option>)}</select></label></div></form><div className="admin-user-results" data-testid="admin-users" aria-busy={users.busy}>{users.busy ? <div className="admin-loading"><Spinner text="正在读取用户列表…"/></div> : users.error ? <AdminFailure message={users.error} onRetry={users.retry} testId="admin-users-error"/> : users.data?.items.length ? <table className="admin-table"><thead><tr><th scope="col">用户</th><th scope="col">身份</th><th scope="col">知识画像</th><th scope="col">可发现状态</th><th scope="col">加入时间</th><th scope="col">最近活跃</th><th scope="col"><span className="admin-sr-only">操作</span></th></tr></thead><tbody>{users.data.items.map(user => <UserRow key={user.id} user={user} onSelect={() => setSelected(user.id)}/>)}</tbody></table> : <div data-testid="admin-users-empty"><AdminEmpty title={filtered ? '没有符合条件的用户' : '还没有用户加入'} text={filtered ? '试试调整搜索词或筛选条件。' : '参与者访问同频后，会显示在这里。'} action={filtered ? <button type="button" className="button secondary" onClick={reset}><SlidersHorizontal size={15}/>清空筛选</button> : undefined}/></div>}</div>{users.data && <div className="admin-pagination" data-testid="admin-pagination"><span>共 {number(users.data.total)} 位用户 · 每页 20 位</span><div><button type="button" className="icon-button" data-testid="admin-page-prev" aria-label="上一页" disabled={users.busy || users.data.page <= 1} onClick={() => setFilters(current => ({ ...current, page: Math.max(1, (users.data?.page || 1) - 1) }))}><ChevronLeft size={18}/></button><span>第 {users.data.page} / {Math.max(1, users.data.totalPages)} 页</span><button type="button" className="icon-button" data-testid="admin-page-next" aria-label="下一页" disabled={users.busy || users.data.page >= users.data.totalPages} onClick={() => setFilters(current => ({ ...current, page: (users.data?.page || 1) + 1 }))}><ChevronRight size={18}/></button></div></div>}{selected && <AdminDetail userId={selected} onClose={() => setSelected(null)} onUnauthorized={onUnauthorized}/>}</section>;
}

function UserRow({ user, onSelect }: { user: AdminUserRow; onSelect: () => void }) {
  return <tr data-testid="admin-user-row" data-user-id={user.id}><td className="admin-user-identity"><div><Avatar name={user.name} src={user.avatar} seed={user.id} size={38}/><div><strong>{user.name || '未命名用户'}</strong><small title={user.id}>{user.id}</small><OnlineStatus online={user.online}/></div></div></td><td data-label="身份"><ProviderBadge provider={user.provider}/></td><td data-label="知识画像" className="admin-user-profile">{user.profile ? <><strong>{user.profile.title || '已建画像'}</strong><div className="tags">{user.profile.interests.slice(0, 3).map(topic => <span className="tag" key={topic.id}>{topic.label}</span>)}{user.profile.interests.length > 3 && <span className="tag">+{user.profile.interests.length - 3}</span>}</div></> : <span className="admin-no-profile">未建画像</span>}</td><td data-label="可发现状态"><span className={`admin-visibility ${user.profile?.discoverable ? 'is-public' : ''}`}>{user.profile ? user.profile.discoverable ? '画像公开' : '画像未公开' : '暂无画像'}</span></td><td data-label="加入时间" className="admin-date-cell">{dateTime(user.createdAt)}</td><td data-label="最近活跃" className="admin-date-cell">{dateTime(user.lastSeenAt)}</td><td className="admin-user-action"><button type="button" className="text-button" data-testid="admin-user-detail" data-user-id={user.id} onClick={onSelect} aria-label={`查看${user.name || '用户'}的详情`}>查看详情<ChevronRight size={15}/></button></td></tr>;
}

function AdminDetail({ userId, onClose, onUnauthorized }: { userId: string; onClose: () => void; onUnauthorized: () => void }) {
  const detail = useAdminResource<AdminUserDetail>(`/users/${encodeURIComponent(userId)}`, 0, onUnauthorized);
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { element?.close(); document.body.style.overflow = previous; };
  }, []);
  return <dialog ref={dialog} className="admin-detail-dialog" aria-labelledby={headingId} data-testid="admin-detail" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="admin-detail-scroll"><header className="admin-detail-heading"><div><span className="eyebrow">PARTICIPANT PROFILE</span><h2 id={headingId}>用户详情</h2></div><button type="button" className="icon-button" data-testid="admin-detail-close" aria-label="关闭用户详情" onClick={onClose}><X size={20}/></button></header><div className="admin-detail-body" aria-busy={detail.busy}>{detail.busy ? <div className="admin-loading"><Spinner text="正在读取用户详情…"/></div> : detail.error ? <AdminFailure message={detail.error} onRetry={detail.retry} testId="admin-detail-error"/> : detail.data ? <DetailContent detail={detail.data}/> : null}</div></div></dialog>;
}

function DetailContent({ detail }: { detail: AdminUserDetail }) {
  const { user, profile, activity } = detail;
  const pairingLabels: Record<string, string> = { idle: '未在匹配', searching: '正在匹配', proposed: '等待确认', connected: '已连接' };
  const activityCounts = [ ['connections', '建立的连接'], ['pendingInvitations', '待处理邀请'], ['messages', '发送的消息'], ['saved', '收藏的伙伴'], ['importedItems', '导入的条目'] ] as const;
  return <><div className="admin-detail-person"><Avatar name={user.name} src={user.avatar} seed={user.id} size={64}/><div><h3>{user.name || '未命名用户'}</h3><div className="admin-detail-badges"><ProviderBadge provider={user.provider}/><OnlineStatus online={user.online}/></div><p className="admin-detail-id">{user.id}</p></div></div><dl className="admin-detail-dates"><div><dt>加入时间</dt><dd data-testid="admin-detail-createdAt">{dateTime(user.createdAt)}</dd></div><div><dt>知乎注册时间</dt><dd data-testid="admin-detail-registeredAt">{dateTime(user.registeredAt)}</dd></div><div><dt>最近活跃时间</dt><dd data-testid="admin-detail-lastSeenAt">{dateTime(user.lastSeenAt)}</dd></div><div><dt>当前匹配状态</dt><dd>{pairingLabels[user.pairingStatus] || '暂无记录'}</dd></div></dl>{user.provider === 'guest' && <p className="admin-guest-note">此身份由访问站点时自动创建，尚未完成知乎授权。</p>}{profile ? <section className="admin-detail-profile" data-testid="admin-detail-profile"><div className="admin-profile-title"><div><p className="eyebrow">KNOWLEDGE PORTRAIT</p><h3>{profile.title || '知识画像'}</h3></div><SourceBadge mode={profile.analysisMode}/></div><p className="admin-profile-summary">{profile.summary || '暂无画像摘要'}</p><div className="admin-profile-grid"><div className="admin-radar-card" data-testid="admin-detail-radar"><Radar dimensions={profile.dimensions}/><p>六个维度呈现兴趣分布，不代表能力评分。</p><ul className="admin-dimension-values">{profile.dimensions.map(dimension => <li key={dimension.id}><i style={{ backgroundColor: dimension.color }}/><span>{dimension.label}</span><strong>{Math.round(dimension.value)}</strong></li>)}</ul></div><div className="admin-profile-notes"><h4>兴趣主题</h4><div className="tags">{profile.interests.length ? profile.interests.map(topic => <span className="tag tag-purple" key={topic.id}>{topic.label}</span>) : <span className="admin-muted">暂无兴趣主题</span>}</div><h4>画像亮点</h4>{profile.highlights.length ? <ul className="admin-highlights">{profile.highlights.map((highlight, index) => <li key={index}><Sparkles size={14}/><span>{highlight}</span></li>)}</ul> : <p className="admin-muted">暂无画像亮点</p>}<h4>交流目标</h4><div className="tags">{profile.goals.length ? profile.goals.map(goal => <span className="tag" key={goal}>{GOALS.find(item => item.id === goal)?.label || goal}</span>) : <span className="admin-muted">暂无交流目标</span>}</div></div></div><div className="admin-detail-texts"><section><h4>关于自己</h4><p>{profile.about || '暂无填写'}</p></section><section><h4>想聊的问题</h4><p>{profile.question || '暂无填写'}</p></section></div><section className="admin-style-section"><div><h4>交流风格</h4><p>{profile.style.label || '暂无填写'}</p></div><div className="admin-style-bars">{profile.style.values.map((value, index) => <div key={index}><span>{STYLE_AXES[index] || `维度 ${index + 1}`}</span><i><i style={{ width: `${Math.min(100, Math.max(0, value))}%` }}/></i><strong>{Math.round(value)}</strong></div>)}</div></section><div className="admin-profile-meta"><span className={`admin-visibility ${profile.discoverable ? 'is-public' : ''}`}>{profile.discoverable ? '画像公开，可被发现' : '画像未公开'}</span><span>第 {profile.revision} 版 · 更新于 {dateTime(profile.updatedAt)}</span></div></section> : <div className="admin-no-profile-detail" data-testid="admin-detail-empty-profile"><AdminEmpty title="尚未建立知识画像" text="该用户还没有完成画像创建。"/></div>}<section className="admin-detail-activity"><h3>参与记录</h3><div>{activityCounts.map(([key, label]) => <article key={key}><strong>{number(activity[key])}</strong><span>{label}</span></article>)}</div><p>最近导入时间：{dateTime(activity.importedAt)}</p></section></>;
}
