import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, Check, ChevronDown, FileText, History, Lightbulb, ListChecks, RefreshCw, Sparkles, X } from 'lucide-react';
import { api, formatTime, messageOf } from '../../api';
import { Empty, PageTitle, Spinner } from '../../components';
import { ProfilePage } from '../../ProfilePage';
import type { Conversation, Interest, Invitation, PageActions } from '../../types';
import type { CircleMessage, CircleSummary } from '../../../shared/circles-types';
import type { CompanionMessage, CompanionSession } from '../companion/CompanionPage';

interface Report {
  revision: number; title: string; summary: string; updatedAt: string;
  coverage: { items: number; earliest: string | null; latest: string | null; notice: string };
  sections: { id: string; title: string; text: string; evidenceIds: string[] }[];
  interests: Interest[];
}
interface ReportState { report: Report | null; history: { revision: number; createdAt: string; title: string }[] }
interface Suggestion { id: string; text: string; sourceText: string; topicIds: string[]; status: string }
interface SuggestionsState { items: Suggestion[]; enabled: boolean }
type SourceType = 'conversation' | 'circle' | 'companion';
interface SourceOption { id: string; label: string }
interface OwnMessage { id: string; text: string; createdAt: string }
const sourceLabels: Record<SourceType, string> = { conversation: '伙伴私聊', circle: '同题讨论', companion: 'AI 陪伴' };
const uniqueMessages = (first: OwnMessage[], second: OwnMessage[]) => [...new Map([...first, ...second].map(message => [message.id, message])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export function KnowledgePage({ actions, version, onNavigate }: { actions: PageActions; version: number; onNavigate: (page: string) => void }) {
  const [tab, setTab] = useState<'report' | 'portrait' | 'suggestions'>('report');
  const [data, setData] = useState<ReportState | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<ReportState>('/knowledge/report', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setData(result); setError(''); } }).catch(cause => { if (!controller.signal.aborted) setError(messageOf(cause)); });
    return () => controller.abort();
  }, [version, reload]);
  const report = data?.report;
  return <div className="tz-feature" data-testid="knowledge-page">
    {tab !== 'portrait' && <PageTitle eyebrow="KNOWLEDGE, IN YOUR OWN WORDS" title="让每一次思考，留下线索" description="从你提供和确认的材料，整理此刻的兴趣与问题。"><button className="button secondary" onClick={actions.onCreate}><Sparkles size={15}/>{actions.data.profile ? '补充与修正' : '创建知识画像'}</button></PageTitle>}
    <div className="tz-tabs tz-page-tabs" role="group" aria-label="知识画像视图"><button className={tab === 'report' ? 'active' : ''} aria-pressed={tab === 'report'} onClick={() => setTab('report')}><BookOpen size={15}/>知识报告</button><button className={tab === 'portrait' ? 'active' : ''} aria-pressed={tab === 'portrait'} onClick={() => setTab('portrait')}><FileText size={15}/>人格与分享卡</button><button className={tab === 'suggestions' ? 'active' : ''} aria-pressed={tab === 'suggestions'} onClick={() => setTab('suggestions')}><ListChecks size={15}/>待确认知识</button></div>
    {tab === 'report' && <>{error && <div className="tz-error" role="alert">{error}<button className="text-button" onClick={() => setReload(value => value + 1)}>重新读取</button></div>}{!data && !error ? <Spinner text="正在整理知识线索…"/> : report ? <div className="tz-report-layout"><section className="tz-stack"><article className="tz-card tz-report-intro" data-testid="knowledge-report"><span className="tz-status">来自你已确认的材料</span><h2>{report.title}</h2><p>{report.summary}</p><div className="tz-coverage"><FileText size={17}/><div><strong>{report.coverage.items} 条材料</strong><span>{report.coverage.earliest && report.coverage.latest ? `${formatTime(report.coverage.earliest)} 至 ${formatTime(report.coverage.latest)}` : '当前可用的材料范围'}</span><p>{report.coverage.notice || '这份报告只描述当前材料中的兴趣线索，不能代表长期兴趣、知识水平或能力。'}</p></div></div><p className="tz-caption">最近更新于 {formatTime(report.updatedAt)} · 你可以随时补充和修正</p></article>{report.sections.map(section => {
      const evidence = (actions.data.profile?.evidence || []).filter(item => section.evidenceIds.includes(item.id));
      return <article className="tz-card tz-report-section" key={section.id}><h2>{section.title}</h2><p>{section.text}</p>{evidence.length > 0 && <details className="tz-evidence"><summary><ChevronDown size={14}/>查看依据 · {evidence.length} 条材料</summary>{evidence.map(item => <blockquote key={item.id}><strong>{item.label}</strong><p>{item.text}</p></blockquote>)}</details>}</article>;
    })}</section><aside className="tz-stack"><section className="tz-card"><h2><Lightbulb size={19}/>当前兴趣线索</h2><p className="tz-muted">反映这批材料的主题，不是能力分数。</p><div className="tz-interest-bars">{report.interests.map(interest => <div key={interest.id}><span>{interest.label}</span><div><i style={{ width: `${Math.max(4, Math.min(100, interest.weight <= 1 ? interest.weight * 100 : interest.weight))}%` }}/></div></div>)}</div><button className="text-button tz-top-gap" onClick={actions.onImport}>从知乎选择材料<ArrowUpRight size={14}/></button></section><section className="tz-card"><h2><History size={18}/>成长记录</h2>{data.history.length ? <ol className="tz-history">{data.history.slice(0, 8).map(item => <li key={item.revision}><span>{item.title}</span><small>{formatTime(item.createdAt)} · 第 {item.revision} 次记录</small></li>)}</ol> : <p className="tz-muted">确认新的知识后，这里会留下画像更新记录。</p>}<button className="text-button tz-top-gap" onClick={() => setTab('suggestions')}>整理我的发言<ArrowUpRight size={14}/></button></section></aside></div> : !error && <section className="tz-card"><Empty title="你的知识画像，从真实的材料开始" text="选择兴趣、写下正在想的问题，或连接知乎后选择自己的内容。材料不足时，我们会如实说明。" action="创建知识画像" onAction={actions.onCreate}/><div className="tz-empty-actions"><button className="text-button" onClick={actions.onImport}>从知乎导入内容<ArrowUpRight size={14}/></button><button className="text-button" onClick={() => onNavigate('discover')}>先参加一个问题讨论<ArrowUpRight size={14}/></button></div></section>}</>}
    {tab === 'portrait' && (actions.data.profile ? <ProfilePage actions={actions}/> : <section className="tz-card"><Empty title="先留下自己的兴趣与问题" text="你确认后才会生成个人画像与分享卡。" action="创建知识画像" onAction={actions.onCreate}/></section>)}
    {tab === 'suggestions' && <SuggestionsPanel actions={actions} version={version} onNavigate={onNavigate}/>}
  </div>;
}

function SuggestionsPanel({ actions, version, onNavigate }: { actions: PageActions; version: number; onNavigate: (page: string) => void }) {
  const [data, setData] = useState<SuggestionsState | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [sourceType, setSourceType] = useState<SourceType>('conversation'), [sourceId, setSourceId] = useState('');
  const [sources, setSources] = useState<SourceOption[]>([]), [sourceLoading, setSourceLoading] = useState(false), [sourceError, setSourceError] = useState('');
  const [messages, setMessages] = useState<OwnMessage[]>([]), [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null), [messageLoading, setMessageLoading] = useState(false), [messagesLoaded, setMessagesLoaded] = useState(false);
  const [busy, setBusy] = useState('');
  const alive = useRef(true), lock = useRef(false), messageSequence = useRef(0), loadController = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; messageSequence.current++; loadController.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<SuggestionsState>('/knowledge/suggestions', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setData(result); setError(''); } }).catch(cause => { if (!controller.signal.aborted) setError(messageOf(cause)); });
    return () => controller.abort();
  }, [version, reload]);
  useEffect(() => {
    const controller = new AbortController(); setSourceLoading(true); setSources([]); setSourceId(''); setSourceError('');
    async function load() {
      if (sourceType === 'conversation') { const result = await api<{ invitations: Invitation[] }>('/connections', { signal: controller.signal }); return result.invitations.filter(item => item.status === 'accepted').map(item => ({ id: item.id, label: `与 ${item.person.name} 的对话` })); }
      if (sourceType === 'circle') { const result = await api<{ circles: CircleSummary[] }>('/circles?mine=1', { signal: controller.signal }); return result.circles.map(item => ({ id: item.id, label: item.title })); }
      const result = await api<{ items: CompanionSession[] }>('/companion/sessions', { signal: controller.signal }); return result.items.map(item => ({ id: item.id, label: item.title || '与 AI 的对话' }));
    }
    void load().then(items => { if (!controller.signal.aborted) setSources(items); }).catch(cause => { if (!controller.signal.aborted) setSourceError(messageOf(cause)); }).finally(() => { if (!controller.signal.aborted) setSourceLoading(false); });
    return () => controller.abort();
  }, [sourceType]);
  useEffect(() => {
    loadController.current?.abort(); messageSequence.current++; setMessages([]); setSelectedIds([]); setNextBefore(null); setMessagesLoaded(false); setMessageLoading(false);
  }, [sourceId, sourceType]);

  async function loadMessages(before?: string) {
    if (!sourceId || messageLoading) return;
    loadController.current?.abort(); const controller = new AbortController(), sequence = ++messageSequence.current; loadController.current = controller;
    setMessageLoading(true); setSourceError('');
    try {
      const suffix = before ? `?before=${encodeURIComponent(before)}` : '';
      let own: OwnMessage[], next: string | null = null;
      if (sourceType === 'conversation') {
        const result = await api<Conversation>(`/conversations/${encodeURIComponent(sourceId)}${suffix}`, { signal: controller.signal });
        own = result.items.filter(item => item.authorId === actions.data.user.id); next = result.hasMore ? result.nextBefore : null;
      } else if (sourceType === 'circle') {
        const result = await api<{ messages: CircleMessage[]; hasMore: boolean; nextBefore: string | null }>(`/circles/${encodeURIComponent(sourceId)}/messages${suffix}`, { signal: controller.signal });
        own = result.messages.filter(item => item.kind === 'human' && item.authorId === actions.data.user.id && !item.hidden && !item.redacted); next = result.hasMore ? result.nextBefore : null;
      } else {
        const result = await api<{ messages: CompanionMessage[] }>(`/companion/sessions/${encodeURIComponent(sourceId)}`, { signal: controller.signal });
        own = result.messages.filter(item => item.role === 'user');
      }
      if (!controller.signal.aborted && sequence === messageSequence.current) { setMessages(previous => before ? uniqueMessages(previous, own) : own); setNextBefore(next); setMessagesLoaded(true); }
    } catch (cause) { if (!controller.signal.aborted && sequence === messageSequence.current) setSourceError(messageOf(cause)); }
    finally { if (!controller.signal.aborted && sequence === messageSequence.current) setMessageLoading(false); }
  }
  async function mutate(id: string, job: () => Promise<unknown>, success: string) {
    if (lock.current) return;
    lock.current = true; setBusy(id); setError('');
    try { const result = await job(); if (!alive.current) return; setReload(value => value + 1); if (id === 'generate') setSelectedIds([]); actions.notify(result && typeof result === 'object' && 'notice' in result && typeof result.notice === 'string' ? result.notice : success); if (id.startsWith('accept:')) await actions.refresh(); }
    catch (cause) { if (alive.current) setError(messageOf(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  const pending = data?.items.filter(item => item.status === 'pending') || [];
  return <div className="tz-two-column" data-testid="knowledge-suggestions"><section className="tz-card"><div className="tz-section-heading"><h2><Sparkles size={18}/>从自己的发言中找线索</h2><button className="icon-button" aria-label="刷新知识建议" onClick={() => setReload(value => value + 1)}><RefreshCw size={16}/></button></div><p className="tz-muted">逐条选择你想保留的本人发言。系统整理出建议后，仍需要你确认，才会加入知识画像。</p>
    {data && !data.enabled && <div className="tz-info tz-top-gap"><div><p>你尚未开启“从我的发言中整理知识”。</p><button className="text-button" onClick={() => onNavigate('account')}>前往账号偏好设置<ArrowUpRight size={14}/></button></div></div>}
    <div className="tz-form tz-top-gap"><label>发言来自哪里<select data-testid="knowledge-source-type" value={sourceType} disabled={Boolean(busy)} onChange={event => setSourceType(event.target.value as SourceType)}>{Object.entries(sourceLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>选择一段对话<select data-testid="knowledge-source" value={sourceId} disabled={sourceLoading || Boolean(busy)} onChange={event => setSourceId(event.target.value)}><option value="">{sourceLoading ? '正在读取…' : sources.length ? '请选择' : '还没有可选择的对话'}</option>{sources.map(source => <option value={source.id} key={source.id}>{source.label}</option>)}</select></label><button className="button secondary" onClick={() => void loadMessages()} disabled={!sourceId || messageLoading || Boolean(busy)} data-testid="knowledge-load-messages">{messageLoading ? <Spinner text="正在读取…"/> : '查看我的发言'}</button></div>
    {sourceError && <p className="tz-error tz-top-gap" role="alert">{sourceError}</p>}
    {messagesLoaded && <div className="tz-own-messages">{messages.length ? <><p className="tz-caption">已选 {selectedIds.length} 条 · 每次最多 10 条</p>{messages.map(item => <label key={item.id} className="tz-select-message"><input type="checkbox" data-testid="knowledge-message-select" checked={selectedIds.includes(item.id)} disabled={Boolean(busy) || (!selectedIds.includes(item.id) && selectedIds.length >= 10)} onChange={event => setSelectedIds(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))}/><span><p>{item.text}</p><time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time></span></label>)}</> : <p className="tz-caption">这页还没有可选择的本人发言。</p>}{nextBefore && <button className="text-button tz-top-gap" disabled={messageLoading || Boolean(busy)} onClick={() => void loadMessages(nextBefore)}>查看更早的发言<ChevronDown size={14}/></button>}</div>}
    {selectedIds.length > 0 && <div className="tz-top-gap"><p className="tz-caption">仅使用勾选的本人发言。若已开启 AI 画像分析，选中内容会发送到本站配置的模型；建议仍需你确认。</p><button className="button primary tz-top-gap" data-testid="knowledge-generate" disabled={!data?.enabled || Boolean(busy)} onClick={() => void mutate('generate', () => api('/knowledge/suggestions', { method: 'POST', json: { sourceType, sourceId, messageIds: selectedIds } }), '已整理成待确认建议，请逐条查看。')}>{busy === 'generate' ? <Spinner text="正在整理…"/> : <><Sparkles size={16}/>整理 {selectedIds.length} 条发言</>}</button></div>}
    </section><section className="tz-card"><h2><ListChecks size={19}/>由你确认，再成为知识</h2>{error && <p className="tz-error tz-top-gap" role="alert">{error}</p>}{!data && !error ? <Spinner text="正在读取建议…"/> : pending.length ? <ul className="tz-suggestion-list">{pending.map(item => <li key={item.id} data-testid="knowledge-suggestion"><p>{item.text}</p><details className="tz-evidence"><summary>查看原始发言</summary><blockquote>{item.sourceText}</blockquote></details><div className="tz-actions"><button className="button secondary" data-testid="knowledge-accept" disabled={Boolean(busy) || !actions.data.profile} onClick={() => void mutate(`accept:${item.id}`, () => api(`/knowledge/suggestions/${encodeURIComponent(item.id)}/accept`, { method: 'POST', json: { revision: actions.data.profile!.revision } }), '已确认并加入你的知识画像。')}><Check size={15}/>确认加入画像</button><button className="text-button" disabled={Boolean(busy)} onClick={() => void mutate(`dismiss:${item.id}`, () => api(`/knowledge/suggestions/${encodeURIComponent(item.id)}/dismiss`, { method: 'POST', json: {} }), '这条建议已忽略。')}><X size={14}/>忽略</button></div></li>)}</ul> : <Empty title="收获，等你亲自确认" text="选择自己的发言并整理后，待确认的建议会出现在这里。"/>}{!actions.data.profile && <button className="text-button" onClick={actions.onCreate}>先创建知识画像<ArrowUpRight size={14}/></button>}</section></div>;
}
