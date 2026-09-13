import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ArrowUpRight, Bookmark, Check, ChevronRight, Sparkles, X, LoaderCircle, MessageCircle, Waves } from 'lucide-react';
import type { Dimension, Match } from './types';

export function Logo({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'brand-small' : ''}`}><span className="brand-symbol"><svg viewBox="0 0 42 42" aria-hidden="true"><path d="M7 23c6-17 11-17 16-2s8 13 13-5M7 31c6-17 11-17 16-2s8 13 13-5"/><circle cx="33" cy="8" r="2.5"/></svg></span>{!small && <span className="brand-word">同频<span>知识让我们相遇</span></span>}</div>;
}

const palettes = [
  ['#dce4e1', '#527b77', '#eed6c4', '#3f4a49'], ['#ebe1d7', '#b39174', '#f2dac8', '#584e4c'],
  ['#dbe0eb', '#7085aa', '#e8c8b2', '#424657'], ['#e9dfea', '#a186a5', '#f4d9c6', '#58464c'],
  ['#e3e6d9', '#8b9e71', '#eed2bf', '#4c4c40'], ['#e9d9d5', '#b3786c', '#e9c4ad', '#403d40'],
  ['#dfdfed', '#8982b2', '#f2d8c4', '#514a61'], ['#d8e5e9', '#6e9caa', '#e9c8b6', '#414b52'],
];
export function Avatar({ name, seed = name, src, size = 48 }: { name: string; seed?: string; src?: string; size?: number }) {
  const uid = useId().replace(/:/g, '');
  const n = [...seed].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  const [bg, shirt, skin, hair] = palettes[n % palettes.length];
  return <span className="avatar" style={{ width: size, height: size, background: bg }} aria-label={name}>
    {src ? <img src={src} alt={name} referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = 'none'; }} /> : null}
    <svg viewBox="0 0 64 64" aria-hidden="true"><defs><clipPath id={uid}><circle cx="32" cy="32" r="32"/></clipPath></defs><g clipPath={`url(#${uid})`}><rect width="64" height="64" fill={bg}/><circle cx="52" cy="10" r="18" fill="#fff" opacity=".22"/><path d="M9 66c0-17 9-25 23-25s23 8 23 25" fill={shirt}/><path d="M26 37h12v12c-4 4-8 4-12 0" fill={skin}/>{n % 3 === 0 && <path d="M15 37V23C15 5 50 6 49 25v21H15" fill={hair}/>}<ellipse cx="32" cy="28" rx="13" ry="16" fill={skin}/><path d={n % 2 ? 'M18 25C12 4 49 3 47 28c-3-6-7-7-10-13-2 6-9 9-19 10' : 'M18 25C15 5 49 4 46 26l-6-9c-6 7-13 7-22 8'} fill={hair}/><path d="M25 30h1m12 0h1" stroke={hair} strokeWidth="2.1" strokeLinecap="round"/><path d="M29 37q3 2 6 0" stroke="#b78472" fill="none" strokeLinecap="round"/>{n % 4 === 0 && <g stroke={hair} fill="none" strokeWidth="1.2"><rect x="21" y="26" width="10" height="8" rx="3"/><rect x="34" y="26" width="10" height="8" rx="3"/><path d="M31 29h3"/></g>}<path d="m23 48 9 7 9-7" stroke="#fff" strokeOpacity=".4" strokeWidth="2" fill="none"/></g></svg>
  </span>;
}

export function Dialog({ title, children, onClose, wide = false, busy = false, className = '' }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; busy?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => { const el = ref.current; el?.showModal(); const old = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { el?.close(); document.body.style.overflow = old; }; }, []);
  return <dialog ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''} ${className}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="dialog-shell"><div className="dialog-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭弹窗"><X size={20}/></button></div>{children}</div>
  </dialog>;
}

export function Spinner({ text = '正在加载…' }: { text?: string }) { return <span className="loading-inline" role="status"><LoaderCircle size={18} className="spin"/>{text}</span>; }
export function Empty({ title, text, action, onAction }: { title: string; text: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><span className="empty-icon"><Waves size={28}/></span><h3>{title}</h3><p>{text}</p>{action && <button className="button primary" onClick={onAction}>{action}<ArrowUpRight size={16}/></button>}</div>;
}
export function PoolToggle({ value, onChange }: { value: string; onChange: (value: 'demo' | 'people') => void }) {
  return <div className="pool-toggle" aria-label="选择伙伴来源"><button className={value === 'demo' ? 'active' : ''} aria-pressed={value === 'demo'} onClick={() => onChange('demo')}>体验伙伴</button><button className={value === 'people' ? 'active' : ''} aria-pressed={value === 'people'} onClick={() => onChange('people')}>真实参与者</button></div>;
}

export function Radar({ dimensions, comparison, large = false }: { dimensions: Dimension[]; comparison?: Dimension[]; large?: boolean }) {
  const center = [150, 131], radius = 82;
  const point = (i: number, fraction: number) => [center[0] + Math.sin(i * Math.PI / 3) * radius * fraction, center[1] - Math.cos(i * Math.PI / 3) * radius * fraction];
  const points = (values: number[]) => values.map((v, i) => point(i, v).join(',')).join(' ');
  return <svg viewBox="0 0 300 260" className={`radar ${large ? 'radar-large' : ''}`} role="img" aria-label={`知识兴趣分布：${dimensions.map(d => `${d.label}${d.value}`).join('、')}`}>
    {[.25, .5, .75, 1].map(n => <polygon key={n} points={points(dimensions.map(() => n))} fill={n === 1 ? '#f9f9fc' : 'none'} stroke="#e8e8f0"/>).reverse()}
    {dimensions.map((d, i) => <line key={d.id} x1={150} y1={131} x2={point(i, 1)[0]} y2={point(i, 1)[1]} stroke="#e8e8f0"/>)}
    {comparison && <polygon points={points(comparison.map(d => d.value / 100))} fill="#dfb28d25" stroke="#ceaa80" strokeWidth="1.5" strokeDasharray="4 3"/>}
    <polygon points={points(dimensions.map(d => d.value / 100))} fill="#8b82d82b" stroke="#8a81d2" strokeWidth="2"/>
    {dimensions.map((d, i) => <g key={d.id}><circle cx={point(i, d.value / 100)[0]} cy={point(i, d.value / 100)[1]} r="3" fill="#8a81d2" stroke="white" strokeWidth="1.5"/><text x={point(i, 1.29)[0]} y={point(i, 1.29)[1] + 4} textAnchor="middle" fill="#8a8b99" fontSize="11">{d.label}</text></g>)}
  </svg>;
}

export function HeroArt() {
  return <div className="hero-art" aria-hidden="true"><svg viewBox="0 0 350 270"><defs><radialGradient id="orb"><stop stopColor="#f6f4ff"/><stop offset="1" stopColor="#dcd8f6"/></radialGradient><linearGradient id="planet" x2="1" y2="1"><stop stopColor="#aaa1ed"/><stop offset="1" stopColor="#7065b7"/></linearGradient></defs>
    <circle cx="182" cy="135" r="111" fill="none" stroke="#d7d2eb" strokeDasharray="3 7"/>
    <ellipse cx="182" cy="135" rx="141" ry="70" transform="rotate(-28 182 135)" fill="none" stroke="#ccc5e6"/>
    <ellipse cx="182" cy="135" rx="128" ry="54" transform="rotate(44 182 135)" fill="none" stroke="#ddd8ed"/>
    <circle cx="182" cy="135" r="76" fill="url(#orb)"/>
    <circle cx="182" cy="135" r="59" fill="none" stroke="#fff" strokeOpacity=".65"/>
    <path d="M139 138c16-45 29-45 41-6s24 38 42-8M139 158c16-45 29-45 41-6s24 38 42-8" fill="none" stroke="url(#planet)" strokeWidth="8" strokeLinecap="round"/>
    <circle cx="214" cy="103" r="7" fill="#c4cb95"/>
    <g transform="translate(54 57) rotate(-12)"><rect x="-23" y="-23" width="46" height="46" rx="14" fill="#fff" stroke="#e8e4f3"/><path d="m-12-10 12 3 12-3v21L0 14l-12-3zM0-7v21" fill="#e4ddf8" stroke="#a39ac7" strokeWidth="1.5"/><path d="m-8-4 4 1m-4 5 4 1m8-7 4-1m-4 7 4-1" stroke="#a39ac7" strokeLinecap="round"/></g>
    <g transform="translate(289 99) rotate(10)"><rect x="-23" y="-23" width="46" height="46" rx="14" fill="#fff" stroke="#e8e4f3"/><path d="M-10 1c-13-11 3-22 10-9 8-13 23-2 10 9L0 12z" fill="#e7cfba" stroke="#caaf93" strokeWidth="1.5"/></g>
    <g transform="translate(117 228) rotate(-6)"><rect x="-23" y="-23" width="46" height="46" rx="14" fill="#fff" stroke="#e8e4f3"/><path d="M-12-9h24v17H1l-7 6V8h-6z" fill="#dce5d5" stroke="#99ad8b" strokeWidth="1.5"/><circle cx="-6" r="1.5" fill="#99ad8b"/><circle r="1.5" fill="#99ad8b"/><circle cx="6" r="1.5" fill="#99ad8b"/></g>
    <g stroke="#b5aad6" strokeWidth="1.8"><path d="M259 30v12m-6-6h12M43 173v10m-5-5h10M277 216v8m-4-4h8"/></g>
    <circle cx="212" cy="22" r="4" fill="#d9c6ac"/><circle cx="68" cy="117" r="3" fill="#b5bdaa"/><circle cx="292" cy="170" r="5" fill="#ccc4e2"/>
  </svg></div>;
}

export function MatchCard({ match, onSelect, onSave, saving = false }: { match: Match; onSelect: () => void; onSave: () => void; saving?: boolean }) {
  return <article className="match-card" data-testid="match-card"><div className="match-card-top"><Avatar name={match.name} seed={match.id} src={match.avatar}/><div className="match-person"><h3>{match.name}<span className="person-origin">{match.demo ? '体验人物' : match.provider === 'zhihu' ? '知乎已连接' : '访客'}</span></h3><p>{match.title}</p></div><div className="match-score"><strong>{match.score}<span>°</span></strong><span>{match.matchingMode === 'complement' ? '互补指数' : '同频指数'}</span></div></div>
    <p className="person-about">{match.about}</p>
    <div className="tags">{match.interests.slice(0, 4).map(t => <span key={t.id} className={`tag ${match.shared.some(s => s.id === t.id) ? 'tag-purple' : ''}`}>{t.label}</span>)}</div>
    <div className="match-reason"><Sparkles size={14}/><p>{match.reasons[0]}</p></div>
    <div className="match-card-footer"><button className="text-button" onClick={onSelect}>为什么同频<ChevronRight size={15}/></button><button className={`icon-button save-button ${match.saved ? 'is-saved' : ''}`} aria-label={`${match.saved ? '取消收藏' : '收藏'}${match.name}`} aria-pressed={match.saved} disabled={saving} onClick={onSave}>{match.saved ? <Bookmark size={18} fill="currentColor"/> : <Bookmark size={18}/>}</button></div>
  </article>;
}

export function SourceBadge({ mode }: { mode: string }) { return <span className={`source-badge ${mode === 'model' ? 'source-ai' : ''}`}>{mode === 'model' ? <Sparkles size={12}/> : <Check size={12}/>} {mode === 'model' ? 'AI 解读' : '规则分析'}</span>; }
export function PageTitle({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return <div className="page-title"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{children}</div>;
}
export function QuoteMark() { return <MessageCircle size={16}/>; }
