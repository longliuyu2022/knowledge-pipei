import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Check, Copy, Link, LoaderCircle, Share2, UsersRound } from 'lucide-react';
import { Dialog } from './components';
import './invite.css';

export function InviteDialog({ onClose }: { onClose: () => void }) {
  const link = `${window.location.origin}/#pairing`;
  const inputId = useId();
  const descriptionId = useId();
  const linkInput = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const mounted = useRef(false);
  const pending = useRef(false);
  const [busy, setBusy] = useState<'copy' | 'share' | ''>('');
  const [feedback, setFeedback] = useState('');
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator.share === 'function';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const trigger = returnFocus.current;
      requestAnimationFrame(() => {
        if (trigger?.isConnected && !document.querySelector('dialog[open]')) trigger.focus({ preventScroll: true });
      });
    };
  }, []);

  function selectLink() {
    const input = linkInput.current;
    input?.focus({ preventScroll: true });
    input?.select();
    input?.setSelectionRange(0, link.length);
  }

  function manualCopy(message: string) {
    if (!mounted.current) return;
    setCopied(false);
    setFeedback(`${message}链接已选中，可长按复制，或按 Ctrl / ⌘ + C。`);
    selectLink();
  }

  async function copyLink() {
    if (pending.current) return;
    pending.current = true; setBusy('copy'); setCopied(false); setFeedback('');
    try {
      if (window.isSecureContext && navigator.clipboard?.writeText) await navigator.clipboard.writeText(link);
      else {
        selectLink();
        if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
      }
      if (mounted.current) { setCopied(true); setFeedback('链接已复制，可以发给朋友了。'); }
    } catch { manualCopy('未能自动复制。'); }
    finally { pending.current = false; if (mounted.current) setBusy(''); }
  }

  async function shareLink() {
    if (pending.current || !canShare) return;
    pending.current = true; setBusy('share'); setCopied(false); setFeedback('');
    try {
      await navigator.share({
        title: '同频 · 邀请朋友一起配对',
        text: '来同频，从共同的兴趣开始认识新朋友。各自完成知识画像后，点击「开始配对」。',
        url: link,
      });
      if (mounted.current) setFeedback('分享操作已完成，也可以继续复制链接。');
    } catch (cause) {
      manualCopy(cause instanceof DOMException && cause.name === 'AbortError' ? '已取消分享。' : '暂时无法打开分享。');
    } finally { pending.current = false; if (mounted.current) setBusy(''); }
  }

  return <Dialog title="邀请朋友一起配对" onClose={onClose} className="invite-dialog">
    <div className="invite-content" data-testid="invite-dialog">
      <div className="invite-intro"><span className="invite-symbol"><UsersRound size={27}/></span><div><p className="eyebrow">GOOD CONVERSATIONS TRAVEL</p><h3>把共同的好奇，分享给朋友</h3><p>用一个链接，邀请朋友来同频认识新的伙伴。</p></div></div>
      <ol className="invite-steps" aria-label="参与配对的步骤"><li><span>01</span><p>打开链接，<strong>各自完成知识画像</strong></p></li><li><span>02</span><p>准备好后，<strong>都点击「开始配对」</strong></p></li><li><span>03</span><p>遇见伙伴，<strong>双方确认后聊天</strong></p></li></ol>
      <p className="invite-expectation" id={descriptionId}>系统会从在线队列中寻找合适的伙伴。邀请朋友并不保证你们会配到彼此。</p>
      <label className="invite-link-label" htmlFor={inputId}><Link size={14}/>公开配对链接</label>
      <input ref={linkInput} id={inputId} className="invite-link-input" data-testid="invite-link" value={link} readOnly aria-describedby={descriptionId} autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} onClick={event => event.currentTarget.select()}/>
      <div className="invite-actions"><button type="button" className="button primary" data-testid="invite-copy" disabled={Boolean(busy)} onClick={() => void copyLink()}>{busy === 'copy' ? <LoaderCircle size={16} className="spin"/> : copied ? <Check size={16}/> : <Copy size={16}/>} {busy === 'copy' ? '正在复制…' : copied ? '已复制链接' : '复制邀请链接'}<ArrowUpRight size={15}/></button>{canShare && <button type="button" className="button secondary" data-testid="invite-share" disabled={Boolean(busy)} onClick={() => void shareLink()}>{busy === 'share' ? <LoaderCircle size={16} className="spin"/> : <Share2 size={16}/>} {busy === 'share' ? '正在分享…' : '分享给朋友'}</button>}</div>
      <p className={`invite-feedback ${copied ? 'is-copied' : ''}`} role="status" aria-live="polite" aria-atomic="true" data-testid="invite-feedback">{feedback || '这是公开入口，拿到链接的人都可以参与。'}</p>
    </div>
  </Dialog>;
}
