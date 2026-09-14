import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Bookmark, Check, CircleHelp, Eye, FileText, LockKeyhole, LogOut, RefreshCw, ShieldCheck, Sparkles, Trash2, UserRound, Users } from 'lucide-react';
import { api, APIError, formatTime, messageOf } from './api';
import { Avatar, Dialog, Spinner } from './components';
import { ZhihuDataCheck } from './ZhihuDataCheck';
import type { PageActions, Profile } from './types';
import './profile.css';

type DialogProps = { actions: PageActions; onClose: () => void };
type BlockedPerson = { id: string; name: string };
type ImportSource = 'contents' | 'followees' | 'collections';
type ImportResult = { count: number; counts: Partial<Record<ImportSource, number>>; profile: Profile | null };

function downloadJSON(value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `tongzhi-my-data-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SettingsDialog({ actions, onClose, onReset }: DialogProps & { onReset: () => Promise<void> }) {
  const { data } = actions;
  const [busy, setBusy] = useState('');
  const pending = useRef(false);
  const [error, setError] = useState('');
  const [confirmAction, setConfirmAction] = useState<'delete' | 'imports' | 'logout' | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [blocked, setBlocked] = useState<BlockedPerson[]>([]);
  const [blockedLoading, setBlockedLoading] = useState(true);
  const [blockedError, setBlockedError] = useState('');
  const [visible, setVisible] = useState(Boolean(data.profile?.discoverable));
  const confirmationId = useId();

  useEffect(() => { setVisible(Boolean(data.profile?.discoverable)); }, [data.profile?.discoverable]);

  const loadBlocked = useCallback(async (signal?: AbortSignal) => {
    setBlockedLoading(true); setBlockedError('');
    try {
      const response = await api<{ people: BlockedPerson[] }>('/blocked', { signal });
      if (!signal?.aborted) setBlocked(response.people);
    } catch (cause) { if (!signal?.aborted) setBlockedError(messageOf(cause)); }
    finally { if (!signal?.aborted) setBlockedLoading(false); }
  }, []);

  useEffect(() => { const controller = new AbortController(); void loadBlocked(controller.signal); return () => controller.abort(); }, [loadBlocked]);

  async function change(key: string, operation: () => Promise<void>, success: string, reset = false) {
    if (pending.current) return;
    pending.current = true; setBusy(key); setError('');
    let changed = false;
    try {
      await operation(); changed = true;
      if (reset) await onReset(); else await actions.refresh();
      setConfirmAction(null);
      actions.notify(success);
      if (reset) onClose();
    } catch (cause) { setError((changed ? '操作已完成，但页面还未同步。' : '') + messageOf(cause)); }
    finally { pending.current = false; setBusy(''); }
  }

  async function exportData() {
    if (pending.current) return;
    pending.current = true; setBusy('export'); setError('');
    try { downloadJSON(await api('/account/export')); actions.notify('已开始下载你在同知的数据。'); }
    catch (cause) { setError(messageOf(cause)); }
    finally { pending.current = false; setBusy(''); }
  }

  function setConfirm(next: typeof confirmAction) { setConfirmAction(next); setConfirmation(''); setError(''); }

  return <Dialog title="账号与数据设置" onClose={onClose} busy={Boolean(busy)} className="account-dialog">
    <div className="account-user"><Avatar name={data.user.name} seed={data.user.id} src={data.user.avatar} size={48} /><div><strong>{data.user.name}</strong><span>{data.user.provider === 'zhihu' ? '知乎账号' : '当前浏览器的访客身份'}</span></div><span className="tag">{data.zhihuConnected ? '知乎已连接' : '由你掌握资料'}</span></div>
    <section className="account-section"><h3><Eye size={17} />让伙伴发现我</h3><div className="account-setting-row"><div><strong>{visible ? '已加入真实参与者匹配' : '暂不加入匹配'}</strong><p>开启后，伙伴可查看昵称、画像、自述、问题与交流偏好，并向你发起邀请。关闭会取消等待中的邀请，已接受的对话保留。</p></div>
      <label className="account-switch"><input type="checkbox" role="switch" aria-label="让伙伴发现我" checked={visible} disabled={Boolean(busy) || !data.profile} onChange={event => {
        const discoverable = event.target.checked;
        void change('visibility', async () => { await api('/profile/visibility', { method: 'POST', json: { discoverable, revision: data.profile?.revision } }); setVisible(discoverable); }, discoverable ? '已加入匹配池。' : '已退出匹配池。');
      }} /><span aria-hidden="true" /></label>
    </div>{!data.profile && <button className="text-button" disabled={Boolean(busy)} onClick={() => { onClose(); actions.onCreate(); }}>先创建自己的兴趣画像<ArrowRight size={14} /></button>}</section>

    <section className="account-section"><h3><LockKeyhole size={17} />我的数据</h3><div className="account-setting-row"><div><strong>导出我的资料</strong><p>下载账号资料、画像、导入摘要、数据检查结果和收藏记录，保存为 JSON 文件。</p></div><button className="button secondary account-small-button" disabled={Boolean(busy)} onClick={exportData}>{busy === 'export' ? <Spinner text="导出中…" /> : <><ArrowDownToLine size={15} />导出</>}</button></div>
      <div className="account-setting-row"><div><strong>知乎导入内容</strong><p>{data.imports.count ? `已导入 ${data.imports.count} 条摘要${data.imports.fetchedAt ? ` · ${formatTime(data.imports.fetchedAt)}` : ''}` : '尚未导入知乎摘要'}。{data.imports.checkedAt && `最近检查：${formatTime(data.imports.checkedAt)}。`}清除后保留手动填写的兴趣。</p></div><button className="text-button account-danger-text" disabled={Boolean(busy) || (!data.imports.count && !data.imports.checkedAt)} onClick={() => setConfirm('imports')}>清除导入</button></div>
      {confirmAction === 'imports' && <div className="account-confirm-box"><strong>清除已导入的摘要？</strong><p>导入摘要和数据检查记录将一并清除。画像将按手动填写的兴趣重新生成，并暂时退出匹配池。本次知乎连接也会结束，再次导入需要重新连接。</p><div><button className="button secondary account-small-button" disabled={Boolean(busy)} onClick={() => setConfirm(null)}>取消</button><button className="button account-danger-button account-small-button" disabled={Boolean(busy)} onClick={() => void change('imports', async () => { await api('/zhihu/import', { method: 'DELETE' }); }, '导入已清除。请查看更新后的画像，再决定是否重新加入匹配。')}>{busy === 'imports' ? <Spinner text="清除中…" /> : '确认清除'}</button></div></div>}
    </section>

    <section className="account-section"><h3><ShieldCheck size={17} />屏蔽的伙伴</h3><p className="account-section-note">取消屏蔽后，你们可以在符合匹配条件时重新发现彼此。</p>
      {blockedLoading ? <div className="account-blocked-status"><Spinner text="正在读取屏蔽列表…" /></div> : blockedError ? <div className="account-blocked-status"><p className="form-error" role="alert">{blockedError}</p><button className="text-button" onClick={() => void loadBlocked()} disabled={Boolean(busy)}><RefreshCw size={14} />重新加载</button></div> : blocked.length ? <ul className="account-blocked-list">{blocked.map(person => <li key={person.id}><span><UserRound size={15} />{person.name}</span><button className="text-button" disabled={Boolean(busy)} onClick={() => void change(`unblock:${person.id}`, async () => { await api(`/blocked/${encodeURIComponent(person.id)}`, { method: 'DELETE' }); setBlocked(people => people.filter(item => item.id !== person.id)); }, `已取消对「${person.name}」的屏蔽。`)}>{busy === `unblock:${person.id}` ? <Spinner text="正在恢复…" /> : '取消屏蔽'}</button></li>)}</ul> : <p className="account-empty">目前没有屏蔽的伙伴</p>}
    </section>

    <section className="account-section account-session"><div className="account-setting-row"><div><strong>退出当前会话</strong><p>{data.user.provider === 'guest' ? '访客资料关联当前浏览器会话，退出后无法找回。建议先导出。' : '退出会让你暂时离开匹配池，再次连接知乎可回到自己的账号。'}</p></div><button className="button secondary account-small-button" disabled={Boolean(busy)} onClick={() => setConfirm('logout')}><LogOut size={15} />退出</button></div>
      {confirmAction === 'logout' && <div className="account-confirm-box"><strong>确认退出当前会话？</strong><p>{data.user.provider === 'guest' ? '退出后将创建一个新的访客身份，当前资料无法通过该访客身份恢复。' : '当前知乎连接将结束，等待中的邀请会取消。'}</p><div><button className="button secondary account-small-button" disabled={Boolean(busy)} onClick={() => setConfirm(null)}>留下来</button><button className="button primary account-small-button" disabled={Boolean(busy)} onClick={() => void change('logout', async () => { await api('/logout', { method: 'POST', json: {} }); }, '已退出，当前为新的访客会话。', true)}>{busy === 'logout' ? <Spinner text="正在退出…" /> : '确认退出'}</button></div></div>}
      <button className="text-button account-danger-text account-delete-trigger" disabled={Boolean(busy)} onClick={() => setConfirm('delete')}><Trash2 size={14} />删除我在同知的全部数据</button>
      {confirmAction === 'delete' && <form className="account-confirm-box account-delete-box" onSubmit={event => { event.preventDefault(); if (confirmation.trim() === '删除') void change('delete', async () => { await api('/account', { method: 'DELETE', json: { confirm: 'delete' } }); }, '你在同知的数据已删除。', true); }}><strong>这次告别，将清除所有记录</strong><p>删除此账号在同知的画像、导入摘要、收藏、AI 会话与私聊记录，并撤回本人小组发言及其派生内容，并退出登录。此操作无法撤销，你的知乎账号与知乎内容不受影响。</p><label htmlFor={confirmationId}>请输入「删除」以确认</label><input id={confirmationId} autoComplete="off" className="account-confirm-input" placeholder="删除" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={Boolean(busy)} /><div><button type="button" className="button secondary account-small-button" disabled={Boolean(busy)} onClick={() => setConfirm(null)}>取消</button><button type="submit" className="button account-danger-button account-small-button" disabled={Boolean(busy) || confirmation.trim() !== '删除'}>{busy === 'delete' ? <Spinner text="正在删除…" /> : '永久删除我的数据'}</button></div></form>}
    </section>
    {error && <p className="form-error account-error" role="alert">{error}</p>}
    <p className="account-bottom-note"><LockKeyhole size={13} />你的好奇心，始终由你自己掌握</p>
  </Dialog>;
}

export function LoginDialog({ actions, onClose }: DialogProps) {
  const { data } = actions;
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');

  async function connect() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const response = await api<{ url: string }>('/auth/zhihu/start', { method: 'POST', json: {} });
      const destination = new URL(response.url);
      if (destination.protocol !== 'https:' || destination.hostname !== 'openapi.zhihu.com' || destination.pathname !== '/authorize' || destination.username || destination.password) throw new Error('授权地址暂时无法使用，请稍后重试。');
      window.location.assign(destination.href);
    } catch (cause) { setError(messageOf(cause)); pending.current = false; setBusy(false); }
  }

  function create() { onClose(); actions.onCreate(); }

  return <Dialog title={data.zhihuConnected ? '我的知乎连接' : '连接知乎，延伸你的好奇心'} onClose={onClose} busy={busy} className="login-dialog">
    <div className="login-illustration"><span className="login-orbit orbit-one" /><span className="login-orbit orbit-two" /><span className="login-zhihu-mark">知</span><span className="login-spark"><Sparkles size={17} /></span></div>
    {data.zhihuConnected ? <>
      <div className="login-intro"><h3>已经与你的知乎连接</h3><p>你好，{data.user.name}。接下来，由你选择哪些内容可以成为兴趣的线索。</p></div>
      <div className="login-benefit"><ShieldCheck size={19} /><p>每次导入都需要你主动选择数据来源。你可以在账号与数据设置中随时清除导入。</p></div>
      {data.capabilities.zhihuData ? <button className="button primary login-main-action" onClick={() => { onClose(); actions.onImport(); }}>选择要导入的内容<ArrowRight size={16} /></button> : <div className="login-status-note"><CircleHelp size={18} /><p>知乎内容导入暂未开放，可以先用你填写的兴趣完善画像。</p></div>}
      <button className="button secondary login-main-action" onClick={create}>{data.profile ? '完善我的兴趣画像' : '创建我的兴趣画像'}</button>
    </> : <>
      <div className="login-intro"><h3>好内容里，藏着同频的你</h3><p>把你愿意分享的知识线索，变成相遇的起点。</p></div>
      <div className="login-benefits"><div><UserRound size={19} /><span><strong>连接自己的账号</strong><p>在知乎页面亲自登录并确认授权；站内继续使用你选择的昵称。</p></span></div><div><BookOpen size={19} /><span><strong>主动选择，按需导入</strong><p>可选择公开创作摘要、关注简介与近期收藏摘要，每类最多 10 条。</p></span></div><div><LockKeyhole size={19} /><span><strong>公开与否，由你决定</strong><p>创建画像默认不加入匹配池，原始导入摘要不会展示给伙伴。</p></span></div></div>
      {!data.capabilities.oauth && <div className="login-status-note"><CircleHelp size={18} /><p><strong>知乎登录暂未开放</strong>本站尚未启用知乎登录。你可以先选择兴趣，体验画像与匹配。</p></div>}
      {data.capabilities.oauth && !data.capabilities.zhihuData && <p className="login-capability-note">当前可绑定知乎登录身份，内容导入将在开放后可用。</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {data.capabilities.oauth && <button className="button primary login-main-action" onClick={connect} disabled={busy}>{busy ? <Spinner text="正在前往知乎…" /> : <>{data.user.provider === 'zhihu' ? '重新连接知乎' : '前往知乎授权'}<ArrowUpRight size={17} /></>}</button>}
      <button className={`button ${data.capabilities.oauth ? 'secondary' : 'primary'} login-main-action`} onClick={create} disabled={busy}>{data.profile ? '继续完善我的画像' : '先用兴趣创建画像'}<ArrowRight size={16} /></button>
      <p className="login-bottom-note">你的每一个授权选择，都会在知乎页面由你亲自确认。</p>
    </>}
  </Dialog>;
}

const importOptions = [
  { id: 'contents' as const, label: '我的创作', description: '公开回答、文章等内容的标题与摘要', Icon: FileText, unit: '条' },
  { id: 'followees' as const, label: '我关注的人', description: '公开昵称与一句话介绍，寻找兴趣线索', Icon: Users, unit: '位' },
  { id: 'collections' as const, label: '我的近期收藏', description: '近期公开收藏的标题与摘要，仅限最近一批', Icon: Bookmark, unit: '条' },
];

export function ImportDialog({ actions, onClose }: DialogProps) {
  const { data } = actions;
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [useAI, setUseAI] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const [needsConnection, setNeedsConnection] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const working = busy || checking;
  const available = data.capabilities.zhihuData && data.zhihuConnected && !needsConnection;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || checking || !sources.length || !available) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const response = await api<ImportResult>('/zhihu/import', { method: 'POST', json: { sources, useAI } });
      setResult(response);
      try { await actions.refresh(); actions.notify(response.count ? `已导入 ${response.count} 条摘要${response.profile ? '并更新画像，当前未加入匹配池。' : '，可用于创建你的画像。'}` : '所选范围没有可导入的公开摘要。'); }
      catch (cause) { setRefreshFailed(true); setError('导入请求已完成，但页面还未同步。' + messageOf(cause)); }
    } catch (cause) {
      setError(messageOf(cause));
      if (cause instanceof APIError && ['zhihu_expired', 'zhihu_required'].includes(cause.code)) setNeedsConnection(true);
    } finally { pending.current = false; setBusy(false); }
  }

  async function retryRefresh() {
    if (pending.current || checking) return;
    pending.current = true; setBusy(true); setError('');
    try { await actions.refresh(); setRefreshFailed(false); }
    catch (cause) { setError(messageOf(cause)); }
    finally { pending.current = false; setBusy(false); }
  }

  return <Dialog title="从知乎，补充兴趣的线索" onClose={onClose} busy={busy || checking} className={`import-dialog ${checking ? 'is-checking' : ''}`}>
    {result ? <div className="import-result"><span className={`import-result-icon ${result.count ? '' : 'empty'}`}>{result.count ? <Check size={30} /> : <BookOpen size={30} />}</span><h3>{result.count ? `收集到 ${result.count} 条兴趣线索` : '这次还没有找到可用的公开摘要'}</h3><p>{result.count ? result.profile ? '画像已结合这些摘要更新。查看新的画像后，可以重新选择让伙伴发现你。' : '线索已保存，创建画像时可以把它们与自己的兴趣放在一起。' : '可以继续手动填写兴趣，也可以在有新的公开内容后再导入。'}</p><div className="import-result-counts">{importOptions.filter(option => sources.includes(option.id)).map(option => <span key={option.id}><option.Icon size={16} />{option.label}<strong>{result.counts[option.id] || 0} {option.unit}</strong></span>)}</div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {refreshFailed ? <button className="button primary" disabled={working} onClick={retryRefresh}>{busy ? <Spinner text="同步中…" /> : <><RefreshCw size={16} />同步最新资料</>}</button> : <button className="button primary" disabled={working} onClick={() => { onClose(); if (result.profile) { actions.navigate('profile'); actions.onShare(); } else actions.onCreate(); }}>{result.profile ? '查看我的知识人格' : '创建我的知识人格'}<ArrowRight size={16} /></button>}
      <button className="text-button" disabled={working} onClick={onClose}>完成</button>
    </div> : <form onSubmit={submit}>
      <div className="import-intro"><span><BookOpen size={23} /></span><div><h3>你选择的内容，才会成为线索</h3><p>只读取你主动勾选的公开摘要与简介，每类最多 10 条。</p></div></div>
      {!available && <div className="login-status-note"><CircleHelp size={18} /><div><strong>{!data.capabilities.zhihuData ? '知乎内容导入暂未开放' : '请先连接自己的知乎账号'}</strong><p>{!data.capabilities.zhihuData ? '现在仍可用手动填写的兴趣生成画像。' : '连接后，你可以选择要导入的内容。'}</p></div></div>}
      <fieldset disabled={working || !available} className="import-options"><legend className="import-options-legend">选择本次导入的来源</legend>{importOptions.map(option => <label key={option.id} className={`import-source-option ${sources.includes(option.id) ? 'selected' : ''}`}><input type="checkbox" checked={sources.includes(option.id)} onChange={event => { setSources(current => event.target.checked ? [...current, option.id] : current.filter(id => id !== option.id)); setError(''); }} /><span className="import-source-icon"><option.Icon size={20} /></span><span className="import-source-text"><strong>{option.label}<small>最多 10 {option.unit}</small></strong><span>{option.description}</span></span></label>)}</fieldset>
      {data.profile && <label className={`wizard-consent import-ai-consent ${!available || !data.capabilities.ai ? 'unavailable' : ''}`}><input type="checkbox" checked={useAI} disabled={working || !available || !data.capabilities.ai} onChange={event => setUseAI(event.target.checked)} /><span><strong><Sparkles size={15} />使用 AI 重新解读我的画像</strong><small>{data.capabilities.ai ? '允许将所选摘要与已有兴趣交给 AI 解读。关闭后按兴趣规则更新。' : 'AI 解读暂不可用，将按兴趣规则更新。'}</small></span></label>}
      <div className="import-scope-note"><LockKeyhole size={15} /><p>{data.imports.count ? '本次导入会替换上次导入的内容。' : '导入的原始摘要仅自己可见，可在设置中清除。'}{data.profile ? '更新后的画像将暂时退出匹配，查看后可重新加入。' : '创建画像时，你可以选择是否使用 AI 解读。'}</p></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="import-footer"><button type="button" className="button secondary" disabled={working} onClick={onClose}>暂不导入</button>{!available ? <button type="button" className="button primary" onClick={() => { onClose(); if (data.capabilities.zhihuData) actions.onLogin(); else actions.onCreate(); }}>{data.capabilities.zhihuData ? '连接知乎账号' : '用兴趣创建画像'}<ArrowRight size={15} /></button> : <button type="submit" className="button primary" disabled={working || !sources.length}>{busy ? <Spinner text="正在读取并整理…" /> : <><ArrowDownToLine size={16} />{data.profile ? '导入并更新画像' : '导入所选摘要'}{sources.length > 0 && <span>({sources.length})</span>}</>}</button>}</div>
    </form>}
    {data.capabilities.zhihuData && <ZhihuDataCheck key={data.user.id} actions={actions} disabled={busy} onBusyChange={setChecking} onReconnect={() => { onClose(); actions.onLogin(); }}/>}
  </Dialog>;
}
