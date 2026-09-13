#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { inspectSource, migrate, MigrationError, snapshotDatabase, validateMigration } from './library.mjs';

const HELP = `同频 / 同题 → 同知迁移工具（Node >=22.16）

node scripts/migration/migrate.mjs inspect --project tongpin|tongti --source PATH
node scripts/migration/migrate.mjs snapshot --source PATH --output NEW_PATH
node scripts/migration/migrate.mjs dry-run --tongpin PATH --tongti PATH [--identities MANIFEST.json]
node scripts/migration/migrate.mjs apply --tongpin PATH --tongti PATH --target EMPTY_PATH [--identities MANIFEST.json]
node scripts/migration/migrate.mjs validate --target PATH

两个来源至少提供一个。dry-run 自动使用并删除临时目标。apply 拒绝非空或已改变的目标。
日志仅包含聚合计数、哈希和诊断码；旧会话、OAuth 状态及管理令牌不会进入新库。
`;

try {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') { process.stdout.write(HELP); }
  else {
    const args = {};
    for (let i = 0; i < rest.length; i += 2) {
      const key = rest[i];
      if (!key.startsWith('--') || !rest[i + 1] || rest[i + 1].startsWith('--') || args[key.slice(2)] !== undefined) throw new MigrationError('invalid_cli_arguments');
      args[key.slice(2)] = rest[i + 1];
    }
    const allowed = { inspect: ['project', 'source'], snapshot: ['source', 'output'],
      'dry-run': ['tongpin', 'tongti', 'identities'], apply: ['tongpin', 'tongti', 'identities', 'target'], validate: ['target'] }[command];
    if (!allowed || Object.keys(args).some(key => !allowed.includes(key))) throw new MigrationError('invalid_cli_arguments');
    let result;
    if (command === 'inspect') result = inspectSource(args.project, args.source);
    else if (command === 'snapshot') result = await snapshotDatabase(args.source, args.output);
    else if (command === 'validate') result = validateMigration(args.target);
    else {
      let identities = [];
      if (args.identities) {
        let input;
        try { input = JSON.parse(readFileSync(args.identities, 'utf8')); } catch { throw new MigrationError('identity_manifest_unreadable'); }
        if (!input || input.version !== 1 || !Array.isArray(input.verifiedIdentities)) throw new MigrationError('identity_manifest_invalid');
        identities = input.verifiedIdentities;
      }
      result = await migrate({ mode: command, sources: Object.fromEntries(['tongpin', 'tongti'].filter(project => args[project]).map(project => [project, args[project]])),
        targetPath: args.target, verifiedIdentities: identities });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error instanceof MigrationError ? error.code : 'migration_failed',
    message: error instanceof MigrationError ? error.message : '迁移失败；未输出原始数据或凭据。' })}\n`);
  process.exitCode = 1;
}
