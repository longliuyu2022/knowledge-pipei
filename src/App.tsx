import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, ChevronRight, Compass, Fingerprint, Info, Menu, MessagesSquare, Network, Orbit, RefreshCw, Search, ShieldCheck, Sparkles, X } from 'lucide-react';
import { api, messageOf, setCSRF } from './api';
import { Avatar, Empty, HeroArt, Logo, MatchCard, PoolToggle, Radar, SourceBadge, Spinner } from './components';
import { ProfileWizard } from './ProfileWizard';
import { ProfilePage } from './ProfilePage';
import { PersonaShareDialog } from './PersonaShareDialog';
import { ImportDialog, LoginDialog, SettingsDialog } from './AccountDialogs';
import { MatchDialog } from './MatchDialog';
import { ConnectionsPage } from './ConnectionsPage';
import { PairingPage } from './PairingPage';
import { StarMap } from './StarMap';
import { TOPICS } from '../shared/catalog';
import type { Bootstrap, Match, Mode, Page, PageActions, Pool } from './types';
import './pairing-entry.css';
import './onboarding.css';

const navigation = [
  { id: 'discover' as Page, label: '发现同频', icon: Compass },
  { id: 'pairing' as Page, label: '灵魂匹配', icon: Orbit },
  { id: 'profile' as Page, label: '我的知识人格', icon: Fingerprint },
  { id: 'graph' as Page, label: '同频星图', icon: Network },
  { id: 'connections' as Page, label: '我的连接', icon: MessagesSquare },
];
const currentPage = (): Page => navigation.some(item => item.id === location.hash.slice(1)) ? location.hash.slice(1) as Page : 'discover';
type Modal = 'wizard' | 'login' | 'import' | 'settings' | 'share' | null;

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState('');
  const [authReturn] = useState(() => new URLSearchParams(location.search).get('auth') === 'success');
  const authHandled = useRef(false);
  const [page, setPage] = useState<Page>(currentPage);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [selected, setSelected] = useState<Match | null>(null);
  const [conversationToOpen, setConversationToOpen] = useState<{ userId: string; id: string } | null>(null);
  const [pool, setPool] = useState<Pool>('demo');
  const [tab, setTab] = useState<'recommended' | 'complement' | 'saved'>('recommended');
  const [query, setQuery] = useState(''), [topic, setTopic] = useState('all');
  const [matches, setMatches] = useState<Match[]>([]);
  const [matchLoading, setMatchLoading] = useState(true), [matchError, setMatchError] = useState('');
  const [matchNotice, setMatchNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mode: Mode = page === 'discover' && tab === 'complement' ? 'complement' : 'resonance';
  const notify = useCallback((text: string, error = false) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, error }); toastTimer.current = setTimeout(() => setToast(null), 5500);
  }, []);
  const refresh = useCallback(async () => {
    const result = await api<Bootstrap>('/bootstrap'); setCSRF(result.csrf); setData(result); setBootError(''); setVersion(v => v + 1);
  }, []);
  useEffect(() => { refresh().catch(error => setBootError(messageOf(error))); }, [refresh]);
  useEffect(() => {
    const listener = () => { setPage(currentPage()); setMobileMenu(false); window.scrollTo({ top: 0, behavior: 'instant' }); };
    window.addEventListener('hashchange', listener); return () => window.removeEventListener('hashchange', listener);
  }, []);
  useEffect(() => {
    const auth = new URLSearchParams(location.search).get('auth');
    if (!auth) return;
    const text: Record<string, string> = { success: '知乎已连接。你可以选择导入的内容。', state_error: '授权请求未能验证，请重新连接知乎。', cancelled: '你尚未完成授权，可以继续用兴趣体验。', failed: '知乎连接未完成，请稍后重试。' };
    notify(text[auth] || '授权状态已更新', auth === 'failed' || auth === 'state_error');
    history.replaceState(null, '', location.pathname + location.hash);
  }, [notify]);
  useEffect(() => {
    if (!data || !authReturn || authHandled.current) return;
    authHandled.current = true;
    setModal(data.zhihuConnected && data.capabilities.zhihuData ? 'import' : 'wizard');
  }, [data, authReturn]);
  useEffect(() => {
    if (!data?.user.id) return;
    const events = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | null = null;
    const changed = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => refresh().catch(() => {}), 220); };
    const newPool = () => setVersion(v => v + 1);
    const pairingChanged = () => window.dispatchEvent(new Event('tongpin:pairing'));
    events.addEventListener('changed', changed); events.addEventListener('pool', newPool);
    events.addEventListener('pairing', pairingChanged); events.addEventListener('open', pairingChanged);
    return () => { if (timer) clearTimeout(timer); events.close(); };
  }, [data?.user.id, refresh]);
  useEffect(() => {
    if (!data) return;
    const controller = new AbortController(); setMatchLoading(true); setMatchError('');
    api<{ matches: Match[]; notice: string | null }>(`/matches?pool=${pool}&mode=${mode}`, { signal: controller.signal })
      .then(result => { setMatches(result.matches); setMatchNotice(result.notice); })
      .catch(error => { if (error.name !== 'AbortError') { setMatchError(messageOf(error)); setMatches([]); } })
      .finally(() => { if (!controller.signal.aborted) setMatchLoading(false); });
    return () => controller.abort();
  }, [data?.user.id, data?.profile?.revision, pool, mode, version]);
  const changePool = useCallback((next: Pool) => {
    setPool(next); setMatches([]); setMatchLoading(true); setVersion(v => v + 1);
  }, []);
  const navigate = useCallback((next: Page, nextPool?: Pool) => {
    if (nextPool) changePool(nextPool);
    if (currentPage() === next) { setPage(next); window.scrollTo({ top: 0, behavior: 'instant' }); }
    else location.hash = next;
    setMobileMenu(false);
  }, [changePool]);
  const openConversation = useCallback((id: string) => {
    if (!data) return;
    setConversationToOpen({ userId: data.user.id, id });
    setSelected(null); setModal(null); navigate('connections');
  }, [data?.user.id, navigate]);
  const conversationOpened = useCallback(() => setConversationToOpen(null), []);
  const open = (next: Modal) => { setSelected(null); setModal(next); setMobileMenu(false); };
  const onSave = async (match: Match) => {
    if (!data || savingIds.has(match.id)) return;
    const saved = !data.savedIds.includes(match.id);
    setSavingIds(ids => new Set([...ids, match.id]));
    try {
      const result = await api<{ savedIds: string[] }>(`/saved/${match.id}`, { method: 'PUT', json: { saved } });
      setData(previous => previous ? { ...previous, savedIds: result.savedIds } : previous);
      setVersion(v => v + 1); notify(saved ? `已收藏${match.name}，可以在「我的连接」里找到。` : '已取消收藏');
    } catch (error) { notify(messageOf(error), true); }
    finally { setSavingIds(ids => { const next = new Set(ids); next.delete(match.id); return next; }); }
  };
  const allMatches = useMemo(() => matches.map(match => ({ ...match, saved: data?.savedIds.includes(match.id) || false })), [matches, data?.savedIds]);
  const visibleMatches = useMemo(() => {
    const search = query.trim().toLowerCase();
    return allMatches.filter(match => (tab !== 'saved' || match.saved) && (topic === 'all' || match.interests.some(t => t.id === topic)) && (!search || `${match.name} ${match.about} ${match.question} ${match.title} ${match.interests.map(t => t.label).join(' ')}`.toLowerCase().includes(search)));
  }, [allMatches, query, topic, tab]);
  if (!data) return <div className="boot-screen"><Logo/><div>{bootError ? <Empty title="连接暂时走远了" text={bootError} action="重新连接" onAction={() => { setBootError(''); refresh().catch(error => setBootError(messageOf(error))); }}/> : <Spinner text="让好奇心慢慢靠近…"/>}</div></div>;

  const actions: PageActions = { data, refresh, notify, onCreate: () => open('wizard'), onShare: () => open('share'), onLogin: () => open('login'), onImport: () => open(data.zhihuConnected ? 'import' : 'login'), onSelect: match => { setModal(null); setSelected(match); }, onSave, navigate };
  const profile = data.profile || data.sampleProfile;
  const activeNavigation = navigation.find(item => item.id === page)!;
  const reset = async () => { setSelected(null); setModal(null); setConversationToOpen(null); setPool('demo'); setQuery(''); setTopic('all'); setTab('recommended'); await refresh(); navigate('discover'); };
  return <div className={data.profile ? 'app-shell' : 'onboarding-shell'}>
    {!data.profile ? <main className="onboarding-page">
      <Logo/>
      <section className="onboarding-card">
        <span className="onboarding-symbol"><Fingerprint size={40} strokeWidth={1.4}/></span>
        <p className="eyebrow">从好奇心开始，认识独一无二的你</p>
        <h1>先认识你，<br/>再遇见同频的人。</h1>
        <p className="onboarding-description">接入知乎，带来你的兴趣线索；<br/>或亲手填写，让我们从你喜欢的话题开始。</p>
        <div className="onboarding-actions">
          <button className="button primary" onClick={actions.onImport}><span className="zhihu-mark" aria-hidden="true">知</span>{data.zhihuConnected ? '导入知乎兴趣' : '接入知乎'}<ArrowRight size={17}/></button>
          <button className="button secondary" onClick={actions.onCreate}><Fingerprint size={18}/>手动填写兴趣<ArrowRight size={17}/></button>
        </div>
        <p className="onboarding-next"><Sparkles size={15}/>填写并确认后，揭晓你的人格卡片</p>
        <p className="onboarding-privacy"><ShieldCheck size={14}/>由你决定分享什么，生成后默认不加入匹配池。</p>
      </section>
    </main> : <>

    {mobileMenu && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setMobileMenu(false)}/>}
    <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
      <a href="#discover" className="brand-link" aria-label="同频首页" onClick={() => setMobileMenu(false)}><Logo/></a>
      <div className="sidebar-section-label">我的好奇宇宙</div>
      <nav aria-label="主导航">{navigation.map(item => <a key={item.id} href={`#${item.id}`} className={`nav-item ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined} onClick={() => setMobileMenu(false)}><item.icon size={19}/><span>{item.label}</span>{item.id === 'connections' && data.incomingCount > 0 && <span className="nav-badge">{data.incomingCount}</span>}{page === item.id && <span className="nav-indicator"/>}</a>)}</nav>
      <div className="sidebar-note"><span className="tiny-star">✳</span><p>不必相同，<br/>也能同频。</p><span>让共同的好奇心<br/>成为相遇的起点</span></div>
      <div className="sidebar-bottom"><button className="nav-item privacy-nav" onClick={() => open('settings')}><ShieldCheck size={18}/><span>数据与隐私</span></button><div className="sidebar-user"><Avatar name={data.profile?.input.name || data.user.name} seed={data.user.id} src={data.user.avatar} size={36}/><div><strong>{data.profile?.input.name || '好奇的朋友'}</strong><span>{data.zhihuConnected ? '知乎已连接' : data.user.provider === 'zhihu' ? '知乎授权需重连' : '从兴趣开始探索'}</span></div><button className="icon-button" aria-label="账号设置" onClick={() => open('settings')}><ChevronRight size={16}/></button></div></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="topbar-location"><button className="icon-button mobile-menu" aria-label="打开导航" aria-expanded={mobileMenu} onClick={() => setMobileMenu(!mobileMenu)}><Menu size={21}/></button><activeNavigation.icon size={16}/><span>{activeNavigation.label}</span><span className="breadcrumb-divider">/</span><span className="topbar-greeting">好奇的人，终会相遇</span></div><div className="topbar-actions"><span className="hackathon-badge"><i/>知乎黑客松 2026</span><button className="button zhihu-button" onClick={data.zhihuConnected ? actions.onImport : actions.onLogin}><span className="zhihu-mark" aria-hidden="true">知</span>{data.zhihuConnected ? '导入知乎兴趣' : '连接知乎'}<ChevronRight size={14}/></button></div></header>
      <main className="main-content" id="main-content">
        {page === 'discover' && <>
          <div className="welcome-row"><p className="eyebrow">A LITTLE CURIOSITY, A NEW CONNECTION</p><span>从一个好问题，认识一个新朋友</span></div>
          <section className="hero"><div className="hero-copy"><div className="hero-pill"><span/>让知识，成为相遇的引力</div><h1>总有人，<br className="hero-mobile-break"/>和你<span>想到一起。</span></h1><p>藏在收藏夹里的热爱，值得被另一个人看见。<br/>发现你的知识人格，遇见聊得来的知识伙伴。</p><div className="hero-actions"><button className="button dark" onClick={actions.onCreate}>{data.profile ? '更新我的知识人格' : '发现我的知识人格'}<ArrowUpRight size={17}/></button><span>{data.profile ? '好奇心变了，画像也可以更新' : '从 3 个兴趣开始 · 约 1 分钟'}</span></div></div><HeroArt/></section>
          <section className="pairing-launch" aria-label="主动匹配在线伙伴"><span className="pairing-launch-icon"><Orbit size={26} strokeWidth={1.5}/></span><div><h2>此刻，遇见一个在线的同频人</h2><p>点击开始，等待彼此都愿意开启的一场对话。</p></div><button className="button primary" onClick={() => navigate('pairing')}>开始灵魂匹配<ArrowRight size={16}/></button></section>
          <div className="discovery-layout"><section className="recommendations" aria-label="伙伴推荐">
            <div className="section-heading"><div><h2>遇见，另一个好奇的灵魂<span className="heading-dot"/></h2><p>{data.profile ? '循着你的兴趣，发现有话可聊的人。' : '先用一份体验画像，感受知识相遇的方式。'}</p></div><button className="text-button subtle" onClick={() => setVersion(v => v + 1)} disabled={matchLoading}><RefreshCw size={14} className={matchLoading ? 'spin' : ''}/><span className="desktop-text">刷新</span></button></div>
            <div className="recommendation-toolbar"><div className="recommendation-tabs" aria-label="推荐方式"><button className={tab === 'recommended' ? 'active' : ''} aria-pressed={tab === 'recommended'} onClick={() => setTab('recommended')}>为你推荐</button><button className={tab === 'complement' ? 'active' : ''} aria-pressed={tab === 'complement'} onClick={() => setTab('complement')}>互补视角</button><button className={tab === 'saved' ? 'active' : ''} aria-pressed={tab === 'saved'} onClick={() => setTab('saved')}>已收藏</button></div><PoolToggle value={pool} onChange={changePool}/></div>
            <div className="search-row"><label className="search-field"><Search size={16}/><input aria-label="搜索伙伴" placeholder="搜索伙伴、兴趣或正在想的问题" value={query} maxLength={100} onChange={e => setQuery(e.target.value)}/>{query && <button className="icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={14}/></button>}</label><select className="topic-select" aria-label="筛选兴趣" value={topic} onChange={e => setTopic(e.target.value)}><option value="all">全部兴趣</option>{TOPICS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
            <div className="pool-note"><Info size={13}/><span>{pool === 'demo' ? '体验伙伴均为虚构人物，用来展示匹配方式。' : '这里只展示主动加入匹配的用户，兴趣由本人提供。'}{tab === 'complement' ? ' 互补推荐兼顾共同话题与新视角。' : ''}</span></div>
            {matchNotice && <p className="inline-notice">{matchNotice}</p>}
            {matchError ? <Empty title="推荐暂时没有加载出来" text={matchError} action="再试一次" onAction={() => setVersion(v => v + 1)}/> : matchLoading && !allMatches.length ? <div className="match-grid" aria-label="正在寻找伙伴">{[0, 1, 2, 3].map(i => <div className="match-skeleton" key={i}><div/><span/><span/><p/></div>)}</div> : visibleMatches.length ? <div className="match-grid" aria-busy={matchLoading}>{visibleMatches.map(match => <MatchCard key={match.id} match={match} onSelect={() => actions.onSelect(match)} onSave={() => { void onSave(match); }} saving={savingIds.has(match.id)}/>)}</div> : <Empty title={query || topic !== 'all' ? '还没有找到这个方向的伙伴' : tab === 'saved' ? '把有共鸣的人，留在这里' : '第一场同频，等你开启'} text={query || topic !== 'all' ? '换一个关键词或清除兴趣筛选，看看新的可能。' : tab === 'saved' ? '点击伙伴卡片上的收藏图标，就能随时回来看看。' : data.profile?.discoverable ? '你已加入匹配。邀请朋友打开这个网站，生成画像并主动加入，就能在这里遇见。' : '生成你的知识人格，再开启「让伙伴发现我」，成为第一位参与者。'} action={query || topic !== 'all' ? '清除筛选' : tab === 'saved' ? '去发现伙伴' : data.profile ? '设置参与匹配' : '生成我的知识人格'} onAction={() => { if (query || topic !== 'all') { setQuery(''); setTopic('all'); } else if (tab === 'saved') setTab('recommended'); else open(data.profile ? 'settings' : 'wizard'); }}/>}
            {!!visibleMatches.length && <div className="list-end"><span/>已发现 {visibleMatches.length} 位{pool === 'demo' ? '体验伙伴' : '参与者'} · 相遇也需要一点主动<span/></div>}
          </section><aside className="discovery-aside">
            <section className="panel mini-profile"><div className="mini-profile-heading"><h2>我的知识人格</h2>{data.profile ? <SourceBadge mode={profile.analysis.mode}/> : <span className="preview-badge">体验画像</span>}</div><div className="personality-symbol"><Fingerprint size={30} strokeWidth={1.4}/><span>✦</span></div><h3>{profile.title}</h3><p className="personality-caption">{profile.style.label} · 保持独立的好奇心</p><Radar dimensions={profile.dimensions}/><div className="tags mini-profile-tags">{profile.interests.slice(0, 3).map(t => <span className="tag" key={t.id}>{t.label}</span>)}</div><button className="mini-profile-link" onClick={() => navigate('profile')}>看看我的兴趣宇宙<ArrowRight size={15}/></button>{!data.profile && <p className="sample-footnote">这是示例画像，生成后会换成你的兴趣。</p>}</section>
            <section className="conversation-note"><span className="quote-glyph">“</span><div className="eyebrow">留一个问题给世界</div><h3>{profile.input.question || '最近一次改变看法，是因为什么？'}</h3><p>一个好问题，是一场好对话的开始。</p><button className="text-button" onClick={() => allMatches[0] ? actions.onSelect(allMatches[0]) : actions.onCreate()}>从这里开始聊<ArrowUpRight size={15}/></button><span className="note-star">✳</span></section>
            <div className="privacy-hint"><ShieldCheck size={16}/><p>你决定分享什么。<br/>原始导入内容仅自己可见。</p></div>
          </aside></div>
        </>}
        {page === 'profile' && <ProfilePage actions={actions}/>}
        {page === 'pairing' && <PairingPage key={data.user.id} actions={actions} onConnected={openConversation}/>}
        {page === 'graph' && <StarMap profile={profile} matches={allMatches} onSelect={actions.onSelect} preview={!data.profile} pool={pool} onPoolChange={changePool} loading={matchLoading} onCreate={actions.onCreate}/>}
        {page === 'connections' && <ConnectionsPage actions={actions} version={version} requestedConversationId={conversationToOpen?.userId === data.user.id ? conversationToOpen.id : undefined} onConversationOpened={conversationOpened}/>}
        <footer className="page-footer"><span>同频 · 知乎灵魂对对碰</span><span>共同的好奇心，比相同的答案更珍贵。</span><span>知乎黑客松 2026 参赛作品</span></footer>
      </main>
    </div>
    <nav className="mobile-bottom-nav" aria-label="快捷导航">{navigation.map(item => <a key={item.id} href={`#${item.id}`} className={page === item.id ? 'active' : ''}><item.icon size={20}/><span>{item.label.replace('我的', '')}</span>{item.id === 'connections' && data.incomingCount > 0 && <i/>}</a>)}</nav>
    </>}
    {modal === 'wizard' && <ProfileWizard onSaved={() => setModal('share')} data={data} onClose={() => setModal(null)} onComplete={async () => { await refresh(); setModal(null); navigate(page === 'pairing' ? 'pairing' : 'profile'); }} notify={notify}/>}
    {modal === 'share' && data.profile && <PersonaShareDialog key={data.user.id} profile={data.profile} onClose={() => setModal(null)} />}
    {modal === 'login' && <LoginDialog actions={actions} onClose={() => setModal(null)}/>}
    {modal === 'import' && <ImportDialog actions={actions} onClose={() => setModal(null)}/>}
    {modal === 'settings' && <SettingsDialog actions={actions} onClose={() => setModal(null)} onReset={reset}/>}
    {selected && <MatchDialog match={{ ...selected, saved: data.savedIds.includes(selected.id) }} actions={actions} onClose={() => setSelected(null)}/>}
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <Info size={17}/> : <Check size={17}/>}<span>{toast.text}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={15}/></button></div>}
  </div>;
}
