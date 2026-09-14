import { useEffect, useState } from 'react';
import { Download, Copy, MessageCircle, BookOpen, Share2, Sparkles, Check } from 'lucide-react';
import { Dialog, Spinner } from './components';
import { personaFor } from '../shared/personas.js';
import { createPersonaCard, savePersonaCard } from './persona-card';
import type { Profile } from './types';
import './persona.css';

export function PersonaShareDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const persona = personaFor(profile.input);
  const [card, setCard] = useState<{ blob: Blob; url: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const text = `我的知识人格是「${profile.title}」。\n${persona?.tagline || profile.summary}\n${(persona?.keywords || profile.interests.slice(0, 3).map(item => item.label)).map(word => `#${word}`).join(' ')}\n同频 · 让共同的好奇心，成为相遇的起点。`;
  useEffect(() => {
    let active = true, url = '';
    setFailed(false); setCard(null);
    createPersonaCard(profile, false).then(blob => {
      if (!active) return;
      url = URL.createObjectURL(blob); setCard({ blob, url });
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [profile, attempt]);

  async function copy(platform = '') {
    try { await navigator.clipboard.writeText(text); setNotice(platform ? `文案已复制，请打开${platform}粘贴；图片可用“保存图片”下载。` : '分享文案已复制。'); }
    catch { setNotice('当前浏览器无法自动复制，请展开“查看分享文案与分享方式”，手动复制文案。'); }
  }
  function download(wechat = false) {
    if (!card) return;
    savePersonaCard(card.blob);
    setNotice(wechat ? '图片已开始下载，请打开微信，在聊天或朋友圈中选择这张图片分享。' : '人格卡图片已开始下载。');
  }
  async function share() {
    if (!navigator.share) { setNotice('当前浏览器不支持系统分享，可保存图片或复制文案后分享。'); return; }
    setSharing(true);
    try {
      const file = card ? new File([card.blob], '我的知识人格.png', { type: 'image/png' }) : null;
      await navigator.share(file && navigator.canShare?.({ files: [file] }) ? { title: '我的知识人格', text, files: [file] } : { title: '我的知识人格', text });
      setNotice('已完成系统分享操作。');
    } catch (error) { setNotice(error instanceof DOMException && error.name === 'AbortError' ? '已取消分享，你的画像仍然保留。' : '系统分享未完成，可以改用保存图片或复制文案。'); }
    finally { setSharing(false); }
  }
  return <Dialog title="我的人格卡片" onClose={onClose} busy={sharing} className="persona-share-dialog">
    <div className="persona-share-layout">
      <div className="persona-share-stage">
        <span className="persona-stage-label"><Sparkles size={14} aria-hidden="true" /> 好奇心的独家名片</span>
        {card ? <img className="persona-share-image" src={card.url} alt={`${profile.input.name}的人格卡：${profile.title}`} /> : failed ? <p role="alert">图片暂未生成。<button className="text-button" onClick={() => setAttempt(value => value + 1)}>重新生成</button></p> : <Spinner text="正在生成你的人格卡…" />}
        <p className="persona-stage-caption">不必相同，也能同频。<span>让有趣的你，被看见。</span></p>
      </div>
      <div className="persona-share-content">
        <span className="persona-share-ready"><Check size={13} aria-hidden="true" /> 你的知识人格已生成</span>
        <h3>原来，我是这样的我。</h3>
        <p className="persona-share-subtitle">每一份好奇，都有自己的形状。<br />把这张名片，分享给懂你的人。</p>
        <div className="persona-share-identity"><span>属于 {profile.input.name} 的探索称号</span><strong>{profile.title}</strong><p>{persona?.tagline || '让共同的好奇心，成为相遇的起点。'}</p></div>
        <div className="persona-share-buttons">
          <button className="button primary persona-download" disabled={!card || sharing} onClick={() => download()}><Download size={17} aria-hidden="true" />保存图片</button>
          <button className="button secondary" disabled={sharing} onClick={() => void copy()}><Copy size={17} aria-hidden="true" />复制文案</button>
        </div>
        <div className="persona-share-divider"><span>分享给同频的人</span></div>
        <div className="persona-share-channels">
          <button disabled={!card || sharing} onClick={() => download(true)}><span className="channel-icon channel-wechat"><MessageCircle size={22} aria-hidden="true" /></span><span>微信 / 朋友圈</span></button>
          <button disabled={sharing} onClick={() => void copy('知乎 / 小红书')}><span className="channel-icon channel-story"><BookOpen size={22} aria-hidden="true" /></span><span>知乎 / 小红书</span></button>
          <button disabled={!card || sharing} onClick={() => void share()}><span className="channel-icon channel-more"><Share2 size={22} aria-hidden="true" /></span><span>更多分享</span></button>
        </div>
        <details className="persona-share-details"><summary>查看分享文案与分享方式</summary><label className="persona-share-copy">分享文案<textarea readOnly value={text} rows={5} onFocus={event => event.currentTarget.select()} /></label><p className="persona-footnote">微信使用图片分享，知乎和小红书可粘贴文案配图；“更多分享”调用设备支持的分享菜单。</p></details>
        {notice && <p role="status" className="persona-pending">{notice}</p>}
        <p className="persona-share-signoff">你比任何一种标签，都更丰富。</p>
      </div>
    </div>
  </Dialog>;
}
