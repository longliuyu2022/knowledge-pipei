import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Bookmark, Check, ChevronRight, Clock3, Flag, Inbox, MessageCircle, RefreshCw, Send, ShieldOff, UserRoundCheck } from 'lucide-react';
import { api, APIError, formatTime, messageOf } from './api';
import { Avatar, Dialog, Empty, MatchCard, PageTitle, Spinner } from './components';
import { ConversationStarter } from './ConversationStarter';
import { ReportDialog } from './features/account/ReportDialog';
import type { Conversation, Invitation, Match, Message, PageActions, Person } from './types';
import './connections.css';

interface ConnectionsData { saved: Match[]; invitations: Invitation[] }
type ConnectionTab = 'saved' | 'invitations' | 'conversations';
type InvitationFilter = 'all' | 'incoming' | 'outgoing';
type RespondAction = 'accept' | 'decline';
const emptyMessages: Message[] = [];
const requestSignal = (controller: AbortController) => AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);

function mergeMessages(first: Message[], second: Message[]) {
  return [...new Map([...first, ...second].map(item => [item.id, item])).values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

interface ConnectionsProps {
  actions: PageActions;
  version: number;
  requestedConversationId?: string;
  onConversationOpened?: () => void;
}

export function ConnectionsPage(props: ConnectionsProps) {
  return <ConnectionsContent key={props.actions.data.user.id} {...props}/>;
}

function ConnectionsContent({ actions, version, requestedConversationId, onConversationOpened }: ConnectionsProps) {
  const [tab, setTab] = useState<ConnectionTab>(requestedConversationId ? 'conversations' : 'invitations');
  const [filter, setFilter] = useState<InvitationFilter>('all');
  const [data, setData] = useState<ConnectionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [savingIds, setSavingIds] = useState<string[]>([]);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState('');
  const [responding, setResponding] = useState<Record<string, RespondAction>>({});
  const [responseErrors, setResponseErrors] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({});
  const [confirmedMessages, setConfirmedMessages] = useState<Record<string, Message[]>>({});
  const [blockPerson, setBlockPerson] = useState<Person | null>(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const [blockError, setBlockError] = useState('');
  const alive = useRef(true), listSequence = useRef(0);
  const detailRequest = useRef<AbortController | null>(null);
  const saveLocks = useRef(new Set<string>()), personLocks = useRef(new Set<string>()), messageLocks = useRef(new Set<string>());
  const messageAttempts = useRef(new Map<string, { text: string; clientMessageId: string }>());
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const pending = data?.invitations.filter(item => item.status === 'pending') || [];
  const accepted = data?.invitations.filter(item => item.status === 'accepted') || [];
  const selected = accepted.find(item => item.id === selectedId) || null;

  useEffect(() => { alive.current = true; return () => { alive.current = false; detailRequest.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController(), sequence = ++listSequence.current;
    setLoading(true);
    void api<ConnectionsData>('/connections', { signal: requestSignal(controller) }).then(result => {
      if (controller.signal.aborted || sequence !== listSequence.current) return;
      setData(result); setLoadError('');
    }).catch(error => {
      if (!controller.signal.aborted && sequence === listSequence.current) setLoadError(messageOf(error));
    }).finally(() => {
      if (!controller.signal.aborted && sequence === listSequence.current) setLoading(false);
    });
    return () => controller.abort();
  }, [version, reload]);

  useEffect(() => {
    if (!requestedConversationId || !data || loading) return;
    setTab('conversations');
    if (data.invitations.some(item => item.id === requestedConversationId && item.status === 'accepted')) {
      setSelectedId(requestedConversationId);
      setOpenError('');
      onConversationOpened?.();
    } else setOpenError('刚建立的对话暂时没有载入，请刷新我的连接后重试。');
  }, [requestedConversationId, data, loading, onConversationOpened]);

  useEffect(() => {
    if (data && selectedId && !data.invitations.some(item => item.id === selectedId && item.status === 'accepted')) setSelectedId(null);
  }, [data, selectedId]);

  useEffect(() => {
    setOpeningId(null);
    return () => detailRequest.current?.abort();
  }, [tab]);

  function refreshList() { listSequence.current++; setReload(value => value + 1); }
  async function refreshAfterMutation() {
    refreshList();
    try { await actions.refresh(); }
    catch { actions.notify('操作已完成，账号状态暂未刷新，可稍后重试刷新。', true); }
  }

  async function openPerson(person: Person) {
    detailRequest.current?.abort();
    const controller = new AbortController(); detailRequest.current = controller;
    setOpeningId(person.id); setOpenError('');
    try {
      const result = await api<{ match: Match }>(`/people/${encodeURIComponent(person.id)}`, { signal: requestSignal(controller) });
      if (!controller.signal.aborted) actions.onSelect({ ...result.match, saved: actions.data.savedIds.includes(person.id) });
    } catch (error) {
      if (!controller.signal.aborted) setOpenError(`无法查看 ${person.name}：${messageOf(error)}`);
    } finally {
      if (!controller.signal.aborted && alive.current) setOpeningId(null);
    }
  }

  async function save(match: Match) {
    if (saveLocks.current.has(match.id)) return;
    saveLocks.current.add(match.id); setSavingIds(ids => [...ids, match.id]);
    try { await actions.onSave({ ...match, saved: actions.data.savedIds.includes(match.id) }); if (alive.current) refreshList(); }
    catch (error) { actions.notify(messageOf(error), true); }
    finally { saveLocks.current.delete(match.id); if (alive.current) setSavingIds(ids => ids.filter(id => id !== match.id)); }
  }

  async function respond(invitation: Invitation, action: RespondAction) {
    if (personLocks.current.has(invitation.person.id)) return;
    personLocks.current.add(invitation.person.id);
    setResponding(values => ({ ...values, [invitation.id]: action }));
    setResponseErrors(values => ({ ...values, [invitation.id]: '' }));
    try {
      await api(`/invitations/${encodeURIComponent(invitation.id)}/respond`, { method: 'POST', json: { action } });
      if (!alive.current) return;
      listSequence.current++;
      setData(current => current && ({ ...current, invitations: action === 'accept'
        ? current.invitations.map(item => item.id === invitation.id ? { ...item, status: 'accepted' } : item)
        : current.invitations.filter(item => item.id !== invitation.id) }));
      if (action === 'accept') { setSelectedId(invitation.id); setTab('conversations'); }
      actions.notify(action === 'accept' ? '已接受邀请，你们可以开始对话了。' : '已婉拒这条邀请。');
      await refreshAfterMutation();
    } catch (error) {
      if (alive.current) setResponseErrors(values => ({ ...values, [invitation.id]: messageOf(error) }));
    } finally {
      personLocks.current.delete(invitation.person.id);
      if (alive.current) setResponding(values => { const next = { ...values }; delete next[invitation.id]; return next; });
    }
  }

  function changeDraft(id: string, value: string) {
    if (value !== (draftsRef.current[id] || '')) messageAttempts.current.delete(id);
    draftsRef.current = { ...draftsRef.current, [id]: value };
    setDrafts(draftsRef.current);
  }

  async function sendMessage(invitation: Invitation) {
    const id = invitation.id, submittedDraft = draftsRef.current[id] || '', text = submittedDraft.trim();
    if (!text || text.length > 2000 || messageLocks.current.has(id) || personLocks.current.has(invitation.person.id)) return;
    const previousAttempt = messageAttempts.current.get(id);
    const clientMessageId = previousAttempt?.text === text ? previousAttempt.clientMessageId : crypto.randomUUID();
    messageAttempts.current.set(id, { text, clientMessageId });
    messageLocks.current.add(id); setSending(values => ({ ...values, [id]: true }));
    setSendErrors(values => ({ ...values, [id]: '' }));
    try {
      const message = await api<Message>(`/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', json: { text, clientMessageId } });
      if (!alive.current) return;
      if (messageAttempts.current.get(id)?.clientMessageId === clientMessageId) messageAttempts.current.delete(id);
      setConfirmedMessages(values => ({ ...values, [id]: mergeMessages(values[id] || [], [message]) }));
      if (draftsRef.current[id] === submittedDraft) changeDraft(id, '');
      setData(current => current && ({ ...current, invitations: current.invitations.map(item => item.id === id
        ? { ...item, lastMessage: { text: message.text, createdAt: message.createdAt } } : item) }));
      refreshList();
    } catch (error) {
      if (alive.current) setSendErrors(values => ({ ...values, [id]: messageOf(error) }));
    } finally {
      messageLocks.current.delete(id);
      if (alive.current) setSending(values => ({ ...values, [id]: false }));
    }
  }

  async function block() {
    if (!blockPerson || personLocks.current.has(blockPerson.id) || data?.invitations.some(item => item.person.id === blockPerson.id && messageLocks.current.has(item.id))) return;
    const person = blockPerson;
    personLocks.current.add(person.id); setBlockBusy(true); setBlockError('');
    try {
      await api(`/blocked/${encodeURIComponent(person.id)}`, { method: 'POST', json: {} });
      if (!alive.current) return;
      listSequence.current++;
      setData(current => current && ({ saved: current.saved.filter(item => item.id !== person.id), invitations: current.invitations.filter(item => item.person.id !== person.id) }));
      setBlockPerson(null);
      actions.notify(`已屏蔽 ${person.name}`);
      await refreshAfterMutation();
    } catch (error) { if (alive.current) setBlockError(messageOf(error)); }
    finally { personLocks.current.delete(person.id); if (alive.current) setBlockBusy(false); }
  }

  const filteredInvitations = pending.filter(item => filter === 'all' || item.direction === filter);
  const tabs: { id: ConnectionTab; label: string; count: number; icon: typeof Bookmark }[] = [
    { id: 'saved', label: '收藏的伙伴', count: data?.saved.length || 0, icon: Bookmark },
    { id: 'invitations', label: '连接邀请', count: pending.length, icon: Inbox },
    { id: 'conversations', label: '我的对话', count: accepted.length, icon: MessageCircle },
  ];

  function focusTab(index: number) {
    const next = tabs[(index + tabs.length) % tabs.length].id;
    setTab(next);
    document.getElementById(`connections-tab-${next}`)?.focus();
  }

  return <div className="connections-page">
    <PageTitle eyebrow="MEANINGFUL CONNECTIONS" title="让相遇，有下文" description="收藏值得认识的人，让共同的好奇心慢慢生长。"><button className="button secondary" onClick={() => actions.navigate('pairing')}>发现更多伙伴<ArrowUpRight size={16}/></button></PageTitle>
    {!actions.data.profile && <div className="connection-notice connections-profile-notice"><UserRoundCheck size={20}/><div><strong>让知识画像帮助你找到交流方向</strong><p>你可以先在问题小组中交流；补充知识画像后，还能发起后台异步匹配。</p></div><button className="text-button" onClick={actions.onCreate}>生成我的画像<ArrowUpRight size={15}/></button></div>}
    <div className="connections-tabs-row"><div className="connections-tabs" role="tablist" aria-label="我的连接分类">{tabs.map((item, index) => <button key={item.id} id={`connections-tab-${item.id}`} role="tab" tabIndex={tab === item.id ? 0 : -1} aria-selected={tab === item.id} aria-controls={`connections-panel-${item.id}`} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      focusTab(event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : index + (event.key === 'ArrowLeft' ? -1 : 1));
    }}><item.icon size={17}/><span>{item.label}</span><span className="connections-tab-count">{item.count}</span></button>)}</div><button className="icon-button connections-refresh" aria-label="刷新我的连接" title="刷新我的连接" disabled={loading} onClick={refreshList}><RefreshCw size={16} className={loading ? 'spin' : ''}/></button></div>
    {loadError && <div className="connection-error connections-load-error" role="alert"><p>{loadError}{data ? ' 仍保留上次读取的连接。' : ''}</p><button className="text-button" onClick={refreshList} disabled={loading}>重试加载</button></div>}
    {openError && <div className="connection-error connections-load-error" role="alert"><p>{openError}</p></div>}
    {openingId && <div className="connections-opening"><Spinner text="正在打开伙伴画像…"/></div>}
    {!data && loading ? <div className="connections-initial-loading"><Spinner text="正在寻找相遇留下的线索…"/></div> : !data ? <div className="panel"><Empty title="连接暂时没有加载出来" text="你的收藏和邀请会保留，可以重新尝试。" action="重新加载" onAction={refreshList}/></div> : <>
      {tab === 'saved' && <section id="connections-panel-saved" role="tabpanel" aria-labelledby="connections-tab-saved" className="connections-tab-panel"><div className="connections-section-intro"><div><h2>值得继续交流的知识伙伴<span>{data.saved.length} 位伙伴</span></h2><p>收藏一位伙伴，留待下次围绕共同问题深入交流。</p></div></div>{data.saved.length ? <div className="connections-saved-grid">{data.saved.map(match => <MatchCard key={match.id} match={{ ...match, saved: actions.data.savedIds.includes(match.id) }} onSelect={() => void openPerson(match)} onSave={() => void save(match)} saving={savingIds.includes(match.id)}/>)}</div> : <div className="panel"><Empty title="把想认识的人，先留在这里" text="在匹配提案或已连接伙伴的名片中收藏，下次就能继续了解。" action="去发现伙伴" onAction={() => actions.navigate('pairing')}/></div>}</section>}
      {tab === 'invitations' && <section id="connections-panel-invitations" role="tabpanel" aria-labelledby="connections-tab-invitations" className="connections-tab-panel"><div className="connections-section-intro"><div><h2>一段对话，从彼此愿意开始</h2><p>收到邀请后，由你决定是否接受。接受后才会开启真实对话。</p></div></div><div className="connections-invitation-filters" role="group" aria-label="邀请方向">{([{ id: 'all', label: '全部' }, { id: 'incoming', label: '收到的' }, { id: 'outgoing', label: '发出的' }] as const).map(item => <button key={item.id} aria-pressed={filter === item.id} className={filter === item.id ? 'active' : ''} onClick={() => setFilter(item.id)}>{item.label}<span>{pending.filter(invitation => item.id === 'all' || invitation.direction === item.id).length}</span></button>)}</div>{filteredInvitations.length ? <div className="connections-invitation-grid">{filteredInvitations.map(invitation => <article className="connection-invitation-card panel" key={invitation.id}><div className="connection-invitation-heading"><button className="connection-person-button" onClick={() => void openPerson(invitation.person)} disabled={openingId === invitation.person.id}><Avatar name={invitation.person.name} seed={invitation.person.id} src={invitation.person.avatar} size={44}/><span><strong>{invitation.person.name}<ChevronRight size={13}/></strong><span>{invitation.person.title}</span></span></button><span className={`tag ${invitation.direction === 'incoming' ? 'tag-purple' : ''}`}>{invitation.direction === 'incoming' ? '收到的邀请' : '等待接受'}</span></div><div className="connection-invitation-message"><span>{invitation.direction === 'incoming' ? 'TA 想和你聊' : '你发出的邀请'}</span><p>{invitation.message}</p></div><div className="tags">{invitation.person.interests.slice(0, 3).map(topic => <span key={topic.id} className="tag">{topic.label}</span>)}</div><div className="connection-invitation-time"><Clock3 size={12}/><time dateTime={invitation.createdAt}>{formatTime(invitation.createdAt)}</time></div>{responseErrors[invitation.id] && <p className="form-error" role="alert">{responseErrors[invitation.id]}</p>}<div className="connection-invitation-actions">{invitation.direction === 'incoming' ? <><button className="button primary" disabled={Boolean(responding[invitation.id])} onClick={() => void respond(invitation, 'accept')}>{responding[invitation.id] === 'accept' ? <Spinner text="正在接受…"/> : <><Check size={15}/>接受邀请</>}</button><button className="button ghost" disabled={Boolean(responding[invitation.id])} onClick={() => void respond(invitation, 'decline')}>{responding[invitation.id] === 'decline' ? '正在婉拒…' : '婉拒'}</button></> : <span className="connection-waiting-label">对方接受后，你们就可以开始对话</span>}<button className="icon-button connection-invitation-block" aria-label={`屏蔽${invitation.person.name}`} title="屏蔽这位伙伴" disabled={Boolean(responding[invitation.id])} onClick={() => { setBlockPerson(invitation.person); setBlockError(''); }}><ShieldOff size={16}/></button></div></article>)}</div> : <div className="panel"><Empty title={filter === 'outgoing' ? '还没有等待回应的邀请' : filter === 'incoming' ? '还没有收到新的邀请' : '给相遇留一点时间'} text={filter === 'incoming' ? '加入真实匹配后，感兴趣的伙伴可以向你发出邀请。' : '找到一个共同的兴趣，向真实伙伴发出第一句问候。'} action="发现真实伙伴" onAction={() => actions.navigate('pairing')}/></div>}</section>}
      {tab === 'conversations' && <section id="connections-panel-conversations" role="tabpanel" aria-labelledby="connections-tab-conversations" className="connections-tab-panel"><div className="connections-section-intro"><div><h2>从共同的话题，聊到新的世界<span>{accepted.length} 个连接</span></h2><p>通过问题小组邀请或知识匹配，双方确认后开启深入交流。</p></div></div>{accepted.length ? <div className={`connections-chat-layout panel ${selected ? 'has-selection' : ''}`}><aside className="connections-conversation-sidebar" aria-label="已建立的连接"><div className="connections-conversation-sidebar-title">我的对话<span>{accepted.length}</span></div>{accepted.map(invitation => <button key={invitation.id} className={`conversation-list-item ${selectedId === invitation.id ? 'active' : ''}`} aria-pressed={selectedId === invitation.id} onClick={() => setSelectedId(invitation.id)}><Avatar name={invitation.person.name} seed={invitation.person.id} src={invitation.person.avatar} size={43}/><span className="conversation-list-copy"><span><strong>{invitation.person.name}</strong><time dateTime={invitation.lastMessage?.createdAt || invitation.createdAt}>{formatTime(invitation.lastMessage?.createdAt || invitation.createdAt)}</time></span><span>{drafts[invitation.id]?.trim() ? <><em>草稿</em> {drafts[invitation.id]}</> : invitation.lastMessage?.text || '连接已建立，从共同问题开始'}</span></span></button>)}</aside><div className="connections-chat-main">{selected ? <ConversationPanel key={selected.id} invitation={selected} actions={actions} refreshKey={`${version}:${reload}`} confirmed={confirmedMessages[selected.id] || emptyMessages} draft={drafts[selected.id] || ''} onDraft={value => changeDraft(selected.id, value)} sending={Boolean(sending[selected.id])} sendError={sendErrors[selected.id] || ''} onSend={() => sendMessage(selected)} onBack={() => setSelectedId(null)} onPerson={() => void openPerson(selected.person)} onBlock={() => { setBlockPerson(selected.person); setBlockError(''); }}/>: <div className="connections-chat-placeholder"><Empty title="选一位伙伴，继续你们的对话" text="不用急着找一个完美的开场，共同的好奇心就是很好的起点。"/></div>}</div></div> : <div className="panel"><Empty title="有来有往，才是连接" text="发出或接受一条真实邀请，双方同意后，对话会出现在这里。" action={pending.length ? '查看连接邀请' : '去发现伙伴'} onAction={() => pending.length ? setTab('invitations') : actions.navigate('pairing')}/></div>}</section>}
    </>}
    {blockPerson && <Dialog title={`屏蔽 ${blockPerson.name}？`} onClose={() => { if (!blockBusy) setBlockPerson(null); }} busy={blockBusy} className="connection-block-dialog"><div className="connection-block-dialog-body"><p>屏蔽后将不再互相发现，这位伙伴会从收藏和连接中移除，当前邀请与对话会结束。</p>{blockError && <p className="form-error" role="alert">{blockError}</p>}<div className="connection-block-dialog-actions"><button className="button secondary" disabled={blockBusy} onClick={() => setBlockPerson(null)}>再想想</button><button className="button secondary connection-danger" disabled={blockBusy || data?.invitations.some(item => item.person.id === blockPerson.id && sending[item.id])} onClick={() => void block()}>{blockBusy ? <Spinner text="正在屏蔽…"/> : '确认屏蔽'}</button></div></div></Dialog>}
  </div>;
}

interface ConversationPanelProps {
  invitation: Invitation; actions: PageActions; refreshKey: string; confirmed: Message[];
  draft: string; onDraft: (value: string) => void; sending: boolean; sendError: string;
  onSend: () => Promise<void>; onBack: () => void; onPerson: () => void; onBlock: () => void;
}

function ConversationPanel({ invitation, actions, refreshKey, confirmed, draft, onDraft, sending, sendError, onSend, onBack, onPerson, onBlock }: ConversationPanelProps) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [reporting, setReporting] = useState<Message | null>(null);
  const olderRequest = useRef<AbortController | null>(null), olderLock = useRef(false);
  const generation = useRef(0), alive = useRef(true);
  const viewport = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const draftValue = useRef(draft); draftValue.current = draft;
  const nearBottom = useRef(true), initialScroll = useRef(false);
  const pendingAnchor = useRef<{ height: number; top: number } | null>(null);
  const messages = mergeMessages(conversation?.items || [], confirmed);
  const lastMessageId = messages.at(-1)?.id;

  useEffect(() => { alive.current = true; return () => { alive.current = false; olderRequest.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController(), currentGeneration = ++generation.current;
    olderRequest.current?.abort(); olderLock.current = false; setMoreLoading(false);
    setLoading(true);
    void api<Conversation>(`/conversations/${encodeURIComponent(invitation.id)}`, { signal: requestSignal(controller) }).then(result => {
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      setConversation(previous => {
        if (!previous || !previous.items.length) return result;
        const overlap = result.items.some(item => previous.items.some(old => old.id === item.id));
        if (!overlap && result.hasMore) return result;
        return { ...result, items: mergeMessages(previous.items, result.items), hasMore: previous.hasMore, nextBefore: previous.nextBefore };
      });
      setError(''); setUnavailable(false);
    }).catch(cause => {
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      setError(messageOf(cause));
      if (cause instanceof APIError && [401, 403, 404].includes(cause.status)) setUnavailable(true);
    }).finally(() => { if (!controller.signal.aborted && currentGeneration === generation.current) setLoading(false); });
    return () => controller.abort();
  }, [invitation.id, refreshKey, attempt]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !conversation) return;
    if (pendingAnchor.current) {
      const anchor = pendingAnchor.current;
      element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
      pendingAnchor.current = null;
    } else if (!initialScroll.current || nearBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
    initialScroll.current = true;
  }, [conversation, lastMessageId, messages.length]);

  async function loadMore() {
    if (olderLock.current || !conversation?.hasMore || !conversation.nextBefore || loading) return;
    olderLock.current = true;
    const controller = new AbortController(); olderRequest.current = controller;
    const currentGeneration = generation.current, cursor = conversation.nextBefore;
    setMoreLoading(true); setMoreError('');
    try {
      const result = await api<Conversation>(`/conversations/${encodeURIComponent(invitation.id)}?before=${encodeURIComponent(cursor)}`, { signal: requestSignal(controller) });
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      if (viewport.current) pendingAnchor.current = { height: viewport.current.scrollHeight, top: viewport.current.scrollTop };
      setConversation(previous => previous && ({ ...previous, items: mergeMessages(result.items, previous.items), hasMore: result.hasMore, nextBefore: result.nextBefore }));
    } catch (cause) {
      if (!controller.signal.aborted && currentGeneration === generation.current) setMoreError(messageOf(cause));
    } finally {
      if (olderRequest.current === controller) {
        olderLock.current = false;
        if (alive.current) setMoreLoading(false);
      }
    }
  }

  function submitMessage() {
    if (!draft.trim() || sending || unavailable || !conversation) return;
    nearBottom.current = true;
    void onSend();
  }

  function updateDraft(value: string) { draftValue.current = value; onDraft(value); }

  function addQuestion(question: string) {
    if (!conversation || unavailable) return false;
    const text = question.trim(), current = draftValue.current;
    const next = current + (current ? '\n\n' : '') + text;
    const added = Boolean(text) && next.length <= 2000;
    if (added) updateDraft(next);
    window.requestAnimationFrame(() => {
      if (!alive.current || !composer.current) return;
      composer.current.focus();
      const end = composer.current.value.length;
      composer.current.setSelectionRange(end, end);
    });
    return added;
  }

  return <div className="conversation-panel">
    <header className="conversation-header"><button className="icon-button conversation-mobile-back" onClick={onBack} aria-label="返回对话列表"><ArrowLeft size={19}/></button><button className="connection-person-button" onClick={onPerson}><Avatar name={invitation.person.name} seed={invitation.person.id} src={invitation.person.avatar} size={40}/><span><strong>{invitation.person.name}<ChevronRight size={13}/></strong><span>双方已确认连接</span></span></button><button className="icon-button conversation-block-button" onClick={onBlock} disabled={sending} aria-label={`屏蔽${invitation.person.name}`} title="屏蔽这位伙伴"><ShieldOff size={17}/></button></header>
    {error && <div className="connection-error conversation-load-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => setAttempt(value => value + 1)} disabled={loading}>重新读取</button></div>}
    {conversation && !unavailable && <ConversationStarter key={JSON.stringify([invitation.id, actions.data.profile?.revision, invitation.person])} conversationId={invitation.id} refreshKey={refreshKey} onUseQuestion={addQuestion}/>}
    <div className="conversation-messages" ref={viewport} tabIndex={0} aria-label={`与 ${invitation.person.name} 的消息记录`} onScroll={() => { const element = viewport.current; if (element) nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90; }}>
      {!conversation && loading ? <div className="conversation-initial-loading"><Spinner text="正在打开你们的对话…"/></div> : conversation && <>
        <div className="conversation-origin"><span><UserRoundCheck size={13}/>对话始于这次连接</span><p>{conversation.invitation}</p></div>
        {conversation.hasMore && <div className="conversation-history"><button className="text-button" disabled={moreLoading || loading} onClick={() => void loadMore()}>{moreLoading ? <Spinner text="正在读取更早的消息…"/> : '查看更早的消息'}</button>{moreError && <p className="form-error" role="alert">{moreError}</p>}</div>}
        {messages.length ? <ol className="conversation-message-list" aria-label="消息">{messages.map(message => {
          const mine = message.authorId === actions.data.user.id;
          return <li key={message.id} className={`conversation-message ${mine ? 'is-mine' : ''}`}><Avatar name={mine ? actions.data.user.name : invitation.person.name} seed={message.authorId} src={mine ? actions.data.user.avatar : invitation.person.avatar} size={30}/><div className="conversation-message-content"><div className="conversation-message-meta"><span>{mine ? '我' : invitation.person.name}</span><time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>{!mine && <button type="button" className="tz-message-report" data-testid="conversation-report" aria-label="举报这条消息" title="举报这条消息" disabled={unavailable} onClick={() => setReporting(message)}><Flag size={12}/></button>}</div><p>{message.text}</p></div></li>;
        })}</ol> : <div className="conversation-first-message"><MessageCircle size={26}/><p>你们已经连接，第一句留给你们。</p><span>聊聊那个让你想认识 TA 的问题吧。</span></div>}
      </>}
    </div>
    {reporting && <ReportDialog conversationId={invitation.id} message={reporting} personName={invitation.person.name} onClose={() => setReporting(null)} onSent={notice => { setReporting(null); actions.notify(notice); }}/>}
    <form className="conversation-composer" onSubmit={event => { event.preventDefault(); submitMessage(); }}><label className="sr-only" htmlFor={`message-${invitation.id}`}>发送给 {invitation.person.name} 的消息</label><textarea ref={composer} id={`message-${invitation.id}`} value={draft} onChange={event => updateDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); submitMessage(); } }} maxLength={2000} rows={3} placeholder="认真回应一个问题，或分享今天的新发现…" disabled={!conversation || unavailable}/>{sendError && <p className="form-error" role="alert">{sendError} 草稿已保留，请确认后重试。</p>}<div className="conversation-composer-footer"><span><span className="conversation-keyboard-tip">Enter 发送 · Shift + Enter 换行</span><span className="conversation-message-count">{draft.length}/2000</span></span><button className="button primary" type="submit" disabled={sending || !draft.trim() || !conversation || unavailable}>{sending ? <Spinner text="发送中…"/> : <><Send size={15}/>发送</>}</button></div><p className="tz-chat-safety-note">消息可能经 AI 辅助审核，可举报和申诉。<a href="#account">查看处理与申诉</a></p></form>
  </div>;
}
