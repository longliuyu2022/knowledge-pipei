import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, MessageCircle, Plus, Sparkles } from 'lucide-react';
import { api, messageOf } from './api';
import { SourceBadge, Spinner } from './components';
import type { ConversationContext, Icebreakers } from './types';

interface ConversationStarterProps {
  conversationId: string;
  onUseQuestion: (question: string) => boolean;
}

function validQuestions(questions: string[]) {
  return Array.isArray(questions) && questions.length === 3 && questions.every(question => typeof question === 'string' && question.trim());
}

function sourceLink(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}

export function ConversationStarter({ conversationId, onUseQuestion }: ConversationStarterProps) {
  const [context, setContext] = useState<ConversationContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [inspiration, setInspiration] = useState<Icebreakers | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [expanded, setExpanded] = useState(true);
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const bodyId = useId();
  const generationRequest = useRef<AbortController | null>(null);
  const generationLock = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    generationRequest.current?.abort(); generationLock.current = false;
    setLoading(true); setLoadError(''); setContext(null); setInspiration(null);
    setGenerating(false); setGenerationError(''); setNotice('');
    void api<ConversationContext>(`/conversations/${encodeURIComponent(conversationId)}/context`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    }).then(result => {
      if (controller.signal.aborted) return;
      if (!validQuestions(result.questions)) throw new Error('话题暂时没有完整载入，可以重试。');
      setContext(result);
    }).catch(error => { if (!controller.signal.aborted) setLoadError(messageOf(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); generationRequest.current?.abort(); };
  }, [conversationId, attempt]);

  async function generate() {
    if (!context || generationLock.current) return;
    const controller = new AbortController(); generationRequest.current = controller; generationLock.current = true;
    setGenerating(true); setGenerationError(''); setNotice('');
    try {
      const result = await api<Icebreakers>(`/conversations/${encodeURIComponent(conversationId)}/icebreakers`, {
        method: 'POST', json: {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(80000)]),
      });
      if (controller.signal.aborted) return;
      if (!validQuestions(result.questions)) throw new Error('这次灵感没有完整生成，可以继续使用当前话题。');
      setInspiration(result);
    } catch (error) {
      if (!controller.signal.aborted) setGenerationError(messageOf(error));
    } finally {
      if (generationRequest.current === controller) {
        generationLock.current = false;
        if (!controller.signal.aborted) setGenerating(false);
      }
    }
  }

  function useQuestion(question: string) {
    const added = onUseQuestion(question);
    setNoticeError(!added);
    setNotice(added ? '已加入草稿，编辑后发送。' : '草稿最多 2000 字，请先整理内容，再加入这个话题。');
    if (added) setExpanded(false);
  }

  const questions = inspiration?.questions || context?.questions || [];
  return <section className="conversation-starter" data-testid="conversation-starter" data-conversation-id={conversationId} data-mode={inspiration?.mode || 'rules'} aria-label="共同兴趣与聊天话题" aria-busy={loading || generating}>
    <div className="conversation-starter-heading"><button type="button" className="conversation-starter-toggle" data-testid="conversation-starter-toggle" aria-expanded={expanded} aria-controls={bodyId} aria-label={expanded ? '收起聊天话题' : '展开聊天话题'} onClick={() => setExpanded(value => !value)}><MessageCircle size={15}/><strong>从共同的好奇心聊起</strong><ChevronDown size={15} className={expanded ? 'is-expanded' : ''}/></button>{context && <SourceBadge mode={inspiration?.mode || context.mode}/>}</div>
    {notice && <p className={`conversation-starter-notice ${noticeError ? 'is-error' : ''}`} data-testid="conversation-starter-notice" role="status">{notice}</p>}
    <div className="conversation-starter-body" id={bodyId} hidden={!expanded}>
      {loading && <div className="conversation-starter-loading"><Spinner text="正在整理你们的聊天起点…"/></div>}
      {loadError && <div className="conversation-starter-error" data-testid="conversation-starter-error" role="alert"><p>{loadError} 你们可以继续正常聊天。</p><button type="button" className="text-button" data-testid="conversation-starter-retry" onClick={() => setAttempt(value => value + 1)}>重试读取话题</button></div>}
      {context && <>
        <div className="conversation-starter-shared" data-testid="conversation-starter-shared"><span>共同兴趣</span>{context.shared.length ? context.shared.map(topic => <span className="tag tag-purple" key={topic.id} data-topic-id={topic.id}>{topic.label}</span>) : <p>具体兴趣暂未重合，可以交换各自的新发现。</p>}</div>
        <p className="conversation-starter-hint">点击话题加入草稿，保留已写内容，由你编辑后发送。</p>
        <ol className="conversation-starter-questions" data-testid="conversation-starter-questions">{questions.map((question, index) => <li key={`${index}:${question}`}><button type="button" data-testid="conversation-starter-question" onClick={() => useQuestion(question)} aria-label={`加入草稿：${question}`}><span>{String(index + 1).padStart(2, '0')}</span><span>{question}</span><Plus size={14}/></button></li>)}</ol>
        {generationError && <p className="conversation-starter-error" data-testid="conversation-starter-generation-error" role="alert">{generationError} 当前话题和草稿已保留。</p>}
        {inspiration?.notice && <p className="conversation-starter-service-note">{inspiration.notice}</p>}
        {inspiration?.sourceNotice && <p className="conversation-starter-service-note">{inspiration.sourceNotice}</p>}
        <div className="conversation-starter-tools"><button type="button" className="text-button" data-testid="conversation-starter-generate" disabled={generating} onClick={() => void generate()}>{generating ? <Spinner text="正在寻找更多灵感…"/> : <><Sparkles size={14}/>生成更多灵感</>}</button>{context.reasons.length > 0 && <details className="conversation-starter-reasons"><summary>为什么聊这些</summary><ul>{context.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>}</div>
        {inspiration && inspiration.sources.length > 0 && <details className="conversation-starter-sources"><summary>参考阅读 · {inspiration.sources.length} 条</summary><ul>{inspiration.sources.map(source => <li key={source.id}>{sourceLink(source.url) ? <a href={sourceLink(source.url)} target="_blank" rel="noopener noreferrer">{source.title}<ArrowUpRight size={12}/></a> : <span>{source.title}</span>}</li>)}</ul></details>}
      </>}
    </div>
  </section>;
}
