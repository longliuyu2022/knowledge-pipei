import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Bookmark, Check, Copy, Lightbulb, MessageCircle, Send, ShieldOff, Sparkles } from 'lucide-react';
import { GOALS } from '../shared/catalog';
import { api, copyText, messageOf } from './api';
import { Avatar, Dialog, Radar, SourceBadge, Spinner } from './components';
import type { Explanation, Icebreakers, Invitation, Match, PageActions } from './types';
import './connections.css';

type MatchDialogProps = { match: Match; actions: PageActions; onClose: () => void };

const breakdownDescriptions: Record<string, string> = {
  topic: '双方在知识领域上的接近程度',
  interest: '具体兴趣的加权重合程度',
  anchor: '可以作为对话起点的共同兴趣',
  perspective: '共同话题之外，可以交换的不同视角',
  style: '双方主动选择的交流节奏接近程度',
  goal: '深度交流、共同学习等期待的重合程度',
};
const icebreakerLabels = ['轻松开场', '深入一点', '一起行动'];
const bounded = (value: number) => Math.max(0, Math.min(100, value));
function sourceLink(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}

export function MatchDialog(props: MatchDialogProps) {
  return <MatchDialogContent key={`${props.match.id}:${props.match.matchingMode}`} {...props}/>;
}

function MatchDialogContent({ match, actions, onClose }: MatchDialogProps) {
  const own = actions.data.profile || actions.data.sampleProfile;
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [explaining, setExplaining] = useState(true);
  const [explainError, setExplainError] = useState('');
  const [explainAttempt, setExplainAttempt] = useState(0);
  const [icebreakers, setIcebreakers] = useState<Icebreakers | null>(null);
  const [iceLoading, setIceLoading] = useState(false);
  const [iceError, setIceError] = useState('');
  const [copied, setCopied] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [relation, setRelation] = useState<Invitation | null>(null);
  const [relationLoading, setRelationLoading] = useState(!match.demo);
  const [relationError, setRelationError] = useState('');
  const [relationAttempt, setRelationAttempt] = useState(0);
  const [draft, setDraft] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [blockError, setBlockError] = useState('');
  const alive = useRef(true);
  const iceRequest = useRef<AbortController | null>(null);
  const iceLock = useRef(false), saveLock = useRef(false), actionLock = useRef(false);
  const saved = actions.data.savedIds.includes(match.id);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; iceRequest.current?.abort(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setExplaining(true); setExplainError(''); setExplanation(null);
    void api<Explanation>(`/people/${encodeURIComponent(match.id)}/explain`, {
      method: 'POST', json: { mode: match.matchingMode },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(80000)]),
    }).then(result => { if (!controller.signal.aborted) setExplanation(result); })
      .catch(error => { if (!controller.signal.aborted) setExplainError(messageOf(error)); })
      .finally(() => { if (!controller.signal.aborted) setExplaining(false); });
    return () => controller.abort();
  }, [match.id, match.matchingMode, own.revision, explainAttempt]);

  useEffect(() => {
    if (match.demo) return;
    const controller = new AbortController();
    setRelationLoading(true);
    void api<{ invitations: Invitation[] }>('/connections', {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    }).then(result => {
      if (controller.signal.aborted) return;
      setRelation(result.invitations.find(item => item.person.id === match.id) || null);
      setRelationError('');
    }).catch(error => { if (!controller.signal.aborted) setRelationError(messageOf(error)); })
      .finally(() => { if (!controller.signal.aborted) setRelationLoading(false); });
    return () => controller.abort();
  }, [match.id, match.demo, actions.data, relationAttempt]);

  async function generateIcebreakers() {
    if (iceLock.current) return;
    iceLock.current = true;
    const controller = new AbortController(); iceRequest.current = controller;
    setIceLoading(true); setIceError(''); setCopied(null);
    try {
      const result = await api<Icebreakers>(`/people/${encodeURIComponent(match.id)}/icebreakers`, {
        method: 'POST', json: {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(80000)]),
      });
      if (!controller.signal.aborted) setIcebreakers(result);
    } catch (error) {
      if (!controller.signal.aborted) setIceError(messageOf(error));
    } finally {
      iceLock.current = false;
      if (alive.current && !controller.signal.aborted) setIceLoading(false);
    }
  }

  async function save() {
    if (saveLock.current || actionLock.current) return;
    saveLock.current = true; setSaving(true);
    try { await actions.onSave({ ...match, saved }); }
    catch (error) { actions.notify(messageOf(error), true); }
    finally { saveLock.current = false; if (alive.current) setSaving(false); }
  }

  async function copyQuestion(question: string, index: number) {
    try { await copyText(question); if (alive.current) setCopied(index); }
    catch (error) { actions.notify(messageOf(error), true); }
  }

  async function refreshAfterMutation() {
    try { await actions.refresh(); }
    catch { actions.notify('操作已完成，页面状态暂未刷新，可稍后重新打开查看。', true); }
  }

  async function sendInvitation() {
    const profile = actions.data.profile;
    const message = draft.trim();
    if (actionLock.current || saveLock.current || relationLoading || match.demo || !profile || relation || sent) return;
    if (message.length < 2) { setInviteError('写下至少 2 个字，让对方知道你想聊什么。'); return; }
    actionLock.current = true; setInviteBusy(true); setInviteError('');
    let visibilityChanged = false;
    try {
      if (!profile.discoverable) {
        await api('/profile/visibility', { method: 'POST', json: { discoverable: true, revision: profile.revision } });
        visibilityChanged = true;
      }
      await api('/invitations', { method: 'POST', json: { targetId: match.id, message } });
      if (alive.current) { setSent(message); setDraft(''); }
      actions.notify('邀请已发送，等待对方接受。');
      await refreshAfterMutation();
    } catch (error) {
      if (alive.current) { setInviteError(messageOf(error)); setRelationAttempt(value => value + 1); }
      if (visibilityChanged) await refreshAfterMutation();
    } finally {
      actionLock.current = false;
      if (alive.current) setInviteBusy(false);
    }
  }

  async function block() {
    if (actionLock.current || saveLock.current) return;
    actionLock.current = true; setBlockBusy(true); setBlockError('');
    try {
      await api(`/blocked/${encodeURIComponent(match.id)}`, { method: 'POST', json: {} });
      actions.notify(`已屏蔽 ${match.name}`);
      await refreshAfterMutation();
      onClose();
    } catch (error) { if (alive.current) setBlockError(messageOf(error)); }
    finally { actionLock.current = false; if (alive.current) setBlockBusy(false); }
  }

  function openConnections() { onClose(); actions.navigate('connections'); }
  function createProfile() { onClose(); actions.onCreate(); }
  const reasons = explanation?.reasons || match.reasons;
  const inviteFinished = sent !== null || relation !== null;

  return <Dialog title={match.matchingMode === 'complement' ? '不一样的视角，也可以同频' : '你们为什么同频'} onClose={onClose} wide busy={inviteBusy || blockBusy} className="match-detail-dialog">
    <div className="match-detail-body">
      <div className="match-detail-person">
        <Avatar name={match.name} seed={match.id} src={match.avatar} size={68}/>
        <div className="match-detail-identity"><div className="match-detail-name"><h3>{match.name}</h3><span className={`tag ${match.demo ? '' : 'tag-purple'}`}>{match.demo ? '虚构体验人物' : match.provider === 'zhihu' ? '知乎已连接' : '真实参与者'}</span></div><p>{match.title}</p></div>
        <div className="match-detail-score"><strong>{match.score}<span>°</span></strong><span>{match.matchingMode === 'complement' ? '互补指数' : '同频指数'}</span></div>
      </div>
      <p className="match-detail-about">{match.about || match.summary}</p>
      <div className="match-detail-preferences"><span><MessageCircle size={14}/>{match.style.label}</span>{match.goals.map(goal => <span key={goal}>{GOALS.find(item => item.id === goal)?.short || goal}</span>)}</div>

      {!actions.data.profile && <div className="connection-notice"><Lightbulb size={17}/><div><strong>现在看到的是与你的示例画像的比较</strong><p>生成自己的知识人格，看看哪些好奇心真正与你相遇。</p></div><button className="text-button" onClick={createProfile}>生成我的画像<ArrowUpRight size={15}/></button></div>}
      {match.demo && <p className="match-demo-note">这是一位用于体验匹配的虚构人物。你可以收藏、查看分析和练习破冰，体验人物不能接收邀请。</p>}

      <section className="match-detail-section">
        <div className="connection-section-title"><h3>好奇心交汇的地方</h3><span>{match.shared.length} 个共同兴趣</span></div>
        {match.shared.length ? <div className="tags">{match.shared.map(topic => <span key={topic.id} className="tag tag-purple">{topic.label}</span>)}</div> : <p className="muted">暂时没有重合的具体兴趣，也可以从彼此的新发现聊起。</p>}
        {match.newTopics.length > 0 && <p className="match-new-perspectives">TA 还可以带来<span>{match.newTopics.map(topic => topic.label).join('、')}</span>的视角。</p>}
      </section>

      <section className="match-explanation match-detail-section" aria-busy={explaining}>
        <div className="connection-section-title"><h3><Sparkles size={17}/>你们的连接线索</h3><SourceBadge mode={explanation?.mode || 'rules'}/></div>
        {explaining && <div className="match-explain-loading"><Spinner text="正在结合双方画像，展开连接线索…"/><p>下面先展示基于兴趣和交流偏好的规则分析。</p></div>}
        {explainError && <div className="connection-error" role="alert"><p>{explainError} 当前保留规则分析。</p><button className="text-button" onClick={() => setExplainAttempt(value => value + 1)}>重新解读</button></div>}
        <ol className="match-reasons">{reasons.map((reason, index) => <li key={`${index}:${reason}`}><span>{String(index + 1).padStart(2, '0')}</span><p>{reason}</p></li>)}</ol>
        {explanation?.bridge && <blockquote className="match-bridge"><Lightbulb size={17}/><p>{explanation.bridge}</p></blockquote>}
        {explanation?.notice && <p className="connection-service-note">{explanation.notice}</p>}
      </section>

      <div className="match-detail-comparison">
        <section className="match-radar-panel"><h3>知识兴趣的形状</h3><Radar dimensions={own.dimensions} comparison={match.dimensions}/><div className="match-radar-legend"><span><i/>{actions.data.profile ? '你' : '示例画像'}</span><span><i/>{match.name}</span></div><p>记录兴趣倾向，不衡量知识水平。</p></section>
        <section className="match-breakdown-panel"><h3>每一度同频，都有依据</h3><div className="match-breakdown">{match.breakdown.map(item => <div className="match-breakdown-item" key={item.id}><div><span>{item.label}<small>权重 {item.weight}%</small></span><strong>{item.value}<small>/100</small></strong></div><div className="match-meter" role="meter" aria-label={item.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={bounded(item.value)}><span style={{ width: `${bounded(item.value)}%` }}/></div><p>{item.id === 'topic' && match.algorithm === 'embedding' ? '自述与兴趣文本的语义接近程度' : breakdownDescriptions[item.id]}</p></div>)}</div></section>
      </div>
      <p className="match-score-note">指数根据双方的兴趣、交流方式和期待加权计算，不代表关系成功概率。{match.algorithm === 'embedding' ? '本次知识领域比较使用语义向量。' : '本次知识领域比较使用知识主题向量。'}</p>

      <section className="match-icebreakers match-detail-section" aria-busy={iceLoading}>
        <div className="connection-section-title"><h3><MessageCircle size={17}/>第一句，从好奇心开始</h3>{icebreakers && <SourceBadge mode={icebreakers.mode}/>}</div>
        {!icebreakers && <p className="match-section-intro">围绕双方的兴趣，找一个轻松、具体的开场。准备好之后，由你决定要不要说。</p>}
        {iceError && <div className="connection-error" role="alert"><p>{iceError}</p></div>}
        {icebreakers && <>
          <div className="icebreaker-list">{icebreakers.questions.map((question, index) => <article className="icebreaker-card" key={`${index}:${question}`}><div><span className="icebreaker-kind">{icebreakerLabels[index] || '对话灵感'}</span><button className="text-button" onClick={() => void copyQuestion(question, index)} aria-label={`复制${icebreakerLabels[index] || '破冰问题'}`}>{copied === index ? <><Check size={14}/>已复制</> : <><Copy size={14}/>复制</>}</button></div><p>{question}</p></article>)}</div>
          {icebreakers.notice && <p className="connection-service-note">{icebreakers.notice}</p>}
          {icebreakers.sourceNotice && <p className="connection-service-note">{icebreakers.sourceNotice}</p>}
          {icebreakers.sources.length > 0 && <div className="icebreaker-sources"><h4>从这些知乎内容继续探索</h4><p className="muted">以下为搜索摘要，完整内容请查看原文。</p>{icebreakers.sources.map(source => <article className="icebreaker-source" key={source.id}><div><span className="source-badge">{source.scope || '搜索摘要'}</span>{icebreakers.sourceIds.includes(source.id) && <span className="icebreaker-source-used">本次破冰参考</span>}</div><h5>{source.title}</h5><p>{source.summary || '搜索结果没有提供摘要，可打开原文了解内容。'}</p><div className="icebreaker-source-footer"><span>{source.author || '作者未提供'}</span>{sourceLink(source.url) && <a className="text-button" href={sourceLink(source.url)} target="_blank" rel="noopener noreferrer">查看原文<ArrowUpRight size={14}/></a>}</div></article>)}</div>}
        </>}
        <button className="button secondary icebreaker-generate" onClick={() => void generateIcebreakers()} disabled={iceLoading || inviteBusy || blockBusy}>{iceLoading ? <Spinner text="正在寻找适合你们的开场…"/> : <><Sparkles size={16}/>{icebreakers ? '重新生成破冰问题' : iceError ? '重试生成破冰问题' : '生成破冰问题'}</>}</button>
      </section>

      {!match.demo && <section className="match-invitation match-detail-section">
        <div className="connection-section-title"><h3>让一句问候，成为连接的开始</h3><Send size={17}/></div>
        {relationError && <div className="connection-error" role="alert"><p>邀请状态读取失败：{relationError}</p><button className="text-button" onClick={() => setRelationAttempt(value => value + 1)} disabled={relationLoading}>重试读取</button></div>}
        {inviteFinished ? <div className="invitation-success" role="status"><span><Check size={19}/></span><div><h4>{relation?.status === 'accepted' ? '你们已经建立连接' : relation?.direction === 'incoming' ? '这位伙伴向你发来了邀请' : '邀请已发出，等待对方接受'}</h4><p>{relation?.status === 'accepted' ? '前往「我的连接」，继续你们的真实对话。' : relation?.direction === 'incoming' ? '前往「我的连接」查看内容，由你决定是否接受。' : '只有对方接受后，才能开始双人对话。'}</p>{sent && <blockquote>{sent}</blockquote>}<button className="text-button" onClick={openConnections}>查看我的连接<ArrowUpRight size={15}/></button></div></div> : !actions.data.profile ? <div className="match-invitation-create"><p>先生成自己的知识人格，让对方知道你是谁、想聊什么。</p><button className="button primary" onClick={createProfile}>生成我的画像<ArrowUpRight size={16}/></button></div> : <form onSubmit={event => { event.preventDefault(); void sendInvitation(); }}>
          <label className="field" htmlFor="match-invitation-message"><span>你想和 {match.name} 聊什么？</span><textarea id="match-invitation-message" value={draft} onChange={event => setDraft(event.target.value)} maxLength={500} minLength={2} required rows={3} placeholder="从一个共同兴趣，或一个你正好在想的问题开始…" disabled={inviteBusy || blockBusy}/></label>
          <div className="match-draft-meta"><span>邀请只会发送给这位伙伴</span><span>{draft.length}/500</span></div>
          {!actions.data.profile.discoverable && <p className="match-visibility-note">发送邀请需要加入真实匹配。加入后，参与者可看到你的昵称、知识画像和交流期待。</p>}
          {inviteError && <p className="form-error" role="alert">{inviteError}</p>}
          <button className="button primary" type="submit" disabled={inviteBusy || blockBusy || saving || relationLoading || draft.trim().length < 2}>{inviteBusy ? <Spinner text="正在发送邀请…"/> : relationLoading ? <Spinner text="正在读取邀请状态…"/> : <><Send size={16}/>{actions.data.profile.discoverable ? '发送连接邀请' : '加入匹配并发送邀请'}</>}</button>
        </form>}
        {inviteError && inviteFinished && <p className="form-error" role="alert">{inviteError}</p>}
      </section>}

      <div className="match-detail-footer"><button className={`button ${saved ? 'secondary' : 'primary'}`} onClick={() => void save()} disabled={saving || inviteBusy || blockBusy}>{saving ? <Spinner text="正在保存…"/> : <><Bookmark size={16} fill={saved ? 'currentColor' : 'none'}/>{saved ? '已收藏 · 取消收藏' : '收藏这位伙伴'}</>}</button><button className="text-button match-block-link" onClick={() => setConfirmBlock(value => !value)} disabled={inviteBusy || blockBusy || saving}><ShieldOff size={14}/>屏蔽这位伙伴</button></div>
      {confirmBlock && <div className="connection-block-confirm"><h4>屏蔽 {match.name}？</h4><p>屏蔽后将不再互相发现，这位伙伴会从收藏和连接中移除，当前邀请与对话会结束。</p>{blockError && <p className="form-error" role="alert">{blockError}</p>}<div><button className="button secondary" disabled={blockBusy} onClick={() => setConfirmBlock(false)}>再想想</button><button className="button secondary connection-danger" disabled={blockBusy || saving} onClick={() => void block()}>{blockBusy ? <Spinner text="正在屏蔽…"/> : '确认屏蔽'}</button></div></div>}
    </div>
  </Dialog>;
}
