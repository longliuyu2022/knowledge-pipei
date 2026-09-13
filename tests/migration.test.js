import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, scryptSync } from 'node:crypto';
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { migrate, snapshotDatabase, validateMigration, inspectSource } from '../scripts/migration/library.mjs';
import { KnowledgeStore } from '../server/knowledge-store.js';
import { Circles } from '../server/circles/service.js';
import { verifyPassword } from '../server/email-auth.js';
import { buildProfile } from '../server/matching.js';
import { DEFAULT_INPUT } from '../shared/catalog.js';

const at = n => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const code = expected => error => error.code === expected;
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const legacyPassword = 'fixture password only';
const salt = '1234567890abcdef1234567890abcdef';
// Preserve the old app's use of the salt's hex TEXT, rather than decoded bytes.
const passwordHash = `scrypt-v1$${salt}$${scryptSync(legacyPassword, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
const insert = (db, table, values) => db.prepare(`INSERT INTO ${table} (${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`).run(...Object.values(values));
const identityManifest = [
  { sourceProject: 'tongpin', userId: 'same-id', kind: 'hash', value: 'hashed-person' },
  { sourceProject: 'tongti', userId: 'same-id', kind: 'hash', value: 'hashed-person' },
  { sourceProject: 'tongti', userId: 'numeric-ti', kind: 'uid', value: '99999999999999999999' },
];

function pinSchema(db) {
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE users (id TEXT PRIMARY KEY,name TEXT,provider TEXT,subject TEXT UNIQUE,avatar TEXT,created_at TEXT,last_seen_at TEXT,registered_at TEXT);
    CREATE TABLE profiles (user_id TEXT PRIMARY KEY,data TEXT,revision INTEGER,discoverable INTEGER,updated_at TEXT);
    CREATE TABLE imports (user_id TEXT PRIMARY KEY,data TEXT,fetched_at TEXT);
    CREATE TABLE saved (user_id TEXT,target_id TEXT,created_at TEXT,PRIMARY KEY(user_id,target_id));
    CREATE TABLE invitations (id TEXT PRIMARY KEY,sender_id TEXT,recipient_id TEXT,message TEXT,status TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY,conversation_id TEXT,author_id TEXT,text TEXT,created_at TEXT,client_message_id TEXT);
    CREATE TABLE blocked (user_id TEXT,target_id TEXT,created_at TEXT,PRIMARY KEY(user_id,target_id));
    CREATE TABLE sessions (token_hash TEXT,user_id TEXT,csrf TEXT,expires_at INTEGER);
    CREATE TABLE zhihu_validations (user_id TEXT,data TEXT,checked_at TEXT);`);
}
function tiSchema(db) {
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE users (id TEXT PRIMARY KEY,nickname TEXT,identity TEXT,avatar_hue INTEGER,goal TEXT,stage TEXT,zhihu_id TEXT UNIQUE,created_at TEXT);
    CREATE TABLE email_accounts (user_id TEXT PRIMARY KEY,email TEXT UNIQUE,password_hash TEXT,site_role TEXT,status TEXT,registered_at TEXT,last_login_at TEXT);
    CREATE TABLE communities (id TEXT PRIMARY KEY,title TEXT,description TEXT,question TEXT,goal TEXT,tags TEXT,color TEXT,icon TEXT,is_starter INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE memberships (community_id TEXT,user_id TEXT,role TEXT,goal TEXT,stage TEXT,participation TEXT,subscribed INTEGER,joined_at TEXT,last_read_at TEXT,last_read_message_rowid INTEGER,last_read_update_rowid INTEGER,PRIMARY KEY(community_id,user_id));
    CREATE TABLE messages (id TEXT PRIMARY KEY,community_id TEXT,author_id TEXT,kind TEXT,text TEXT,reply_to TEXT,action TEXT,ai_mode TEXT,citations TEXT,source_ids TEXT,dependency_ids TEXT,hidden INTEGER,created_at TEXT);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY,community_id TEXT,title TEXT,content TEXT,status TEXT,version INTEGER,ai_mode TEXT,citations TEXT,source_ids TEXT,dependency_ids TEXT,origin_message_id TEXT,created_by TEXT,updated_by TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE updates (id TEXT PRIMARY KEY,community_id TEXT,author_id TEXT,type TEXT,text TEXT,created_at TEXT);
    CREATE TABLE sources (id TEXT PRIMARY KEY,community_id TEXT,title TEXT,url TEXT,author TEXT,summary TEXT,scope TEXT,added_by TEXT,created_at TEXT);
    CREATE TABLE reports (id TEXT PRIMARY KEY,community_id TEXT,message_id TEXT,reporter_id TEXT,reason TEXT,status TEXT,resolved_by TEXT,created_at TEXT,resolved_at TEXT);
    CREATE TABLE blocks (user_id TEXT,blocked_user_id TEXT,PRIMARY KEY(user_id,blocked_user_id));
    CREATE TABLE sessions (token_hash TEXT,user_id TEXT,expires_at INTEGER);
    CREATE TABLE oauth_states (state_hash TEXT,browser_hash TEXT,expires_at INTEGER,return_to TEXT);
    CREATE TABLE admin_setup (token_hash TEXT,email TEXT,expires_at INTEGER,created_at TEXT);`);
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tongzhi-migration-test-'));
  const paths = { tongpin: join(directory, 'tongpin.sqlite'), tongti: join(directory, 'tongti.sqlite') };
  const pin = new DatabaseSync(paths.tongpin), ti = new DatabaseSync(paths.tongti);
  pinSchema(pin); tiSchema(ti);
  for (const [id, provider, subject] of [['same-id', 'zhihu', 'hashed-person'], ['numeric-pin', 'zhihu', '99999999999999999999'], ['guest-pin', 'guest', null], ['peer-pin', 'guest', null]]) {
    insert(pin, 'users', { id, name: '相同昵称', provider, subject, avatar: '', created_at: at(0), last_seen_at: at(8), registered_at: provider === 'guest' ? null : at(0) });
  }
  const profile = { ...buildProfile({ ...DEFAULT_INPUT, name: '画像化名', question: '合成测试的问题' }), id: 'same-id', avatarSeed: 'same-id' };
  insert(pin, 'profiles', { user_id: 'same-id', data: JSON.stringify(profile), revision: 3, discoverable: 1, updated_at: at(5) });
  insert(pin, 'imports', { user_id: 'same-id', data: JSON.stringify([{ id: 'external-zhihu-post', text: 'private-import-sentinel' }]), fetched_at: at(5) });
  insert(pin, 'saved', { user_id: 'same-id', target_id: 'peer-pin', created_at: at(0) });
  insert(pin, 'invitations', { id: 'same-invitation', sender_id: 'same-id', recipient_id: 'peer-pin', message: '连接', status: 'accepted', created_at: at(0), updated_at: at(1) });
  insert(pin, 'invitations', { id: 'pending', sender_id: 'guest-pin', recipient_id: 'numeric-pin', message: '待决定', status: 'pending', created_at: at(0), updated_at: at(1) });
  insert(pin, 'messages', { id: 'shared-message-id', conversation_id: 'same-invitation', author_id: 'same-id', text: 'private-dm-sentinel', created_at: at(2), client_message_id: 'retry-original' });
  insert(pin, 'blocked', { user_id: 'guest-pin', target_id: 'numeric-pin', created_at: at(3) });
  insert(pin, 'sessions', { token_hash: 'pin-session-secret', user_id: 'same-id', csrf: 'csrf-secret', expires_at: 9999999999999 });
  insert(pin, 'zhihu_validations', { user_id: 'same-id', data: '{"token":"private-validation-sentinel"}', checked_at: at(2) });
  for (const [id, identity, zhihu_id] of [['same-id', 'zhihu', 'hash:hashed-person'], ['numeric-ti', 'zhihu', 'uid:99999999999999999999'], ['guest-ti', 'guest', null], ['email-ti', 'email', null]]) {
    insert(ti, 'users', { id, nickname: '相同昵称', identity, avatar_hue: 140, goal: '旧目标', stage: '旧阶段', zhihu_id, created_at: at(0) });
  }
  insert(ti, 'email_accounts', { user_id: 'email-ti', email: 'MEMBER@example.test', password_hash: passwordHash, site_role: 'admin', status: 'disabled', registered_at: at(0), last_login_at: at(5) });
  insert(ti, 'communities', { id: 'old-circle', title: '合成测试组', description: '历史说明', question: '最后一次修改的问题', goal: '最后目标', tags: '["实践"]', color: 'sage', icon: 'sprout', is_starter: 0, created_at: at(0), updated_at: at(8) });
  for (const [id, role, mc, uc] of [['same-id', 'host', 1, 1], ['guest-ti', 'member', 0, 2], ['email-ti', 'member', 99, 99]]) {
    insert(ti, 'memberships', { community_id: 'old-circle', user_id: id, role, goal: '成员目标', stage: '阶段', participation: '每周一次', subscribed: 1, joined_at: at(0), last_read_at: at(8), last_read_message_rowid: mc, last_read_update_rowid: uc });
  }
  const message = (id, seq, patch = {}) => insert(ti, 'messages', { id, community_id: 'old-circle', author_id: 'same-id', kind: 'human', text: `合成发言 ${id}`, reply_to: null,
    action: null, ai_mode: null, citations: '[]', source_ids: '[]', dependency_ids: '[]', hidden: 0, created_at: at(seq), ...patch });
  message('shared-message-id', 1);
  message('hidden-human', 4, { author_id: 'guest-ti', hidden: 1, text: 'hidden-evidence-sentinel' });
  message('rules-message', 5, { author_id: null, kind: 'ai', action: 'summary', ai_mode: 'rules', text: 'derived-rules-sentinel',
    citations: '[{"messageId":"shared-message-id","nickname":"旧昵称","quote":"过期摘录","label":"发言 1"}]', source_ids: '["source-one"]', dependency_ids: '["shared-message-id","hidden-human"]' });
  message('model-message', 6, { author_id: null, kind: 'ai', action: 'summary', ai_mode: 'model', text: 'derived-model-sentinel', dependency_ids: '["shared-message-id"]' });
  message('reply-message', 7, { author_id: 'email-ti', reply_to: 'shared-message-id' });
  insert(ti, 'updates', { id: 'update-one', community_id: 'old-circle', author_id: 'same-id', type: 'progress', text: '旧进展', created_at: at(2) });
  insert(ti, 'updates', { id: 'update-two', community_id: 'old-circle', author_id: 'guest-ti', type: 'next-topic', text: '下一话题原文', created_at: at(8) });
  insert(ti, 'sources', { id: 'source-one', community_id: 'old-circle', title: '原始来源', url: 'https://www.zhihu.com/question/123', author: '外部作者', summary: '仅为摘要', scope: 'search-summary', added_by: 'guest-ti', created_at: at(2) });
  insert(ti, 'artifacts', { id: 'artifact-one', community_id: 'old-circle', title: '旧成果', content: 'outcome-sentinel', status: 'reviewed', version: 4, ai_mode: 'rules',
    citations: '[{"messageId":"shared-message-id","quote":"原文"}]', source_ids: '["source-one"]', dependency_ids: '["shared-message-id","hidden-human"]', origin_message_id: 'rules-message',
    created_by: 'same-id', updated_by: 'email-ti', created_at: at(5), updated_at: at(8) });
  insert(ti, 'reports', { id: 'report-one', community_id: 'old-circle', message_id: 'hidden-human', reporter_id: 'email-ti', reason: '旧举报', status: 'hidden', resolved_by: 'same-id', created_at: at(6), resolved_at: at(7) });
  insert(ti, 'blocks', { user_id: 'guest-ti', blocked_user_id: 'same-id' });
  insert(ti, 'sessions', { token_hash: 'ti-session-secret', user_id: 'same-id', expires_at: 9999999999999 });
  insert(ti, 'oauth_states', { state_hash: 'oauth-secret', browser_hash: 'browser-secret', expires_at: 9999999999999, return_to: '/' });
  insert(ti, 'admin_setup', { token_hash: 'admin-secret', email: 'private@example.test', expires_at: 9999999999999, created_at: at(0) });
  let pinOpen = true, tiOpen = true;
  const closeSources = () => { if (pinOpen) { pin.close(); pinOpen = false; } if (tiOpen) { ti.close(); tiOpen = false; } };
  t.after(() => { closeSources(); rmSync(directory, { recursive: true, force: true }); });
  const target = join(directory, 'target.sqlite');
  const apply = patch => migrate({ mode: 'apply', sources: paths, targetPath: target, tempDirectory: directory, ...patch });
  return { directory, paths, pin, ti, target, closeSources, apply };
}
const mapped = (db, project, type, oldId) => db.prepare('SELECT new_id FROM legacy_id_map WHERE source_project=? AND entity_type=? AND old_id=?').get(project, type, oldId)?.new_id;

test('migration snapshots include WAL commits, stay 0600 and refuse overwrite or source aliases', async t => {
  const f = fixture(t), output = join(f.directory, 'backup.sqlite');
  assert.ok(statSync(`${f.paths.tongpin}-wal`).size > 0);
  const mainBefore = digest(f.paths.tongpin), walBefore = digest(`${f.paths.tongpin}-wal`);
  await snapshotDatabase(f.paths.tongpin, output);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  const snap = new DatabaseSync(output, { readOnly: true });
  assert.equal(snap.prepare('SELECT COUNT(*) AS n FROM users').get().n, 4); snap.close();
  assert.equal(digest(f.paths.tongpin), mainBefore); assert.equal(digest(`${f.paths.tongpin}-wal`), walBefore);
  await assert.rejects(snapshotDatabase(f.paths.tongpin, output), code('snapshot_exists'));
  await assert.rejects(snapshotDatabase(f.paths.tongpin, f.paths.tongpin), code('target_aliases_source'));
  const alias = join(f.directory, 'source-hardlink.sqlite'); linkSync(f.paths.tongpin, alias);
  await assert.rejects(snapshotDatabase(f.paths.tongpin, alias), code('target_aliases_source'));
});

test('migration dry-run removes temporary databases, preserves sources, and returns aggregate diagnostics only', async t => {
  const f = fixture(t); f.closeSources();
  const before = Object.fromEntries(Object.entries(f.paths).map(([key, path]) => [key, digest(path)]));
  const report = await migrate({ sources: f.paths, tempDirectory: f.directory });
  assert.equal(report.mode, 'dry-run'); assert.equal(report.applied, false); assert.equal(report.validation.ok, true);
  assert.equal(report.identities.targetUsers, 8); assert.equal(existsSync(f.target), false);
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('tongzhi-migration-')), false);
  for (const [key, path] of Object.entries(f.paths)) assert.equal(digest(path), before[key]);
  const output = JSON.stringify(report);
  for (const secret of ['private-import-sentinel', 'private-dm-sentinel', 'hashed-person', 'MEMBER@example.test', 'derived-model-sentinel', 'password', 'admin-secret']) assert.equal(output.includes(secret), false);
  assert.equal(report.sources.find(s => s.project === 'tongti').skippedCounts.admin_setup, 1);
  await assert.rejects(migrate({ sources: f.paths, targetPath: f.target, tempDirectory: f.directory }), code('dry_run_cannot_have_target'));
});

test('migration separates colliding IDs and same nicknames, and merges only verified typed identities', async t => {
  const f = fixture(t), report = await f.apply({ verifiedIdentities: identityManifest });
  assert.equal(report.identities.targetUsers, 7); assert.equal(report.identities.mergedUsers, 1);
  const db = new DatabaseSync(f.target, { readOnly: true }); t.after(() => db.close());
  const shared = mapped(db, 'tongpin', 'user', 'same-id');
  assert.equal(shared, mapped(db, 'tongti', 'user', 'same-id'));
  assert.notEqual(mapped(db, 'tongpin', 'user', 'guest-pin'), mapped(db, 'tongti', 'user', 'guest-ti'));
  assert.notEqual(mapped(db, 'tongpin', 'user', 'numeric-pin'), mapped(db, 'tongti', 'user', 'numeric-ti'));
  assert.notEqual(mapped(db, 'tongpin', 'message', 'shared-message-id'), mapped(db, 'tongti', 'message', 'shared-message-id'));
  assert.equal(db.prepare("SELECT user_id FROM identities WHERE provider='zhihu' AND subject='hash:hashed-person'").get().user_id, shared);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE subject IS NOT NULL").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM identities WHERE provider='legacy:tongpin:zhihu'").get().n, 2);
  const profile = db.prepare('SELECT * FROM profiles').get(); assert.equal(profile.discoverable, 0); assert.equal(profile.revision, 3); assert.equal(JSON.parse(profile.data).id, shared);
});

test('migration preserves legacy password salt semantics and disabled status without granting admin powers', async t => {
  const f = fixture(t); await f.apply();
  const store = new KnowledgeStore(f.target); t.after(() => store.close());
  const id = mapped(store.db, 'tongti', 'user', 'email-ti');
  const account = store.db.prepare('SELECT * FROM email_accounts WHERE user_id=?').get(id);
  assert.equal(account.email, 'member@example.test'); assert.equal(account.password_hash, passwordHash); assert.equal(account.verified, 0);
  assert.equal(await verifyPassword(legacyPassword, account.password_hash), true);
  assert.equal(await verifyPassword('incorrect fixture password', account.password_hash), false);
  assert.equal(store.isActive(id), false);
  const metadata = JSON.parse(store.db.prepare("SELECT data FROM legacy_metadata WHERE entity_type='email_account'").get().data);
  assert.equal(metadata.legacySiteRole, 'admin'); assert.equal(metadata.adminPrivilegesImported, false);
  for (const table of ['sessions', 'zhihu_validations', 'jobs', 'notifications', 'profile_suggestions']) assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('oauth_states','admin_setup','admin_sessions')").get(), undefined);
  assert.deepEqual(store.preferences(id).preferences, { groupInvites: false, aiAnalysis: false, chatAnalysis: false, notificationDigests: false });
});

test('migration remaps direct conversations and retains independent directed blocks', async t => {
  const f = fixture(t); await f.apply();
  const store = new KnowledgeStore(f.target); t.after(() => store.close());
  const a = mapped(store.db, 'tongpin', 'user', 'same-id'), b = mapped(store.db, 'tongpin', 'user', 'peer-pin');
  const conversation = mapped(store.db, 'tongpin', 'invitation', 'same-invitation');
  const row = store.conversation(a, conversation); assert.equal(row.recipient_id, b);
  assert.equal(store.messages(a, conversation).items[0].text, 'private-dm-sentinel');
  assert.equal(store.db.prepare('SELECT client_message_id FROM messages').get().client_message_id, 'retry-original');
  assert.equal(store.db.prepare('SELECT status FROM invitations WHERE id=?').get(mapped(store.db, 'tongpin', 'invitation', 'pending')).status, 'cancelled');
  const tiGuest = mapped(store.db, 'tongti', 'user', 'guest-ti'), tiHost = mapped(store.db, 'tongti', 'user', 'same-id');
  assert.ok(store.db.prepare('SELECT 1 FROM blocked WHERE user_id=? AND target_id=?').get(tiGuest, tiHost));
  assert.equal(store.db.prepare('SELECT 1 FROM blocked WHERE user_id=? AND target_id=?').get(tiHost, tiGuest), undefined);
});

test('migration labels irreconstructable history, preserves available outcome version and rebuilds independent read cursors', async t => {
  const f = fixture(t); await f.apply();
  const db = new DatabaseSync(f.target, { readOnly: true }); t.after(() => db.close());
  const circle = db.prepare('SELECT * FROM circle_groups').get(), round = db.prepare('SELECT * FROM circle_rounds').get();
  assert.equal(round.status, 'archived'); assert.match(round.question, /最后记录/); assert.match(circle.description, /未记录完整轮次/);
  assert.equal(circle.ai_enabled, 0); assert.equal(circle.auto_summary, 0); assert.equal(circle.current_round_id, round.id);
  const host = mapped(db, 'tongti', 'user', 'same-id'), guest = mapped(db, 'tongti', 'user', 'guest-ti');
  const member = db.prepare('SELECT * FROM circle_memberships WHERE user_id=?').get(host);
  assert.equal(member.role, 'host'); assert.equal(member.subscribed, 0); assert.equal(member.ai_consent, 0); assert.equal(member.allow_connections, 0);
  const lastRead = db.prepare('SELECT last_seq FROM circle_reads WHERE user_id=?').get(host).last_seq;
  assert.equal(db.prepare('SELECT id FROM circle_messages WHERE rowid=?').get(lastRead).id, mapped(db, 'tongti', 'update', 'update-one'));
  const guestRead = db.prepare('SELECT last_seq FROM circle_reads WHERE user_id=?').get(guest).last_seq;
  assert.equal(db.prepare('SELECT action FROM circle_messages WHERE rowid=?').get(guestRead).action, 'legacy_history');
  const outcome = db.prepare('SELECT * FROM circle_outcomes').get(), versions = db.prepare('SELECT * FROM circle_outcome_versions').all();
  assert.equal(versions.length, 1); assert.equal(versions[0].version, 4); assert.deepEqual(JSON.parse(versions[0].snapshot), { ...outcome });
  assert.equal(outcome.reviewed_by, mapped(db, 'tongti', 'user', 'email-ti')); assert.equal(outcome.reviewed_at, at(8));
  assert.equal(outcome.origin_message_id, mapped(db, 'tongti', 'message', 'rules-message'));
  assert.equal(db.prepare('SELECT reply_to FROM circle_messages WHERE id=?').get(mapped(db, 'tongti', 'message', 'reply-message')).reply_to, mapped(db, 'tongti', 'message', 'shared-message-id'));
});

test('migration preserves full derived dependencies and actual app serializers redact hidden or blocked sources', async t => {
  const f = fixture(t); await f.apply();
  const store = new KnowledgeStore(f.target), circles = new Circles({ store, intervalMs: 0 }); t.after(() => { circles.close(); store.close(); });
  const host = mapped(store.db, 'tongti', 'user', 'same-id'), guest = mapped(store.db, 'tongti', 'user', 'guest-ti');
  const rules = store.db.prepare('SELECT * FROM circle_messages WHERE id=?').get(mapped(store.db, 'tongti', 'message', 'rules-message'));
  assert.ok(JSON.parse(rules.dependency_ids).includes(mapped(store.db, 'tongti', 'message', 'hidden-human')));
  assert.ok(JSON.parse(rules.dependency_source_ids).includes(mapped(store.db, 'tongti', 'source', 'source-one')));
  const citations = JSON.parse(rules.citations); assert.equal(citations[0].messageId, mapped(store.db, 'tongti', 'message', 'shared-message-id')); assert.equal('nickname' in citations[0], false);
  assert.equal(circles.messageDTO(rules, host).redacted, true); assert.equal(circles.messageDTO(rules, host).text.includes('sentinel'), false);
  const model = store.db.prepare('SELECT * FROM circle_messages WHERE id=?').get(mapped(store.db, 'tongti', 'message', 'model-message'));
  assert.ok(model.hidden_at); assert.equal(circles.messageDTO(model, host).redacted, true);
  for (const consent of JSON.parse(model.consent_versions)) assert.ok(store.user(consent.userId));
  const original = store.db.prepare('SELECT * FROM circle_messages WHERE id=?').get(mapped(store.db, 'tongti', 'message', 'shared-message-id'));
  assert.equal(circles.messageDTO(original, guest).hidden, true);
  assert.equal(circles.outcomeDTO(store.db.prepare('SELECT * FROM circle_outcomes').get(), host).redacted, true);
});

test('migration never silently empties missing reference arrays and hides their derived content', async t => {
  const f = fixture(t);
  f.ti.prepare("UPDATE messages SET dependency_ids=?,source_ids=? WHERE id='rules-message'").run('["deleted-message"]', '["deleted-source"]');
  f.ti.prepare("UPDATE artifacts SET origin_message_id='deleted-origin' WHERE id='artifact-one'").run();
  const report = await f.apply(); assert.ok(report.validation.retainedHiddenReferences > 0);
  const db = new DatabaseSync(f.target, { readOnly: true }); t.after(() => db.close());
  const row = db.prepare('SELECT * FROM circle_messages WHERE id=?').get(mapped(db, 'tongti', 'message', 'rules-message'));
  assert.ok(row.hidden_at); assert.ok(JSON.parse(row.dependency_ids).includes(mapped(db, 'tongti', 'unresolved_message', 'deleted-message')));
  assert.ok(JSON.parse(row.source_ids).includes(mapped(db, 'tongti', 'unresolved_source', 'deleted-source')));
  const outcome = db.prepare('SELECT * FROM circle_outcomes').get(); assert.ok(outcome.hidden_at); assert.equal(outcome.origin_message_id, null);
  assert.ok(JSON.parse(outcome.dependency_ids).includes(mapped(db, 'tongti', 'unresolved_message', 'deleted-origin')));
});

test('migration apply is idempotent including source-session churn and refuses a changed target or input', async t => {
  const f = fixture(t), first = await f.apply();
  const before = digest(f.target);
  f.pin.prepare('UPDATE sessions SET expires_at=expires_at+100').run();
  const second = await f.apply();
  assert.equal(second.alreadyApplied, true); assert.equal(second.applied, false); assert.equal(second.batchId, first.batchId);
  assert.deepEqual(second.validation.counts, first.validation.counts); assert.equal(digest(f.target), before);
  assert.equal(validateMigration(f.target).ok, true);
  await assert.rejects(f.apply({ verifiedIdentities: identityManifest }), code('target_contains_other_migration'));
  const target = new DatabaseSync(f.target); target.prepare("UPDATE users SET name='local edit'").run(); target.close();
  await assert.rejects(f.apply(), code('target_changed_after_migration'));
  assert.throws(() => validateMigration(f.target), code('target_changed_after_migration'));
});

test('migration rejects unrelated nonempty targets and aliases before mutating either database', async t => {
  const f = fixture(t), db = new DatabaseSync(f.target); db.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('keep');"); db.close();
  const before = digest(f.target);
  await assert.rejects(f.apply(), code('target_not_empty')); assert.equal(digest(f.target), before);
  await assert.rejects(f.apply({ targetPath: f.paths.tongpin }), code('target_aliases_source'));
  const symlink = join(f.directory, 'target-symlink'); symlinkSync(f.paths.tongpin, symlink);
  await assert.rejects(f.apply({ targetPath: symlink }), code('target_not_regular_file'));
  const hardlink = join(f.directory, 'target-hardlink'); linkSync(f.paths.tongpin, hardlink);
  await assert.rejects(f.apply({ targetPath: hardlink }), code('target_aliases_source'));
});

test('migration verifies typed manifests against source data and never guesses numeric identities', async t => {
  const f = fixture(t);
  for (const entry of [
    { sourceProject: 'tongpin', userId: 'same-id', kind: 'hash', value: 'another-person' },
    { sourceProject: 'tongti', userId: 'numeric-ti', kind: 'hash', value: '99999999999999999999' },
    { sourceProject: 'tongpin', userId: 'guest-pin', kind: 'hash', value: 'guessed-by-nickname' },
  ]) await assert.rejects(f.apply({ verifiedIdentities: [entry] }), code('identity_manifest_source_mismatch'));
  await assert.rejects(f.apply({ verifiedIdentities: [{ sourceProject: 'tongti', userId: 'numeric-ti', kind: 'uid', value: 99999 }] }), code('identity_manifest_invalid'));
  await assert.rejects(f.apply({ verifiedIdentities: [{ sourceProject: 'tongpin', userId: 'same-id', kind: 'uid', value: 'hashed-person' }] }), code('uid_must_be_lossless_decimal_string'));
  assert.equal(existsSync(f.target), false);
});

test('migration fails atomically on malformed JSON, email collisions and orphaned required records', async t => {
  const f = fixture(t);
  f.ti.prepare("UPDATE messages SET citations='malformed private JSON' WHERE id='model-message'").run();
  await assert.rejects(f.apply(), code('invalid_json')); assert.equal(existsSync(f.target), false);
  f.ti.prepare("UPDATE messages SET citations='[]' WHERE id='model-message'").run();
  insert(f.ti, 'email_accounts', { user_id: 'guest-ti', email: 'member@EXAMPLE.test', password_hash: passwordHash, site_role: 'member', status: 'active', registered_at: at(0), last_login_at: null });
  await assert.rejects(f.apply(), code('email_identity_conflict')); assert.equal(existsSync(f.target), false);
  f.ti.prepare("DELETE FROM email_accounts WHERE user_id='guest-ti'").run();
  f.pin.prepare("UPDATE messages SET author_id='missing-user'").run();
  await assert.rejects(f.apply(), code('dm_author_or_conversation_invalid')); assert.equal(existsSync(f.target), false);
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('tongzhi-migration-')), false);
});

test('migration import into an existing empty schema rolls back all data after a late failure', async t => {
  const f = fixture(t), empty = new KnowledgeStore(f.target); empty.close();
  f.ti.prepare("UPDATE reports SET message_id='missing-report-target'").run();
  await assert.rejects(f.apply(), code('reported_message_missing'));
  const check = new DatabaseSync(f.target, { readOnly: true }); t.after(() => check.close());
  for (const table of ['users', 'profiles', 'messages', 'circle_groups', 'circle_messages', 'legacy_id_map', 'migration_runs']) assert.equal(check.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
});

test('migration CLI inspect and errors do not disclose record bodies, identity subjects or credentials', async t => {
  const f = fixture(t); f.closeSources();
  const inspection = inspectSource('tongti', f.paths.tongti);
  assert.equal(inspection.tables.find(table => table.name === 'users').count, 4);
  assert.equal(inspection.tables.find(table => table.name === 'admin_setup').migrate, false);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cli = join(root, 'scripts/migration/migrate.mjs');
  const manifestPath = join(f.directory, 'identities.json'); writeFileSync(manifestPath, JSON.stringify({ version: 1, verifiedIdentities: identityManifest }), { mode: 0o600 });
  const run = spawnSync(process.execPath, [cli, 'dry-run', '--tongpin', f.paths.tongpin, '--tongti', f.paths.tongti, '--identities', manifestPath], { encoding: 'utf8', cwd: root });
  assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).identities.mergedUsers, 1);
  assert.equal(run.stdout.includes('hashed-person'), false); assert.equal(run.stdout.includes('private-import-sentinel'), false);
  const bad = spawnSync(process.execPath, [cli, 'dry-run', '--tongti', f.paths.tongti, '--target', f.target], { encoding: 'utf8', cwd: root });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /invalid_cli_arguments/); assert.equal(bad.stderr.includes('MEMBER@'), false);
});
