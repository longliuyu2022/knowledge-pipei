import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { publicProfile } from './matching.js';
import { fail } from './errors.js';

export const hashToken = value => createHash('sha256').update(value).digest('hex');
const id = () => randomUUID();
const now = () => new Date().toISOString();

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '新朋友', provider TEXT NOT NULL DEFAULT 'guest',
        subject TEXT UNIQUE, avatar TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        discoverable INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS imports (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data TEXT NOT NULL, fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS saved (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, target_id)
      );
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK (sender_id != recipient_id), CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pending_invitation ON invitations(sender_id, recipient_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS recipient_invitations ON invitations(recipient_id, status);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
        author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text TEXT NOT NULL, created_at TEXT NOT NULL, client_message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS conversation_messages ON messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS blocked (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, target_id)
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'client_message_id')) this.db.exec('ALTER TABLE messages ADD COLUMN client_message_id TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS message_retry_key ON messages(author_id, conversation_id, client_message_id) WHERE client_message_id IS NOT NULL');
  }
  close() { this.db.close(); }
  user(userId) { return this.db.prepare('SELECT id, name, provider, avatar FROM users WHERE id = ?').get(userId) || null; }
  createUser(name = '新朋友') {
    const userId = id();
    this.db.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)').run(userId, name, now());
    return this.user(userId);
  }
  createSession(userId) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hashToken(token), userId, csrf, Date.now() + 30 * 86400000);
    return { token, csrf, userId };
  }
  session(token) {
    if (typeof token !== 'string' || token.length > 100) return null;
    const row = this.db.prepare('SELECT user_id, csrf FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hashToken(token), Date.now());
    return row ? { user: this.user(row.user_id), csrf: row.csrf } : null;
  }
  endSession(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)); }
  oauthUser(previousId, identity) {
    const existing = this.db.prepare('SELECT id FROM users WHERE subject = ?').get(identity.subject);
    if (existing) {
      this.db.prepare('UPDATE users SET name = ?, avatar = ? WHERE id = ?').run(identity.name, identity.avatar, existing.id);
      return this.user(existing.id);
    }
    const previous = this.user(previousId);
    const user = previous?.provider === 'guest' ? previous : this.createUser(identity.name);
    this.db.prepare("UPDATE users SET name = ?, provider = 'zhihu', subject = ?, avatar = ? WHERE id = ?").run(identity.name, identity.subject, identity.avatar, user.id);
    return this.user(user.id);
  }
  profile(userId) {
    const row = this.db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
    return row ? { ...JSON.parse(row.data), revision: row.revision, discoverable: Boolean(row.discoverable), updatedAt: row.updated_at } : null;
  }
  saveProfile(userId, profile, expectedRevision) {
    if (!this.user(userId)) fail(401, 'session_expired', '会话已结束，请刷新页面');
    const current = this.profile(userId);
    if (expectedRevision !== (current?.revision || 0)) fail(409, 'profile_changed', '画像已在其他页面更新，请刷新后再试');
    this.db.prepare(`INSERT INTO profiles (user_id, data, revision, updated_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, revision = profiles.revision + 1, discoverable = 0, updated_at = excluded.updated_at`).run(userId, JSON.stringify(profile), now());
    this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(profile.input.name, userId);
    this.db.prepare("UPDATE invitations SET status = 'cancelled', updated_at = ? WHERE (sender_id = ? OR recipient_id = ?) AND status = 'pending'").run(now(), userId, userId);
    return this.profile(userId);
  }
  setDiscoverable(userId, value) {
    if (!this.profile(userId)) fail(400, 'profile_required', '先生成你的知识人格，再让伙伴发现你');
    this.db.prepare('UPDATE profiles SET discoverable = ?, updated_at = ? WHERE user_id = ?').run(value ? 1 : 0, now(), userId);
    if (!value) this.db.prepare("UPDATE invitations SET status = 'cancelled', updated_at = ? WHERE (sender_id = ? OR recipient_id = ?) AND status = 'pending'").run(now(), userId, userId);
    return this.profile(userId);
  }
  imports(userId) {
    const row = this.db.prepare('SELECT * FROM imports WHERE user_id = ?').get(userId);
    return row ? { items: JSON.parse(row.data), fetchedAt: row.fetched_at } : { items: [], fetchedAt: null };
  }
  saveImports(userId, items) {
    this.db.prepare('INSERT INTO imports VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at').run(userId, JSON.stringify(items), now());
    return this.imports(userId);
  }
  clearImports(userId) { this.db.prepare('DELETE FROM imports WHERE user_id = ?').run(userId); }
  isBlocked(a, b) { return Boolean(this.db.prepare('SELECT 1 FROM blocked WHERE (user_id = ? AND target_id = ?) OR (user_id = ? AND target_id = ?)').get(a, b, b, a)); }
  publicUser(userId, viewerId, allowConnection = false) {
    const user = this.user(userId), profile = this.profile(userId);
    if (!user || !profile || this.isBlocked(userId, viewerId)) return null;
    if (userId !== viewerId && !profile.discoverable && !(allowConnection && this.connectionBetween(userId, viewerId))) return null;
    return publicProfile(profile, user);
  }
  people(viewerId) {
    return this.db.prepare('SELECT user_id FROM profiles WHERE discoverable = 1 AND user_id != ? ORDER BY updated_at DESC LIMIT 50').all(viewerId)
      .map(row => this.publicUser(row.user_id, viewerId)).filter(Boolean);
  }
  savedIds(userId) { return this.db.prepare('SELECT target_id FROM saved WHERE user_id = ? ORDER BY created_at DESC').all(userId).map(row => row.target_id); }
  setSaved(userId, targetId, value) {
    if (value) this.db.prepare('INSERT OR IGNORE INTO saved VALUES (?, ?, ?)').run(userId, targetId, now());
    else this.db.prepare('DELETE FROM saved WHERE user_id = ? AND target_id = ?').run(userId, targetId);
  }
  connectionBetween(a, b) {
    return this.db.prepare("SELECT * FROM invitations WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)) AND status = 'accepted' LIMIT 1").get(a, b, b, a) || null;
  }
  invite(senderId, recipientId, message) {
    if (senderId === recipientId) fail(400, 'self_invitation', '不能邀请自己');
    if (!this.profile(senderId)?.discoverable) fail(400, 'join_required', '先开启「让伙伴发现我」，再发送邀请');
    if (!this.publicUser(recipientId, senderId)) fail(404, 'person_unavailable', '这位伙伴目前不在匹配池中');
    const existing = this.db.prepare("SELECT status FROM invitations WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)) AND status IN ('pending', 'accepted')").get(senderId, recipientId, recipientId, senderId);
    if (existing) fail(409, 'invitation_exists', existing.status === 'accepted' ? '你们已经建立连接，可以直接对话' : '你们之间已有待处理的邀请');
    const invitationId = id();
    this.db.prepare('INSERT INTO invitations (id, sender_id, recipient_id, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(invitationId, senderId, recipientId, message, now(), now());
    return invitationId;
  }
  respond(userId, invitationId, action) {
    const row = this.db.prepare('SELECT * FROM invitations WHERE id = ?').get(invitationId);
    if (!row || row.recipient_id !== userId || this.isBlocked(row.sender_id, row.recipient_id)) fail(404, 'invitation_missing', '找不到这条邀请');
    if (row.status !== 'pending') fail(409, 'invitation_handled', '这条邀请已经处理过了');
    if (!this.profile(row.sender_id)?.discoverable || !this.profile(row.recipient_id)?.discoverable) fail(409, 'person_unavailable', '一方已退出匹配池，这条邀请不再有效');
    this.db.prepare('UPDATE invitations SET status = ?, updated_at = ? WHERE id = ?').run(action === 'accept' ? 'accepted' : 'declined', now(), invitationId);
    return row;
  }
  invitations(userId) {
    const rows = this.db.prepare("SELECT * FROM invitations WHERE (sender_id = ? OR recipient_id = ?) AND status IN ('pending', 'accepted') ORDER BY updated_at DESC").all(userId, userId);
    return rows.filter(row => !this.isBlocked(row.sender_id, row.recipient_id)).map(row => ({
      id: row.id, direction: row.sender_id === userId ? 'outgoing' : 'incoming', status: row.status,
      message: row.message, createdAt: row.created_at,
      person: this.publicUser(row.sender_id === userId ? row.recipient_id : row.sender_id, userId, row.status === 'accepted'),
      lastMessage: this.db.prepare('SELECT text, created_at AS createdAt FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1').get(row.id) || null,
    })).filter(row => row.person);
  }
  conversation(userId, conversationId) {
    const row = this.db.prepare("SELECT * FROM invitations WHERE id = ? AND status = 'accepted' AND (sender_id = ? OR recipient_id = ?)").get(conversationId, userId, userId);
    if (!row || this.isBlocked(row.sender_id, row.recipient_id)) fail(404, 'conversation_missing', '这段对话暂时无法访问');
    return row;
  }
  messages(userId, conversationId, before = null) {
    this.conversation(userId, conversationId);
    let cursor = Number.MAX_SAFE_INTEGER;
    if (before) {
      const row = this.db.prepare('SELECT rowid FROM messages WHERE id = ? AND conversation_id = ?').get(before, conversationId);
      if (!row) fail(400, 'invalid_cursor', '消息分页位置无效');
      cursor = row.rowid;
    }
    const rows = this.db.prepare('SELECT id, author_id AS authorId, text, created_at AS createdAt FROM messages WHERE conversation_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT 101').all(conversationId, cursor);
    return { items: rows.slice(0, 100).reverse(), hasMore: rows.length > 100, nextBefore: rows.length > 100 ? rows[99].id : null };
  }
  sendMessage(userId, conversationId, text, clientMessageId = null) {
    const row = this.conversation(userId, conversationId);
    const recipientId = row.sender_id === userId ? row.recipient_id : row.sender_id;
    if (clientMessageId) {
      const existing = this.db.prepare('SELECT id, author_id AS authorId, text, created_at AS createdAt FROM messages WHERE author_id = ? AND conversation_id = ? AND client_message_id = ?').get(userId, conversationId, clientMessageId);
      if (existing) {
        if (existing.text !== text) fail(409, 'client_message_conflict', '这条消息的重试标识已用于另一段内容，请刷新后重新发送');
        return { message: { ...existing }, recipientId };
      }
    }
    const message = { id: id(), authorId: userId, text, createdAt: now() };
    this.db.prepare('INSERT INTO messages (id, conversation_id, author_id, text, created_at, client_message_id) VALUES (?, ?, ?, ?, ?, ?)').run(message.id, conversationId, userId, text, message.createdAt, clientMessageId);
    return { message, recipientId };
  }
  block(userId, targetId) {
    if (userId === targetId) fail(400, 'invalid_target', '不能屏蔽自己');
    this.db.prepare('INSERT OR IGNORE INTO blocked VALUES (?, ?, ?)').run(userId, targetId, now());
    this.db.prepare('DELETE FROM saved WHERE (user_id = ? AND target_id = ?) OR (user_id = ? AND target_id = ?)').run(userId, targetId, targetId, userId);
    this.db.prepare("UPDATE invitations SET status = 'cancelled', updated_at = ? WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)").run(now(), userId, targetId, targetId, userId);
  }
  blocked(userId) {
    return this.db.prepare('SELECT target_id AS id FROM blocked WHERE user_id = ?').all(userId);
  }
  unblock(userId, targetId) { this.db.prepare('DELETE FROM blocked WHERE user_id = ? AND target_id = ?').run(userId, targetId); }
  deleteAccount(userId) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM saved WHERE target_id = ?').run(userId);
      this.db.prepare('DELETE FROM blocked WHERE target_id = ?').run(userId);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
