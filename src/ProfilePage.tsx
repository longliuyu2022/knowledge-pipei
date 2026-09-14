import { useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronUp, CircleHelp, Compass, Eye, FileText, Fingerprint, LockKeyhole, PencilLine, Quote, Sparkles } from 'lucide-react';
import { GOALS, STYLE_AXES } from '../shared/catalog.js';
import { personaFor } from '../shared/personas.js';
import { api, formatTime, messageOf } from './api';
import { Avatar, PageTitle, Radar, SourceBadge, Spinner } from './components';
import { PersonaExplorer } from './PersonaExplorer';
import { createPersonaCard, savePersonaCard } from './persona-card';
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
  const persona = personaFor(profile.input);
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
    try { savePersonaCard(await createPersonaCard(profile, isSample), isSample); actions.notify('知识人格卡已生成，已开始下载 PNG 图片。'); }
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
      <div className="profile-page-actions"><button className="button primary" onClick={() => actions.navigate('pairing')}>寻找同频伙伴<ArrowRight size={16}/></button>{!isSample && <button className="button secondary" onClick={actions.onShare}>分享人格卡</button>}<button className="button secondary" onClick={actions.onCreate}><PencilLine size={16}/>{isSample ? '创建我的人格' : '编辑人格'}</button></div>
    </PageTitle>

    {isSample && <div className="profile-sample-notice"><span><Compass size={18} /></span><div><strong>先看看，一份知识人格是什么模样</strong><p>下面是一份体验示例，不是对你的分析。选择自己的兴趣，就能生成你的专属画像。</p></div><button className="text-button" onClick={actions.onCreate}>从我的兴趣开始<ArrowRight size={15} /></button></div>}

    <div className="profile-overview">
      <section className="panel profile-persona">
        <div className="profile-persona-top"><div className="profile-persona-user"><Avatar name={profile.input.name} seed={isSample ? 'profile-example' : data.user.id} src={isSample ? undefined : data.user.avatar} size={48} /><div><strong>{profile.input.name}</strong><span>{isSample ? '体验示例' : '我的好奇心宇宙'}</span></div></div><SourceBadge mode={profile.analysis.mode} /></div>
        <p className="profile-persona-label">{persona ? '你的人格名片 · 12 种有趣的灵魂' : '你的知识探索者称号'}</p>
        <h2>{profile.title}<span aria-hidden="true">✧</span></h2>
        {persona && <p className="persona-quote">{persona.tagline}</p>}
        <p className="profile-persona-summary">{profile.summary}</p>
        {persona && <div className="tags">{persona.keywords.map(word => <span className="tag tag-purple" key={word}>{word}</span>)}</div>}
        <div className="tags">{profile.interests.slice(0, 5).map(interest => <span className="tag profile-persona-tag" key={interest.id}>{interest.label}</span>)}</div>
        <div className="profile-highlights">{profile.highlights.map((highlight, index) => <div key={`${index}-${highlight}`}><span>{index === 0 ? <BookOpen size={17} /> : <Sparkles size={17} />}</span><p>{highlight}</p></div>)}</div>
        <p className="profile-caption"><Fingerprint size={13} />兴趣的一个切面，等待你不断写下新的一页</p>
      </section>

    </div>

    {profile.analysis.notice && <p className="profile-analysis-note"><CircleHelp size={15} />{profile.analysis.notice}</p>}
    <details className="redesign-details" open={!persona}><summary>了解我的人格 · 优势与成长建议</summary><PersonaExplorer key={`${profile.input.personaDrive}-${profile.input.personaConnection}-${isSample}`} profile={profile} sample={isSample} onEdit={actions.onCreate}/></details>

    <details className="redesign-details"><summary>兴趣、交流偏好与来源依据</summary>      <section className="panel profile-radar-panel"><div className="section-heading"><h2>知识兴趣雷达</h2><span className="profile-info-icon" title="根据所选兴趣、自述和导入摘要，呈现六个方向的兴趣关联。分值不代表知识水平或能力。"><CircleHelp size={16} aria-label="雷达显示兴趣关联，不代表能力评分" /></span></div><p className="profile-section-description">每一束好奇，都有自己的方向</p><Radar dimensions={profile.dimensions} large /><div className="profile-radar-legend"><span />你的兴趣分布{isSample && <small>· 体验数据</small>}</div><p className="profile-caption">仅呈现兴趣关联，不代表能力评分</p></section><div className="profile-detail-grid">
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

    </details>
    <div className="profile-endnote"><span>{!isSample && profile.updatedAt && !Number.isNaN(Date.parse(profile.updatedAt)) ? `最近更新于 ${formatTime(profile.updatedAt)}` : '每一次新的好奇，都会让这幅画像更丰富'}</span><button className="text-button" onClick={() => actions.navigate('pairing')}>去寻找同频的人<ArrowRight size={15} /></button></div>
  </div>;
}
