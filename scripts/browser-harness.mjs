import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { loadConfig, projectRoot } from '../server/config.js';
import { createApp } from '../server/app.js';

export async function runBrowserSuite(name, run, options = {}) {
  const { configOverrides = {}, ...appOptions } = options;
  assert.ok(configOverrides && typeof configOverrides === 'object' && !Array.isArray(configOverrides), 'configOverrides must be an object.');
  const allowedOverrides = new Set(['SOUL_ADMIN_USERNAME', 'SOUL_ADMIN_PASSWORD_HASH']);
  for (const [key, value] of Object.entries(configOverrides)) {
    assert.ok(allowedOverrides.has(key) && typeof value === 'string', 'Browser configuration overrides are limited to test administrator credentials.');
  }
  if (!existsSync(resolve(projectRoot, 'dist/index.html'))) throw new Error('Run npm run build before browser verification.');
  const artifactsDir = resolve(projectRoot, 'artifacts'); mkdirSync(artifactsDir, { recursive: true });
  const reportPath = resolve(artifactsDir, `browser-${name}.json`);
  const report = { suite: name, status: 'running', startedAt: new Date().toISOString(), checks: [], pageErrors: [], assetErrors: [] };
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  save();
  const directory = mkdtempSync(join(tmpdir(), `tongpin-${name}-`));
  const config = loadConfig(projectRoot, {
    SOUL_ADMIN_USERNAME: '', SOUL_ADMIN_PASSWORD_HASH: '', ...configOverrides,
    SOUL_ADMIN_PASSWORD_HASH_FILE: '', CREDENTIALS_DIRECTORY: '',
    SOUL_DB_PATH: join(directory, 'test.sqlite'), SOUL_PUBLIC_ORIGIN: '', SOUL_AI_ENABLED: 'false', SOUL_USE_LOCAL_MODEL: 'false',
    SOUL_AI_API_KEY: '', SOUL_AI_BASE_URL: '', SOUL_AI_MODEL: '', SOUL_AI_CONFIG_FILE: '', SOUL_LOCAL_MODEL_CONFIG: '',
    SOUL_EMBEDDING_API_KEY: '', SOUL_EMBEDDING_BASE_URL: '', SOUL_EMBEDDING_MODEL: '',
    ZHIHU_ACCESS_SECRET: '', ZHIHU_ACCESS_SECRET_FILE: '', ZHIHU_OAUTH_APP_ID: '',
    ZHIHU_OAUTH_APP_KEY: '', ZHIHU_OAUTH_APP_KEY_FILE: '', ZHIHU_OAUTH_REDIRECT_URI: '',
  });
  const service = createApp(config, appOptions);
  const server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`; config.allowedOrigins.add(origin);
  const executablePath = process.env.CHROMIUM_PATH || ['/usr/local/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    async function newContext(options = {}) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', ...options });
      context.on('page', page => {
        page.on('pageerror', error => report.pageErrors.push(error.message));
        page.on('response', response => { if (['script', 'stylesheet', 'image', 'font'].includes(response.request().resourceType()) && response.status() >= 400) report.assetErrors.push({ url: new URL(response.url()).pathname, status: response.status() }); });
      });
      return context;
    }
    async function check(label, job) {
      const start = Date.now();
      try { await job(); report.checks.push({ label, status: 'passed', elapsedMs: Date.now() - start }); console.log(`PASS ${label}`); save(); }
      catch (error) { report.checks.push({ label, status: 'failed', message: error.message, elapsedMs: Date.now() - start }); save(); throw error; }
    }
    await run({ browser, newContext, origin, check, artifactsDir, report, service });
    await check('浏览器运行与静态资源无错误', async () => { assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.assetErrors, []); });
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.stack; throw error; }
  finally {
    report.finishedAt = new Date().toISOString(); save();
    await browser?.close();
    await new Promise(done => { server.close(done); server.closeAllConnections(); });
    service.close(); rmSync(directory, { recursive: true, force: true });
  }
  return report;
}
