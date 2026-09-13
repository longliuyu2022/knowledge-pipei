import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { publicProfile } from './matching.js';
import { DOMAINS, STYLES } from '../shared/catalog.js';
import { fail } from './errors.js';

const stamp = () => new Date().toISOString();
export const DEFAULT_PREFERENCES = Object.freeze({ groupInvites: true, aiAnalysis: false, chatAnalysis: false, notificationDigests: true });
const parsed = (text, fallback = {}) => { try { return JSON.parse(text); } catch { return fallback; } };

export function basicProfile(user) {
  return { id: user.id, name: user.name, provider: user.provider, avatar: '', avatarSeed: user.id,
    about: '', question: '', goals: ['conversation'], selectedTopicIds: [], title: '从共同的问题开始',
    summary: '这位成员尚未发布知识画像，可以从共同参与的问题继续交流。', highlights: [], interests: [],
    dimensions: DOMAINS.map(d => ({ ...d, value: 0 })), vector: DOMAINS.map(() => 0),
    style: { id: 'unspecified', label: '尚未填写交流偏好', values: STYLES[0].values.map(() => 50) },
    analysis: { mode: 'rules' }, demo: false };
}

export class KnowledgeStore extends Store {
  constructor(path) {
    super(path);
    const cols = this.db.prepare('PRAGMA table_info(users)').all();
    if (!cols.some(c => c.name === 'status')) this.db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identities (
        provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, PRIMARY KEY(provider,subject)
      );
      CREATE TABLE IF NOT EXISTS email_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_history (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
        data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,revision)
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', href TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, dedupe_key TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS notification_owner ON notifications(user_id,created_at);
      CREATE TABLE IF NOT EXISTS connection_context (
        invitation_id TEXT PRIMARY KEY REFERENCES invitations(id) ON DELETE CASCADE,
        origin TEXT NOT NULL, circle_id TEXT, question TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_suggestions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL, source_id TEXT NOT NULL, message_ids TEXT NOT NULL, source_text TEXT NOT NULL,
        text TEXT NOT NULL, topic_ids TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        consent_revision INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS moderation_cases (
        id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        scope TEXT NOT NULL, scope_id TEXT NOT NULL, text TEXT NOT NULL, reason TEXT NOT NULL,
        decision TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
        resolved_at TEXT, appeal TEXT NOT NULL DEFAULT '', reviewed_by TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS user_reports (
        id TEXT PRIMARY KEY, reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        target_id TEXT REFERENCES users(id) ON DELETE SET NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL,
        message_id TEXT, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sanctions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, reason TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope_id TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued', run_at INTEGER NOT NULL, lease_until INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(kind,scope_id)
      );
      CREATE TABLE IF NOT EXISTS legacy_id_map (
        source_project TEXT NOT NULL, entity_type TEXT NOT NULL, old_id TEXT NOT NULL, new_id TEXT NOT NULL,
        PRIMARY KEY(source_project,entity_type,old_id)
      );
      CREATE TABLE IF NOT EXISTS migration_runs (
        id TEXT PRIMARY KEY, source_project TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
        report TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    this.onUserChanged = () => {};
    this.groupAccess = () => false;
  }
  transaction(fn) {
    const key = `tx_${randomUUID().replaceAll('-', '')}`;
    this.db.exec(`SAVEPOINT ${key}`);
    try { const value = fn(); this.db.exec(`RELEASE ${key}`); return value; }
    catch (error) { this.db.exec(`ROLLBACK TO ${key}`); this.db.exec(`RELEASE ${key}`); throw error; }
  }
  isActive(userId) { return this.db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(userId) !== undefined; }
  session(token) {
    const session = super.session(token);
    return session && this.isActive(session.user.id) ? session : null;
  }
  createUser(name) {
    const user = super.createUser(name || `求知者${randomUUID().slice(0, 4)}`);
    return user;
  }
  oauthUser(previousId, identity) {
    // The display name remains the user's app pseudonym; OAuth identity is not a public profile.
    const previous = this.user(previousId);
    const typed = ['hash','uid'].includes(identity.subjectKind) ? `${identity.subjectKind}:${identity.subject}` : null;
    const known = typed && this.db.prepare("SELECT user_id AS id FROM identities WHERE provider='zhihu' AND subject=?").get(typed);
    // Imported identities use typed keys; no unverified legacy alias is claimed.
    // Raw subjects remain readable only for records created by the older local API.
    const bound = known || this.db.prepare('SELECT id FROM users WHERE subject=?').get(typed || identity.subject);
    if (bound) {
      if (!this.isActive(bound.id)) fail(403, 'account_disabled', '账号已停用，请通过申诉渠道联系管理员');
      if (previous && previous.id !== bound.id && this.account(previous.id).hasPassword) fail(409, 'identity_in_use', '此知乎身份已绑定另一个账号，请先登录原账号');
      return this.user(bound.id);
    }
    const user = previous || this.createUser();
    const currentSubject = this.db.prepare('SELECT subject FROM users WHERE id=?').get(user.id)?.subject;
    const bindings = this.db.prepare("SELECT subject FROM identities WHERE provider='zhihu' AND user_id=?").all(user.id);
    if ((currentSubject && currentSubject !== (typed || identity.subject)) || bindings.some(binding => binding.subject !== (typed || identity.subject))) fail(409, 'identity_changed', '当前账号已绑定其他知乎身份');
    this.db.prepare("UPDATE users SET provider='zhihu',subject=?,avatar='',registered_at=COALESCE(registered_at,?) WHERE id=?").run(typed || identity.subject, stamp(), user.id);
    this.db.prepare('INSERT OR IGNORE INTO identities VALUES (?,?,?,?)').run('zhihu', typed || identity.subject, user.id, stamp());
    return this.user(user.id);
  }
  account(userId) {
    const user = this.user(userId);
    const email = this.db.prepare('SELECT email,verified FROM email_accounts WHERE user_id=?').get(userId);
    return { name: user?.name || '', provider: user?.provider || 'guest', email: email?.email || null, hasPassword: Boolean(email), emailVerified: Boolean(email?.verified) };
  }
  registerEmail(userId, email, passwordHash, name) {
    return this.transaction(() => {
      if (!this.isActive(userId)) fail(401, 'session_expired', '请重新登录');
      if (this.db.prepare('SELECT 1 FROM email_accounts WHERE email=? OR user_id=?').get(email, userId)) fail(409, 'email_exists', '邮箱已注册或当前账号已绑定邮箱');
      const at = stamp();
      this.db.prepare('INSERT INTO email_accounts(user_id,email,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)').run(userId, email, passwordHash, at, at);
      this.db.prepare("UPDATE users SET name=?,provider=CASE WHEN provider='guest' THEN 'email' ELSE provider END,registered_at=COALESCE(registered_at,?) WHERE id=?").run(name, at, userId);
      this.db.prepare('INSERT INTO identities VALUES (?,?,?,?)').run('email', email, userId, at);
      return this.user(userId);
    });
  }
  preferences(userId) {
    const row = this.db.prepare('SELECT data,revision,updated_at FROM user_preferences WHERE user_id=?').get(userId);
    return { preferences: { ...DEFAULT_PREFERENCES, ...parsed(row?.data) }, revision: row?.revision || 0, updatedAt: row?.updated_at || null };
  }
  setPreferences(userId, patch, revision) {
    const current = this.preferences(userId);
    if (revision !== current.revision) fail(409, 'preferences_changed', '偏好已在其他页面更新，请刷新后再试');
    if (!patch || Array.isArray(patch) || typeof patch !== 'object' || !Object.keys(patch).length || Object.entries(patch).some(([key, value]) => !(key in DEFAULT_PREFERENCES) || typeof value !== 'boolean')) fail(400, 'invalid_preferences', '偏好选项不正确');
    const next = { ...current.preferences, ...patch };
    this.db.prepare('INSERT INTO user_preferences VALUES (?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,revision=user_preferences.revision+1,updated_at=excluded.updated_at').run(userId, JSON.stringify(next), stamp());
    if (!next.chatAnalysis) this.db.prepare('DELETE FROM profile_suggestions WHERE user_id=?').run(userId);
    if (!next.groupInvites) this.db.prepare("UPDATE invitations SET status='cancelled',updated_at=? WHERE recipient_id=? AND status='pending' AND id IN (SELECT invitation_id FROM connection_context WHERE origin='circle')").run(stamp(), userId);
    this.onUserChanged(userId, 'preferences_changed');
    return this.preferences(userId);
  }
  saveProfile(userId, profile, revision) {
    const saved = super.saveProfile(userId, profile, revision);
    this.db.prepare('INSERT OR REPLACE INTO profile_history VALUES (?,?,?,?)').run(userId, saved.revision, JSON.stringify({ title: saved.title, summary: saved.summary, interests: saved.interests, analysis: saved.analysis.mode }), saved.updatedAt);
    this.db.prepare('DELETE FROM profile_history WHERE user_id=? AND revision NOT IN (SELECT revision FROM profile_history WHERE user_id=? ORDER BY revision DESC LIMIT 20)').run(userId, userId);
    this.onUserChanged(userId, 'profile_changed');
    return saved;
  }
  setDiscoverable(userId, value) {
    if (!this.profile(userId)) fail(400, 'profile_required', '请先生成知识画像');
    this.db.prepare('UPDATE profiles SET discoverable=?,updated_at=? WHERE user_id=?').run(Number(value), stamp(), userId);
    if (!value) this.db.prepare("UPDATE invitations SET status='cancelled',updated_at=? WHERE (sender_id=? OR recipient_id=?) AND status='pending' AND id NOT IN (SELECT invitation_id FROM connection_context WHERE origin='circle')").run(stamp(), userId, userId);
    return this.profile(userId);
  }
  clearImports(userId) {
    super.clearImports(userId);
    this.db.prepare('DELETE FROM profile_history WHERE user_id=?').run(userId);
    this.db.prepare('DELETE FROM profile_suggestions WHERE user_id=?').run(userId);
    this.onUserChanged(userId, 'source_removed');
  }
  privateProfileCard(userId) {
    const user = this.user(userId), profile = this.profile(userId);
    if (!user || !this.isActive(userId)) return null;
    return profile ? { ...publicProfile(profile, user), avatar: '' } : basicProfile(user);
  }
  publicUser(userId, viewerId, allowConnection = false) {
    if (!this.isActive(userId) || this.isBlocked(userId, viewerId)) return null;
    const profile = this.profile(userId);
    const pending = this.db.prepare("SELECT c.circle_id FROM invitations i JOIN connection_context c ON c.invitation_id=i.id WHERE c.origin='circle' AND i.status='pending' AND ((i.sender_id=? AND i.recipient_id=?) OR (i.sender_id=? AND i.recipient_id=?))").get(userId, viewerId, viewerId, userId);
    if (userId !== viewerId && !profile?.discoverable && !(allowConnection && this.connectionBetween(userId, viewerId)) && !(pending && this.groupAccess(userId, viewerId, pending.circle_id))) return null;
    return this.privateProfileCard(userId);
  }
  circleInvite({ userId, targetId, circleId, message }) {
    if (userId === targetId || !this.isActive(userId) || !this.isActive(targetId) || this.isBlocked(userId, targetId) || !this.groupAccess(userId, targetId, circleId)) fail(403, 'connection_unavailable', '双方需要在小组内开启深入交流邀请');
    if (!this.preferences(targetId).preferences.groupInvites) fail(403, 'invitation_disabled', '对方暂未开启小组交流邀请');
    const existing = this.activeInvitationBetween(userId, targetId);
    if (existing) return { id: existing.id, status: existing.status, conversationId: existing.status === 'accepted' ? existing.id : null };
    const invitationId = randomUUID(), at = stamp();
    this.transaction(() => {
      this.db.prepare('INSERT INTO invitations(id,sender_id,recipient_id,message,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(invitationId, userId, targetId, message || '想围绕我们共同参与的问题继续交流。', at, at);
      const question = this.db.prepare('SELECT r.question FROM circle_groups g JOIN circle_rounds r ON r.id=g.current_round_id WHERE g.id=?').get(circleId)?.question || '';
      this.db.prepare('INSERT INTO connection_context VALUES (?,?,?,?,?)').run(invitationId, 'circle', circleId, question, at);
      this.notify(targetId, { kind: 'connection', title: '收到一份深入交流邀请', body: '来自你共同参与的问题小组，接受后才会建立私聊。', href: '#connections' });
    });
    return { id: invitationId, status: 'pending', conversationId: null };
  }
  respond(userId, invitationId, action) {
    const context = this.db.prepare('SELECT * FROM connection_context WHERE invitation_id=?').get(invitationId);
    if (context?.origin !== 'circle') return super.respond(userId, invitationId, action);
    const row = this.db.prepare('SELECT * FROM invitations WHERE id=?').get(invitationId);
    if (!row || row.recipient_id !== userId || row.status !== 'pending' || this.isBlocked(row.sender_id, row.recipient_id)) fail(404, 'invitation_missing', '这份邀请已失效');
    if (!this.isActive(row.sender_id) || !this.isActive(row.recipient_id) || !this.groupAccess(row.sender_id, row.recipient_id, context.circle_id) || !this.preferences(userId).preferences.groupInvites) fail(409, 'invitation_expired', '小组参与或邀请许可已改变');
    this.db.prepare('UPDATE invitations SET status=?,updated_at=? WHERE id=?').run(action === 'accept' ? 'accepted' : 'declined', stamp(), invitationId);
    if (action === 'accept') this.notify(row.sender_id, { kind: 'connection', title: '交流邀请已接受', body: '现在可以围绕共同问题继续对话。', href: `#connections/${invitationId}` });
    return row;
  }
  conversation(userId, conversationId) {
    const row = super.conversation(userId, conversationId);
    if (!this.isActive(row.sender_id) || !this.isActive(row.recipient_id)) fail(404, 'conversation_missing', '这段对话暂时无法访问');
    return row;
  }
  notify(userId, { kind = 'update', title, body = '', href = '#notifications', key = null }) {
    if (!this.isActive(userId)) return null;
    const notificationId = randomUUID();
    this.db.prepare('INSERT OR IGNORE INTO notifications(id,user_id,kind,title,body,href,created_at,dedupe_key) VALUES (?,?,?,?,?,?,?,?)').run(notificationId, userId, kind.slice(0, 30), String(title).slice(0, 160), String(body).slice(0, 500), /^#[a-zA-Z0-9/_-]+$/.test(href) ? href : '#notifications', stamp(), key ? `${userId}:${key}` : null);
    return notificationId;
  }
  notifications(userId) {
    const items = this.db.prepare('SELECT id,kind,title,body,href,read,created_at AS createdAt FROM notifications WHERE user_id=? ORDER BY rowid DESC LIMIT 100').all(userId).map(row => ({ ...row, read: Boolean(row.read) }));
    return { items, unread: this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read=0').get(userId).n };
  }
  markNotifications(userId, ids) {
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string'))) fail(400, 'invalid_notifications', '通知列表不正确');
    if (ids) for (const id of ids) this.db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(id, userId);
    else this.db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(userId);
    return this.notifications(userId);
  }
  block(userId, targetId) {
    super.block(userId, targetId);
    this.onUserChanged(userId, 'blocked'); this.onUserChanged(targetId, 'blocked');
  }
  audit(actor, action, target, detail = {}) { this.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?)').run(randomUUID(), actor, action, target, JSON.stringify(detail), stamp()); }
  deleteAccount(userId) {
    this.onUserChanged(userId, 'deleted');
    this.db.prepare("UPDATE moderation_cases SET text='',reason='账号已删除',appeal='' WHERE user_id=?").run(userId);
    this.db.prepare("UPDATE user_reports SET reason='相关账号已删除' WHERE reporter_id=? OR target_id=?").run(userId, userId);
    super.deleteAccount(userId);
  }
}
