import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, BookOpen, Check, CheckCheck, Circle, Clock3, Compass, HeartHandshake, Info, LockKeyhole, MessageCircle, Radio, RefreshCw, Share2, ShieldCheck, Shuffle, Sparkles, UsersRound, Waves, WifiOff, X } from 'lucide-react';
import { GOALS, TOPIC_MAP } from '../shared/catalog.js';
import { api, APIError, messageOf } from './api';
import { Avatar, PageTitle, Spinner } from './components';
import { InviteDialog } from './InviteDialog';
import type { Mode, PageActions, PairingState } from './types';
import './pairing.css';

type Operation = '' | 'start' | 'accept' | 'skip' | 'cancel' | 'sync';
const isActive = (state: PairingState | null) => state?.status === 'searching' || state?.status === 'proposed';
const reasonText: Record<string, string> = {
  cancelled: '本次配对已结束。准备好时，可以再开始一轮。',
  offline: '连接中断后，本轮配对已经结束。网络恢复后，请手动重新开始。',
  queue_expired: '这轮等待已结束，暂时没有找到符合条件的在线伙伴。可以稍后再试。',
  profile_changed: '你的画像已更新，本轮配对已经结束。查看新的资料后，可以重新开始。',
  account_changed: '当前账号已发生变化，请确认自己的资料后重新开始。',
  blocked: '与这位伙伴的配对已经结束。',
  person_unavailable: '这次配对已结束，伙伴目前无法访问。',
  skipped: '已跳过这位伙伴，正在继续寻找。短时间内不会再次配到同一个人。',
  peer_skipped: '这次没有建立连接，正在继续寻找另一位伙伴。',
  peer_left: '对方已离开，正在本轮剩余时间里继续寻找另一位伙伴。',
  proposal_expired: '这次的确认时间已结束，正在本轮剩余时间里继续寻找。',
  pair_unavailable: '刚才的配对已失效，正在继续寻找在线伙伴。',
};

function Orbit({ active, name, seed, avatar, children }: { active: boolean; name?: string; seed?: string; avatar?: string; children?: React.ReactNode }) {
  return <div className={`pairing-orbit ${active ? 'is-searching' : ''}`}>
    <div className="pairing-orbit-decoration" aria-hidden="true"><span className="pairing-orbit-ring ring-one" /><span className="pairing-orbit-ring ring-two" /><span className="pairing-orbit-ring ring-three" /><span className="pairing-orbit-star star-one">✧</span><span className="pairing-orbit-star star-two">✦</span><span className="pairing-orbit-book"><BookOpen size={19} /></span><span className="pairing-orbit-spark"><Sparkles size={18} /></span></div>
    {children || <div className="pairing-orbit-self"><Avatar name={name || '我的兴趣'} seed={seed} src={avatar} size={84} /><span className="pairing-signal-dots" aria-hidden="true"><i /><i /><i /></span></div>}
  </div>;
}

export function PairingPage({ actions, onConnected }: { actions: PageActions; onConnected: (conversationId: string) => void }) {
  const { data } = actions;
  const [state, setState] = useState<PairingState | null>(null);
  const stateRef = useRef<PairingState | null>(null);
  const [mode, setMode] = useState<Mode>('resonance');
  const [topic, setTopic] = useState('all');
  const [busy, setBusy] = useState<Operation>('');
  const mutation = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [offline, setOffline] = useState(!navigator.onLine);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(false);
  const epoch = useRef(0);
  const syncController = useRef<AbortController | null>(null);
  const mutationController = useRef<AbortController | null>(null);
  const queuedSync = useRef(false);
  const syncRef = useRef<(heartbeat?: boolean) => Promise<void>>(async () => {});
  const refreshActions = useRef(actions.refresh);
  refreshActions.current = actions.refresh;
  const filterId = useId();

  const applyState = useCallback((next: PairingState) => {
    const previous = stateRef.current;
    stateRef.current = next;
    setState(next);
    setSyncError('');
    setLoading(false);
    setNow(Date.now());
    if (!previous || isActive(next)) { setMode(next.mode); setTopic(next.topic || 'all'); }
  }, []);

  const synchronize = useCallback(async (heartbeat = false) => {
    if (!mounted.current) return;
    if (!navigator.onLine) { setOffline(true); setLoading(false); return; }
    if (mutation.current || syncController.current) { queuedSync.current = true; return; }
    const controller = new AbortController(), requestEpoch = epoch.current;
    syncController.current = controller;
    const current = stateRef.current;
    const sendHeartbeat = heartbeat && isActive(current) && Boolean(current?.attemptId);
    try {
      const next = await api<PairingState>(sendHeartbeat ? '/pairing/heartbeat' : '/pairing', {
        ...(sendHeartbeat ? { method: 'POST', json: { attemptId: current!.attemptId } } : {}),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
      });
      if (mounted.current && requestEpoch === epoch.current && !controller.signal.aborted) applyState(next);
    } catch (cause) {
      if (mounted.current && requestEpoch === epoch.current && !controller.signal.aborted) {
        setSyncError(messageOf(cause));
        setLoading(false);
      }
    } finally {
      if (syncController.current === controller) {
        syncController.current = null;
        if (queuedSync.current && mounted.current && !mutation.current) {
          queuedSync.current = false;
          queueMicrotask(() => { void syncRef.current(false); });
        }
      }
    }
  }, [applyState]);
  syncRef.current = synchronize;

  useEffect(() => {
    mounted.current = true;
    epoch.current++;
    stateRef.current = null;
    setState(null); setLoading(true); setError(''); setSyncError(''); setBusy('');
    mutation.current = false; queuedSync.current = false;
    void synchronize(false).then(() => { if (isActive(stateRef.current)) void synchronize(true); });
    const changed = () => { void synchronize(false); };
    const online = () => { setOffline(false); void synchronize(false).then(() => { if (isActive(stateRef.current)) void synchronize(true); }); };
    const disconnected = () => { setOffline(true); };
    const visible = () => { if (document.visibilityState === 'visible') online(); };
    const timer = setInterval(() => { void synchronize(true); }, 10000);
    window.addEventListener('tongpin:pairing', changed);
    window.addEventListener('online', online);
    window.addEventListener('offline', disconnected);
    document.addEventListener('visibilitychange', visible);
    return () => {
      mounted.current = false; epoch.current++;
      syncController.current?.abort(); syncController.current = null;
      mutationController.current?.abort(); mutationController.current = null;
      clearInterval(timer);
      window.removeEventListener('tongpin:pairing', changed);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', disconnected);
      document.removeEventListener('visibilitychange', visible);
      // Leaving this page stops presence updates; only an explicit cancel ends a round immediately.
    };
  }, [data.user.id, synchronize]);

  const active = isActive(state);
  const status = state?.status || 'idle';
  const expires = state?.expiresAt ? Date.parse(state.expiresAt) : NaN;
  const remaining = Number.isFinite(expires) ? Math.max(0, Math.ceil((expires - now) / 1000)) : null;
  const expired = active && remaining === 0;
  const expiresSynced = useRef('');
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (expired && state?.expiresAt && expiresSynced.current !== state.expiresAt) {
      expiresSynced.current = state.expiresAt;
      void synchronize(false);
    }
  }, [expired, state?.expiresAt, synchronize]);

  const ownTopics = useMemo(() => data.profile?.interests || [], [data.profile]);
  const candidate = state?.pair && !state.pair.person.demo ? state.pair.person : null;
  const pair = candidate ? state?.pair : null;
  const networkUncertain = offline || Boolean(syncError);
  const queue = !loading && !networkUncertain ? state?.queue : null;
  const controlsDisabled = Boolean(busy) || loading || networkUncertain;
  const notice = state?.reason ? reasonText[state.reason] || state.notice : state?.notice;
  const timerText = remaining === null ? '' : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;

  async function operate(operation: Exclude<Operation, '' | 'sync'>) {
    if (mutation.current || !stateRef.current) return;
    if (!navigator.onLine) { setOffline(true); setError('当前网络已断开，暂时无法确认这次操作。恢复连接后请重新同步。'); return; }
    const current = stateRef.current;
    if (operation === 'start' && !data.profile) { actions.onCreate(); return; }
    if ((operation === 'accept' || operation === 'skip') && !current.pair) return;
    if (operation === 'cancel' && !current.attemptId) return;
    mutation.current = true; setBusy(operation); setError('');
    epoch.current++;
    syncController.current?.abort(); syncController.current = null;
    const controller = new AbortController(), requestEpoch = epoch.current;
    mutationController.current = controller;
    const path = operation === 'start' ? '/pairing/start' : operation === 'cancel' ? '/pairing/cancel' : '/pairing/respond';
    const json = operation === 'start' ? { revision: data.profile!.revision, mode, topic: topic === 'all' ? null : topic }
      : operation === 'cancel' ? { attemptId: current.attemptId }
        : { pairId: current.pair!.id, decision: operation === 'accept' ? 'accept' : 'skip' };
    try {
      const next = await api<PairingState>(path, { method: 'POST', json, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      if (mounted.current && requestEpoch === epoch.current && !controller.signal.aborted) {
        applyState(next);
        if (operation === 'cancel' && next.status === 'idle') actions.notify('本轮配对已取消。');
        if (next.status === 'connected') void refreshActions.current().catch(() => {});
      }
    } catch (cause) {
      if (mounted.current && requestEpoch === epoch.current && !controller.signal.aborted) {
        setError(messageOf(cause));
        if (cause instanceof APIError && ['profile_changed', 'profile_required', 'csrf_mismatch', 'session_required'].includes(cause.code)) {
          try { await refreshActions.current(); } catch { /* The inline error remains available for retry. */ }
        }
      }
    } finally {
      if (mutationController.current === controller) {
        mutationController.current = null;
        mutation.current = false;
        if (mounted.current) { setBusy(''); queuedSync.current = false; void synchronize(false); }
      }
    }
  }

  async function retrySync() {
    if (mutation.current) return;
    setError(''); setBusy('sync');
    try { await refreshActions.current(); await synchronize(false); }
    catch (cause) { if (mounted.current) setSyncError(messageOf(cause)); }
    finally { if (mounted.current) setBusy(''); }
  }

  const cancelButton = <button type="button" className="text-button pairing-cancel" data-testid="pairing-cancel" onClick={() => void operate('cancel')} disabled={Boolean(busy) || offline}>
    {busy === 'cancel' ? <Spinner text="正在取消…" /> : <><X size={14} />取消配对</>}
  </button>;
  const statusLabel = loading ? '正在同步配对状态' : networkUncertain ? '在线状态暂未同步' : status === 'searching' ? '正在等待在线伙伴' : status === 'proposed' ? pair?.acceptedByMe ? '你已确认，等待对方' : '遇见一位伙伴，等待双方确认' : status === 'connected' ? '双方已确认，可以开始聊天' : '尚未开始配对';

  return <div className="pairing-page" data-testid="pairing-page">
    <PageTitle eyebrow="A GOOD CONVERSATION STARTS HERE" title="此刻，遇见同频的人" description="主动迈出一小步，把现在留给一场好对话。">
      <div className="pairing-title-actions"><span className="pairing-title-badge"><HeartHandshake size={16} />主动在线 · 双方同意</span><button type="button" className="button secondary pairing-invite-button" data-testid="pairing-invite" onClick={() => setInviteOpen(true)}><Share2 size={15}/>邀请朋友一起配对</button></div>
    </PageTitle>
    <div className="pairing-layout">
      <section className={`panel pairing-stage pairing-stage-${status}`} aria-labelledby="pairing-stage-title">
        <div className="pairing-stage-top"><span><Radio size={14} />此刻配对</span><span><LockKeyhole size={13} />无需加入公开发现</span></div>
        <p className={`pairing-state-label ${active ? 'is-active' : ''}`} data-testid="pairing-status" data-status={status} role="status" aria-live="polite"><i />{statusLabel}</p>
        <div className="pairing-queue-summary" data-testid="pairing-queue" data-updated-at={queue?.updatedAt}>
          <div role="status" aria-live="polite" aria-atomic="true"><UsersRound size={15}/><strong data-testid="pairing-queue-count">{queue ? `${queue.waiting.toLocaleString('zh-CN')} 人正在排队` : loading ? '正在同步排队人数…' : '排队人数暂未同步'}</strong>{queue && <span data-testid="pairing-queue-confirming">{queue.confirming.toLocaleString('zh-CN')} 人确认中</span>}</div>
          <p>{queue ? '全站排队人数包含正在等待的自己，正在确认者另计。' : '连接恢复后，会显示实际的排队人数。'}</p>
          {queue?.waiting === 0 && queue.confirming === 0 && <p className="pairing-queue-empty">此刻还没有人等待，可以邀请朋友各自开始配对。</p>}
        </div>

        {(offline || syncError) && <div className="pairing-network-note" role="alert"><WifiOff size={18} /><div><strong>{offline ? '网络连接已断开' : '暂时无法同步在线状态'}</strong><p>页面可能显示上次同步的状态。持续离线会结束本轮，恢复后会重新核对，不会自动开始新一轮。</p>{syncError && <small>{syncError}</small>}</div><button type="button" className="text-button" onClick={retrySync} disabled={Boolean(busy) || offline}>重新同步</button></div>}
        {notice && <div className="pairing-notice" role="status"><Info size={15} /><p>{notice}</p></div>}
        {error && <div className="form-error pairing-action-error" role="alert"><p>{error}</p><button type="button" className="text-button" onClick={retrySync} disabled={Boolean(busy) || offline}><RefreshCw size={14} />重新同步状态</button></div>}

        {(status === 'idle' || loading) && <div className="pairing-idle-content">
          <Orbit active={false}>
            {data.profile ? <button type="button" className="pairing-orbit-button" data-testid="pairing-start" onClick={() => void operate('start')} disabled={controlsDisabled} aria-describedby="pairing-sharing-note"><Waves size={31} /><strong>{busy === 'start' ? '正在出发…' : loading ? '正在同步…' : '开始配对'}</strong><span>让好奇心发出信号</span></button>
              : <span className="pairing-orbit-placeholder"><Compass size={42} /><span>相遇，从认识你开始</span></span>}
          </Orbit>
          <h2 id="pairing-stage-title">{!data.profile ? '先给好奇心，一张小小的名片' : state?.reason === 'queue_expired' ? '这次，还没等到合适的伙伴' : state?.reason === 'offline' ? '先歇一歇，连接已暂时离开' : '把此刻，留给一次好对话'}</h2>
          <p>{!data.profile ? '选择几个真正喜欢的话题，生成自己的知识画像，就能与另一位正在等待的人相遇。' : '选一种相遇方式，点击开始。只有同样主动等待的人，才会出现在你的配对里。'}</p>
          {!data.profile && <button type="button" className="button primary pairing-create" data-testid="pairing-create" onClick={actions.onCreate}><Sparkles size={17} />创建我的知识画像<ArrowRight size={16} /></button>}
          <div className="pairing-idle-details"><span><Clock3 size={14} />每轮最多等待 3 分钟</span><span><CheckCheck size={14} />双方确认后才聊天</span></div>
        </div>}

        {status === 'searching' && !loading && <div className="pairing-search-content">
          <Orbit active={!networkUncertain && !expired} name={data.profile?.input.name || data.user.name} seed={data.user.id} avatar={data.user.avatar} />
          <h2 id="pairing-stage-title">给相遇，一点发生的时间</h2>
          <p>暂未找到符合条件的在线伙伴。<br />正在等待另一位也点击了「开始配对」的人。</p>
          <div className="pairing-search-tags"><span className="tag tag-purple">{state?.mode === 'complement' ? '互补碰撞' : '同频共鸣'}</span><span className="tag">{state?.topic ? TOPIC_MAP.get(state.topic)?.label || '指定兴趣' : '不限兴趣方向'}</span></div>
          <div className="pairing-countdown" aria-live="off"><Clock3 size={16} /><span>{expired ? '正在确认本轮是否已结束…' : '本轮剩余等待时间'}</span>{!expired && <time dateTime={state?.expiresAt || undefined}>{timerText}</time>}</div>
          {cancelButton}
          <p className="pairing-presence-note">请保持本页在线。你可以随时取消，或结束本轮后调整兴趣方向。</p>
        </div>}

        {status === 'proposed' && !loading && candidate && pair && <div className="pairing-proposed-content" data-testid="pairing-candidate">
          <div className="pairing-proposal-heading"><div><span className="eyebrow">A LITTLE CURIOSITY IN COMMON</span><h2 id="pairing-stage-title">这份好奇心，与你相遇了</h2></div><span className="pairing-proposal-clock" aria-live="off"><Clock3 size={14} />{expired ? '正在同步…' : `${timerText} 内确认`}</span></div>
          <div className="pairing-person-header"><Avatar name={candidate.name} seed={candidate.avatarSeed || candidate.id} src={candidate.avatar} size={64} /><div><h3>{candidate.name}</h3><p>{candidate.title}</p><span><i />同样主动等待的真实伙伴</span></div><div className="pairing-person-score" data-testid="pairing-score"><strong>{candidate.score}<span>°</span></strong><small>{candidate.matchingMode === 'complement' ? '互补指数' : '同频指数'}</small></div></div>
          <p className="pairing-person-summary">{candidate.summary || candidate.about}</p>
          <div className="tags pairing-person-topics">{candidate.interests.slice(0, 7).map(interest => <span key={interest.id} className={`tag ${candidate.shared.some(shared => shared.id === interest.id) ? 'tag-purple' : ''}`}>{interest.label}</span>)}</div>
          <div className="pairing-reasons"><span><Sparkles size={16} />为什么这一次相遇值得期待</span><ul>{candidate.reasons.map((reason, index) => <li key={`${index}-${reason}`}><i /><p>{reason}</p></li>)}</ul></div>
          <div className="pairing-person-preferences"><span><MessageCircle size={14} />{candidate.style.label}</span>{GOALS.filter(goal => candidate.goals.includes(goal.id)).map(goal => <span key={goal.id}>{goal.short}</span>)}</div>
          {candidate.question && <blockquote className="pairing-person-question"><span>一个 TA 想聊的问题</span><p>“{candidate.question}”</p></blockquote>}
          <div className="pairing-confirmations" aria-live="polite"><span className={pair.acceptedByMe ? 'confirmed' : ''}>{pair.acceptedByMe ? <Check size={14} /> : <Circle size={13} />}我{pair.acceptedByMe ? '已确认' : '待确认'}</span><span className="pairing-confirmation-line" /><span className={pair.acceptedByOther ? 'confirmed' : ''}>{pair.acceptedByOther ? <Check size={14} /> : <Circle size={13} />}对方{pair.acceptedByOther ? '已确认' : '待确认'}</span></div>
          <div className="pairing-candidate-actions"><button type="button" className="button secondary" data-testid="pairing-skip" onClick={() => void operate('skip')} disabled={controlsDisabled || expired}>{busy === 'skip' ? <Spinner text="正在换一位…" /> : <><Shuffle size={16} />换一个</>}</button><button type="button" className="button primary" data-testid="pairing-accept" onClick={() => void operate('accept')} disabled={controlsDisabled || expired || pair.acceptedByMe}>{busy === 'accept' ? <Spinner text="正在确认…" /> : pair.acceptedByMe ? <><Check size={16} />已确认，等待对方</> : <><MessageCircle size={17} />聊一聊</>}</button></div>
          {pair.acceptedByMe && <p className="pairing-accept-note">你已同意开启对话。对方也确认后，聊天入口会出现。</p>}
          <div className="pairing-proposal-footer">{cancelButton}<span>双方确认之前，聊天不会开启</span></div>
        </div>}

        {status === 'proposed' && !loading && !candidate && <div className="pairing-missing-person"><Info size={28} /><h2 id="pairing-stage-title">伙伴资料暂时无法读取</h2><p>重新同步后再决定是否确认，也可以结束本轮。</p><button type="button" className="button secondary" onClick={retrySync} disabled={Boolean(busy)}>重新同步</button>{cancelButton}</div>}

        {status === 'connected' && !loading && <div className="pairing-connected-content">
          <div className="pairing-connected-avatars"><Avatar name={data.profile?.input.name || data.user.name} seed={data.user.id} src={data.user.avatar} size={80} /><span><HeartHandshake size={27} /></span>{candidate ? <Avatar name={candidate.name} seed={candidate.avatarSeed || candidate.id} src={candidate.avatar} size={80} /> : <span className="pairing-connected-placeholder"><MessageCircle size={30} /></span>}</div>
          <span className="pairing-connected-badge"><CheckCheck size={15} />双方已确认</span>
          <h2 id="pairing-stage-title">你们都说了声，聊一聊</h2>
          <p>{candidate ? `你与 ${candidate.name} 的对话已经准备好。` : '一段新的对话已经准备好。'}<br />从一个共同喜欢的话题，开始认识彼此吧。</p>
          {candidate && <div className="tags pairing-connected-tags">{(candidate.shared.length ? candidate.shared : candidate.interests.slice(0, 3)).map(interest => <span className="tag tag-purple" key={interest.id}>{interest.label}</span>)}</div>}
          <button type="button" className="button primary pairing-open-chat" data-testid="pairing-open-chat" disabled={!state?.conversationId || Boolean(busy)} onClick={() => { if (state?.conversationId) onConnected(state.conversationId); }}><MessageCircle size={18} />进入聊天<ArrowRight size={17} /></button>
          <button type="button" className="text-button pairing-restart" data-testid="pairing-start" disabled={controlsDisabled || !data.profile} onClick={() => void operate('start')}><Shuffle size={14} />{busy === 'start' ? '正在开始…' : '再开始一轮'}</button>
          <p className="pairing-connection-kept"><ShieldCheck size={14} />这段对话已保存在「我的连接」，重新配对也会保留。</p>
        </div>}

        <div className="pairing-sharing-note" id="pairing-sharing-note"><ShieldCheck size={17} /><p>点击开始后，你会向另一位主动在线者临时展示昵称、画像、兴趣、自述、问题与交流偏好。<strong>原始导入摘要不会展示</strong>，也不会自动加入全局发现。双方确认后，资料随连接保留可见。</p></div>
      </section>

      <aside className="pairing-aside">
        <section className="panel pairing-preferences"><div className="section-heading"><h2>选择一种相遇</h2><Sparkles size={17} /></div><p className="pairing-aside-description">同一种好奇，或一个新视角。</p>
          <fieldset disabled={active || Boolean(busy) || !data.profile} className="pairing-preference-fields"><legend className="pairing-field-legend">配对方式</legend><div className="pairing-mode-options"><button type="button" data-testid="pairing-mode-resonance" aria-pressed={mode === 'resonance'} className={mode === 'resonance' ? 'selected' : ''} onClick={() => setMode('resonance')}><span><Waves size={21} /></span><div><strong>同频共鸣</strong><small>从共同兴趣开始，说到一起</small></div>{mode === 'resonance' && <Check size={15} />}</button><button type="button" data-testid="pairing-mode-complement" aria-pressed={mode === 'complement'} className={mode === 'complement' ? 'selected' : ''} onClick={() => setMode('complement')}><span><Compass size={21} /></span><div><strong>互补碰撞</strong><small>在不同的知识里，遇见新视角</small></div>{mode === 'complement' && <Check size={15} />}</button></div>
            <label className="pairing-topic-label" htmlFor={filterId}>想从哪个话题聊起<span>选填</span></label><select id={filterId} data-testid="pairing-topic" value={topic} onChange={event => setTopic(event.target.value)}><option value="all">不限兴趣，保持好奇</option>{ownTopics.map(interest => <option value={interest.id} key={interest.id}>{interest.label}</option>)}{topic !== 'all' && !ownTopics.some(interest => interest.id === topic) && <option value={topic}>{TOPIC_MAP.get(topic)?.label || '指定兴趣'}</option>}</select>
          </fieldset>
          <p className="pairing-filter-note">{active ? '本轮进行中。取消配对后，可以调整方式和话题。' : '选择话题后，只与同样对它感兴趣的在线伙伴配对。'}</p>
        </section>
        <section className="panel pairing-own-profile"><div className="pairing-own-heading"><span>我的相遇名片</span><LockKeyhole size={14} /></div><div className="pairing-own-person"><Avatar name={data.profile?.input.name || data.user.name} seed={data.user.id} src={data.user.avatar} size={42} /><div><strong>{data.profile?.input.name || '等待被认识的你'}</strong><p>{data.profile?.title || '还没有创建知识画像'}</p></div></div>{data.profile ? <><div className="tags">{data.profile.interests.slice(0, 4).map(interest => <span className="tag" key={interest.id}>{interest.label}</span>)}</div><button type="button" className="text-button" disabled={active || Boolean(busy)} onClick={() => actions.navigate('profile')}>查看我的画像<ArrowUpRight size={14} /></button></> : <p className="pairing-own-empty">用真实的兴趣认识彼此，在线配对不使用体验人物。</p>}</section>
        <section className="pairing-how-it-works"><h3>相遇可以简单，也可以认真</h3><ol><li className={status !== 'idle' ? 'reached' : ''}><span>01</span><div><strong>现在，我想聊聊</strong><p>你主动开始，才会加入在线等待。</p></div></li><li className={status === 'proposed' || status === 'connected' ? 'reached' : ''}><span>02</span><div><strong>把选择留给彼此</strong><p>看到真实画像，双方各自确认。</p></div></li><li className={status === 'connected' ? 'reached' : ''}><span>03</span><div><strong>让一句话，成为开始</strong><p>双方同意后，才会开启私聊。</p></div></li></ol><p><ShieldCheck size={14} />等待和确认期间，都可以随时取消。</p></section>
      </aside>
    </div>
    {inviteOpen && <InviteDialog onClose={() => setInviteOpen(false)}/>}
  </div>;
}
