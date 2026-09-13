import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, KeyRound, Mail, Settings2, ShieldCheck } from 'lucide-react';
import { api, messageOf } from '../../api';
import { Avatar, PageTitle, Spinner } from '../../components';
import type { PageActions } from '../../types';
import { SafetyPanel } from './SafetyPanel';

interface Account { email: string | null; name: string; provider: string; hasPassword: boolean }
export interface Preferences { groupInvites: boolean; aiAnalysis: boolean; chatAnalysis: boolean; notificationDigests: boolean }
interface PreferenceState { preferences: Preferences; revision: number }
const preferenceLabels: { key: keyof Preferences; title: string; text: string }[] = [
  { key: 'groupInvites', title: '接收同题邀请', text: '允许向你推荐或邀请与你的问题相关的同题小组。' },
  { key: 'aiAnalysis', title: '用 AI 整理发言建议', text: '允许把主动选中的本人发言交给模型整理待确认的兴趣建议。单次画像解读、AI 伙伴与双人破冰在各页面另行授权。' },
  { key: 'chatAnalysis', title: '从我的发言中整理知识', text: '仅分析你主动选择的本人发言，建议经你确认后才进入画像。' },
  { key: 'notificationDigests', title: '接收消息摘要', text: '接收同题、匹配与知识更新的摘要提醒。' },
];

export function AccountPage({ actions, version, onPrivacy }: { actions: PageActions; version: number; onPrivacy: () => void }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [preferences, setPreferences] = useState<PreferenceState | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(''), [reload, setReload] = useState(0);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register');
  const [showAuth, setShowAuth] = useState(false);
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [name, setName] = useState(actions.data.user.name === '新朋友' ? '' : actions.data.user.name);
  const [currentPassword, setCurrentPassword] = useState(''), [newPassword, setNewPassword] = useState('');
  const locked = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([api<Account>('/account', { signal: controller.signal }), api<PreferenceState>('/preferences', { signal: controller.signal })])
      .then(([nextAccount, nextPreferences]) => { if (!controller.signal.aborted) { setAccount(nextAccount); setPreferences(nextPreferences); setError(''); } })
      .catch(cause => { if (!controller.signal.aborted) setError(messageOf(cause)); });
    return () => controller.abort();
  }, [actions.data.user.id, version, reload]);

  async function run(id: string, job: () => Promise<void>, success: string) {
    if (locked.current) return;
    locked.current = true; setBusy(id); setError('');
    try { await job(); await actions.refresh(); setReload(value => value + 1); actions.notify(success); }
    catch (cause) { setError(messageOf(cause)); }
    finally { locked.current = false; setBusy(''); }
  }
  return <div className="tz-feature" data-testid="account-page"><PageTitle eyebrow="YOUR ACCOUNT, YOUR CHOICES" title="账号与偏好" description="保存自己的知识线索，也决定它们如何被使用。"/>
    {error && <div className="tz-error" role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>重新读取</button></div>}
    <div className="tz-two-column"><section className="tz-card"><div className="tz-account-person"><Avatar name={actions.data.user.name} seed={actions.data.user.id} src={actions.data.user.avatar} size={52}/><div><h2>{account?.name || actions.data.user.name}</h2><p>{account?.email || (actions.data.user.provider === 'zhihu' ? '已连接知乎，可绑定邮箱' : '当前为浏览器访客身份')}</p></div></div>
      <div className="tz-actions"><button className="button secondary" onClick={actions.onLogin}><span className="zhihu-mark">知</span>{actions.data.zhihuConnected ? '管理知乎连接' : '连接知乎'}<ArrowUpRight size={14}/></button><button className="text-button" onClick={onPrivacy}><ShieldCheck size={15}/>数据、导出与退出</button></div>
      {!!account?.email && <button className="text-button tz-top-gap" onClick={() => { setShowAuth(value => !value); setAuthMode('login'); }}>使用其他邮箱账号</button>}
      {(!account?.email || showAuth) && <form className="tz-form tz-top-gap" data-testid="email-auth-form" onSubmit={event => { event.preventDefault(); void run('auth', async () => { await api(`/auth/email/${authMode}`, { method: 'POST', json: authMode === 'register' ? { email, password, name } : { email, password } }); setPassword(''); setShowAuth(false); }, authMode === 'register' ? '邮箱账号已保存。' : '已登录邮箱账号。'); }}><div className="tz-tabs" role="group" aria-label="邮箱账号方式"><button type="button" className={authMode === 'register' ? 'active' : ''} onClick={() => setAuthMode('register')}>注册邮箱</button><button type="button" className={authMode === 'login' ? 'active' : ''} onClick={() => setAuthMode('login')}>已有账号</button></div>
        {authMode === 'register' && <label>昵称<input data-testid="account-name" value={name} onChange={event => setName(event.target.value)} required maxLength={24} autoComplete="nickname"/></label>}
        <label>邮箱<input data-testid="account-email" type="email" value={email} onChange={event => setEmail(event.target.value)} required maxLength={254} autoComplete="username" placeholder="you@example.com"/></label>
        <label>密码<input data-testid="account-password" type="password" value={password} onChange={event => setPassword(event.target.value)} required minLength={authMode === 'register' ? 12 : 1} maxLength={256} autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} placeholder={authMode === 'register' ? '至少 12 个字符' : '输入账号密码'}/></label>
        <button className="button primary" disabled={Boolean(busy)} data-testid="account-auth-submit">{busy === 'auth' ? <Spinner text="正在保存…"/> : <><Mail size={16}/>{authMode === 'register' ? '创建邮箱账号' : '登录'}</>}</button>
        <p className="tz-caption">使用邮箱或知乎账号，可在其他浏览器找回自己的资料。</p>
      </form>}
      {account?.email && <form className="tz-form tz-divider" data-testid="account-password-form" onSubmit={event => { event.preventDefault(); void run('password', async () => { await api('/auth/email/password', { method: 'POST', json: { currentPassword, newPassword } }); setCurrentPassword(''); setNewPassword(''); }, '密码已更新。'); }}><h3><KeyRound size={16}/>{account.hasPassword ? '修改密码' : '设置密码'}</h3>{account.hasPassword && <label>当前密码<input type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required autoComplete="current-password" maxLength={256}/></label>}<label>新密码<input type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} required autoComplete="new-password" minLength={12} maxLength={256}/></label><button className="button secondary" disabled={Boolean(busy)}>保存新密码</button></form>}
    </section><section className="tz-card" data-testid="account-preferences"><h2><Settings2 size={19}/>我来决定</h2><p className="tz-muted">这些设置可以随时调整；每条知识建议仍需本人确认。</p>{preferences ? preferenceLabels.map(item => <label className="tz-preference" key={item.key}><span><strong>{item.title}</strong><small>{item.text}</small></span><input type="checkbox" role="switch" data-testid={`preference-${item.key}`} checked={preferences.preferences[item.key]} disabled={Boolean(busy)} onChange={event => { const value = event.target.checked; void run(item.key, async () => { const next = await api<PreferenceState>('/preferences', { method: 'PUT', json: { preferences: { [item.key]: value }, revision: preferences.revision } }); setPreferences(next); }, '偏好已保存。'); }}/></label>) : !error && <Spinner text="正在读取偏好…"/>}<button className="text-button tz-top-gap" onClick={onPrivacy}>查看数据与隐私设置<ArrowUpRight size={14}/></button></section></div>
    <SafetyPanel version={version} notify={actions.notify}/>
  </div>;
}
