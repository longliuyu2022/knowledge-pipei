import { randomBytes } from 'node:crypto';
import { fail } from '../errors.js';
import { initializeCircles } from './schema.js';
import { makeId, digest, json, parse, text, bool, oneOf, identifier, ids, capacity, tags, sourceUrl, normalizeQuestionUrl } from './validation.js';
import { facilitate, rules } from './facilitator.js';

const ACTIVE_PHASES = ['recruiting', 'discussing', 'reviewing'];
const DURATIONS = ['24h', '7d', 'ongoing'];
const TRANSITIONS = {
  recruiting: ['discussing', 'dormant', 'archived'],
  discussing: ['reviewing', 'dormant', 'archived'],
  reviewing: ['discussing', 'completed', 'dormant', 'archived'],
  completed: ['archived'], archived: [], dormant: ['discussing', 'archived'],
};
const REDACTED = '这项内容涉及已隐藏、屏蔽、删除或撤回授权的材料，请根据当前可见讨论重新整理。';

export class Circles {
  constructor(options) {
    this.options = options; this.store = options.store; this.db = options.store.db;
    this.clock = options.clock || Date.now; this.closed = false; this.savepoint = 0; this.maintenanceRunning = false;
    initializeCircles(this.db);
    const interval = options.intervalMs ?? 60000;
    if (interval > 0) { this.timer = setInterval(() => { this.runMaintenance().catch(() => {}); }, interval); this.timer.unref?.(); }
  }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); }
  stamp() { return new Date(this.clock()).toISOString(); }
  guard() { if (this.closed) fail(503, 'circles_closed', '小组服务正在重启，请稍后重试'); }
  transaction(callback) {
    const name = `circle_write_${++this.savepoint}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try { const result = callback(); this.db.exec(`RELEASE SAVEPOINT ${name}`); return result; }
    catch (error) { this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`); throw error; }
  }
  user(userId) { if (!userId || !this.store.user(userId) || (this.store.isActive && !this.store.isActive(userId))) fail(401, 'session_expired', '会话已结束或账号已停用，请重新登录'); return userId; }
  async assertRequest(req, userId) {
    this.guard();
    if (req) {
      if (this.options.assertSession) await this.options.assertSession(req);
      this.guard();
      if (req.viewer?.id !== userId) fail(401, 'session_expired', '会话已改变，请刷新后重试');
    }
    this.user(userId);
  }
  limited(key, count = 20) { this.options.rate?.(`circles:${key}`, count, 60000); }
  rawGroup(circleId) { const row = this.db.prepare('SELECT * FROM circle_groups WHERE id=?').get(circleId); if (!row) fail(404, 'circle_missing', '找不到这个问题小组'); return row; }
  rawRound(roundId) { return this.db.prepare('SELECT * FROM circle_rounds WHERE id=?').get(roundId); }
  rawMember(circleId, userId) {
    if (!userId || (this.store.isActive && !this.store.isActive(userId))) return null;
    return this.db.prepare("SELECT * FROM circle_memberships WHERE circle_id=? AND user_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)").get(circleId, userId, this.clock()) || null;
  }
  clean(circleId) {
    const expired = this.db.prepare("SELECT user_id,expires_at FROM circle_memberships WHERE circle_id=? AND status='active'").all(circleId).filter(row => (row.expires_at !== null && row.expires_at <= this.clock()) || (this.store.isActive && !this.store.isActive(row.user_id)));
    if (expired.length) this.transaction(() => {
      for (const member of expired) this.db.prepare("UPDATE circle_memberships SET status=?,role='member',subscribed=0,allow_connections=0,ai_revision=ai_revision+1,left_at=? WHERE circle_id=? AND user_id=? AND status='active'").run(member.expires_at !== null && member.expires_at <= this.clock() ? 'expired' : 'left', this.stamp(), circleId, member.user_id);
      this.transferHost(circleId);
      this.db.prepare('UPDATE circle_groups SET updated_at=? WHERE id=?').run(this.stamp(), circleId);
    });
    return expired.length;
  }
  transferHost(circleId) {
    if (this.db.prepare("SELECT 1 FROM circle_memberships WHERE circle_id=? AND role='host' AND status='active' AND (expires_at IS NULL OR expires_at>?)").get(circleId, this.clock())) return;
    const next = this.db.prepare("SELECT user_id FROM circle_memberships WHERE circle_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY joined_at,rowid LIMIT 1").get(circleId, this.clock());
    if (next) this.db.prepare("UPDATE circle_memberships SET role='host' WHERE circle_id=? AND user_id=?").run(circleId, next.user_id);
  }
  member(circleId, userId, host = false) {
    this.guard(); this.user(userId); this.rawGroup(circleId); this.clean(circleId);
    const member = this.rawMember(circleId, userId);
    if (!member) fail(403, 'membership_required', '加入或续期后才能查看和参与小组讨论');
    if (host && member.role !== 'host') fail(403, 'host_required', '仅小组主持人可以执行此操作');
    return member;
  }
  writable(circleId, userId, roundId = null) {
    const member = this.member(circleId, userId), circle = this.rawGroup(circleId), round = this.rawRound(circle.current_round_id);
    if ((roundId && round.id !== roundId) || !ACTIVE_PHASES.includes(round.status)) fail(409, 'round_readonly', '本轮已结束或休眠，请由主持人恢复讨论或开启下一轮');
    return { member, circle, round };
  }
  roundDTO(row) { return { id: row.id, circleId: row.circle_id, number: row.number, question: row.question, goal: row.goal, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }; }
  memberDTO(row) { return row ? { userId: row.user_id, role: row.role, active: true, duration: row.duration, goal: row.goal, stage: row.stage, subscribed: Boolean(row.subscribed), allowConnections: Boolean(row.allow_connections), aiConsent: Boolean(row.ai_consent), joinedAt: row.joined_at, expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString() } : null; }
  author(userId) {
    const user = userId && this.store.user(userId);
    if (!user) return null;
    const name = this.store.profile?.(userId)?.input?.name || (this.store.isActive || user.provider === 'guest' ? user.name : null) || `知友·${digest(userId).slice(0, 5)}`;
    return { id: user.id, name, avatar: '', avatarHue: parseInt(digest(user.id).slice(0, 4), 16) % 360 };
  }
  blocked(circleId, viewerId, targetId) {
    if (!viewerId || !targetId || viewerId === targetId) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM circle_blocks WHERE circle_id=? AND user_id=? AND target_id=?').get(circleId, viewerId, targetId) || this.db.prepare('SELECT 1 FROM blocked WHERE user_id=? AND target_id=?').get(viewerId, targetId));
  }
  canConnect(userId, targetId, circleId) {
    if (!userId || userId === targetId || !circleId || !this.store.user(userId) || !this.store.user(targetId)) return false;
    if (this.store.isActive && (!this.store.isActive(userId) || !this.store.isActive(targetId))) return false;
    if (this.store.preferences?.(targetId)?.preferences?.groupInvites === false) return false;
    const mine = this.rawMember(circleId, userId), theirs = this.rawMember(circleId, targetId);
    return Boolean(mine?.allow_connections && theirs?.allow_connections && !this.store.isBlocked(userId, targetId) && !this.blocked(circleId, userId, targetId) && !this.blocked(circleId, targetId, userId));
  }
  unavailable(row, viewerId, visited = new Set()) {
    if (!row || row.hidden_at || this.blocked(row.circle_id, viewerId, row.author_id || row.created_by)) return true;
    if (visited.has(row.id)) return true;
    const nextVisited = new Set([...visited, row.id]);
    const dependencies = new Set([...parse(row.dependency_ids), ...parse(row.citations).map(c => c.messageId)]);
    if (row.origin_message_id) dependencies.add(row.origin_message_id);
    for (const id of dependencies) {
      const message = this.db.prepare('SELECT * FROM circle_messages WHERE id=?').get(id);
      if (!message || message.circle_id !== row.circle_id || message.round_id !== row.round_id || this.unavailable(message, viewerId, nextVisited)) return true;
    }
    for (const id of new Set([...parse(row.source_ids), ...parse(row.dependency_source_ids)])) {
      const source = this.db.prepare('SELECT * FROM circle_sources WHERE id=?').get(id);
      if (!source || source.circle_id !== row.circle_id || source.round_id !== row.round_id || source.hidden_at || this.blocked(row.circle_id, viewerId, source.created_by)) return true;
    }
    if (row.ai_mode === 'model') for (const consent of parse(row.consent_versions)) {
      const member = this.rawMember(row.circle_id, consent.userId);
      if (!member?.ai_consent || member.ai_revision !== consent.revision) return true;
    }
    return false;
  }
  citations(row) {
    return parse(row.citations).map(citation => {
      const message = this.db.prepare('SELECT author_id,text FROM circle_messages WHERE id=?').get(citation.messageId);
      return { messageId: citation.messageId, name: this.author(message?.author_id)?.name || '已注销成员', quote: (message?.text || '').slice(0, 240), ...(citation.label ? { label: citation.label } : {}) };
    });
  }
  messageDTO(row, viewerId) {
    const hidden = this.unavailable(row, viewerId), redacted = hidden && row.kind === 'ai';
    const reply = row.reply_to ? this.db.prepare('SELECT * FROM circle_messages WHERE id=?').get(row.reply_to) : null;
    return { id: row.id, circleId: row.circle_id, roundId: row.round_id, kind: row.kind, authorId: row.author_id, author: this.author(row.author_id),
      text: hidden ? (redacted ? REDACTED : '这条发言已隐藏或被你屏蔽。') : row.text,
      replyTo: row.reply_to, reply: reply ? { id: reply.id, text: this.unavailable(reply, viewerId) ? '引用的发言已不可见。' : reply.text.slice(0, 180), authorName: this.author(reply.author_id)?.name || 'AI 主持' } : null,
      action: row.action, aiMode: row.ai_mode, citations: hidden ? [] : this.citations(row), sourceIds: hidden ? [] : parse(row.source_ids), hidden, redacted, createdAt: row.created_at };
  }
  sourceDTO(row) { return { id: row.id, circleId: row.circle_id, roundId: row.round_id, title: row.title, url: row.url, author: row.author, summary: row.summary, scope: row.scope, createdBy: row.created_by, createdAt: row.created_at }; }
  outcomeDTO(row, viewerId, current = row) {
    const redacted = Boolean(current.hidden_at) || this.unavailable(row, viewerId);
    return { id: row.id, circleId: row.circle_id, roundId: row.round_id, title: redacted ? '需要重新整理的成果' : row.title, content: redacted ? REDACTED : row.content, status: row.status, version: row.version,
      aiMode: row.ai_mode, citations: redacted ? [] : this.citations(row), sourceIds: redacted ? [] : parse(row.source_ids), redacted,
      createdBy: row.created_by, updatedBy: row.updated_by, reviewedBy: row.reviewed_by, reviewedByName: row.reviewed_by ? this.author(row.reviewed_by)?.name || '已注销成员' : null,
      reviewedAt: row.reviewed_at, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  unread(circleId, userId) {
    if (!this.rawMember(circleId, userId)) return 0;
    const rows = this.db.prepare(`SELECT m.* FROM circle_messages m LEFT JOIN circle_reads r ON r.circle_id=m.circle_id AND r.round_id=m.round_id AND r.user_id=?
      WHERE m.circle_id=? AND m.rowid>COALESCE(r.last_seq,0) AND (m.author_id IS NULL OR m.author_id<>?) AND m.hidden_at IS NULL`).all(userId, circleId, userId);
    return rows.filter(row => !this.unavailable(row, userId)).length;
  }
  summary(circleId, userId) {
    this.clean(circleId); const circle = this.rawGroup(circleId), membership = userId ? this.rawMember(circleId, userId) : null;
    return { id: circle.id, title: circle.title, description: circle.description, questionId: circle.question_id, questionUrl: circle.question_url, tags: parse(circle.tags), capacity: circle.capacity,
      memberCount: this.db.prepare("SELECT COUNT(*) AS count FROM circle_memberships WHERE circle_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)").get(circleId, this.clock()).count,
      currentRound: this.roundDTO(this.rawRound(circle.current_round_id)), joined: Boolean(membership), membership: this.memberDTO(membership), unreadCount: membership ? this.unread(circleId, userId) : 0,
      aiEnabled: Boolean(circle.ai_enabled), autoSummary: Boolean(circle.auto_summary), aiStatus: { pending: circle.ai_lease_until > this.clock(), lastRunAt: circle.last_ai_at ? new Date(circle.last_ai_at).toISOString() : null, lastSummaryAt: circle.last_summary_at ? new Date(circle.last_summary_at).toISOString() : null }, createdAt: circle.created_at, updatedAt: circle.updated_at };
  }
  list(userId, query = {}) {
    const q = text(query.q, '搜索词', 200).toLowerCase(), normalized = normalizeQuestionUrl(query.questionUrl);
    return this.db.prepare('SELECT id FROM circle_groups ORDER BY updated_at DESC,id LIMIT 200').all().map(row => this.summary(row.id, userId)).filter(circle =>
      (!(query.mine === '1' || query.mine === 'true' || query.mine === true) || circle.joined) && (!normalized.questionId || circle.questionId === normalized.questionId) &&
      (!q || `${circle.title} ${circle.description} ${circle.currentRound.question} ${circle.currentRound.goal} ${circle.tags.join(' ')}`.toLowerCase().includes(q)));
  }
  recommendations(userId, input = {}) {
    const profile = userId ? this.store.profile?.(userId) : null;
    const supplied = [text(input.q, '问题', 500), text(input.goal, '目标', 500), text(input.stage, '阶段', 200)];
    const interests = (profile?.interests || []).map(i => i.label || '').filter(Boolean);
    const query = [...supplied, ...interests].join(' ').toLowerCase();
    const tokens = [...new Set([...query.split(/[\s,，。；;、!?！？]+/).filter(Boolean), ...interests.map(t => t.toLowerCase())])];
    const circles = this.list(userId).filter(c => c.currentRound.status !== 'archived' && c.memberCount < c.capacity).map(circle => {
      const body = `${circle.title} ${circle.currentRound.question} ${circle.currentRound.goal} ${circle.tags.join(' ')}`.toLowerCase();
      const hits = tokens.filter(token => token.length > 1 && body.includes(token));
      const tagHits = circle.tags.filter(tag => query.includes(tag.toLowerCase()));
      const shared = [...new Set([...hits, ...tagHits])].slice(0, 3);
      return { circle, score: hits.length + tagHits.length * 2, reasons: shared.length ? [`你关注的“${shared.join('、')}”与本轮问题相关。`, `本轮目标：${circle.currentRound.goal}`] : [`可以探索：${circle.currentRound.question}`, '暂未找到明确兴趣交集，请根据目标自行判断。'] };
    }).sort((a, b) => b.score - a.score).slice(0, 12).map(({ circle, reasons }) => ({ ...circle, reasons }));
    return { circles, mode: 'rules', profileUsed: Boolean(profile), notice: circles.length ? (profile ? null : '可以直接按问题探索；确认知识画像后可结合兴趣推荐。') : '暂时没有可加入的小组，可以为你的具体问题创建一个。' };
  }
  page(circleId, userId, { roundId, before } = {}) {
    this.member(circleId, userId); const circle = this.rawGroup(circleId), round = this.rawRound(roundId || circle.current_round_id);
    if (!round || round.circle_id !== circleId) fail(404, 'round_missing', '找不到这个讨论轮次');
    let cursor = Number.MAX_SAFE_INTEGER;
    if (before) { const position = this.db.prepare('SELECT rowid AS seq FROM circle_messages WHERE id=? AND round_id=?').get(identifier(before), round.id); if (!position) fail(400, 'invalid_cursor', '消息分页位置无效'); cursor = position.seq; }
    const rows = this.db.prepare('SELECT * FROM circle_messages WHERE round_id=? AND rowid<? ORDER BY rowid DESC LIMIT 101').all(round.id, cursor);
    return { messages: rows.slice(0, 100).reverse().map(row => this.messageDTO(row, userId)), hasMore: rows.length > 100, nextBefore: rows.length > 100 ? rows[99].id : null };
  }
  detail(circleId, userId, roundId = null) {
    const summary = this.summary(circleId, userId);
    const empty = { ...summary, selectedRoundId: summary.currentRound.id, rounds: [], members: [], messages: [], sources: [], outcomes: [], hasMoreMessages: false, nextBefore: null };
    if (!summary.joined) return empty;
    const selected = this.rawRound(roundId || summary.currentRound.id);
    if (!selected || selected.circle_id !== circleId) fail(404, 'round_missing', '找不到这个讨论轮次');
    const page = this.page(circleId, userId, { roundId: selected.id });
    return { ...empty, selectedRoundId: selected.id, rounds: this.db.prepare('SELECT * FROM circle_rounds WHERE circle_id=? ORDER BY number').all(circleId).map(row => this.roundDTO(row)),
      members: this.db.prepare("SELECT * FROM circle_memberships WHERE circle_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY joined_at,rowid").all(circleId, this.clock()).map(row => ({ ...this.author(row.user_id), role: row.role, goal: row.goal, stage: row.stage, joinedAt: row.joined_at, expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(), blocked: this.blocked(circleId, userId, row.user_id), canConnect: this.canConnect(userId, row.user_id, circleId) })),
      messages: page.messages, hasMoreMessages: page.hasMore, nextBefore: page.nextBefore,
      sources: this.db.prepare('SELECT * FROM circle_sources WHERE round_id=? AND hidden_at IS NULL ORDER BY rowid').all(selected.id).filter(row => !this.blocked(circleId, userId, row.created_by)).map(row => this.sourceDTO(row)),
      outcomes: this.db.prepare('SELECT * FROM circle_outcomes WHERE round_id=? ORDER BY rowid DESC').all(selected.id).map(row => this.outcomeDTO(row, userId)) };
  }
  expiry(duration) { return duration === 'ongoing' ? null : this.clock() + (duration === '24h' ? 86400000 : 7 * 86400000); }
  changed(circleId, { actorId, kind = 'circle_update', publicChange = false, notify = false } = {}) {
    if (this.closed) return;
    const members = this.db.prepare("SELECT * FROM circle_memberships WHERE circle_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)").all(circleId, this.clock());
    for (const member of members) {
      if (this.store.isActive && !this.store.isActive(member.user_id)) continue;
      this.options.emit?.(member.user_id, 'circles');
      if (!notify || !member.subscribed || member.user_id === actorId || !this.options.notify) continue;
      const previous = this.db.prepare('SELECT last_at FROM circle_notification_state WHERE circle_id=? AND user_id=? AND kind=?').get(circleId, member.user_id, kind);
      if (previous && this.clock() - previous.last_at < 15 * 60000) continue;
      this.db.prepare('INSERT INTO circle_notification_state VALUES (?,?,?,?) ON CONFLICT(circle_id,user_id,kind) DO UPDATE SET last_at=excluded.last_at').run(circleId, member.user_id, kind, this.clock());
      const result = this.options.notify(member.user_id, { kind, title: this.rawGroup(circleId).title, body: kind === 'circle_outcome' ? '小组已有新的待核对成果，打开查看。' : '你加入的小组有新进展，打开查看。', href: `/#circles/${circleId}` });
      if (result?.catch) result.catch(() => {});
    }
    if (actorId && !members.some(member => member.user_id === actorId)) this.options.emit?.(actorId, 'circles');
    if (publicChange) this.options.broadcast?.('circles');
  }
  create(userId, data) {
    this.user(userId); this.limited(`create:${userId}`, 5);
    const title = text(data.title, '小组标题', 100, 2), question = text(data.question, '具体问题', 500, 5), goal = text(data.goal, '本轮目标', 500, 2), description = text(data.description, '说明', 1200);
    const link = normalizeQuestionUrl(data.questionUrl), topicTags = tags(data.tags), limit = capacity(data.capacity), duration = oneOf(data.duration, DURATIONS, 'ongoing'), consent = bool(data.aiConsent), subscribed = bool(data.subscribed, true), connections = bool(data.allowConnections);
    const circleId = makeId('circle'), roundId = makeId('round'), stamp = this.stamp();
    this.transaction(() => {
      this.db.prepare('INSERT INTO circle_groups (id,title,description,question_id,question_url,tags,capacity,current_round_id,created_by,activity_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(circleId, title, description, link.questionId, link.questionUrl, json(topicTags), limit, roundId, userId, this.clock(), stamp, stamp);
      this.db.prepare('INSERT INTO circle_rounds (id,circle_id,number,question,goal,created_by,created_at,updated_at) VALUES (?,?,1,?,?,?,?,?)').run(roundId, circleId, question, goal, userId, stamp, stamp);
      this.db.prepare("INSERT INTO circle_memberships (circle_id,user_id,role,duration,goal,ai_consent,subscribed,allow_connections,joined_at,expires_at) VALUES (?,?,'host',?,?,?,?,?,?,?)").run(circleId, userId, duration, goal, consent ? 1 : 0, Number(subscribed), Number(connections), stamp, this.expiry(duration));
    });
    this.changed(circleId, { publicChange: true }); return this.detail(circleId, userId);
  }
  join(circleId, userId, data) {
    this.user(userId); const circle = this.rawGroup(circleId); this.clean(circleId);
    if (this.rawMember(circleId, userId)) return this.preferences(circleId, userId, data);
    const duration = oneOf(data.duration, DURATIONS, 'ongoing'), goal = text(data.goal, '参与目标', 500), stage = text(data.stage, '当前阶段', 200);
    const subscribed = bool(data.subscribed, true), connections = bool(data.allowConnections), consent = bool(data.aiConsent);
    this.limited(`join:${userId}`, 20);
    this.transaction(() => {
      if (this.rawRound(circle.current_round_id).status === 'archived') fail(409, 'circle_archived', '小组当前轮次已归档，请等待主持人开启下一轮');
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM circle_memberships WHERE circle_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)").get(circleId, this.clock()).n;
      if (count >= circle.capacity) fail(409, 'circle_full', '小组暂时已满，可以选择其他目标或创建新小组');
      this.db.prepare(`INSERT INTO circle_memberships (circle_id,user_id,duration,goal,stage,subscribed,allow_connections,ai_consent,joined_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(circle_id,user_id) DO UPDATE SET role='member',status='active',duration=excluded.duration,goal=excluded.goal,stage=excluded.stage,subscribed=excluded.subscribed,allow_connections=excluded.allow_connections,ai_consent=excluded.ai_consent,ai_revision=circle_memberships.ai_revision+1,joined_at=excluded.joined_at,expires_at=excluded.expires_at,left_at=NULL`).run(circleId, userId, duration, goal, stage, Number(subscribed), Number(connections), Number(consent), this.stamp(), this.expiry(duration));
      this.transferHost(circleId); this.db.prepare('UPDATE circle_groups SET updated_at=? WHERE id=?').run(this.stamp(), circleId);
    });
    this.changed(circleId, { publicChange: true }); return this.detail(circleId, userId);
  }
  preferences(circleId, userId, data) {
    const current = this.member(circleId, userId), duration = oneOf(data.duration, DURATIONS, current.duration);
    const goal = data.goal === undefined ? current.goal : text(data.goal, '参与目标', 500), stage = data.stage === undefined ? current.stage : text(data.stage, '当前阶段', 200);
    const subscribed = bool(data.subscribed, Boolean(current.subscribed)), connections = bool(data.allowConnections, Boolean(current.allow_connections)), consent = bool(data.aiConsent, Boolean(current.ai_consent));
    this.transaction(() => {
      this.db.prepare('UPDATE circle_memberships SET duration=?,goal=?,stage=?,subscribed=?,allow_connections=?,ai_consent=?,ai_revision=ai_revision+?,expires_at=? WHERE circle_id=? AND user_id=?').run(duration, goal, stage, Number(subscribed), Number(connections), Number(consent), current.ai_consent !== Number(consent) ? 1 : 0, data.duration === undefined ? current.expires_at : this.expiry(duration), circleId, userId);
      if (current.ai_consent && !consent) this.eraseDerived({ circleId, consentUserId: userId });
    });
    this.changed(circleId); return this.detail(circleId, userId);
  }
  leave(circleId, userId) {
    this.user(userId); this.rawGroup(circleId); this.clean(circleId);
    this.transaction(() => {
      this.db.prepare("UPDATE circle_memberships SET status='left',role='member',subscribed=0,allow_connections=0,ai_revision=ai_revision+1,left_at=? WHERE circle_id=? AND user_id=? AND status='active'").run(this.stamp(), circleId, userId);
      this.transferHost(circleId); this.db.prepare('UPDATE circle_groups SET updated_at=? WHERE id=?').run(this.stamp(), circleId);
    });
    this.changed(circleId, { actorId: userId, publicChange: true }); return this.detail(circleId, userId);
  }
  settings(circleId, userId, data) {
    this.member(circleId, userId, true); const circle = this.rawGroup(circleId);
    const enabled = bool(data.aiEnabled, Boolean(circle.ai_enabled)), automatic = bool(data.autoSummary, Boolean(circle.auto_summary)), limit = capacity(data.capacity, circle.capacity);
    if (automatic && !enabled) fail(400, 'ai_disabled', '启用自动主持前需先启用 AI 主持');
    if (limit < this.summary(circleId, userId).memberCount) fail(409, 'capacity_in_use', '人数上限不能小于当前有效成员数');
    this.db.prepare('UPDATE circle_groups SET ai_enabled=?,auto_summary=?,capacity=?,version=version+1,updated_at=? WHERE id=?').run(Number(enabled), Number(automatic), limit, this.stamp(), circleId);
    this.changed(circleId, { publicChange: true }); return this.detail(circleId, userId);
  }
  changePhase(circleId, userId, roundId, status) {
    this.member(circleId, userId, true); const circle = this.rawGroup(circleId), round = this.rawRound(roundId);
    if (!round || round.circle_id !== circleId || circle.current_round_id !== roundId) fail(409, 'round_readonly', '只能调整当前轮次，历史轮次保持只读');
    oneOf(status, Object.keys(TRANSITIONS));
    if (status !== round.status && !TRANSITIONS[round.status].includes(status)) fail(409, 'invalid_transition', '请按讨论、核对成果、阶段完成的顺序推进本轮');
    this.transaction(() => {
      this.db.prepare('UPDATE circle_rounds SET status=?,updated_at=? WHERE id=?').run(status, this.stamp(), roundId);
      this.db.prepare('UPDATE circle_groups SET version=version+1,activity_at=?,updated_at=? WHERE id=?').run(this.clock(), this.stamp(), circleId);
    });
    this.changed(circleId, { actorId: userId, publicChange: true, notify: true }); return this.detail(circleId, userId);
  }
  nextRound(circleId, userId, data) {
    this.member(circleId, userId, true); const circle = this.rawGroup(circleId), current = this.rawRound(circle.current_round_id);
    if (!['completed', 'archived'].includes(current.status)) fail(409, 'round_in_progress', '先核对并完成或归档当前轮次，再开启新轮');
    const question = text(data.question, '下一轮问题', 500, 5), goal = text(data.goal, '下一轮目标', 500, 2), roundId = makeId('round'), stamp = this.stamp();
    this.transaction(() => {
      this.db.prepare("UPDATE circle_rounds SET status='archived',updated_at=? WHERE id=?").run(stamp, current.id);
      this.db.prepare('INSERT INTO circle_rounds (id,circle_id,number,question,goal,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(roundId, circleId, current.number + 1, question, goal, userId, stamp, stamp);
      this.db.prepare('UPDATE circle_groups SET current_round_id=?,version=version+1,last_summary_seq=0,last_summary_at=0,activity_at=?,updated_at=? WHERE id=?').run(roundId, this.clock(), stamp, circleId);
    });
    this.changed(circleId, { actorId: userId, publicChange: true, notify: true }); return this.detail(circleId, userId);
  }
  markRead(circleId, userId, data) {
    this.member(circleId, userId); const roundId = data.roundId || this.rawGroup(circleId).current_round_id;
    if (this.rawRound(roundId)?.circle_id !== circleId) fail(404, 'round_missing', '找不到这个轮次');
    const position = data.messageId ? this.db.prepare('SELECT rowid AS seq FROM circle_messages WHERE id=? AND round_id=?').get(identifier(data.messageId), roundId) : this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS seq FROM circle_messages WHERE round_id=?').get(roundId);
    if (!position) fail(400, 'invalid_cursor', '已读位置无效');
    this.db.prepare('INSERT INTO circle_reads VALUES (?,?,?,?) ON CONFLICT(circle_id,user_id,round_id) DO UPDATE SET last_seq=MAX(circle_reads.last_seq,excluded.last_seq)').run(circleId, userId, roundId, position.seq);
    this.options.emit?.(userId, 'circles'); return { ok: true, unreadCount: this.unread(circleId, userId) };
  }
  validReply(circleId, roundId, userId, replyTo) {
    if (!replyTo) return;
    const reply = this.db.prepare('SELECT * FROM circle_messages WHERE id=?').get(replyTo);
    if (!reply || reply.circle_id !== circleId || reply.round_id !== roundId || this.unavailable(reply, userId)) fail(409, 'reply_unavailable', '被回复的发言不属于当前轮次或已不可见');
  }
  async sendMessage(req, circleId, data) {
    const userId = req.viewer?.id; this.member(circleId, userId);
    const content = text(data.text, '发言', 4000, 1), clientId = text(data.clientMessageId, '消息重试标识', 100, 8), replyTo = data.replyTo ? identifier(data.replyTo) : null;
    const existingResult = () => {
      const row = this.db.prepare('SELECT * FROM circle_messages WHERE circle_id=? AND author_id=? AND client_message_id=?').get(circleId, userId, clientId);
      if (!row) return null;
      if (row.text !== content || row.reply_to !== replyTo) fail(409, 'client_message_conflict', '这条重试标识已用于不同发言');
      return { message: this.messageDTO(row, userId), deduplicated: true };
    };
    const existing = existingResult(); if (existing) return existing;
    const { round } = this.writable(circleId, userId); this.validReply(circleId, round.id, userId, replyTo); this.limited(`message:${userId}`, 30);
    await this.assertRequest(req, userId);
    if (!this.options.moderate) fail(503, 'moderation_unavailable', '内容检查暂不可用，请稍后重试');
    const verdict = await this.options.moderate({ userId, text: content, scope: 'circle', scopeId: circleId });
    await this.assertRequest(req, userId); this.writable(circleId, userId, round.id); this.validReply(circleId, round.id, userId, replyTo);
    if (verdict?.allowed !== true) fail(422, 'message_not_allowed', typeof verdict?.notice === 'string' ? verdict.notice.slice(0, 500) : '这条发言暂未通过内容检查');
    const result = this.transaction(() => {
      const duplicate = existingResult(); if (duplicate) return duplicate;
      const messageId = makeId('message');
      this.db.prepare('INSERT INTO circle_messages (id,circle_id,round_id,author_id,text,reply_to,client_message_id,created_at) VALUES (?,?,?,?,?,?,?,?)').run(messageId, circleId, round.id, userId, content, replyTo, clientId, this.stamp());
      this.db.prepare("UPDATE circle_rounds SET status='discussing',updated_at=? WHERE id=? AND status='recruiting'").run(this.stamp(), round.id);
      this.db.prepare('UPDATE circle_groups SET activity_at=?,updated_at=? WHERE id=?').run(this.clock(), this.stamp(), circleId);
      return { message: this.messageDTO(this.db.prepare('SELECT * FROM circle_messages WHERE id=?').get(messageId), userId), deduplicated: false };
    });
    if (!result.deduplicated) this.changed(circleId, { actorId: userId, notify: true, publicChange: true }); return result;
  }
  hideMessage(circleId, userId, messageId, erase = false) {
    const member = this.member(circleId, userId), row = this.db.prepare('SELECT * FROM circle_messages WHERE id=? AND circle_id=?').get(messageId, circleId);
    if (!row) fail(404, 'message_missing', '找不到这条发言');
    if (member.role !== 'host' && (!erase || row.author_id !== userId)) fail(403, 'host_required', '只有主持人可隐藏他人的发言');
    this.transaction(() => {
      this.db.prepare('UPDATE circle_messages SET hidden_at=?,text=? WHERE id=?').run(this.stamp(), erase ? '' : row.text, messageId);
      if (erase) this.eraseDerived({ circleId, messageIds: new Set([messageId]) });
    });
    this.changed(circleId); return { ok: true };
  }
  async search(req, circleId, query) {
    const userId = req.viewer?.id, { round } = this.writable(circleId, userId), q = text(query, '搜索词', 200, 2);
    this.limited(`search:${userId}`, 5); await this.assertRequest(req, userId);
    if (!this.options.zhihu?.search) fail(503, 'search_unavailable', '知乎搜索暂不可用，可以先添加手动资料链接');
    const result = await this.options.zhihu.search(q);
    await this.assertRequest(req, userId); this.writable(circleId, userId, round.id);
    this.db.prepare('DELETE FROM circle_search_receipts WHERE expires_at<=?').run(this.clock());
    const items = [];
    for (const item of (Array.isArray(result?.items) ? result.items : []).slice(0, 12)) {
      try {
        const source = { title: text(item.title, '搜索标题', 300, 1), url: sourceUrl(item.url), author: text(item.author || '', '作者', 200), summary: text(item.summary || '', '搜索摘要', 6000), scope: 'zhihu-search' };
        const token = randomBytes(24).toString('base64url');
        this.db.prepare('INSERT INTO circle_search_receipts (token_hash,user_id,circle_id,round_id,payload,expires_at) VALUES (?,?,?,?,?,?)').run(digest(token), userId, circleId, round.id, json(source), this.clock() + 15 * 60000);
        items.push({ ...source, id: String(item.id || digest(source.url).slice(0, 16)), searchResultToken: token });
      } catch { /* Invalid upstream entries cannot become trusted source cards. */ }
    }
    return { items, notice: typeof result?.notice === 'string' ? result.notice.slice(0, 500) : items.length ? null : '未找到有效来源，可以调整关键词或手动加入资料链接。' };
  }
  addSource(circleId, userId, data) {
    const { round } = this.writable(circleId, userId); this.limited(`source:${userId}`, 15);
    let source, tokenHash = null;
    if (data.searchResultToken !== undefined) {
      tokenHash = digest(text(data.searchResultToken, '搜索凭证', 100, 8));
      const receipt = this.db.prepare('SELECT * FROM circle_search_receipts WHERE token_hash=?').get(tokenHash);
      if (!receipt || receipt.user_id !== userId || receipt.circle_id !== circleId || receipt.round_id !== round.id || receipt.expires_at <= this.clock() || receipt.used_at) fail(409, 'search_result_expired', '来源凭证已失效或不属于当前用户和轮次，请重新搜索');
      source = parse(receipt.payload, null);
      if (!source) fail(409, 'search_result_expired', '来源凭证无效，请重新搜索');
    } else {
      const summary = text(data.summary, '成员摘录', 6000), scope = oneOf(data.scope, ['link', 'excerpt'], summary ? 'excerpt' : 'link');
      if (scope === 'link' && summary) fail(400, 'source_scope_invalid', '填写摘录时需明确标为成员摘录');
      source = { title: text(data.title, '资料标题', 300, 1), url: sourceUrl(data.url), author: text(data.author, '作者', 200), summary, scope };
    }
    const sourceId = makeId('source');
    this.transaction(() => {
      if (tokenHash) {
        const used = this.db.prepare('UPDATE circle_search_receipts SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?').run(this.clock(), tokenHash, this.clock());
        if (!used.changes) fail(409, 'search_result_expired', '这条来源凭证已经使用，请重新搜索');
      }
      this.db.prepare('INSERT INTO circle_sources (id,circle_id,round_id,title,url,author,summary,scope,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(sourceId, circleId, round.id, source.title, source.url, source.author, source.summary, source.scope, userId, this.stamp());
      this.db.prepare('UPDATE circle_groups SET updated_at=? WHERE id=?').run(this.stamp(), circleId);
    });
    this.changed(circleId, { actorId: userId, notify: true }); return this.sourceDTO(this.db.prepare('SELECT * FROM circle_sources WHERE id=?').get(sourceId));
  }
  deleteSource(circleId, userId, sourceId) {
    const member = this.member(circleId, userId), source = this.db.prepare('SELECT * FROM circle_sources WHERE id=? AND circle_id=?').get(sourceId, circleId);
    if (!source) fail(404, 'source_missing', '找不到这条资料');
    if (source.created_by !== userId && member.role !== 'host') fail(403, 'host_required', '只能删除本人加入的资料，或由主持人处理');
    this.transaction(() => {
      this.db.prepare("UPDATE circle_sources SET hidden_at=?,title='已删除资料',url='',summary='',author='' WHERE id=?").run(this.stamp(), sourceId);
      this.eraseDerived({ circleId, sourceIds: new Set([sourceId]) });
    });
    this.changed(circleId); return { ok: true };
  }
  references(circleId, roundId, userId, messageIds, sourceIds) {
    const citations = messageIds.map((id, index) => {
      const row = this.db.prepare('SELECT * FROM circle_messages WHERE id=?').get(id);
      if (!row || row.circle_id !== circleId || row.round_id !== roundId || row.kind !== 'human' || this.unavailable(row, userId)) fail(409, 'reference_unavailable', '引用的真人发言不属于本轮或已不可见');
      return { messageId: row.id, name: this.author(row.author_id)?.name || '已注销成员', quote: row.text.slice(0, 240), label: `发言 ${index + 1}` };
    });
    for (const sourceId of sourceIds) {
      const row = this.db.prepare('SELECT * FROM circle_sources WHERE id=?').get(sourceId);
      if (!row || row.circle_id !== circleId || row.round_id !== roundId || row.hidden_at || this.blocked(circleId, userId, row.created_by)) fail(409, 'reference_unavailable', '引用的资料不属于本轮或已不可见');
    }
    return { citations, sourceIds, dependencyIds: messageIds, dependencySourceIds: sourceIds, consentVersions: [] };
  }
  insertOutcome(circleId, roundId, userId, data, originMessageId = null) {
    const outcomeId = makeId('outcome'), stamp = this.stamp();
    this.db.prepare(`INSERT INTO circle_outcomes (id,circle_id,round_id,title,content,ai_mode,citations,source_ids,dependency_ids,dependency_source_ids,consent_versions,origin_message_id,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(outcomeId, circleId, roundId, data.title, data.content || data.text, data.mode || null, json(data.citations || []), json(data.sourceIds || []), json(data.dependencyIds || []), json(data.dependencySourceIds || []), json(data.consentVersions || []), originMessageId, userId, userId, stamp, stamp);
    this.saveOutcomeVersion(outcomeId); return this.db.prepare('SELECT * FROM circle_outcomes WHERE id=?').get(outcomeId);
  }
  saveOutcomeVersion(outcomeId) {
    const row = this.db.prepare('SELECT * FROM circle_outcomes WHERE id=?').get(outcomeId);
    this.db.prepare('INSERT INTO circle_outcome_versions (outcome_id,version,snapshot,created_at) VALUES (?,?,?,?)').run(row.id, row.version, json(row), this.stamp());
  }
  addOutcome(circleId, userId, data) {
    const { round } = this.writable(circleId, userId);
    const title = text(data.title, '成果标题', 120, 2), content = text(data.content, '成果正文', 16000, 5);
    const references = this.references(circleId, round.id, userId, ids(data.messageIds), ids(data.sourceIds));
    const row = this.transaction(() => this.insertOutcome(circleId, round.id, userId, { title, content, ...references }));
    this.changed(circleId, { actorId: userId, kind: 'circle_outcome', notify: true }); return this.outcomeDTO(row, userId);
  }
  getOutcome(circleId, userId, outcomeId, { writable = false, visible = true } = {}) {
    this.member(circleId, userId); const row = this.db.prepare('SELECT * FROM circle_outcomes WHERE id=? AND circle_id=?').get(outcomeId, circleId);
    if (!row) fail(404, 'outcome_missing', '找不到这份成果');
    if (writable && (this.rawGroup(circleId).current_round_id !== row.round_id || this.rawRound(row.round_id).status === 'archived')) fail(409, 'round_readonly', '历史轮次的成果保持只读');
    if (visible && this.unavailable(row, userId)) fail(409, 'outcome_redacted', REDACTED);
    return row;
  }
  editOutcome(circleId, userId, outcomeId, data) {
    const row = this.getOutcome(circleId, userId, outcomeId, { writable: true });
    if (!Number.isInteger(data.version) || data.version !== row.version) fail(409, 'outcome_version_conflict', '成果已由其他成员更新，请刷新后再编辑');
    const title = data.title === undefined ? row.title : text(data.title, '成果标题', 120, 2), content = data.content === undefined ? row.content : text(data.content, '成果正文', 16000, 5);
    const changed = title !== row.title || content !== row.content, status = oneOf(data.status, ['draft', 'reviewed'], changed ? 'draft' : row.status);
    this.transaction(() => {
      const updated = this.db.prepare('UPDATE circle_outcomes SET title=?,content=?,status=?,version=version+1,updated_by=?,updated_at=?,reviewed_by=?,reviewed_at=? WHERE id=? AND version=?').run(title, content, status, userId, this.stamp(), status === 'reviewed' ? userId : null, status === 'reviewed' ? this.stamp() : null, outcomeId, row.version);
      if (!updated.changes) fail(409, 'outcome_version_conflict', '成果已更新，请刷新后再编辑');
      this.saveOutcomeVersion(outcomeId);
    });
    this.changed(circleId); return this.outcomeDTO(this.db.prepare('SELECT * FROM circle_outcomes WHERE id=?').get(outcomeId), userId);
  }
  outcomeVersions(circleId, userId, outcomeId) {
    const row = this.getOutcome(circleId, userId, outcomeId, { visible: false });
    return this.db.prepare('SELECT snapshot FROM circle_outcome_versions WHERE outcome_id=? ORDER BY version DESC').all(outcomeId).map(version => this.outcomeDTO(parse(version.snapshot, {}), userId, row));
  }
  exportOutcome(circleId, userId, outcomeId) {
    const row = this.getOutcome(circleId, userId, outcomeId), outcome = this.outcomeDTO(row, userId);
    const sources = parse(row.source_ids).map(id => this.db.prepare('SELECT * FROM circle_sources WHERE id=?').get(id)).filter(Boolean);
    const references = outcome.citations.map((citation, i) => `${i + 1}. ${citation.name}：${citation.quote}`).join('\n');
    const links = sources.map(source => `- ${source.title} — ${source.author || '作者未提供'}\n  ${source.url}\n  来源范围：${source.scope === 'zhihu-search' ? '知乎搜索摘要' : source.scope === 'excerpt' ? '成员提供摘录' : '仅链接'}，不代表全文。`).join('\n');
    return `# ${outcome.title}\n\n${outcome.content}\n\n---\n版本：${outcome.version}；${outcome.status === 'reviewed' ? `核对人：${outcome.reviewedByName}（仅代表该成员核对，非全员共识）` : '尚待成员核对'}\n生成方式：${outcome.aiMode === 'model' ? 'AI 模型草稿' : outcome.aiMode === 'rules' ? '本地规则摘录' : '成员编写'}\n\n## 发言引用\n${references || '无附带引用。'}\n\n## 资料来源\n${links || '无附带资料。'}\n\n> 本文属于小组成员可见成果。向小组以外发布前，请确认发言者同意及可公开范围。\n`;
  }
  context(circleId, userId, { model = false } = {}) {
    const { circle, round } = this.writable(circleId, userId);
    const allowedAuthor = authorId => { const member = authorId && this.rawMember(circleId, authorId); return !model || Boolean(member?.ai_consent); };
    const rows = this.db.prepare("SELECT * FROM (SELECT rowid AS seq,* FROM circle_messages WHERE round_id=? AND kind='human' AND hidden_at IS NULL ORDER BY rowid DESC LIMIT 200) ORDER BY seq").all(round.id);
    const messages = rows.filter(row => !this.unavailable(row, userId) && allowedAuthor(row.author_id)).slice(-50).map(row => this.messageDTO(row, userId));
    const sources = this.db.prepare('SELECT * FROM circle_sources WHERE round_id=? AND hidden_at IS NULL ORDER BY rowid DESC LIMIT 100').all(round.id).filter(row => !this.blocked(circleId, userId, row.created_by) && allowedAuthor(row.created_by)).slice(0, 12).reverse().map(row => this.sourceDTO(row));
    const authorIds = [...new Set([userId, ...messages.map(m => m.authorId), ...sources.map(s => s.createdBy)].filter(Boolean))];
    const consentVersions = model ? authorIds.map(id => ({ userId: id, revision: this.rawMember(circleId, id).ai_revision })) : [];
    return { title: circle.title, question: round.question, goal: round.goal, messages, sources, consentVersions };
  }
  async runAI(req, circleId, data, automaticUserId = null) {
    const userId = req?.viewer?.id || automaticUserId;
    let { circle, round, member } = this.writable(circleId, userId);
    const action = oneOf(data.action, ['opener', 'summary', 'outcome']), useAI = bool(data.useAI, true), leaseKey = makeId('lease');
    await this.assertRequest(req, userId);
    ({ circle, round, member } = this.writable(circleId, userId));
    if (circle.ai_lease_until > this.clock()) fail(409, 'ai_busy', '小组正在整理，请等待当前结果');
    if (circle.last_ai_at && this.clock() - circle.last_ai_at < 30000) fail(429, 'ai_cooldown', '先留一点时间给真人讨论，30 秒后可再次整理');
    this.limited(`ai:${userId}`, 5);
    const leased = this.db.prepare('UPDATE circle_groups SET ai_lease_key=?,ai_lease_until=?,last_ai_at=? WHERE id=? AND ai_lease_until<=?').run(leaseKey, this.clock() + 120000, this.clock(), circleId, this.clock());
    if (!leased.changes) fail(409, 'ai_busy', '小组正在整理，请稍后重试');
    try {
      const local = this.context(circleId, userId), external = this.context(circleId, userId, { model: true });
      let generated;
      if (useAI && circle.ai_enabled && member.ai_consent && this.options.ai?.json && (external.messages.length || !local.messages.length || action === 'opener')) {
        try { generated = await facilitate(this.options.ai, action, external); }
        catch { generated = rules(action, local, '模型暂不可用或输出未通过引用校验，已使用本地规则摘录。'); }
      } else generated = rules(action, local, useAI ? '外部 AI 未获所需授权或暂未启用，使用本地规则摘录。' : '本次使用本地规则摘录。');
      await this.assertRequest(req, userId); this.writable(circleId, userId, round.id);
      const latest = this.rawGroup(circleId);
      if (latest.version !== circle.version || latest.ai_lease_key !== leaseKey || (automaticUserId && !latest.auto_summary)) fail(409, 'ai_context_changed', '小组设置或轮次已改变，请重新整理');
      const derived = { id: makeId('pending'), circle_id: circleId, round_id: round.id, dependency_ids: json(generated.dependencyIds), dependency_source_ids: json(generated.dependencySourceIds), citations: json(generated.citations), source_ids: json(generated.sourceIds), consent_versions: json(generated.consentVersions), ai_mode: generated.mode };
      if (this.unavailable(derived, userId)) fail(409, 'ai_context_changed', '整理期间材料权限已改变，请根据当前可见发言重试');
      const result = this.transaction(() => {
        const messageId = makeId('message');
        this.db.prepare(`INSERT INTO circle_messages (id,circle_id,round_id,kind,text,action,ai_mode,citations,source_ids,dependency_ids,dependency_source_ids,consent_versions,created_at)
          VALUES (?,?,?,'ai',?,?,?,?,?,?,?,?,?)`).run(messageId, circleId, round.id, generated.text, action, generated.mode, derived.citations, derived.source_ids, derived.dependency_ids, derived.dependency_source_ids, derived.consent_versions, this.stamp());
        const outcome = action === 'outcome' ? this.insertOutcome(circleId, round.id, userId, generated, messageId) : null;
        const seq = this.db.prepare("SELECT COALESCE(MAX(rowid),0) AS seq FROM circle_messages WHERE round_id=? AND kind='human'").get(round.id).seq;
        this.db.prepare('UPDATE circle_groups SET last_summary_at=CASE WHEN ? THEN ? ELSE last_summary_at END,last_summary_seq=CASE WHEN ? THEN ? ELSE last_summary_seq END,ai_lease_key=NULL,ai_lease_until=0,updated_at=? WHERE id=? AND ai_lease_key=?').run(action !== 'opener' ? 1 : 0, this.clock(), action !== 'opener' ? 1 : 0, seq, this.stamp(), circleId, leaseKey);
        return { message: this.messageDTO(this.db.prepare('SELECT * FROM circle_messages WHERE id=?').get(messageId), userId), outcome: outcome ? this.outcomeDTO(outcome, userId) : null, mode: generated.mode, notice: generated.notice };
      });
      this.changed(circleId, { actorId: userId, kind: action === 'outcome' ? 'circle_outcome' : 'circle_update', notify: true }); return result;
    } finally {
      if (!this.closed) this.db.prepare('UPDATE circle_groups SET ai_lease_key=NULL,ai_lease_until=0 WHERE id=? AND ai_lease_key=?').run(circleId, leaseKey);
    }
  }
  block(circleId, userId, targetId, enabled = true) {
    this.member(circleId, userId); identifier(targetId);
    if (userId === targetId) fail(400, 'self_block', '不能屏蔽自己');
    if (enabled && !this.db.prepare('SELECT 1 FROM circle_memberships WHERE circle_id=? AND user_id=?').get(circleId, targetId)) fail(404, 'member_missing', '找不到这个小组成员');
    if (enabled) this.db.prepare('INSERT OR IGNORE INTO circle_blocks VALUES (?,?,?,?)').run(circleId, userId, targetId, this.stamp());
    else this.db.prepare('DELETE FROM circle_blocks WHERE circle_id=? AND user_id=? AND target_id=?').run(circleId, userId, targetId);
    this.options.emit?.(userId, 'circles'); this.options.emit?.(targetId, 'circles'); return { ok: true };
  }
  report(circleId, userId, data) {
    this.member(circleId, userId); this.limited(`report:${userId}`, 8);
    const messageId = identifier(data.messageId), reason = text(data.reason, '举报原因', 1000, 2), message = this.db.prepare('SELECT * FROM circle_messages WHERE id=? AND circle_id=?').get(messageId, circleId);
    if (!message || this.unavailable(message, userId)) fail(404, 'message_missing', '找不到可举报的发言');
    const existing = this.db.prepare("SELECT id FROM circle_reports WHERE message_id=? AND reporter_id=? AND status='open'").get(messageId, userId);
    if (existing) return existing.id;
    const reportId = makeId('report');
    this.db.prepare('INSERT INTO circle_reports (id,circle_id,message_id,reporter_id,reason,created_at) VALUES (?,?,?,?,?,?)').run(reportId, circleId, messageId, userId, reason, this.stamp());
    const host = this.db.prepare("SELECT user_id FROM circle_memberships WHERE circle_id=? AND role='host' AND status='active'").get(circleId);
    if (host) this.options.emit?.(host.user_id, 'circles'); return reportId;
  }
  reports(circleId, userId) {
    this.member(circleId, userId, true);
    return this.db.prepare('SELECT r.*,m.text,m.author_id,m.hidden_at FROM circle_reports r JOIN circle_messages m ON m.id=r.message_id WHERE r.circle_id=? ORDER BY r.created_at DESC LIMIT 100').all(circleId).map(row => ({ id: row.id, messageId: row.message_id, reason: row.reason, status: row.status, reporterId: row.reporter_id, createdAt: row.created_at, resolvedAt: row.resolved_at, message: { text: row.text, authorName: this.author(row.author_id)?.name || 'AI 主持', hidden: Boolean(row.hidden_at) } }));
  }
  resolveReport(circleId, userId, reportId, action) {
    this.member(circleId, userId, true); oneOf(action, ['hide', 'dismiss']);
    const report = this.db.prepare('SELECT * FROM circle_reports WHERE id=? AND circle_id=?').get(reportId, circleId);
    if (!report) fail(404, 'report_missing', '找不到这条举报');
    if (report.status !== 'open') fail(409, 'report_resolved', '这条举报已经处理');
    this.transaction(() => {
      this.db.prepare('UPDATE circle_reports SET status=?,resolved_by=?,resolved_at=? WHERE id=?').run(action === 'hide' ? 'hidden' : 'dismissed', userId, this.stamp(), reportId);
      if (action === 'hide') this.db.prepare('UPDATE circle_messages SET hidden_at=? WHERE id=?').run(this.stamp(), report.message_id);
    });
    this.changed(circleId); return { ok: true };
  }
  async connect(req, circleId, data) {
    const userId = req.viewer?.id, targetId = identifier(data.targetId), message = text(data.message, '交流邀请', 500, 2);
    this.member(circleId, userId); this.limited(`connect:${userId}`, 5);
    if (!this.canConnect(userId, targetId, circleId)) fail(403, 'connection_not_allowed', '双方需为有效成员并允许组内邀请，屏蔽后不能发起连接');
    await this.assertRequest(req, userId);
    if (!this.options.connect) fail(503, 'connection_unavailable', '知识连接暂不可用，请稍后重试');
    const connection = await this.options.connect({ userId, targetId, circleId, message });
    await this.assertRequest(req, userId);
    if (!this.canConnect(userId, targetId, circleId)) fail(409, 'connection_changed', '邀请权限已改变，请刷新查看最新状态');
    return { connection, notice: connection?.status === 'accepted' ? '你们已经建立连接，可以继续交流。' : '邀请已发出，双方确认后才能私聊。' };
  }
  eraseDerived({ circleId = null, messageIds = new Set(), sourceIds = new Set(), consentUserId = null }) {
    const matches = row => (!circleId || row.circle_id === circleId) && (
      [...parse(row.dependency_ids), ...parse(row.citations).map(c => c.messageId), row.origin_message_id].some(id => messageIds.has(id)) ||
      [...parse(row.source_ids), ...parse(row.dependency_source_ids)].some(id => sourceIds.has(id)) ||
      (row.ai_mode === 'model' && consentUserId && parse(row.consent_versions).some(c => c.userId === consentUserId)));
    for (const row of this.db.prepare("SELECT * FROM circle_messages WHERE kind='ai'").all()) if (matches(row)) {
      this.db.prepare("UPDATE circle_messages SET text='',hidden_at=?,citations='[]' WHERE id=?").run(this.stamp(), row.id); messageIds.add(row.id);
    }
    for (const row of this.db.prepare('SELECT * FROM circle_outcomes').all()) if (matches(row)) this.db.prepare("UPDATE circle_outcomes SET title='需要重新整理的成果',content='',hidden_at=?,citations='[]' WHERE id=?").run(this.stamp(), row.id);
    for (const version of this.db.prepare('SELECT outcome_id,version,snapshot FROM circle_outcome_versions').all()) {
      const row = parse(version.snapshot, null); if (!row || !matches(row)) continue;
      row.title = '需要重新整理的成果'; row.content = ''; row.hidden_at = this.stamp(); row.citations = '[]';
      this.db.prepare('UPDATE circle_outcome_versions SET snapshot=? WHERE outcome_id=? AND version=?').run(json(row), version.outcome_id, version.version);
    }
  }
  exportUser(userId) {
    this.user(userId);
    return {
      memberships: this.db.prepare('SELECT circle_id AS circleId,role,status,duration,goal,stage,subscribed,allow_connections AS allowConnections,ai_consent AS aiConsent,joined_at AS joinedAt,expires_at AS expiresAt,left_at AS leftAt FROM circle_memberships WHERE user_id=?').all(userId),
      messages: this.db.prepare("SELECT id,circle_id AS circleId,round_id AS roundId,text,created_at AS createdAt FROM circle_messages WHERE author_id=? AND kind='human' AND hidden_at IS NULL").all(userId),
      sources: this.db.prepare('SELECT * FROM circle_sources WHERE created_by=? AND hidden_at IS NULL').all(userId).map(row => this.sourceDTO(row)),
      outcomes: this.db.prepare('SELECT * FROM circle_outcomes WHERE created_by=?').all(userId).filter(row => this.rawMember(row.circle_id, userId) && !this.unavailable(row, userId)).map(row => this.outcomeDTO(row, userId)),
    };
  }
  profileEvidence(userId, circleId, messageIds) {
    this.member(circleId, userId);
    return ids(messageIds).map(id => {
      const row = this.db.prepare("SELECT * FROM circle_messages WHERE id=? AND circle_id=? AND author_id=? AND kind='human'").get(id, circleId, userId);
      if (!row || this.rawRound(row.round_id)?.circle_id !== circleId || this.unavailable(row, userId)) fail(403, 'profile_evidence_unavailable', '画像建议只能使用本人当前有权读取且未隐藏的发言');
      return { id: row.id, text: row.text };
    });
  }
  deleteUser(userId) {
    const memberships = this.db.prepare('SELECT circle_id FROM circle_memberships WHERE user_id=?').all(userId);
    const messageIds = new Set(this.db.prepare('SELECT id FROM circle_messages WHERE author_id=?').all(userId).map(row => row.id));
    const sourceIds = new Set(this.db.prepare('SELECT id FROM circle_sources WHERE created_by=?').all(userId).map(row => row.id));
    this.transaction(() => {
      this.eraseDerived({ messageIds, sourceIds, consentUserId: userId });
      this.db.prepare("UPDATE circle_messages SET text='',hidden_at=?,author_id=NULL WHERE author_id=?").run(this.stamp(), userId);
      this.db.prepare("UPDATE circle_sources SET title='已删除资料',url='',summary='',author='',hidden_at=?,created_by=NULL WHERE created_by=?").run(this.stamp(), userId);
      const ownedOutcomes = this.db.prepare('SELECT id FROM circle_outcomes WHERE created_by=?').all(userId);
      for (const outcome of ownedOutcomes) {
        this.db.prepare("UPDATE circle_outcomes SET title='已删除成果',content='',citations='[]',hidden_at=?,created_by=NULL,updated_by=NULL,reviewed_by=NULL WHERE id=?").run(this.stamp(), outcome.id);
        this.db.prepare('DELETE FROM circle_outcome_versions WHERE outcome_id=?').run(outcome.id);
      }
      for (const version of this.db.prepare('SELECT outcome_id,version,snapshot FROM circle_outcome_versions').all()) {
        const snapshot = parse(version.snapshot, {}); let changed = false;
        for (const field of ['created_by', 'updated_by', 'reviewed_by']) if (snapshot[field] === userId) { snapshot[field] = null; changed = true; }
        if (changed) this.db.prepare('UPDATE circle_outcome_versions SET snapshot=? WHERE outcome_id=? AND version=?').run(json(snapshot), version.outcome_id, version.version);
      }
      this.db.prepare("UPDATE circle_reports SET reason='举报者已删除账号',reporter_id=NULL WHERE reporter_id=?").run(userId);
      this.db.prepare('DELETE FROM circle_search_receipts WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM circle_reads WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM circle_notification_state WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM circle_blocks WHERE user_id=? OR target_id=?').run(userId, userId);
      this.db.prepare('DELETE FROM circle_memberships WHERE user_id=?').run(userId);
      for (const member of memberships) { this.clean(member.circle_id); this.transferHost(member.circle_id); }
    });
    for (const member of memberships) this.changed(member.circle_id, { publicChange: true });
    return { messagesRemoved: messageIds.size, sourcesRemoved: sourceIds.size };
  }
  async runMaintenance() {
    if (this.closed || this.maintenanceRunning) return;
    this.maintenanceRunning = true;
    try {
      this.db.prepare('DELETE FROM circle_search_receipts WHERE expires_at<=?').run(this.clock());
      const circles = this.db.prepare('SELECT * FROM circle_groups ORDER BY last_summary_at,id').all();
      let generated = false;
      for (const circle of circles) {
        if (this.closed) return;
        if (this.clean(circle.id)) this.changed(circle.id, { publicChange: true });
        const round = this.rawRound(circle.current_round_id);
        if (ACTIVE_PHASES.includes(round.status) && this.clock() - circle.activity_at >= 7 * 86400000) {
          this.db.prepare("UPDATE circle_rounds SET status='dormant',updated_at=? WHERE id=?").run(this.stamp(), round.id);
          this.db.prepare('UPDATE circle_groups SET version=version+1,updated_at=? WHERE id=?').run(this.stamp(), circle.id);
          this.changed(circle.id, { publicChange: true }); continue;
        }
        if (generated || !circle.ai_enabled || !circle.auto_summary || !ACTIVE_PHASES.includes(round.status) || circle.ai_lease_until > this.clock() || this.clock() - Math.max(circle.last_summary_at, circle.last_ai_at) < 30 * 60000) continue;
        const count = this.db.prepare("SELECT COUNT(*) AS count FROM circle_messages WHERE round_id=? AND kind='human' AND hidden_at IS NULL AND rowid>?").get(round.id, circle.last_summary_seq).count;
        const host = this.db.prepare("SELECT user_id FROM circle_memberships WHERE circle_id=? AND role='host' AND status='active' AND ai_consent=1 AND (expires_at IS NULL OR expires_at>?)").get(circle.id, this.clock());
        if (count < 20 || !host) continue;
        generated = true;
        try { await this.runAI(null, circle.id, { action: 'summary', useAI: true }, host.user_id); } catch { /* Leave the durable cursor unchanged; the next eligible tick may retry. */ }
      }
    } finally { this.maintenanceRunning = false; }
  }
}
