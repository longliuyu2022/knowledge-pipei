import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capabilities, loadConfig } from '../server/config.js';

test('OAuth can read deployment credentials without storing them in project configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'tongpin-credentials-'));
  try {
    const directory = join(root, 'credentials'); mkdirSync(directory);
    writeFileSync(join(directory, 'zhihu_app_key'), 'fake-app-credential\n', { mode: 0o600 });
    writeFileSync(join(directory, 'zhihu_access_secret'), 'fake-content-credential\n', { mode: 0o600 });
    const config = loadConfig(root, {
      SOUL_USE_LOCAL_MODEL: 'false', CREDENTIALS_DIRECTORY: directory,
      ZHIHU_OAUTH_APP_ID: '123', ZHIHU_OAUTH_REDIRECT_URI: 'https://example.com/auth/callback',
    });
    assert.equal(config.zhihu.oauth.appKey, 'fake-app-credential');
    assert.equal(config.zhihu.accessSecret, 'fake-content-credential');
    assert.equal(capabilities(config).oauth, true);
    assert.equal(capabilities(config).zhihuData, true);
    assert.equal(JSON.stringify(capabilities(config)).includes('credential'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Explicit credentials take precedence; missing requested files fail without exposing their path', () => {
  const root = mkdtempSync(join(tmpdir(), 'tongpin-credentials-'));
  try {
    const missing = join(root, 'not-present-private-path');
    const environment = { SOUL_USE_LOCAL_MODEL: 'false', ZHIHU_OAUTH_APP_KEY_FILE: missing };
    assert.throws(() => loadConfig(root, environment), error => error.message === 'ZHIHU_OAUTH_APP_KEY 的服务端凭证文件不可读取');
    assert.equal(loadConfig(root, { ...environment, ZHIHU_OAUTH_APP_KEY: 'explicit-fake-credential' }).zhihu.oauth.appKey, 'explicit-fake-credential');
    assert.equal(loadConfig(root, { SOUL_USE_LOCAL_MODEL: 'false', CREDENTIALS_DIRECTORY: root }).zhihu.oauthConfigured, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Hackathon metadata supplies only public OAuth settings and allows explicit environment overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'tongpin-configuration-'));
  try {
    writeFileSync(join(root, 'hackathon.config.json'), JSON.stringify({ oauth: { enabled: true, appId: '123', redirectUri: 'https://example.com/auth/callback' } }));
    const config = loadConfig(root, { SOUL_USE_LOCAL_MODEL: 'false' });
    assert.equal(config.zhihu.oauth.appId, '123');
    assert.equal(config.zhihu.oauth.redirectUri, 'https://example.com/auth/callback');
    assert.equal(config.zhihu.oauthConfigured, false);
    assert.equal(loadConfig(root, { SOUL_USE_LOCAL_MODEL: 'false', ZHIHU_OAUTH_APP_ID: '' }).zhihu.oauth.appId, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Admin credentials are server-only, disabled by default, and loaded from a private hash file', () => {
  const root = mkdtempSync(join(tmpdir(), 'tongpin-admin-config-'));
  try {
    assert.equal(loadConfig(root, { SOUL_USE_LOCAL_MODEL: 'false' }).admin.configured, false);
    writeFileSync(join(root, 'admin_password_hash'), 'synthetic-password-hash\n', { mode: 0o600 });
    const config = loadConfig(root, { SOUL_USE_LOCAL_MODEL: 'false', CREDENTIALS_DIRECTORY: root, SOUL_ADMIN_USERNAME: 'owner' });
    assert.equal(config.admin.username, 'owner');
    assert.equal(config.admin.passwordHash, 'synthetic-password-hash');
    assert.equal(config.admin.configured, true);
    assert.equal(JSON.stringify(capabilities(config)).includes('synthetic-password-hash'), false);
    const privateFile = join(root, 'private-hash-file');
    writeFileSync(privateFile, 'another-synthetic-hash');
    assert.equal(loadConfig(root, { SOUL_USE_LOCAL_MODEL: 'false', SOUL_ADMIN_PASSWORD_HASH_FILE: privateFile }).admin.passwordHash, 'another-synthetic-hash');
    assert.throws(() => loadConfig(root, { SOUL_USE_LOCAL_MODEL: 'false', SOUL_ADMIN_PASSWORD_HASH_FILE: join(root, 'missing') }), /SOUL_ADMIN_PASSWORD_HASH 的服务端凭证文件不可读取/);
    assert.throws(() => loadConfig(root, { SOUL_USE_LOCAL_MODEL: 'false', SOUL_ADMIN_USERNAME: '../owner' }), /SOUL_ADMIN_USERNAME/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
