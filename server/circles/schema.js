export function initializeCircles(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS circle_groups (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      question_id TEXT, question_url TEXT, tags TEXT NOT NULL DEFAULT '[]', capacity INTEGER NOT NULL DEFAULT 12,
      current_round_id TEXT, created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      ai_enabled INTEGER NOT NULL DEFAULT 1, auto_summary INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1, ai_lease_key TEXT, ai_lease_until INTEGER NOT NULL DEFAULT 0,
      last_ai_at INTEGER NOT NULL DEFAULT 0, last_summary_at INTEGER NOT NULL DEFAULT 0,
      last_summary_seq INTEGER NOT NULL DEFAULT 0, activity_at INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK(capacity BETWEEN 2 AND 30)
    );
    CREATE INDEX IF NOT EXISTS circle_question ON circle_groups(question_id);
    CREATE TABLE IF NOT EXISTS circle_rounds (
      id TEXT PRIMARY KEY, circle_id TEXT NOT NULL REFERENCES circle_groups(id) ON DELETE CASCADE,
      number INTEGER NOT NULL, question TEXT NOT NULL, goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'recruiting' CHECK(status IN ('recruiting','discussing','reviewing','completed','archived','dormant')),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(circle_id,number)
    );
    CREATE TABLE IF NOT EXISTS circle_memberships (
      circle_id TEXT NOT NULL REFERENCES circle_groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('host','member')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','left','expired')),
      duration TEXT NOT NULL DEFAULT 'ongoing' CHECK(duration IN ('24h','7d','ongoing')),
      goal TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT '',
      subscribed INTEGER NOT NULL DEFAULT 1, allow_connections INTEGER NOT NULL DEFAULT 0,
      ai_consent INTEGER NOT NULL DEFAULT 0, ai_revision INTEGER NOT NULL DEFAULT 1,
      joined_at TEXT NOT NULL, expires_at INTEGER, left_at TEXT,
      PRIMARY KEY(circle_id,user_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS circle_one_host ON circle_memberships(circle_id) WHERE role='host' AND status='active';
    CREATE INDEX IF NOT EXISTS circle_members_by_user ON circle_memberships(user_id,status,expires_at);
    CREATE TABLE IF NOT EXISTS circle_blocks (
      circle_id TEXT NOT NULL REFERENCES circle_groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      PRIMARY KEY(circle_id,user_id,target_id), CHECK(user_id<>target_id)
    );
    CREATE TABLE IF NOT EXISTS circle_sources (
      id TEXT PRIMARY KEY, circle_id TEXT NOT NULL REFERENCES circle_groups(id) ON DELETE CASCADE,
      round_id TEXT NOT NULL REFERENCES circle_rounds(id) ON DELETE CASCADE,
      title TEXT NOT NULL, url TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL CHECK(scope IN ('link','excerpt','zhihu-search')),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, hidden_at TEXT
    );
    CREATE INDEX IF NOT EXISTS circle_sources_round ON circle_sources(round_id,created_at);
    CREATE TABLE IF NOT EXISTS circle_messages (
      id TEXT PRIMARY KEY, circle_id TEXT NOT NULL REFERENCES circle_groups(id) ON DELETE CASCADE,
      round_id TEXT NOT NULL REFERENCES circle_rounds(id) ON DELETE CASCADE,
      author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      kind TEXT NOT NULL DEFAULT 'human' CHECK(kind IN ('human','ai','system')),
      text TEXT NOT NULL, reply_to TEXT REFERENCES circle_messages(id) ON DELETE SET NULL,
      client_message_id TEXT, hidden_at TEXT, action TEXT, ai_mode TEXT,
      citations TEXT NOT NULL DEFAULT '[]', source_ids TEXT NOT NULL DEFAULT '[]',
      dependency_ids TEXT NOT NULL DEFAULT '[]', dependency_source_ids TEXT NOT NULL DEFAULT '[]',
      consent_versions TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS circle_messages_round ON circle_messages(round_id,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS circle_message_retry ON circle_messages(circle_id,author_id,client_message_id) WHERE client_message_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS circle_reads (
      circle_id TEXT NOT NULL REFERENCES circle_groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      round_id TEXT NOT NULL REFERENCES circle_rounds(id) ON DELETE CASCADE,
      last_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(circle_id,user_id,round_id)
    );
    CREATE TABLE IF NOT EXISTS circle_outcomes (
      id TEXT PRIMARY KEY, circle_id TEXT NOT NULL REFERENCES circle_groups(id) ON DELETE CASCADE,
      round_id TEXT NOT NULL REFERENCES circle_rounds(id) ON DELETE CASCADE,
      title TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','reviewed')),
      version INTEGER NOT NULL DEFAULT 1, ai_mode TEXT, citations TEXT NOT NULL DEFAULT '[]',
      source_ids TEXT NOT NULL DEFAULT '[]', dependency_ids TEXT NOT NULL DEFAULT '[]',
      dependency_source_ids TEXT NOT NULL DEFAULT '[]', consent_versions TEXT NOT NULL DEFAULT '[]',
      origin_message_id TEXT REFERENCES circle_messages(id) ON DELETE SET NULL, hidden_at TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL, updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL, reviewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS circle_outcome_versions (
      outcome_id TEXT NOT NULL REFERENCES circle_outcomes(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(outcome_id,version)
    );
    CREATE TABLE IF NOT EXISTS circle_reports (
      id TEXT PRIMARY KEY, circle_id TEXT NOT NULL REFERENCES circle_groups(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES circle_messages(id) ON DELETE CASCADE,
      reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL, reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','hidden','dismissed')),
      resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS circle_open_report ON circle_reports(message_id,reporter_id) WHERE status='open';
    CREATE TABLE IF NOT EXISTS circle_search_receipts (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      circle_id TEXT NOT NULL REFERENCES circle_groups(id) ON DELETE CASCADE,
      round_id TEXT NOT NULL REFERENCES circle_rounds(id) ON DELETE CASCADE,
      payload TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS circle_notification_state (
      circle_id TEXT NOT NULL REFERENCES circle_groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY(circle_id,user_id,kind)
    );
  `);
}
