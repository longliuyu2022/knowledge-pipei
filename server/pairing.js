import { randomUUID } from 'node:crypto';
import { AppError, fail } from './errors.js';
import { compareProfiles, publicProfile } from './matching.js';
import { TOPIC_MAP } from '../shared/catalog.js';

const active = state => state?.status === 'searching' || state?.status === 'proposed';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const pairKey = (a, b) => [a, b].sort().join(':');
const notices = {
  cancelled: '你已停止本次在线匹配。', offline: '一段时间没有收到心跳，本次匹配已结束；可以重新开始。',
  queue_expired: '本次等待已结束，还没有找到合适的在线伙伴，可以稍后再试。',
  profile_changed: '画像正在更新或已经改变，请查看新画像后重新开始匹配。',
  account_changed: '账号状态已改变，请重新开始匹配。', blocked: '已结束与这位伙伴的匹配。',
  person_unavailable: '这次匹配已结束，伙伴目前无法访问。',
  skipped: '已经换一位，继续寻找在线伙伴。', peer_skipped: '这次没有建立连接，继续寻找新的在线伙伴。',
  peer_left: '对方已离开本次匹配，继续为你寻找在线伙伴。',
  proposal_expired: '本次确认时间已结束，继续寻找在线伙伴。',
  pair_unavailable: '这次配对已失效，继续寻找在线伙伴。',
};

// All state transitions are synchronous: no user can be reserved by two pairs
// between reading the queue and committing a proposal in this single process.
export class Pairing {
  constructor(store, {
    now = () => Date.now(), onChange = () => {}, offlineMs = 45000, queueMs = 180000,
    proposalMs = 60000, avoidMs = 300000, retentionMs = 600000, sweepMs = 5000, maxParticipants = 200,
  } = {}) {
    this.store = store; this.now = now; this.onChange = onChange;
    Object.assign(this, { offlineMs, queueMs, proposalMs, avoidMs, retentionMs, maxParticipants });
    this.states = new Map(); this.pairs = new Map(); this.closed = new Map(); this.avoided = new Map();
    this.changed = new Set(); this.processing = false;
    this.timer = setInterval(() => this.tick(), sweepMs); this.timer.unref();
  }
  close() { clearInterval(this.timer); this.states.clear(); this.pairs.clear(); this.closed.clear(); this.avoided.clear(); this.changed.clear(); }
  update(state, changes) { Object.assign(state, changes, { updatedAt: this.now() }); this.changed.add(state.userId); }
  idle(state, reason) { this.update(state, { status: 'idle', pairId: null, partnerId: null, conversationId: null, reason }); }
  flush() {
    const changed = [...this.changed]; this.changed.clear();
    for (const userId of changed) this.onChange(userId);
  }
  invalidReason(state, now, checkQueue = state.status === 'searching') {
    if (!this.store.user(state.userId)) return 'person_unavailable';
    const profile = this.store.profile(state.userId);
    if (!profile || profile.revision !== state.revision) return 'profile_changed';
    if (state.lastSeen + this.offlineMs <= now) return 'offline';
    if (checkQueue && state.queueExpiresAt <= now) return 'queue_expired';
    return null;
  }
  remember(pair) {
    this.pairs.delete(pair.id);
    this.closed.set(pair.id, { users: [...pair.users], expiresAt: this.now() + this.retentionMs });
    if (this.closed.size > 2000) this.closed.delete(this.closed.keys().next().value);
    this.avoided.set(pairKey(...pair.users), { users: [...pair.users], expiresAt: this.now() + this.avoidMs });
    if (this.avoided.size > 5000) this.avoided.delete(this.avoided.keys().next().value);
  }
  release(pair, reasons = {}, stopped = new Set()) {
    this.remember(pair);
    for (const userId of pair.users) {
      const state = this.states.get(userId);
      if (!state || state.pairId !== pair.id) continue;
      const invalid = this.invalidReason(state, this.now(), true);
      if (stopped.has(userId) || invalid) this.idle(state, stopped.has(userId) ? reasons[userId] || 'cancelled' : invalid);
      else this.update(state, { status: 'searching', pairId: null, partnerId: null, conversationId: null, reason: reasons[userId] || 'peer_left' });
    }
  }
  withdraw(userId, reason, includeCompleted = false) {
    const state = this.states.get(userId);
    if (!state || (!active(state) && !includeCompleted)) return;
    const pair = this.pairs.get(state.pairId);
    if (pair) this.release(pair, { [userId]: reason }, new Set([userId]));
    else this.idle(state, reason);
  }
  invalidate(userId, reason = 'profile_changed') { this.withdraw(userId, reason); this.tick(); }
  forget(userId, reason = 'account_changed') {
    this.withdraw(userId, reason, true); this.states.delete(userId);
    for (const [id, entry] of this.closed) if (entry.users.includes(userId)) this.closed.delete(id);
    for (const [id, entry] of this.avoided) if (entry.users.includes(userId)) this.avoided.delete(id);
    this.tick();
  }
  blocked(a, b) {
    const state = this.states.get(a);
    if (state?.status === 'proposed' && state.partnerId === b) this.withdraw(a, 'blocked');
    this.tick();
  }
  mayBlock(userId, targetId) {
    this.tick();
    const state = this.states.get(userId);
    return state?.status === 'proposed' && state.partnerId === targetId;
  }
  tick() {
    if (this.processing) return;
    this.processing = true;
    try {
      const now = this.now();
      for (const entries of [this.closed, this.avoided]) for (const [id, entry] of entries) if (entry.expiresAt <= now) entries.delete(id);
      for (const [id, state] of this.states) {
        if (active(state)) {
          const reason = this.invalidReason(state, now);
          if (reason) this.withdraw(id, reason);
        } else if (state.status === 'connected') {
          const connection = this.store.connectionBetween(id, state.partnerId);
          if (!connection || connection.id !== state.conversationId || this.store.isBlocked(id, state.partnerId)) this.idle(state, 'person_unavailable');
          else if (state.updatedAt + this.retentionMs <= now) this.states.delete(id);
        } else if (state.updatedAt + this.retentionMs <= now) this.states.delete(id);
      }
      for (const pair of [...this.pairs.values()]) {
        if (pair.expiresAt <= now) this.release(pair, Object.fromEntries(pair.users.map(id => [id, 'proposal_expired'])));
        else if (this.store.isBlocked(...pair.users) || this.store.activeInvitationBetween(...pair.users)) this.release(pair, Object.fromEntries(pair.users.map(id => [id, 'pair_unavailable'])));
      }
      this.matchWaiting();
    } finally { this.processing = false; this.flush(); }
  }
  matchWaiting() {
    const queue = [...this.states.values()].filter(state => state.status === 'searching').sort((a, b) => a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId));
    const profiles = new Map(queue.map(state => [state.userId, this.store.profile(state.userId)]));
    const people = new Map(queue.map(state => [state.userId, publicProfile(profiles.get(state.userId), this.store.user(state.userId))]));
    for (const a of queue) {
      if (a.status !== 'searching') continue;
      const candidates = queue.filter(b => b.status === 'searching' && a.userId !== b.userId
        && !this.avoided.has(pairKey(a.userId, b.userId)) && !this.store.isBlocked(a.userId, b.userId)
        && !this.store.activeInvitationBetween(a.userId, b.userId)
        && (!a.topic || profiles.get(b.userId).interests.some(t => t.id === a.topic))
        && (!b.topic || profiles.get(a.userId).interests.some(t => t.id === b.topic)))
        .map(b => ({ state: b, score: (compareProfiles(profiles.get(a.userId), people.get(b.userId), a.mode).score + compareProfiles(profiles.get(b.userId), people.get(a.userId), b.mode).score) / 2 }))
        .sort((x, y) => y.score - x.score || x.state.joinedAt - y.state.joinedAt || x.state.userId.localeCompare(y.state.userId));
      const b = candidates[0]?.state;
      if (!b) continue;
      const pair = { id: randomUUID(), users: [a.userId, b.userId], accepted: new Set(), expiresAt: this.now() + this.proposalMs };
      this.pairs.set(pair.id, pair);
      this.update(a, { status: 'proposed', pairId: pair.id, partnerId: b.userId, reason: null });
      this.update(b, { status: 'proposed', pairId: pair.id, partnerId: a.userId, reason: null });
    }
  }
  snapshot(userId) {
    const state = this.states.get(userId);
    const result = { status: state?.status || 'idle', attemptId: state?.attemptId || null, mode: state?.mode || 'resonance', topic: state?.topic || null,
      expiresAt: null, heartbeatExpiresAt: null, pair: null, conversationId: state?.conversationId || null, reason: state?.reason || null, notice: state?.reason ? notices[state.reason] || null : null };
    if (!state) return result;
    if (active(state)) result.heartbeatExpiresAt = new Date(state.lastSeen + this.offlineMs).toISOString();
    if (state.status === 'searching') result.expiresAt = new Date(state.queueExpiresAt).toISOString();
    if (state.status === 'proposed' || state.status === 'connected') {
      const pair = this.pairs.get(state.pairId), own = this.store.profile(userId), partner = this.store.profile(state.partnerId), identity = this.store.user(state.partnerId);
      if (own && partner && identity) result.pair = { id: state.pairId,
        person: { ...compareProfiles(own, publicProfile(partner, identity), state.mode), saved: this.store.savedIds(userId).includes(state.partnerId) },
        acceptedByMe: state.status === 'connected' || Boolean(pair?.accepted.has(userId)),
        acceptedByOther: state.status === 'connected' || Boolean(pair?.accepted.has(state.partnerId)) };
      if (pair) result.expiresAt = new Date(pair.expiresAt).toISOString();
    }
    return result;
  }
  state(userId) { this.tick(); return this.snapshot(userId); }
  start(userId, { revision, mode = 'resonance', topic = null } = {}) {
    this.tick();
    const profile = this.store.profile(userId), user = this.store.user(userId);
    if (!user || !profile || user.provider === 'demo') fail(400, 'profile_required', '先生成自己的知识画像，再开始在线匹配');
    if (!Number.isInteger(revision) || revision < 1) fail(400, 'invalid_revision', '请提供当前画像版本');
    if (revision !== profile.revision) fail(409, 'profile_changed', '画像已更新，请查看后重新开始匹配');
    if (!['resonance', 'complement'].includes(mode)) fail(400, 'invalid_mode', '请选择同频或互补匹配');
    if (topic === 'all' || topic === '') topic = null;
    if (topic !== null && !TOPIC_MAP.has(topic)) fail(400, 'invalid_topic', '请选择有效的兴趣方向');
    let state = this.states.get(userId);
    if (active(state)) {
      if (state.mode !== mode || state.topic !== topic) fail(409, 'pairing_active', '本轮匹配已经开始；先停止，再更换筛选条件');
      state.lastSeen = this.now(); return this.state(userId);
    }
    if ([...this.states.values()].filter(active).length >= this.maxParticipants) fail(429, 'pairing_full', '当前在线匹配人数较多，请稍后再试');
    const now = this.now();
    state = { userId, status: 'searching', attemptId: randomUUID(), revision, mode, topic,
      joinedAt: now, queueExpiresAt: now + this.queueMs, lastSeen: now, updatedAt: now, pairId: null, partnerId: null, conversationId: null, reason: null };
    this.states.set(userId, state); this.changed.add(userId);
    return this.state(userId);
  }
  heartbeat(userId, attemptId) {
    if (attemptId !== undefined && !uuid(attemptId)) fail(400, 'invalid_attempt', '匹配轮次标识格式不正确');
    this.tick(); const state = this.states.get(userId);
    if (active(state) && (attemptId === undefined || attemptId === state.attemptId)) state.lastSeen = this.now();
    return this.state(userId);
  }
  cancel(userId, attemptId) {
    if (attemptId !== undefined && !uuid(attemptId)) fail(400, 'invalid_attempt', '匹配轮次标识格式不正确');
    this.tick(); const state = this.states.get(userId);
    if (state && (attemptId === undefined || attemptId === state.attemptId)) this.withdraw(userId, 'cancelled', true);
    return this.state(userId);
  }
  respond(userId, pairId, decision) {
    if (!uuid(pairId)) fail(400, 'invalid_pair', '配对标识格式不正确');
    if (!['accept', 'skip'].includes(decision)) fail(400, 'invalid_decision', '请选择确认或换一位');
    this.tick();
    const pair = this.pairs.get(pairId), state = this.states.get(userId);
    if (!pair || !pair.users.includes(userId) || state?.pairId !== pairId) {
      if (state?.status === 'connected' && state.pairId === pairId || this.closed.get(pairId)?.users.includes(userId)) return this.snapshot(userId);
      fail(404, 'pairing_missing', '这次配对已结束或无法访问');
    }
    state.lastSeen = this.now();
    if (decision === 'skip') {
      this.release(pair, Object.fromEntries(pair.users.map(id => [id, id === userId ? 'skipped' : 'peer_skipped'])));
      return this.state(userId);
    }
    pair.accepted.add(userId); for (const id of pair.users) this.changed.add(id);
    if (pair.accepted.size === 2) {
      try {
        const conversationId = this.store.connectPairing(pair.id, pair.users[0], pair.users[1], this.states.get(pair.users[0]).revision, this.states.get(pair.users[1]).revision);
        this.remember(pair);
        for (const id of pair.users) this.update(this.states.get(id), { status: 'connected', conversationId, reason: null });
      } catch (error) {
        this.release(pair, Object.fromEntries(pair.users.map(id => [id, 'pair_unavailable'])));
        this.tick();
        if (!(error instanceof AppError)) throw error;
      }
    }
    return this.state(userId);
  }
}
