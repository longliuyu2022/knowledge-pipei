import { useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronUp, CircleHelp, Compass, Eye, FileText, Fingerprint, LockKeyhole, PencilLine, Quote, Sparkles } from 'lucide-react';
import { GOALS, STYLE_AXES } from '../shared/catalog.js';
import { api, formatTime, messageOf } from './api';
import { Avatar, PageTitle, Radar, SourceBadge, Spinner } from './components';
import type { Evidence, PageActions, Profile } from './types';
import './profile.css';

const evidenceLabels: Record<string, string> = {
  selected: '主动选择', about: '我的自述', question: '我的问题', written: '主动填写', contents: '知乎创作摘要', followees: '关注用户简介', collections: '近期收藏摘要',
};

function sourceUrl(value?: string) {
  if (!value) return '';
  try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'zhihu.com' || url.hostname.endsWith('.zhihu.com')) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
}

function drawWrapped(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number) {
  const chars = [...value.replace(/\s+/g, ' ').trim()];
  let line = '', row = 0;
  for (let index = 0; index < chars.length; index++) {
    const next = line + chars[index];
    if (ctx.measureText(next).width > maxWidth && line) {
      if (row === maxLines - 1) {
        while (line && ctx.measureText(`${line}…`).width > maxWidth) line = line.slice(0, -1);
        ctx.fillText(`${line}…`, x, y + row * lineHeight);
        return;
      }
      ctx.fillText(line, x, y + row * lineHeight);
      line = chars[index]; row++;
    } else line = next;
  }
  if (line) ctx.fillText(line, x, y + row * lineHeight);
}

async function downloadCard(profile: Profile, sample: boolean) {
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  canvas.width = 1600; canvas.height = 2200;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器无法生成图片，请换一个浏览器重试。');
  ctx.scale(2, 2);
  const font = '"Tongpin Sans", "PingFang SC", "Microsoft YaHei", sans-serif';
  const rounded = (x: number, y: number, width: number, height: number, radius: number, fill: string) => {
    ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fillStyle = fill; ctx.fill();
  };
  const background = ctx.createLinearGradient(0, 0, 800, 1100);
  background.addColorStop(0, '#f6f3ff'); background.addColorStop(.5, '#fffefa'); background.addColorStop(1, '#f2f3ec');
  ctx.fillStyle = background; ctx.fillRect(0, 0, 800, 1100);
  ctx.strokeStyle = '#e5e0ee'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(28, 28, 744, 1044, 25); ctx.stroke();
  ctx.fillStyle = '#494050'; ctx.font = `600 27px ${font}`; ctx.fillText('同知', 72, 87);
  ctx.fillStyle = '#a8a0b3'; ctx.font = `12px ${font}`; ctx.textAlign = 'right'; ctx.fillText('KNOWLEDGE PERSONA', 726, 85); ctx.textAlign = 'left';
  rounded(72, 115, sample ? 188 : 146, 32, 16, '#eae5f6');
  ctx.font = `13px ${font}`; ctx.fillStyle = '#8277ae'; ctx.fillText(sample ? '知识人格 · 体验示例' : '我的知识人格卡', 86, 136);
  ctx.fillStyle = '#85808c'; ctx.font = `21px ${font}`; drawWrapped(ctx, `${profile.input.name}的好奇心宇宙`, 72, 197, 650, 28, 1);
  let titleSize = 42;
  ctx.font = `600 ${titleSize}px ${font}`;
  while (ctx.measureText(profile.title).width > 652 && titleSize > 23) { titleSize--; ctx.font = `600 ${titleSize}px ${font}`; }
  ctx.fillStyle = '#393342'; ctx.fillText(profile.title, 72, 255);
  ctx.fillStyle = '#7c7586'; ctx.font = `18px ${font}`; drawWrapped(ctx, profile.summary, 72, 305, 650, 29, 3);
  const center = { x: 400, y: 573 }, radius = 133;
  const point = (index: number, fraction: number) => ({ x: center.x + Math.sin(index * Math.PI * 2 / profile.dimensions.length) * radius * fraction, y: center.y - Math.cos(index * Math.PI * 2 / profile.dimensions.length) * radius * fraction });
  const polygon = (values: number[]) => {
    ctx.beginPath(); values.forEach((value, index) => { const p = point(index, value); if (index === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); }); ctx.closePath();
  };
  for (const fraction of [1, .75, .5, .25]) { polygon(profile.dimensions.map(() => fraction)); ctx.strokeStyle = '#ded9e9'; ctx.stroke(); }
  profile.dimensions.forEach((_dimension, index) => { const p = point(index, 1); ctx.beginPath(); ctx.moveTo(center.x, center.y); ctx.lineTo(p.x, p.y); ctx.strokeStyle = '#e7e2ee'; ctx.stroke(); });
  polygon(profile.dimensions.map(dimension => Math.max(0, Math.min(100, dimension.value)) / 100));
  ctx.fillStyle = '#8277cb32'; ctx.fill(); ctx.strokeStyle = '#8277cb'; ctx.lineWidth = 2; ctx.stroke();
  profile.dimensions.forEach((dimension, index) => {
    const p = point(index, Math.max(0, Math.min(100, dimension.value)) / 100);
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fillStyle = '#8277cb'; ctx.fill();
    const label = point(index, 1.38); ctx.fillStyle = '#807687'; ctx.font = `17px ${font}`; ctx.textAlign = 'center'; ctx.fillText(dimension.label, label.x, label.y + 6);
  });
  ctx.textAlign = 'left';
  let chipX = 72, chipY = 787;
  ctx.font = `15px ${font}`;
  for (const interest of profile.interests.slice(0, 8)) {
    const width = ctx.measureText(interest.label).width + 28;
    if (chipX + width > 728) { chipX = 72; chipY += 44; }
    if (chipY > 875) break;
    rounded(chipX, chipY, width, 32, 16, '#efebf5'); ctx.fillStyle = '#817491'; ctx.fillText(interest.label, chipX + 14, chipY + 22); chipX += width + 9;
  }
  ctx.fillStyle = '#6f657a'; ctx.font = `16px ${font}`;
  drawWrapped(ctx, `${profile.style.label}  ·  ${GOALS.filter(goal => profile.input.goals.includes(goal.id)).map(goal => goal.short).join(' / ')}`, 72, 937, 650, 23, 1);
  ctx.beginPath(); ctx.moveTo(72, 972); ctx.lineTo(728, 972); ctx.strokeStyle = '#e0dae8'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = '#867d91'; ctx.font = `17px ${font}`; ctx.fillText('让共同的好奇心，成为相遇的起点。', 72, 1007);
  ctx.fillStyle = '#9c95a4'; ctx.font = `12px ${font}`; ctx.fillText(sample ? '体验示例，不代表你的个人分析结果' : '兴趣探索参考，不代表能力评分或人格诊断', 72, 1040);
  ctx.textAlign = 'right'; ctx.fillText(profile.analysis.mode === 'model' ? 'AI 兴趣解读' : '基于所选兴趣', 728, 1040);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片生成失败，请重试。')), 'image/png'));
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `同知-${sample ? '体验示例' : '知识人格卡'}.png`; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function EvidenceItem({ evidence, used }: { evidence: Evidence; used: boolean }) {
  const url = sourceUrl(evidence.url);
  return <li className="profile-evidence-item"><span className={`profile-evidence-icon ${used ? 'used' : ''}`}>{evidence.kind === 'selected' ? <Check size={16} /> : <FileText size={16} />}</span>
    <div><div className="profile-evidence-meta"><span>{evidenceLabels[evidence.kind] || '用户提供'}</span>{used && <small>本次解读依据</small>}</div><strong>{evidence.label}</strong><p>{evidence.text}</p>{url && <a href={url} target="_blank" rel="noopener noreferrer" className="text-button">查看知乎来源<ArrowUpRight size={13} /></a>}</div>
  </li>;
}

export function ProfilePage({ actions }: { actions: PageActions }) {
  const { data } = actions;
  const profile = data.profile || data.sampleProfile;
  const isSample = !data.profile;
  const [exporting, setExporting] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const pending = useRef(false);
  const [allEvidence, setAllEvidence] = useState(false);
  const evidence = allEvidence ? profile.evidence : profile.evidence.slice(0, 4);
  const maxWeight = Math.max(1, ...profile.interests.map(interest => interest.weight));
  const imported = profile.evidence.filter(item => ['contents', 'followees', 'collections'].includes(item.kind)).length;

  async function exportCard() {
    if (exporting) return;
    setExporting(true);
    try { await downloadCard(profile, isSample); actions.notify('知识人格卡已生成，已开始下载 PNG 图片。'); }
    catch (cause) { actions.notify(messageOf(cause), true); }
    finally { setExporting(false); }
  }

  async function toggleVisibility() {
    if (!data.profile || pending.current) return;
    pending.current = true; setVisibilityBusy(true);
    let saved = false;
    try {
      await api('/profile/visibility', { method: 'POST', json: { discoverable: !profile.discoverable, revision: profile.revision } });
      saved = true;
      await actions.refresh();
      actions.notify(profile.discoverable ? '已隐藏公开知识名片。异步匹配请在「找同频的人」中单独暂停或取消。' : '已公开知识名片。可以开始异步匹配，或加入相关问题小组。');
    } catch (cause) { actions.notify((saved ? '设置已保存，页面刷新未完成。' : '') + messageOf(cause), true); }
    finally { pending.current = false; setVisibilityBusy(false); }
  }

  return <div className="profile-page">
    <PageTitle eyebrow="A LITTLE MORE ABOUT YOU" title="我的知识人格" description="把让你停留的内容，连成一幅独特的自己。">
      <div className="profile-page-actions"><button className="button secondary" onClick={exportCard} disabled={exporting}>{exporting ? <Spinner text="生成图片…" /> : <><ArrowDownToLine size={16} />{isSample ? '下载示例卡' : '下载人格卡'}</>}</button><button className="button primary" onClick={actions.onCreate}>{isSample ? <Sparkles size={16} /> : <PencilLine size={16} />}{isSample ? '创建我的画像' : '编辑画像'}</button></div>
    </PageTitle>

    {isSample && <div className="profile-sample-notice"><span><Compass size={18} /></span><div><strong>先看看，一份知识人格是什么模样</strong><p>下面是一份体验示例，不是对你的分析。选择自己的兴趣，就能生成你的专属画像。</p></div><button className="text-button" onClick={actions.onCreate}>从我的兴趣开始<ArrowRight size={15} /></button></div>}

    <div className="profile-overview">
      <section className="panel profile-persona">
        <div className="profile-persona-top"><div className="profile-persona-user"><Avatar name={profile.input.name} seed={isSample ? 'profile-example' : data.user.id} src={isSample ? undefined : data.user.avatar} size={48} /><div><strong>{profile.input.name}</strong><span>{isSample ? '体验示例' : '我的好奇心宇宙'}</span></div></div><SourceBadge mode={profile.analysis.mode} /></div>
        <p className="profile-persona-label">你的知识探索者称号</p>
        <h2>{profile.title}<span aria-hidden="true">✧</span></h2>
        <p className="profile-persona-summary">{profile.summary}</p>
        <div className="tags">{profile.interests.slice(0, 5).map(interest => <span className="tag profile-persona-tag" key={interest.id}>{interest.label}</span>)}</div>
        <div className="profile-highlights">{profile.highlights.map((highlight, index) => <div key={`${index}-${highlight}`}><span>{index === 0 ? <BookOpen size={17} /> : <Sparkles size={17} />}</span><p>{highlight}</p></div>)}</div>
        <p className="profile-caption"><Fingerprint size={13} />兴趣的一个切面，等待你不断写下新的一页</p>
      </section>
      <section className="panel profile-radar-panel"><div className="section-heading"><h2>知识兴趣雷达</h2><span className="profile-info-icon" title="根据所选兴趣、自述和导入摘要，呈现六个方向的兴趣关联。分值不代表知识水平或能力。"><CircleHelp size={16} aria-label="雷达显示兴趣关联，不代表能力评分" /></span></div><p className="profile-section-description">每一束好奇，都有自己的方向</p><Radar dimensions={profile.dimensions} large /><div className="profile-radar-legend"><span />你的兴趣分布{isSample && <small>· 体验数据</small>}</div><p className="profile-caption">仅呈现兴趣关联，不代表能力评分</p></section>
    </div>

    {profile.analysis.notice && <p className="profile-analysis-note"><CircleHelp size={15} />{profile.analysis.notice}</p>}

    <div className="profile-detail-grid">
      <section className="panel profile-interests-panel"><div className="section-heading"><h2>兴趣的线索</h2><span className="profile-count">{profile.interests.length} 个主题</span></div><p className="profile-section-description">从你主动分享的内容中，找到好奇心的落点</p>
        <div className="profile-interest-list">{profile.interests.map(interest => <div className="profile-interest-row" key={interest.id}><div><span>{interest.label}</span><small>{profile.input.topicIds.includes(interest.id) ? '主动选择' : '内容关联'}</small></div><div className="profile-interest-track" aria-hidden="true"><span style={{ width: `${Math.max(8, interest.weight / maxWeight * 100)}%` }} /></div></div>)}</div>
      </section>
      <section className="panel profile-preferences-panel"><div className="section-heading"><h2>让对话，舒服地发生</h2><Quote size={17} /></div><p className="profile-section-description">由你选择的交流方式与相遇期待</p><div className="profile-style-summary"><span>我喜欢</span><strong>{profile.style.label}</strong></div>
        <div className="profile-style-axes">{STYLE_AXES.map((axis, index) => <div key={axis}><span>{axis}</span><div aria-hidden="true"><i style={{ width: `${profile.style.values[index] || 0}%` }} /></div></div>)}</div>
        <p className="profile-goal-label">期待与伙伴一起</p><div className="tags">{GOALS.filter(goal => profile.input.goals.includes(goal.id)).map(goal => <span className="tag tag-purple" key={goal.id}>{goal.short}</span>)}</div>
        <div className="profile-question"><Quote size={16} /><p>{profile.input.question || '好问题，也可以从下一次对话开始。'}</p><span>{profile.input.question ? '一个我想聊的问题' : '还没有填写想聊的问题'}</span></div>
      </section>
    </div>

    <section className="panel profile-sources-panel"><div className="section-heading"><div><h2>这份画像，从何而来</h2><p className="profile-section-description">每一个解读，都有可以回看的线索</p></div><button className="button secondary" onClick={actions.onImport}><BookOpen size={15} />从知乎补充线索</button></div>
      <div className="profile-source-summary"><span><Check size={15} />{profile.input.topicIds.length} 个自选兴趣</span><span><PencilLine size={15} />{[profile.input.about, profile.input.question].filter(Boolean).length} 段主动填写</span><span><BookOpen size={15} />{imported} 条导入线索{isSample && '（示例）'}</span></div>
      <ul className="profile-evidence-list">{evidence.map(item => <EvidenceItem key={item.id} evidence={item} used={profile.evidenceIds.includes(item.id)} />)}</ul>
      {profile.evidence.length > 4 && <button className="text-button profile-evidence-toggle" onClick={() => setAllEvidence(value => !value)}>{allEvidence ? '收起依据' : `查看全部 ${profile.evidence.length} 条依据`}{allEvidence ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>}
      <div className="profile-source-footnote"><LockKeyhole size={14} /><p>{isSample ? '此处展示的是示例的分析依据。你的真实资料只会来自你主动选择、填写或授权导入的内容。' : '这些依据仅自己可见。知乎导入范围为你选择的公开标题、摘要与简介，可在设置中清除。'}</p></div>
    </section>

    {!isSample && <section className="profile-visibility-panel"><span className="profile-visibility-icon">{profile.discoverable ? <Eye size={22} /> : <LockKeyhole size={22} />}</span><div><h3>{profile.discoverable ? '你的知识名片已公开' : '你的知识名片目前仅向已连接伙伴分享'}</h3><p>{profile.discoverable ? '你的昵称、画像、自述、问题与交流偏好对真实参与者可见。关闭后会取消等待中的邀请，已建立的连接保留。' : '加入后，伙伴可查看昵称、兴趣画像、自述、问题与交流偏好。已建立连接的伙伴仍可查看公开资料，原始导入摘要仅自己可见。'}</p></div><button className={`button ${profile.discoverable ? 'secondary' : 'primary'}`} onClick={toggleVisibility} disabled={visibilityBusy}>{visibilityBusy ? <Spinner text="正在保存…" /> : profile.discoverable ? '隐藏公开名片' : '公开知识名片'}</button></section>}

    <div className="profile-endnote"><span>{!isSample && profile.updatedAt && !Number.isNaN(Date.parse(profile.updatedAt)) ? `最近更新于 ${formatTime(profile.updatedAt)}` : '每一次新的好奇，都会让这幅画像更丰富'}</span><button className="text-button" onClick={() => actions.navigate('pairing')}>去寻找同频的人<ArrowRight size={15} /></button></div>
  </div>;
}
