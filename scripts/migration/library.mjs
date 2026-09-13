import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore } from '../../server/knowledge-store.js';
import { initializeCircles } from '../../server/circles/schema.js';
import { normalizeEmail } from '../../server/email-auth.js';

export const MIGRATION_VERSION = 1;
const PROJECTS = ['tongpin', 'tongti'];
const TABLES = {
  tongpin: ['users', 'profiles', 'imports', 'saved', 'invitations', 'messages', 'blocked'],
  tongti: ['users', 'email_accounts', 'communities', 'memberships', 'messages', 'artifacts', 'updates', 'sources', 'reports', 'blocks'],
};
const FORBIDDEN = ['sessions', 'zhihu_validations', 'oauth_states', 'admin_setup', 'admin_sessions'];
const PRIVATE_DEFAULTS = { groupInvites: false, aiAnalysis: false, chatAnalysis: false, notificationDigests: false };
const EPOCH = '1970-01-01T00:00:00.000Z';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value);
const pair = (...values) => json(values);
const identifier = value => `"${value.replaceAll('"', '""')}"`;
const stableId = (project, type, value) => `legacy_${project}_${type}_${sha(String(value)).slice(0, 28)}`;
const uniq = items => [...new Set(items)];
const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${identifier(table)}`).get().n;
const counts = db => Object.fromEntries(tables(db).map(table => [table, count(db, table)]));

export class MigrationError extends Error {
  constructor(code, message = '迁移检查未通过；请根据错误代码检查输入。') { super(message); this.name = 'MigrationError'; this.code = code; }
}
function requireThat(value, code) { if (!value) throw new MigrationError(code); return value; }
function safeError(error) { return error instanceof MigrationError ? error : new MigrationError('database_operation_failed', '数据库操作失败；已停止迁移，未输出原始数据或凭据。'); }
function parseJson(value, kind = 'object') {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new MigrationError('invalid_json'); }
  requireThat(kind === 'array' ? Array.isArray(parsed) : parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'invalid_json_shape');
  return parsed;
}
function text(value, fallback = '') { return typeof value === 'string' ? value : fallback; }
function instant(value, fallback = EPOCH) {
  if (value === null || value === undefined || value === '') return fallback;
  requireThat(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'invalid_timestamp');
  return new Date(value).toISOString();
}
function number(value, fallback = 0) { requireThat(value === undefined || value === null || Number.isSafeInteger(value), 'invalid_integer'); return value ?? fallback; }
function readonly(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
  return db;
}
function sourceFile(path) {
  requireThat(typeof path === 'string' && path !== ':memory:' && existsSync(path), 'source_missing');
  const resolved = realpathSync(path);
  requireThat(statSync(resolved).isFile(), 'source_not_file');
  return resolved;
}
function destinationFile(path, sources = []) {
  requireThat(typeof path === 'string' && path && path !== ':memory:', 'target_required');
  const absolute = resolve(path);
  if (existsSync(absolute) || (() => { try { return lstatSync(absolute).isSymbolicLink(); } catch { return false; } })()) {
    requireThat(!lstatSync(absolute).isSymbolicLink() && statSync(absolute).isFile(), 'target_not_regular_file');
    const targetStat = statSync(absolute);
    for (const source of sources) {
      const sourceStat = statSync(source);
      requireThat(targetStat.dev !== sourceStat.dev || targetStat.ino !== sourceStat.ino, 'target_aliases_source');
    }
  }
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const resolved = join(realpathSync(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
  requireThat(!sources.includes(resolved), 'target_aliases_source');
  return resolved;
}
function removeOwnedDatabase(path) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${path}${suffix}`, { force: true });
}

/** SQLite's backup API includes committed WAL data and never opens the source writable. */
export async function snapshotDatabase(sourcePath, outputPath) {
  const source = sourceFile(sourcePath), output = destinationFile(outputPath, [source]);
  requireThat(!existsSync(output), 'snapshot_exists');
  let db, created = false;
  try {
    const fd = openSync(output, 'wx', 0o600); closeSync(fd); created = true;
    db = readonly(source);
    await backup(db, output);
    chmodSync(output, 0o600);
    const check = readonly(output);
    try { requireThat(check.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'snapshot_integrity_failed'); }
    finally { check.close(); }
    return { path: output, mode: '0600', bytes: statSync(output).size };
  } catch (error) { if (created) removeOwnedDatabase(output); throw safeError(error); }
  finally { db?.close(); }
}

/** Inspection intentionally returns only schema column names and aggregate counts. */
export function inspectSource(project, sourcePath) {
  requireThat(PROJECTS.includes(project), 'unknown_source_project');
  const db = readonly(sourceFile(sourcePath));
  try {
    return { project, tables: tables(db).map(name => ({ name, count: count(db, name),
      columns: db.prepare(`PRAGMA table_info(${identifier(name)})`).all().map(column => column.name),
      migrate: TABLES[project].includes(name) })) };
  } finally { db.close(); }
}

function readSource(project, path) {
  const db = readonly(path);
  try {
    const present = tables(db), data = {}, columns = {}, hash = createHash('sha256');
    requireThat(present.includes('users'), 'source_users_missing');
    for (const table of TABLES[project]) {
      requireThat(present.includes(table) || (project === 'tongti' && table === 'email_accounts'), 'source_schema_incomplete');
      columns[table] = present.includes(table) ? db.prepare(`PRAGMA table_info(${identifier(table)})`).all().map(c => c.name) : [];
      data[table] = present.includes(table) ? db.prepare(`SELECT rowid AS __source_rowid,* FROM ${identifier(table)} ORDER BY rowid`).all() : [];
      hash.update(json([table, columns[table]]));
      for (const row of data[table]) hash.update(json(row));
    }
    requireThat(columns.users.includes(project === 'tongpin' ? 'name' : 'nickname'), 'wrong_source_project');
    return { project, data, columns, fingerprint: hash.digest('hex'),
      counts: Object.fromEntries(TABLES[project].map(t => [t, data[t].length])),
      skippedCounts: Object.fromEntries(present.filter(t => !TABLES[project].includes(t)).map(t => [t, count(db, t)])) };
  } finally { db.close(); }
}

function verifiedPlan(sources, input) {
  requireThat(Array.isArray(input), 'identity_manifest_invalid');
  const sourceMap = new Map(sources.map(s => [s.project, s])), entries = new Map();
  for (const entry of input) {
    requireThat(entry && PROJECTS.includes(entry.sourceProject) && typeof entry.userId === 'string'
      && ['hash', 'uid'].includes(entry.kind) && typeof entry.value === 'string' && entry.value.length > 0
      && entry.value.length <= 512 && entry.value.trim() === entry.value && !/[\u0000-\u001f\u007f]/u.test(entry.value), 'identity_manifest_invalid');
    requireThat(entry.kind !== 'uid' || /^[0-9]+$/.test(entry.value), 'uid_must_be_lossless_decimal_string');
    const source = sourceMap.get(entry.sourceProject), row = source?.data.users.find(user => user.id === entry.userId);
    requireThat(row, 'identity_manifest_user_missing');
    const subject = `${entry.kind}:${entry.value}`;
    requireThat(entry.sourceProject === 'tongpin'
      ? row.provider === 'zhihu' && row.subject === entry.value
      : row.identity === 'zhihu' && row.zhihu_id === subject, 'identity_manifest_source_mismatch');
    const key = pair(entry.sourceProject, entry.userId);
    requireThat(!entries.has(key) || entries.get(key) === subject, 'identity_manifest_conflict');
    entries.set(key, subject);
  }
  const groups = new Map(), userMap = new Map();
  for (const source of sources) for (const row of source.data.users) {
    requireThat(typeof row.id === 'string' && row.id.length > 0, 'source_user_id_invalid');
    const key = pair(source.project, row.id), verified = entries.get(key);
    const groupKey = verified ? `zhihu:${verified}` : `legacy:${key}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ project: source.project, row, verified });
  }
  for (const group of groups.values()) {
    group.sort((a, b) => pair(a.project, a.row.id).localeCompare(pair(b.project, b.row.id), 'en'));
    const canonical = stableId(group[0].project, 'user', group[0].row.id);
    for (const item of group) userMap.set(pair(item.project, item.row.id), canonical);
  }
  return { groups, userMap, verified: entries, fingerprint: sha(json([...entries].sort(([a], [b]) => a.localeCompare(b, 'en')))) };
}

function initializeMetadata(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS legacy_metadata (
    source_project TEXT NOT NULL, entity_type TEXT NOT NULL, old_id TEXT NOT NULL,
    owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    circle_id TEXT REFERENCES circle_groups(id) ON DELETE CASCADE, data TEXT NOT NULL,
    PRIMARY KEY(source_project,entity_type,old_id),
    FOREIGN KEY(source_project,entity_type,old_id) REFERENCES legacy_id_map(source_project,entity_type,old_id) ON DELETE CASCADE
  )`);
}
function stateFingerprint(db) {
  const hash = createHash('sha256');
  for (const table of tables(db).filter(name => name !== 'migration_runs')) {
    const rows = db.prepare(`SELECT rowid AS __rowid,* FROM ${identifier(table)} ORDER BY rowid`).all();
    // Opening the application may create empty companion/matching tables; no data changes are ignored.
    if (rows.length) { hash.update(table); for (const row of rows) hash.update(json(row)); }
  }
  return hash.digest('hex');
}
function currentBatch(db, batchId, sources) {
  const present = tables(db);
  if (!present.includes('migration_runs') || count(db, 'migration_runs') === 0) {
    requireThat(present.every(table => count(db, table) === 0), 'target_not_empty');
    return null;
  }
  const runs = db.prepare('SELECT * FROM migration_runs ORDER BY source_project').all();
  requireThat(runs.length === sources.length && runs.every(run => run.id === `${batchId}:${run.source_project}`
    && sources.find(source => source.project === run.source_project)?.fingerprint === run.source_fingerprint), 'target_contains_other_migration');
  const report = parseJson(runs[0].report);
  requireThat(report.batchId === batchId && runs.every(run => run.report === runs[0].report), 'migration_report_mismatch');
  requireThat(stateFingerprint(db) === report.targetFingerprint, 'target_changed_after_migration');
  return report;
}

function importer(db, sources, plan, stamp) {
  const warningCounts = new Map();
  const warn = (code, n = 1) => warningCounts.set(code, (warningCounts.get(code) || 0) + n);
  const insert = (table, row) => db.prepare(`INSERT INTO ${identifier(table)} (${Object.keys(row).map(identifier).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  const mapping = (project, type, oldId, newId) => {
    const old = db.prepare('SELECT new_id FROM legacy_id_map WHERE source_project=? AND entity_type=? AND old_id=?').get(project, type, String(oldId));
    requireThat(!old || old.new_id === newId, 'mapping_conflict');
    if (!old) insert('legacy_id_map', { source_project: project, entity_type: type, old_id: String(oldId), new_id: newId });
    return newId;
  };
  const mapId = (project, type, oldId) => mapping(project, type, oldId, stableId(project, type, oldId));
  const userId = (project, oldId, optional = false) => {
    if (oldId === null || oldId === undefined || oldId === '') { requireThat(optional, 'required_user_missing'); return null; }
    const found = plan.userMap.get(pair(project, oldId));
    if (!found && optional) { warn('orphaned_author_hidden'); return null; }
    requireThat(found, 'required_user_missing'); return found;
  };
  const meta = (project, type, oldId, data, owner = null, circle = null) => insert('legacy_metadata', {
    source_project: project, entity_type: type, old_id: String(oldId), owner_user_id: owner, circle_id: circle, data: json(data),
  });
  const edgeTarget = (project, oldId) => userId(project, oldId, true) || mapId(project, 'unresolved_user', oldId);

  // Names/emails never participate in this merge. A typed, verified identity is the sole cross-site key.
  for (const group of plan.groups.values()) {
    const id = userId(group[0].project, group[0].row.id);
    const display = group.find(item => item.project === 'tongti') || group[0];
    const accounts = group.flatMap(item => (sources.find(s => s.project === item.project).data.email_accounts || []).filter(a => a.user_id === item.row.id));
    const registered = group.flatMap(item => item.row.registered_at ? [instant(item.row.registered_at)] : []).concat(accounts.map(a => instant(a.registered_at)));
    const disabled = accounts.some(a => a.status === 'disabled') || group.some(item => item.row.status === 'disabled');
    insert('users', { id, name: text(display.row.nickname, text(display.row.name, '旧站成员')), provider: group.some(item => item.row.provider === 'zhihu' || item.row.identity === 'zhihu') ? 'zhihu' : accounts.length ? 'email' : 'guest',
      subject: null, avatar: '', created_at: group.map(item => instant(item.row.created_at)).sort()[0],
      last_seen_at: group.flatMap(item => item.row.last_seen_at ? [instant(item.row.last_seen_at)] : []).sort().at(-1) || null,
      registered_at: registered.sort()[0] || null, status: disabled ? 'disabled' : 'active' });
    insert('user_preferences', { user_id: id, data: json(PRIVATE_DEFAULTS), revision: 1, updated_at: stamp });
    for (const item of group) {
      mapping(item.project, 'user', item.row.id, id);
      const subject = item.project === 'tongpin' ? item.row.subject : item.row.zhihu_id;
      if (subject) {
        requireThat(typeof subject === 'string', 'legacy_subject_must_be_string');
        insert('identities', { provider: `legacy:${item.project}:zhihu`, subject, user_id: id, created_at: stamp });
        if (!item.verified) warn('unverified_zhihu_identity_not_bound');
      }
      meta(item.project, 'user', item.row.id, { name: item.row.name ?? item.row.nickname,
        provider: item.row.provider ?? item.row.identity, avatar: item.row.avatar ?? '', avatarHue: item.row.avatar_hue ?? null,
        goal: item.row.goal ?? '', stage: item.row.stage ?? '', verifiedZhihu: Boolean(item.verified) }, id);
      if ((item.row.provider ?? item.row.identity) === 'guest' && !accounts.some(a => a.user_id === item.row.id)) warn('guest_history_requires_original_identity');
    }
    if (group[0].verified) insert('identities', { provider: 'zhihu', subject: group[0].verified, user_id: id, created_at: stamp });
  }

  for (const source of sources) {
    const project = source.project;
    for (const account of source.data.email_accounts || []) {
      const id = userId(project, account.user_id);
      let email;
      try { email = normalizeEmail(account.email); } catch { throw new MigrationError('legacy_email_invalid'); }
      requireThat(/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(account.password_hash), 'unsupported_password_hash');
      requireThat(['active', 'disabled'].includes(account.status), 'legacy_account_status_invalid');
      requireThat(!db.prepare('SELECT 1 FROM email_accounts WHERE email=? OR user_id=?').get(email, id), 'email_identity_conflict');
      insert('email_accounts', { user_id: id, email, password_hash: account.password_hash, verified: 0,
        created_at: instant(account.registered_at), updated_at: instant(account.last_login_at, instant(account.registered_at)) });
      insert('identities', { provider: 'email', subject: email, user_id: id, created_at: instant(account.registered_at) });
      mapping(project, 'email_account', account.user_id, id);
      meta(project, 'email_account', account.user_id, { legacySiteRole: account.site_role, legacyStatus: account.status,
        lastLoginAt: account.last_login_at || null, adminPrivilegesImported: false }, id);
      if (account.site_role === 'admin') warn('legacy_admin_requires_separate_setup');
    }
    if (project !== 'tongpin') continue;
    for (const row of source.data.profiles) {
      const id = userId(project, row.user_id), data = parseJson(row.data);
      if (data.id !== undefined) data.id = id;
      if (data.avatarSeed === row.user_id) data.avatarSeed = id;
      const revision = number(row.revision, 1); requireThat(revision > 0, 'invalid_profile_revision');
      insert('profiles', { user_id: id, data: json(data), revision, discoverable: 0, updated_at: instant(row.updated_at) });
      mapping(project, 'profile', row.user_id, id);
    }
    for (const row of source.data.imports) {
      const id = userId(project, row.user_id), data = parseJson(row.data, 'array');
      insert('imports', { user_id: id, data: json(data), fetched_at: instant(row.fetched_at) });
      mapping(project, 'import', row.user_id, id);
    }
    for (const row of source.data.saved) {
      const id = userId(project, row.user_id), target = edgeTarget(project, row.target_id);
      insert('saved', { user_id: id, target_id: target, created_at: instant(row.created_at) });
      mapping(project, 'saved', pair(row.user_id, row.target_id), pair(id, target));
    }
    for (const row of source.data.invitations) {
      requireThat(['pending', 'accepted', 'declined', 'cancelled'].includes(row.status), 'invalid_invitation_status');
      const sender = userId(project, row.sender_id), recipient = userId(project, row.recipient_id);
      requireThat(sender !== recipient, 'merged_self_conversation');
      insert('invitations', { id: mapId(project, 'invitation', row.id), sender_id: sender, recipient_id: recipient,
        message: text(row.message), status: row.status === 'pending' ? 'cancelled' : row.status,
        created_at: instant(row.created_at), updated_at: instant(row.updated_at) });
      if (row.status === 'pending') warn('pending_invitation_cancelled');
    }
    const invitations = new Map(source.data.invitations.map(row => [row.id, row]));
    for (const row of source.data.messages) {
      const conversation = invitations.get(row.conversation_id);
      requireThat(conversation && [conversation.sender_id, conversation.recipient_id].includes(row.author_id), 'dm_author_or_conversation_invalid');
      insert('messages', { id: mapId(project, 'message', row.id), conversation_id: mapId(project, 'invitation', row.conversation_id),
        author_id: userId(project, row.author_id), text: text(row.text), created_at: instant(row.created_at), client_message_id: row.client_message_id || null });
    }
  }

  for (const source of sources) for (const row of source.data[source.project === 'tongpin' ? 'blocked' : 'blocks']) {
    const id = userId(source.project, row.user_id), oldTarget = row.target_id ?? row.blocked_user_id, target = edgeTarget(source.project, oldTarget);
    requireThat(id !== target, 'merged_self_block');
    db.prepare('INSERT OR IGNORE INTO blocked VALUES (?,?,?)').run(id, target, instant(row.created_at, stamp));
    mapping(source.project, 'block', pair(row.user_id, oldTarget), pair(id, target));
  }

  const tongti = sources.find(source => source.project === 'tongti');
  if (tongti) {
    const project = 'tongti', data = tongti.data;
    const messageIndex = new Map(data.messages.map(row => [row.id, row])), sourceIndex = new Map(data.sources.map(row => [row.id, row]));
    const messageRefs = (row, derived, at) => {
      let unsafe = false;
      const ref = (type, oldId) => {
        requireThat(typeof oldId === 'string' && oldId.length > 0, 'invalid_reference_id');
        const original = (type === 'message' ? messageIndex : sourceIndex).get(oldId);
        if (!original) { unsafe = true; warn('missing_reference_hidden'); return mapId(project, `unresolved_${type}`, oldId); }
        if (original.community_id !== row.community_id) { unsafe = true; warn('cross_circle_reference_hidden'); }
        return mapId(project, type, oldId);
      };
      const citationInput = parseJson(row.citations ?? '[]', 'array');
      const citations = citationInput.map(citation => {
        requireThat(citation && typeof citation === 'object' && !Array.isArray(citation), 'invalid_citation');
        // The app reconstructs author and quote from the original stored message.
        return { messageId: ref('message', citation.messageId), ...(typeof citation.label === 'string' ? { label: citation.label } : {}) };
      });
      const dependencies = parseJson(row.dependency_ids ?? '[]', 'array').map(id => ref('message', id));
      const sourceIds = parseJson(row.source_ids ?? '[]', 'array').map(id => ref('source', id));
      let dependencySources = [];
      if (derived) {
        dependencies.push(...data.messages.filter(message => message.community_id === row.community_id && message.kind === 'human'
          && instant(message.created_at) <= at).map(message => mapId(project, 'message', message.id)));
        dependencySources = data.sources.filter(source => source.community_id === row.community_id && instant(source.created_at) <= at).map(source => mapId(project, 'source', source.id));
      }
      dependencies.push(...citations.map(citation => citation.messageId));
      let origin = null;
      if (row.origin_message_id) {
        const mapped = ref('message', row.origin_message_id); dependencies.push(mapped);
        if (messageIndex.has(row.origin_message_id) && messageIndex.get(row.origin_message_id).community_id === row.community_id) origin = mapped;
      }
      const model = row.ai_mode === 'model';
      const consents = model ? data.memberships.filter(member => member.community_id === row.community_id)
        .map(member => ({ userId: userId(project, member.user_id), revision: 1 })) : [];
      return { citations: json(citations), source_ids: json(uniq(sourceIds)), dependency_ids: json(uniq(dependencies)),
        dependency_source_ids: json(uniq(dependencySources)), consent_versions: json(consents), origin, unsafe };
    };
    for (const community of data.communities) {
      const circle = mapId(project, 'community', community.id), round = mapId(project, 'historical_round', community.id);
      const members = data.memberships.filter(member => member.community_id === community.id), hosts = members.filter(member => member.role === 'host');
      requireThat(hosts.length <= 1 && members.every(member => ['host', 'member'].includes(member.role)), 'legacy_host_conflict');
      const host = hosts.length ? userId(project, hosts[0].user_id) : null;
      const tags = parseJson(community.tags, 'array'); requireThat(tags.every(tag => typeof tag === 'string'), 'invalid_circle_tags');
      insert('circle_groups', { id: circle, title: text(community.title),
        description: `【同题历史小组】旧站未记录完整轮次，本轮保留旧讨论；问题为最后一次记录，不能据此还原全部历史轮次。\n${text(community.description)}`,
        tags: json(tags), capacity: Math.min(30, Math.max(12, members.length)), current_round_id: round, created_by: host,
        ai_enabled: 0, auto_summary: 0, activity_at: Date.parse(instant(community.updated_at)), created_at: instant(community.created_at), updated_at: instant(community.updated_at) });
      insert('circle_rounds', { id: round, circle_id: circle, number: 1,
        question: `【旧站历史 · 最后记录的问题】${text(community.question)}`, goal: text(community.goal), status: 'archived',
        created_by: host, created_at: instant(community.created_at), updated_at: instant(community.updated_at) });
      meta(project, 'community', community.id, { historicalRoundsReconstructable: false, lastKnownQuestionOnly: true,
        color: community.color, icon: community.icon, isStarter: Boolean(community.is_starter) }, null, circle);
      warn('community_imported_as_historical_round');
      if (members.length > 30) warn('legacy_circle_over_capacity');
      for (const member of members) {
        const id = userId(project, member.user_id), key = pair(community.id, member.user_id);
        insert('circle_memberships', { circle_id: circle, user_id: id, role: member.role, status: 'active', duration: 'ongoing',
          goal: text(member.goal), stage: text(member.stage), subscribed: 0, allow_connections: 0, ai_consent: 0, ai_revision: 1,
          joined_at: instant(member.joined_at), expires_at: null, left_at: null });
        mapping(project, 'membership', key, pair(circle, id));
        meta(project, 'membership', key, { participation: text(member.participation), previousSubscribed: Boolean(member.subscribed),
          lastReadAt: member.last_read_at || null, lastReadMessageRowid: member.last_read_message_rowid ?? null,
          lastReadUpdateRowid: member.last_read_update_rowid ?? null }, id, circle);
      }
      for (const source of data.sources.filter(row => row.community_id === community.id)) {
        const scope = { link: 'link', 'user-excerpt': 'excerpt', 'search-summary': 'zhihu-search' }[source.scope];
        requireThat(scope, 'invalid_legacy_source_scope');
        const author = userId(project, source.added_by, true); let unsafe = Boolean(source.added_by && !author);
        try { const url = new URL(source.url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) unsafe = true; } catch { unsafe = true; }
        if (unsafe) warn('unsafe_source_hidden');
        insert('circle_sources', { id: mapId(project, 'source', source.id), circle_id: circle, round_id: round,
          title: text(source.title), url: text(source.url), author: text(source.author), summary: text(source.summary), scope,
          created_by: author, created_at: instant(source.created_at), hidden_at: unsafe ? stamp : null });
      }
      const noticeId = mapId(project, 'history_notice', community.id);
      const noticeSeq = Number(insert('circle_messages', { id: noticeId, circle_id: circle, round_id: round, kind: 'system',
        text: '此轮来自同题旧站历史：原站更换问题时没有保存完整轮次；这里只展示最后记录的问题及原始讨论时间。旧成果仅有当前版本，已核对表示最后编辑者核对。模型内容因缺少可验证的分析授权而保持隐藏。主持人可主动开启新轮。',
        action: 'legacy_history', created_at: instant(community.created_at) }).lastInsertRowid);
      const events = data.messages.filter(row => row.community_id === community.id).map(row => ({ type: 'message', row }))
        .concat(data.updates.filter(row => row.community_id === community.id).map(row => ({ type: 'update', row })))
        .sort((a, b) => instant(a.row.created_at).localeCompare(instant(b.row.created_at)) || a.type.localeCompare(b.type) || a.row.__source_rowid - b.row.__source_rowid);
      for (const event of events) {
        const row = event.row, author = userId(project, row.author_id, true), id = mapId(project, event.type, row.id);
        const orphan = Boolean(row.author_id && !author);
        if (event.type === 'update') {
          const label = { progress: '进展', question: '问题', 'next-topic': '下一话题', milestone: '里程碑' }[row.type] || '动态';
          event.seq = Number(insert('circle_messages', { id, circle_id: circle, round_id: round, author_id: author,
            kind: 'system', text: `【旧站动态 · ${label}】\n${text(row.text)}`, action: 'legacy_update', hidden_at: orphan ? stamp : null, created_at: instant(row.created_at) }).lastInsertRowid);
          meta(project, 'update', row.id, { type: row.type }, author, circle);
          continue;
        }
        requireThat(['human', 'ai', 'system'].includes(row.kind), 'invalid_message_kind');
        const derived = row.kind === 'ai' || Boolean(row.ai_mode), refs = messageRefs(row, derived, instant(row.created_at));
        // Old model prompts included membership goals, but the old site stored no explicit consent revisions.
        const unproven = derived && (row.ai_mode !== 'rules' || !['summary', 'outcome'].includes(row.action));
        if (unproven) warn('unverifiable_legacy_ai_hidden');
        let reply = null;
        if (row.reply_to) {
          if (messageIndex.get(row.reply_to)?.community_id === row.community_id) reply = mapId(project, 'message', row.reply_to);
          else { refs.unsafe = true; warn('orphaned_reply_hidden'); }
        }
        event.seq = Number(insert('circle_messages', { id, circle_id: circle, round_id: round, author_id: author,
          kind: row.kind, text: text(row.text), reply_to: reply, hidden_at: row.hidden || orphan || unproven || refs.unsafe ? stamp : null,
          action: row.action || null, ai_mode: row.ai_mode || null, citations: refs.citations, source_ids: refs.source_ids,
          dependency_ids: refs.dependency_ids, dependency_source_ids: refs.dependency_source_ids, consent_versions: refs.consent_versions,
          created_at: instant(row.created_at) }).lastInsertRowid);
      }
      for (const member of members) {
        let lastSeq = noticeSeq;
        for (const event of events) {
          const cursor = member[event.type === 'message' ? 'last_read_message_rowid' : 'last_read_update_rowid'];
          const wasRead = cursor === undefined ? instant(event.row.created_at) <= instant(member.last_read_at) : event.row.__source_rowid <= number(cursor);
          if (!wasRead) break;
          lastSeq = event.seq;
        }
        insert('circle_reads', { circle_id: circle, user_id: userId(project, member.user_id), round_id: round, last_seq: lastSeq });
      }
      for (const artifact of data.artifacts.filter(row => row.community_id === community.id)) {
        requireThat(['draft', 'reviewed'].includes(artifact.status), 'invalid_outcome_status');
        const id = mapId(project, 'artifact', artifact.id), derived = Boolean(artifact.ai_mode), refs = messageRefs(artifact, derived, instant(artifact.updated_at));
        const createdBy = userId(project, artifact.created_by, true), updatedBy = userId(project, artifact.updated_by, true);
        const version = number(artifact.version, 1); requireThat(version > 0, 'invalid_outcome_version');
        const unproven = derived && artifact.ai_mode !== 'rules';
        insert('circle_outcomes', { id, circle_id: circle, round_id: round, title: text(artifact.title), content: text(artifact.content),
          status: artifact.status, version, ai_mode: artifact.ai_mode || null, citations: refs.citations, source_ids: refs.source_ids,
          dependency_ids: refs.dependency_ids, dependency_source_ids: refs.dependency_source_ids, consent_versions: refs.consent_versions,
          origin_message_id: refs.origin, hidden_at: unproven || refs.unsafe || !createdBy || !updatedBy ? stamp : null,
          created_by: createdBy, updated_by: updatedBy, reviewed_by: artifact.status === 'reviewed' ? updatedBy : null,
          reviewed_at: artifact.status === 'reviewed' ? instant(artifact.updated_at) : null,
          created_at: instant(artifact.created_at), updated_at: instant(artifact.updated_at) });
        const saved = db.prepare('SELECT * FROM circle_outcomes WHERE id=?').get(id);
        insert('circle_outcome_versions', { outcome_id: id, version, snapshot: json(saved), created_at: instant(artifact.updated_at) });
        meta(project, 'artifact', artifact.id, { availableVersions: [version], previousVersionBodiesAvailable: false,
          reviewedMeansLastEditorOnly: artifact.status === 'reviewed' }, createdBy, circle);
        if (version > 1) warn('outcome_previous_versions_unavailable');
        if (unproven) warn('unverifiable_legacy_ai_hidden');
      }
      for (const report of data.reports.filter(row => row.community_id === community.id)) {
        requireThat(messageIndex.get(report.message_id)?.community_id === community.id, 'reported_message_missing');
        const status = { pending: 'open', hidden: 'hidden', dismissed: 'dismissed' }[report.status];
        requireThat(status, 'invalid_report_status');
        const reporter = userId(project, report.reporter_id, true), message = mapId(project, 'message', report.message_id);
        requireThat(status !== 'open' || !db.prepare("SELECT 1 FROM circle_reports WHERE message_id=? AND reporter_id IS ? AND status='open'").get(message, reporter), 'duplicate_open_report');
        insert('circle_reports', { id: mapId(project, 'report', report.id), circle_id: circle, message_id: message,
          reporter_id: reporter, reason: text(report.reason), status, resolved_by: userId(project, report.resolved_by, true),
          created_at: instant(report.created_at), resolved_at: report.resolved_at ? instant(report.resolved_at) : null });
      }
    }
    // Reject orphan containers instead of silently dropping their history.
    const knownCircles = new Set(data.communities.map(row => row.id));
    for (const table of ['memberships', 'messages', 'artifacts', 'updates', 'sources', 'reports']) {
      requireThat(data[table].every(row => knownCircles.has(row.community_id)), 'orphaned_community_data');
    }
  }
  return [...warningCounts].sort(([a], [b]) => a.localeCompare(b)).map(([code, n]) => ({ code, count: n }));
}

const mapTargets = {
  user: ['users', 'id'], profile: ['profiles', 'user_id'], import: ['imports', 'user_id'], email_account: ['email_accounts', 'user_id'],
  invitation: ['invitations', 'id'], community: ['circle_groups', 'id'], historical_round: ['circle_rounds', 'id'],
  source: ['circle_sources', 'id'], artifact: ['circle_outcomes', 'id'], update: ['circle_messages', 'id'], history_notice: ['circle_messages', 'id'], report: ['circle_reports', 'id'],
};
const sourceMapTypes = { users: 'user', profiles: 'profile', imports: 'import', saved: 'saved', invitations: 'invitation', messages: 'message',
  blocked: 'block', email_accounts: 'email_account', communities: 'community', memberships: 'membership', artifacts: 'artifact', updates: 'update', sources: 'source', reports: 'report', blocks: 'block' };

function validateDb(db, report) {
  requireThat(db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'target_integrity_failed');
  requireThat(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'target_foreign_key_failure');
  const present = tables(db);
  for (const table of [...FORBIDDEN, 'jobs', 'notifications', 'profile_suggestions']) if (present.includes(table)) requireThat(count(db, table) === 0, 'unauthorized_state_imported');
  requireThat(count(db, 'users') === count(db, 'user_preferences'), 'private_preferences_missing');
  for (const row of db.prepare('SELECT data FROM user_preferences').all()) requireThat(json(parseJson(row.data)) === json(PRIVATE_DEFAULTS), 'privacy_default_changed');
  requireThat(!db.prepare('SELECT 1 FROM users WHERE subject IS NOT NULL').get(), 'untyped_identity_binding');
  requireThat(!db.prepare('SELECT 1 FROM profiles WHERE discoverable<>0').get(), 'profile_discoverable');
  requireThat(!db.prepare('SELECT 1 FROM invitations WHERE status=\'pending\'').get(), 'pending_invitation_imported');
  requireThat(!db.prepare('SELECT 1 FROM circle_memberships WHERE subscribed<>0 OR allow_connections<>0 OR ai_consent<>0').get(), 'circle_consent_changed');
  requireThat(!db.prepare('SELECT 1 FROM circle_groups WHERE ai_enabled<>0 OR auto_summary<>0').get(), 'circle_ai_enabled');
  requireThat(!db.prepare("SELECT 1 FROM circle_rounds WHERE status<>'archived'").get(), 'history_not_archived');
  requireThat(!db.prepare('SELECT 1 FROM circle_groups g LEFT JOIN circle_rounds r ON r.id=g.current_round_id WHERE r.id IS NULL OR r.circle_id<>g.id').get(), 'current_round_invalid');
  requireThat(!db.prepare('SELECT 1 FROM messages m JOIN invitations i ON i.id=m.conversation_id WHERE m.author_id<>i.sender_id AND m.author_id<>i.recipient_id').get(), 'dm_membership_invalid');
  const mappings = db.prepare('SELECT * FROM legacy_id_map').all();
  for (const mapping of mappings) {
    if (mapping.entity_type.startsWith('unresolved_')) continue;
    let target = mapTargets[mapping.entity_type];
    if (mapping.entity_type === 'message') target = [mapping.source_project === 'tongpin' ? 'messages' : 'circle_messages', 'id'];
    if (target) requireThat(db.prepare(`SELECT 1 FROM ${identifier(target[0])} WHERE ${identifier(target[1])}=?`).get(mapping.new_id), 'mapped_record_missing');
    else {
      const edge = parseJson(mapping.new_id, 'array'); requireThat(edge.length === 2, 'invalid_edge_mapping');
      const table = { saved: 'saved', block: 'blocked', membership: 'circle_memberships' }[mapping.entity_type];
      requireThat(table, 'unknown_mapping_type');
      requireThat(db.prepare(`SELECT 1 FROM ${table} WHERE ${table === 'circle_memberships' ? 'circle_id=? AND user_id=?' : 'user_id=? AND target_id=?'}`).get(...edge), 'mapped_record_missing');
    }
  }
  if (report?.sources) for (const source of report.sources) for (const [table, expected] of Object.entries(source.counts)) {
    const actual = mappings.filter(mapping => mapping.source_project === source.project && mapping.entity_type === sourceMapTypes[table]).length;
    requireThat(actual === expected, 'source_mapping_count_mismatch');
  }
  let referenceCount = 0, retainedHiddenReferences = 0;
  const checkDerived = row => {
    const citations = parseJson(row.citations, 'array'), dependencies = parseJson(row.dependency_ids, 'array');
    const sources = [...parseJson(row.source_ids, 'array'), ...parseJson(row.dependency_source_ids, 'array')];
    for (const id of [...dependencies, ...citations.map(c => c.messageId), ...(row.origin_message_id ? [row.origin_message_id] : [])]) {
      requireThat(typeof id === 'string', 'invalid_migrated_reference'); referenceCount++;
      const referenced = db.prepare('SELECT circle_id,round_id FROM circle_messages WHERE id=?').get(id);
      if (!referenced || referenced.circle_id !== row.circle_id || referenced.round_id !== row.round_id) {
        requireThat(row.hidden_at, 'visible_dangling_reference'); retainedHiddenReferences++;
      }
    }
    for (const id of sources) {
      requireThat(typeof id === 'string', 'invalid_migrated_reference'); referenceCount++;
      const referenced = db.prepare('SELECT circle_id,round_id FROM circle_sources WHERE id=?').get(id);
      if (!referenced || referenced.circle_id !== row.circle_id || referenced.round_id !== row.round_id) {
        requireThat(row.hidden_at, 'visible_dangling_reference'); retainedHiddenReferences++;
      }
    }
    for (const consent of parseJson(row.consent_versions, 'array')) {
      requireThat(typeof consent.userId === 'string' && Number.isSafeInteger(consent.revision)
        && db.prepare('SELECT 1 FROM users WHERE id=?').get(consent.userId), 'invalid_consent_reference'); referenceCount++;
    }
    if (row.ai_mode === 'model') requireThat(row.hidden_at, 'unverified_model_content_visible');
  };
  for (const table of ['circle_messages', 'circle_outcomes']) for (const row of db.prepare(`SELECT * FROM ${table}`).all()) checkDerived(row);
  for (const row of db.prepare('SELECT * FROM circle_outcome_versions').all()) {
    const snapshot = parseJson(row.snapshot), outcome = db.prepare('SELECT * FROM circle_outcomes WHERE id=?').get(row.outcome_id);
    requireThat(snapshot.id === row.outcome_id && snapshot.version === row.version && outcome.version === row.version, 'outcome_snapshot_mismatch');
    requireThat(json(snapshot) === json(outcome), 'outcome_snapshot_content_mismatch'); checkDerived(snapshot);
  }
  requireThat(!db.prepare('SELECT 1 FROM circle_reads r LEFT JOIN circle_messages m ON m.rowid=r.last_seq WHERE r.last_seq<>0 AND (m.id IS NULL OR m.circle_id<>r.circle_id OR m.round_id<>r.round_id)').get(), 'invalid_read_cursor');
  if (report?.targetFingerprint) requireThat(stateFingerprint(db) === report.targetFingerprint, 'target_changed_after_migration');
  return { ok: true, mappedRecords: mappings.length, referencesChecked: referenceCount, retainedHiddenReferences, counts: counts(db) };
}

/** validate is intentionally a pre-cutover check; later user edits invalidate the pristine-import fingerprint. */
export function validateMigration(targetPath) {
  const db = readonly(sourceFile(targetPath));
  try {
    requireThat(tables(db).includes('migration_runs'), 'migration_report_missing');
    const rows = db.prepare('SELECT report FROM migration_runs').all(); requireThat(rows.length > 0, 'migration_report_missing');
    const report = parseJson(rows[0].report);
    requireThat(rows.every(row => row.report === rows[0].report), 'migration_report_mismatch');
    return { batchId: report.batchId, ...validateDb(db, report) };
  } catch (error) { throw safeError(error); }
  finally { db.close(); }
}

/** Always snapshots sources first. apply only accepts an empty database or an unchanged identical import. */
export async function migrate({ mode = 'dry-run', sources: paths, targetPath, verifiedIdentities = [], tempDirectory = tmpdir() } = {}) {
  requireThat(['dry-run', 'apply'].includes(mode), 'invalid_mode');
  requireThat(paths && typeof paths === 'object' && Object.keys(paths).length > 0
    && Object.keys(paths).every(project => PROJECTS.includes(project)), 'sources_required');
  requireThat(mode !== 'dry-run' || targetPath === undefined, 'dry_run_cannot_have_target');
  const sourcePaths = Object.fromEntries(PROJECTS.filter(project => paths[project]).map(project => [project, sourceFile(paths[project])]));
  requireThat(Object.keys(sourcePaths).length > 0 && new Set(Object.values(sourcePaths)).size === Object.keys(sourcePaths).length, 'source_paths_invalid');
  const target = mode === 'apply' ? destinationFile(targetPath, Object.values(sourcePaths)) : null;
  const work = mkdtempSync(join(tempDirectory, 'tongzhi-migration-')); chmodSync(work, 0o700);
  let store, createdTarget = false, committed = false;
  try {
    const sources = [];
    for (const [project, path] of Object.entries(sourcePaths)) {
      const snapshot = join(work, `${project}.sqlite`); await snapshotDatabase(path, snapshot);
      sources.push(readSource(project, snapshot));
    }
    const plan = verifiedPlan(sources, verifiedIdentities);
    const batchId = `migration_v${MIGRATION_VERSION}_${sha(json([sources.map(s => [s.project, s.fingerprint]), plan.fingerprint])).slice(0, 32)}`;
    const destination = target || join(work, 'target.sqlite');
    if (existsSync(destination)) {
      const existing = readonly(destination);
      try {
        const old = currentBatch(existing, batchId, sources);
        if (old) return { mode, applied: false, alreadyApplied: true, ...old, targetPath: destination, validation: validateDb(existing, old) };
      } finally { existing.close(); }
    } else { const fd = openSync(destination, 'wx', 0o600); closeSync(fd); createdTarget = true; }
    store = new KnowledgeStore(destination); initializeCircles(store.db); initializeMetadata(store.db);
    store.db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;');
    let report;
    try {
      const stamp = new Date().toISOString();
      const warnings = importer(store.db, sources, plan, stamp);
      report = { migrationVersion: MIGRATION_VERSION, batchId, manifestFingerprint: plan.fingerprint,
        sources: sources.map(({ project, fingerprint, counts, skippedCounts }) => ({ project, fingerprint, counts, skippedCounts })),
        identities: { verifiedSourceUsers: plan.verified.size, sourceUsers: sources.reduce((sum, source) => sum + source.data.users.length, 0),
          targetUsers: plan.groups.size, mergedUsers: sources.reduce((sum, source) => sum + source.data.users.length, 0) - plan.groups.size },
        warnings, createdAt: stamp, targetFingerprint: stateFingerprint(store.db) };
      for (const source of sources) store.db.prepare('INSERT INTO migration_runs VALUES (?,?,?,?,?)').run(`${batchId}:${source.project}`, source.project, source.fingerprint, json(report), stamp);
      validateDb(store.db, report);
      store.db.exec('COMMIT'); committed = true;
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    const validation = validateDb(store.db, report);
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    store.close(); store = null; chmodSync(destination, 0o600);
    return { mode, applied: mode === 'apply', alreadyApplied: false, ...report,
      targetPath: mode === 'apply' ? destination : '(temporary target removed)', validation };
  } catch (error) {
    try { store?.close(); } catch {} store = null;
    if (createdTarget && target && !committed) removeOwnedDatabase(target);
    throw safeError(error);
  } finally { store?.close(); rmSync(work, { recursive: true, force: true }); }
}
