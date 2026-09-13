import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { SAMPLE_PROFILE } from '../server/matching.js';

test('SQLite migration preserves legacy messages and adds durable retry deduplication across restarts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'tongpin-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  const a = store.createUser('甲'), b = store.createUser('乙');
  for (const user of [a, b]) { store.saveProfile(user.id, SAMPLE_PROFILE, 0); store.setDiscoverable(user.id, true); }
  const conversation = store.invite(a.id, b.id, '迁移之前的邀请'); store.respond(b.id, conversation, 'accept');
  const original = store.sendMessage(a.id, conversation, '旧版本的消息').message;
  store.db.exec('DROP INDEX message_retry_key');
  store.db.exec('ALTER TABLE messages DROP COLUMN client_message_id');
  store.close();
  store = new Store(path);
  assert.deepEqual({ ...store.messages(a.id, conversation).items[0] }, original);
  const clientMessageId = randomUUID(), saved = store.sendMessage(a.id, conversation, '可以安全重试的消息', clientMessageId).message;
  store.close();
  store = new Store(path);
  assert.deepEqual(store.sendMessage(a.id, conversation, '可以安全重试的消息', clientMessageId).message, saved);
  assert.equal(store.messages(a.id, conversation).items.length, 2);
  store.close();
});
