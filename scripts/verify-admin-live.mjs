import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Reads the owner's separately delivered credential. Never saves user data,
// screenshots of real users, browser storage, or authentication values.
const origin = 'https://zhihupipei.aiimage.icu';
const credentialFile = process.env.TONGPIN_ADMIN_CREDENTIAL_FILE || '/root/.local/share/tongpin/admin-access.json';
const credential = JSON.parse(readFileSync(credentialFile, 'utf8'));
assert.equal(typeof credential.username, 'string');
assert.equal(typeof credential.password, 'string');
const report = { origin, status: 'running', startedAt: new Date().toISOString(), checks: [], pageErrors: [], assetErrors: [] };
const reportFile = resolve('artifacts/admin-public-validation.json');
const privateValues = new Set([credential.password]);
const sanitize = value => {
  let message = String(value).split('Call log:')[0];
  for (const secret of privateValues) if (secret) message = message.replaceAll(secret, '[redacted]');
  return message.slice(0, 500);
};
const save = () => writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
async function check(label, run) {
  await run();
  report.checks.push({ label, status: 'passed' });
  console.log(`PASS ${label}`);
  save();
}
let browser, context, csrf;
try {
  const executablePath = process.env.CHROMIUM_PATH || ['/usr/local/bin/chromium-browser', '/usr/bin/chromium'].find(existsSync);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(sanitize(error.message)));
  page.on('response', response => {
    if (['script', 'stylesheet', 'font', 'image'].includes(response.request().resourceType()) && response.status() >= 400) report.assetErrors.push({ status: response.status(), path: new URL(response.url()).pathname });
  });
  await check('公网后台入口可访问且禁止缓存与搜索索引', async () => {
    const response = await page.goto('/admin', { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200);
    assert.match(response.headers()['cache-control'], /no-store/);
    assert.match(response.headers()['x-robots-tag'], /noindex/);
  });
  await check('未登录时无法读取用户列表、详情或概况', async () => {
    for (const path of ['/users', '/overview', '/users/00000000-0000-4000-8000-000000000000']) {
      assert.equal((await context.request.get('/api/admin' + path)).status(), 401);
    }
  });
  await check('管理员可使用独立密码建立受保护的会话', async () => {
    const bootstrap = await (await context.request.get('/api/admin/session')).json();
    assert.equal(bootstrap.configured, true);
    assert.equal(bootstrap.authenticated, false);
    csrf = bootstrap.csrf; privateValues.add(csrf);
    const response = await context.request.post('/api/admin/login', {
      data: { username: credential.username, password: credential.password },
      headers: { Origin: origin, 'X-CSRF-Token': csrf },
    });
    assert.equal(response.status(), 200);
    const session = await response.json();
    assert.equal(session.authenticated, true);
    assert.notEqual(session.csrf, csrf);
    csrf = session.csrf; privateValues.add(csrf);
    const cookies = await context.cookies(origin + '/api/admin/session');
    for (const cookie of cookies) privateValues.add(cookie.value);
    const cookie = cookies.find(item => item.name === 'soul_admin');
    assert.ok(cookie);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Strict');
    assert.equal(cookie.path, '/api/admin');
    assert.ok(!cookies.some(item => item.name === 'soul_session'));
  });
  await check('登录后实际读取概况和一页用户，验证字段后不保存个人数据', async () => {
    const overview = await context.request.get('/api/admin/overview');
    assert.equal(overview.status(), 200);
    const summary = await overview.json();
    assert.equal(typeof summary.counts.totalUsers, 'number');
    assert.equal(summary.counts.zhihuUsers + summary.counts.guestUsers, summary.counts.totalUsers);
    const users = await context.request.get('/api/admin/users?page=1&pageSize=1');
    assert.equal(users.status(), 200);
    const result = await users.json();
    assert.ok(Array.isArray(result.items) && result.items.length <= 1);
    assert.equal(typeof result.total, 'number');
    for (const user of result.items) for (const field of ['subject', 'csrf', 'token', 'passwordHash', 'evidence', 'imports']) assert.ok(!Object.hasOwn(user, field));
  });
  await check('后台页面能加载真实接口，浏览器与资源无错误', async () => {
    const ready = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/users' && response.status() === 200);
    await page.reload({ waitUntil: 'networkidle' });
    await ready;
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.assetErrors, []);
  });
  await check('退出后会话立即失效且不创建普通访客身份', async () => {
    await page.goto('about:blank');
    const response = await context.request.post('/api/admin/logout', { data: {}, headers: { Origin: origin, 'X-CSRF-Token': csrf } });
    assert.equal(response.status(), 200);
    assert.equal((await context.request.get('/api/admin/users')).status(), 401);
    assert.ok(!(await context.cookies(origin)).some(cookie => cookie.name === 'soul_session'));
    csrf = null;
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = sanitize(error.message);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (context && csrf) {
    try { await context.request.post('/api/admin/logout', { data: {}, headers: { Origin: origin, 'X-CSRF-Token': csrf } }); } catch { /* Browser closure follows. */ }
  }
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  save();
}
