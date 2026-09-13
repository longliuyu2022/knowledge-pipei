import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Uses one private, synthetic account and at most three text-model requests.
// Never writes a browser storage state, credentials, or raw API bodies.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = new URL(process.env.SOUL_VERIFY_ORIGIN || 'https://zhihupipei.aiimage.icu').origin;
assert.equal(new URL(origin).protocol, 'https:', 'Public verification requires HTTPS.');
const artifacts = resolve(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const reportPath = resolve(artifacts, 'public-validation.json');
const report = {
  origin, status: 'running', startedAt: new Date().toISOString(),
  checks: [], modelCalls: [], pageErrors: [], assetErrors: [],
  cleanup: { accountCreated: false, accountDeleted: false },
};
const privateValues = new Set();
const sanitize = value => {
  let text = String(value).split('Call log:')[0].trim();
  for (const secret of privateValues) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.slice(0, 1500);
};
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
async function check(label, task) {
  const started = Date.now();
  try {
    await task();
    report.checks.push({ label, status: 'passed', elapsedMs: Date.now() - started });
    console.log(`PASS ${label}`);
  } catch (error) {
    report.checks.push({ label, status: 'failed', message: sanitize(error.message), elapsedMs: Date.now() - started });
    throw error;
  } finally { save(); }
}

let browser, context, page, csrf, initial;
let modelRequestCount = 0;
const executablePath = process.env.CHROMIUM_PATH || [
  '/usr/local/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(existsSync);

async function modelAction(kind, pathPattern, action) {
  assert.ok(modelRequestCount < 3, 'This verification allows only three model requests.');
  const started = Date.now();
  const waiting = page.waitForResponse(response => response.request().method() === 'POST'
    && pathPattern.test(new URL(response.url()).pathname), { timeout: 90000 });
  waiting.catch(() => {});
  await action();
  const response = await waiting;
  assert.equal(response.status(), 200, `${kind} endpoint must succeed`);
  const body = await response.json();
  const mode = kind === 'profile' ? body.profile.analysis.mode : body.mode;
  const notice = kind === 'profile' ? body.profile.analysis.notice : body.notice;
  report.modelCalls.push({ kind, mode, elapsedMs: Date.now() - started, ...(mode !== 'model' && notice ? { fallbackNotice: sanitize(notice) } : {}) });
  save();
  assert.equal(mode, 'model', `${kind} must use the configured live model`);
  return body;
}

save();
try {
  browser = await chromium.launch({
    headless: true, ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  context = await browser.newContext({
    baseURL: origin, viewport: { width: 1600, height: 1000 }, locale: 'zh-CN',
    ignoreHTTPSErrors: false,
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', error => report.pageErrors.push(sanitize(error.message)));
  page.on('response', response => {
    if (['script', 'stylesheet', 'image', 'font'].includes(response.request().resourceType()) && response.status() >= 400) {
      report.assetErrors.push({ path: new URL(response.url()).pathname, status: response.status() });
    }
  });
  page.on('request', request => {
    if (request.method() === 'POST' && /^\/api\/(profile$|people\/[^/]+\/(explain|icebreakers)$)/.test(new URL(request.url()).pathname)) modelRequestCount++;
  });

  await check('公网 HTTPS 证书、HTTP 跳转与健康接口正常', async () => {
    const redirect = await context.request.get(origin.replace('https:', 'http:') + '/', { maxRedirects: 0 });
    assert.ok([301, 302, 307, 308].includes(redirect.status()));
    assert.equal(new URL(redirect.headers().location).origin, origin);
    const health = await context.request.get('/api/health');
    assert.equal(health.status(), 200);
    assert.equal((await health.json()).status, 'ok');
    const waiting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap');
    waiting.catch(() => {});
    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200);
    initial = await (await waiting).json();
    csrf = initial.csrf;
    privateValues.add(csrf);
    report.cleanup.accountCreated = true;
    for (const cookie of await context.cookies()) privateValues.add(cookie.value);
    const tls = await response.securityDetails();
    assert.ok(tls?.protocol?.startsWith('TLS'));
    assert.ok(tls.validTo * 1000 > Date.now());
    report.tls = { protocol: tls.protocol, issuer: tls.issuer, validUntil: new Date(tls.validTo * 1000).toISOString() };
    report.capabilities = initial.capabilities;
  });

  await check('会话 Cookie 启用 Secure、HttpOnly 和 SameSite=Lax', async () => {
    const cookie = (await context.cookies()).find(item => item.name === 'soul_session');
    assert.ok(cookie, 'Session cookie must exist.');
    assert.equal(cookie.secure, true);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Lax');
    assert.equal(await page.evaluate(() => document.cookie.includes('soul_session=')), false);
    report.cookie = { secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite };
  });

  await check('首页静态资源完整，体验伙伴明确标注并生成参赛封面', async () => {
    await page.locator('.match-card').last().waitFor();
    assert.equal(await page.locator('.match-card').count(), 8);
    assert.match(await page.title(), /同频/);
    assert.match(await page.locator('.pool-note').textContent(), /虚构/);
    assert.equal(initial.profile, null);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(artifacts, 'cover.png'), animations: 'disabled' });
  });

  await check('通过三步向导实际调用模型生成私有画像，原始依据可追溯', async () => {
    assert.equal(initial.capabilities.ai, true, 'Live AI must be configured.');
    await page.getByRole('button', { name: '发现我的知识人格', exact: true }).click();
    const wizard = page.getByRole('dialog', { name: '认识你，从好奇心开始', exact: true });
    for (const name of ['人工智能', '阅读与写作', '心理学']) await wizard.getByRole('button', { name, exact: true }).click();
    await wizard.getByRole('button', { name: '继续', exact: true }).click();
    await wizard.getByRole('textbox', { name: /^关于你/ }).fill('这是上线验收使用的虚构资料。我喜欢人工智能、阅读与心理学，希望通过具体的问题交换想法。');
    await wizard.getByRole('textbox', { name: /^一个你想和别人聊的问题/ }).fill('当 AI 可以给出答案，我们还应该怎样提问？');
    await wizard.getByRole('button', { name: '继续', exact: true }).click();
    await wizard.getByRole('textbox', { name: /^你的昵称/ }).fill('好奇心验收员');
    assert.equal(await wizard.getByRole('checkbox', { name: /使用 AI 解读兴趣/ }).isChecked(), true);
    assert.equal(await wizard.getByRole('checkbox', { name: /生成后，让伙伴发现我/ }).isChecked(), false);
    const result = await modelAction('profile', /^\/api\/profile$/, () => wizard.getByRole('button', { name: '生成我的知识人格', exact: true }).click());
    assert.equal(result.profile.discoverable, false);
    assert.ok(result.profile.evidenceIds.length >= 2);
    assert.ok(result.profile.evidenceIds.every(id => result.profile.evidence.some(item => item.id === id)));
    report.cleanup.profileWasPrivate = true;
    await wizard.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '编辑画像', exact: true }).waitFor();
    const saved = await (await context.request.get('/api/bootstrap')).json();
    assert.equal(saved.profile.analysis.mode, 'model');
    assert.equal(saved.profile.discoverable, false);
  });

  await check('从公网推荐打开详情，真实模型返回匹配解释', async () => {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '发现同频' }).click();
    await page.locator('.match-card').first().waitFor();
    const result = await modelAction('explanation', /^\/api\/people\/[^/]+\/explain$/, () => page.locator('.match-card').first().getByRole('button', { name: '为什么同频' }).click());
    assert.ok(result.reasons.length >= 2);
    assert.ok(result.bridge.length > 0);
    await page.getByRole('dialog').locator('.match-explanation').getByText('AI 解读', { exact: true }).waitFor();
    assert.match(await page.getByRole('dialog').locator('.match-explanation').textContent(), /AI/);
  });

  await check('真实模型生成三种破冰问题，没有伪造知乎来源', async () => {
    const dialog = page.getByRole('dialog');
    const result = await modelAction('icebreakers', /^\/api\/people\/[^/]+\/icebreakers$/, () => dialog.getByRole('button', { name: '生成破冰问题', exact: true }).click());
    report.zhihuSearch = {
      enabled: initial.capabilities.zhihuSearch,
      returnedSourceCount: result.sources.length,
      referencedSourceCount: result.sourceIds.length,
      notice: result.sourceNotice ? sanitize(result.sourceNotice) : null,
    };
    assert.equal(result.questions.length, 3);
    assert.ok(result.sourceIds.every(id => result.sources.some(item => item.id === id)));
    assert.ok(result.questions.every(question => !/https?:\/\//i.test(question)));
    if (!initial.capabilities.zhihuSearch) {
      assert.equal(result.sources.length, 0);
      assert.equal(result.sourceIds.length, 0);
      assert.equal(await dialog.getByRole('link', { name: '查看原文' }).count(), 0);
    }
    await dialog.locator('.icebreaker-card').last().waitFor();
    assert.equal(await dialog.locator('.icebreaker-card').count(), 3);
    assert.equal(modelRequestCount, 3);
  });

  await check('浏览器脚本与资源无错误，生成 512px 作品图标', async () => {
    assert.equal(report.pageErrors.length, 0, 'Browser must not have runtime errors.');
    assert.equal(report.assetErrors.length, 0, 'Static assets must load successfully.');
    const icon = await context.newPage();
    await icon.setViewportSize({ width: 512, height: 512 });
    const svg = readFileSync(resolve(root, 'public/favicon.svg'), 'utf8');
    await icon.setContent(`<style>html,body{margin:0;width:512px;height:512px}svg{display:block;width:512px;height:512px}</style>${svg}`);
    await icon.screenshot({ path: resolve(artifacts, 'icon.png'), omitBackground: true });
    await icon.close();
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = sanitize(error.message);
  console.error(`Public verification failed: ${sanitize(error.message)}`);
  process.exitCode = 1;
} finally {
  try {
    // Stop SSE and the application's automatic refresh before removing the session.
    if (context) {
      await page?.goto('about:blank');
      if (!csrf && (await context.cookies()).some(cookie => cookie.name === 'soul_session')) {
        const bootstrap = await context.request.get('/api/bootstrap');
        if (bootstrap.ok()) {
          csrf = (await bootstrap.json()).csrf;
          privateValues.add(csrf);
          report.cleanup.accountCreated = true;
        }
      }
      if (csrf) await check('临时验收账号已删除，未加入真实匹配池', async () => {
        const response = await context.request.delete('/api/account', {
          headers: { 'x-csrf-token': csrf, Origin: origin }, data: { confirm: 'delete' },
        });
        assert.equal(response.status(), 200, 'Synthetic account cleanup must succeed.');
        assert.equal((await response.json()).ok, true);
        assert.equal((await context.cookies()).some(cookie => cookie.name === 'soul_session'), false);
        report.cleanup.accountDeleted = true;
      });
    }
  } catch (error) {
    report.status = 'failed';
    report.cleanup.error = sanitize(error.message);
    console.error(`Cleanup failed: ${sanitize(error.message)}`);
    process.exitCode = 1;
  }
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  report.modelRequestCount = modelRequestCount;
  save();
}
