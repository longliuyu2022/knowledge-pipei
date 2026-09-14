import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';

const origin = 'https://zhihubisai.aiimage.icu';
const report = { origin, startedAt: new Date().toISOString(), status: 'running', checks: [], pageErrors: [], assetErrors: [], cleanup: 'pending' };
const save = () => writeFileSync('artifacts/next-public-validation.json', JSON.stringify(report, null, 2) + '\n');
const executablePath = process.env.CHROMIUM_PATH || ['/usr/local/bin/chromium-browser', '/usr/bin/chromium'].find(existsSync);
let browser, context, csrf = '', created = false;
async function check(label, job) {
  try { await job(); report.checks.push({ label, status: 'passed' }); console.log(`PASS ${label}`); }
  catch (error) { report.checks.push({ label, status: 'failed', message: error.message }); throw error; }
  finally { save(); }
}
async function api(path, method = 'GET', data) {
  return context.request.fetch(origin + '/api' + path, { method, headers: { Origin: origin, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(data === undefined ? {} : { data }) });
}
try {
  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', response => { if (['script', 'stylesheet', 'font', 'image'].includes(response.request().resourceType()) && response.status() >= 400) report.assetErrors.push({ path: new URL(response.url()).pathname, status: response.status() }); });

  await check('HTTPS 页面与本次构建一致，健康检查正常', async () => {
    const health = await context.request.get(origin + '/api/health'); assert.equal(health.status(), 200); assert.equal((await health.json()).status, 'ok');
    const html = await context.request.get(origin + '/'); assert.equal(html.status(), 200);
    assert.equal(await html.text(), readFileSync('dist/index.html', 'utf8'));
  });
  await check('临时访客仅浏览配对页，未创建画像或入队，显示实际汇总人数', async () => {
    const response = await api('/bootstrap'); assert.equal(response.status(), 200);
    const boot = await response.json(); csrf = boot.csrf; created = true;
    assert.equal(boot.user.provider, 'guest'); assert.equal(boot.profile, null);
    await page.goto(origin + '/#pairing');
    await page.getByTestId('pairing-queue-count').filter({ hasText: /^\d[\d,]* 人正在排队$/ }).waitFor();
    const state = await (await api('/pairing')).json();
    assert.equal(state.status, 'idle'); assert.equal(state.attemptId, null);
    assert.deepEqual(Object.keys(state.queue).sort(), ['confirming', 'updatedAt', 'waiting']);
    for (const key of ['waiting', 'confirming']) assert.ok(Number.isInteger(state.queue[key]) && state.queue[key] >= 0);
  });
  await check('公开邀请入口可复制，链接不携带查询参数或个人身份', async () => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await page.getByTestId('pairing-invite').click();
    assert.equal(await page.getByTestId('invite-link').inputValue(), origin + '/#pairing');
    await page.getByTestId('invite-copy').click();
    await page.getByTestId('invite-feedback').filter({ hasText: '链接已复制' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), origin + '/#pairing');
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  });
  await check('新数据检查与聊天接口上线，未授权用户不能读取他人数据', async () => {
    const passive = await api('/zhihu/validation'); assert.equal(passive.status(), 200);
    const state = await passive.json(); assert.equal(state.report, null); assert.equal(state.connected, false);
    const validate = await api('/zhihu/validation', 'POST', { consent: true }); assert.equal(validate.status(), 401);
    assert.equal((await validate.json()).error.code, 'zhihu_required');
    const chat = await api('/conversations/public-check-no-such-connection/context'); assert.equal(chat.status(), 404);
    assert.equal((await chat.json()).error.code, 'conversation_missing');
  });
  await check('320px 配对与邀请页面无横向溢出，浏览器资源无错误', async () => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.getByTestId('pairing-invite').click();
    const widths = await page.evaluate(() => ({ screen: innerWidth, document: document.documentElement.scrollWidth, dialog: document.querySelector('dialog[open]').scrollWidth }));
    assert.ok(widths.document <= widths.screen + 1); assert.ok(widths.dialog <= widths.screen);
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.assetErrors, []);
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }
finally {
  if (created && context) {
    try {
      const result = await api('/account', 'DELETE', { confirm: 'delete' }); assert.equal(result.status(), 200);
      report.cleanup = 'temporary guest deleted; never queued, no profile, no model or Zhihu business calls';
    } catch { report.cleanup = 'failed; temporary guest may remain'; report.status = 'failed'; process.exitCode = 1; }
  }
  await browser?.close(); report.finishedAt = new Date().toISOString(); save();
}
