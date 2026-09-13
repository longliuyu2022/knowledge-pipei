import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { loadConfig, projectRoot } from '../server/config.js';
import { createApp } from '../server/app.js';
import { DEFAULT_INPUT } from '../shared/catalog.js';

// No project env files, production database, OAuth credentials or model keys are loaded.
const temporary = mkdtempSync(join(tmpdir(), 'tongzhi-shell-browser-'));
const artifacts = join(projectRoot, 'artifacts'); mkdirSync(artifacts, { recursive: true });
const reportFile = join(artifacts, 'browser-tongzhi-shell.json');
const report = { status: 'running', startedAt: new Date().toISOString(), checks: [], pageErrors: [], assetErrors: [] };
const save = () => writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
let browser, server, service, page;
save();
async function check(label, run) {
  const start = Date.now();
  try { await run(); report.checks.push({ label, status: 'passed', elapsedMs: Date.now() - start }); console.log(`PASS ${label}`); }
  catch (error) { report.checks.push({ label, status: 'failed', message: error.message }); throw error; }
  finally { save(); }
}
try {
  execFileSync(process.execPath, [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', join(temporary, 'dist')], { cwd: projectRoot, stdio: 'pipe' });
  const config = loadConfig(temporary, { SOUL_DB_PATH: join(temporary, 'test.sqlite'), SOUL_AI_ENABLED: 'false', SOUL_USE_LOCAL_MODEL: 'false', SOUL_AI_API_KEY: '', SOUL_AI_BASE_URL: '', SOUL_EMBEDDING_API_KEY: '', SOUL_EMBEDDING_BASE_URL: '', ZHIHU_ACCESS_SECRET: '', ZHIHU_OAUTH_APP_ID: '', ZHIHU_OAUTH_APP_KEY: '' });
  service = createApp(config, { matchingOptions: { intervalMs: 100 } });
  server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`; config.allowedOrigins.add(origin);
  const executablePath = ['/usr/local/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  async function context() {
    const result = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
    result.on('page', item => {
      item.on('pageerror', error => report.pageErrors.push(error.message));
      item.on('response', response => { if (['script', 'stylesheet', 'image', 'font'].includes(response.request().resourceType()) && response.status() >= 400) report.assetErrors.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    });
    return result;
  }
  const firstContext = await context(); page = await firstContext.newPage(); page.setDefaultTimeout(15000);
  const requests = []; page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/')) requests.push({ path, method: request.method(), url: request.url() }); });
  async function read(current, path) {
    const response = await current.request.get(`/api${path}`); assert.equal(response.status(), 200, `GET ${path}`); return response.json();
  }
  async function write(current, path, body, method = 'POST') {
    const bootstrap = await read(current, '/bootstrap');
    const response = await current.request.fetch(`/api${path}`, { method, headers: { origin, 'x-csrf-token': bootstrap.csrf }, ...(body === undefined ? {} : { data: body }) });
    const data = await response.json(); assert.ok([200, 201].includes(response.status()), `${method} ${path}: ${response.status()} ${data.error?.message || ''}`); return data;
  }
  async function goto(hash) { await page.goto(`/${hash}`, { waitUntil: 'domcontentloaded' }); await page.getByTestId('tongzhi-app').waitFor(); }
  async function uiWrite(path, action, method = 'POST', current = page) {
    const response = current.waitForResponse(item => new URL(item.url()).pathname === `/api${path}` && item.request().method() === method); response.catch(() => {});
    await action(); const result = await response; const data = await result.json();
    assert.ok([200, 201].includes(result.status()), `${method} ${path}: ${result.status()} ${data.error?.message || ''}`); return data;
  }
  async function noOverflow(label) {
    await page.waitForFunction(() => ![...document.querySelectorAll('.loading-inline,.cz-loading')].some(item => item.getBoundingClientRect().height > 0), null, { timeout: 15000 });
    const state = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, overflowing: [...document.querySelectorAll('main *')].filter(item => item.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(item).position !== 'fixed').slice(0, 5).map(item => `${item.tagName}.${item.className}`) }));
    assert.ok(state.document <= state.viewport + 1 && state.body <= state.viewport + 1, `${label}: ${JSON.stringify(state)}`);
  }
  let own, sessionId, profileRevision, partnerPage, conversationId;
  await check('新用户首页展示问题，五项导航与无虚构画像状态正确', async () => {
    await goto('#discover');
    assert.equal(await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link').count(), 5);
    await page.getByRole('heading', { name: /一个好问题/ }).first().waitFor();
    own = await read(page, '/bootstrap'); assert.equal(own.profile, null);
    await goto('#profile'); await page.getByText('你的知识画像，从真实的材料开始', { exact: true }).waitFor();
    assert.equal(await page.locator('.profile-sample-notice').count(), 0);
    assert.equal(requests.filter(item => item.url.includes('/matches?pool=demo')).length, 0);
    await write(page, '/profile', { input: { ...DEFAULT_INPUT, name: '同知浏览器甲', question: '阅读怎样帮助我们验证人工智能给出的解释？' }, revision: 0, useAI: false });
  });
  await check('邮箱注册保留访客资料，偏好需要本人主动启用', async () => {
    await goto('#account'); await page.getByTestId('preference-chatAnalysis').waitFor();
    assert.equal(await page.getByTestId('preference-chatAnalysis').isChecked(), false);
    assert.equal(await page.getByTestId('preference-aiAnalysis').isChecked(), false);
    await page.getByTestId('account-name').fill('同知浏览器甲');
    await page.getByTestId('account-email').fill('tongzhi-browser@example.invalid');
    await page.getByTestId('account-password').fill('browser-test-password-42');
    await uiWrite('/auth/email/register', () => page.getByTestId('account-auth-submit').click());
    await page.getByText('tongzhi-browser@example.invalid', { exact: true }).waitFor();
    const next = await read(page, '/bootstrap'); assert.equal(next.user.id, own.user.id); assert.ok(next.profile);
    await uiWrite('/preferences', () => page.getByTestId('preference-chatAnalysis').check(), 'PUT');
    await page.getByTestId('preference-chatAnalysis').waitFor(); assert.equal((await read(page, '/preferences')).preferences.chatAnalysis, true);
    assert.equal((await read(page, '/preferences')).preferences.aiAnalysis, false);
  });
  await check('AI 对话创建与发送均需授权，输入上限与后端一致', async () => {
    await goto('#companion'); await page.getByTestId('companion-create').waitFor();
    assert.equal(await page.getByTestId('companion-create').isDisabled(), true);
    assert.equal(await page.getByTestId('companion-consent').isChecked(), false);
    await page.getByTestId('companion-consent').check();
    sessionId = (await uiWrite('/companion/sessions', () => page.getByTestId('companion-create').click())).id;
    await page.getByTestId('companion-input').waitFor(); assert.equal(await page.getByTestId('companion-input').getAttribute('maxlength'), '2000');
    await page.getByTestId('companion-consent').uncheck(); await page.getByTestId('companion-input').fill('阅读和人工智能，是我想继续探索的方向。');
    assert.equal(await page.getByTestId('companion-send').isDisabled(), true);
    await page.getByTestId('companion-consent').check();
  });
  await check('AI 发送结果丢失后保留草稿，相同重试标识不会重复写入', async () => {
    const pattern = '**/api/companion/sessions/*/messages'; let first = true, firstKey, retryKey;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const key = route.request().postDataJSON().clientMessageId;
      if (first) { first = false; firstKey = key; const response = await route.fetch(); assert.equal(response.status(), 201); return route.abort('failed'); }
      retryKey = key; return route.continue();
    });
    await page.getByTestId('companion-send').click();
    await page.locator('.tz-companion-chat .tz-error').waitFor();
    assert.equal(await page.getByTestId('companion-input').inputValue(), '阅读和人工智能，是我想继续探索的方向。');
    await uiWrite(`/companion/sessions/${sessionId}/messages`, () => page.getByTestId('companion-send').click());
    await page.getByTestId('companion-message').nth(1).waitFor();
    assert.equal(firstKey, retryKey); assert.equal((await read(page, `/companion/sessions/${sessionId}`)).messages.length, 2);
    await page.locator('.tz-message-label').filter({ hasText: '本地规则提示' }).waitFor();
    await page.unroute(pattern);
  });
  await check('AI 回应期间修改的下一条草稿不会被清空', async () => {
    const pattern = '**/api/companion/sessions/*/messages'; let release, arrived;
    const held = new Promise(resolve => { arrived = resolve; });
    await page.route(pattern, async route => { arrived(); await new Promise(resolve => { release = resolve; }); await route.continue(); });
    await page.getByTestId('companion-input').fill('我正在用阅读练习检验观点，也想了解人工智能的局限。');
    await page.getByTestId('companion-send').click(); await held;
    await page.getByTestId('companion-input').fill('这条是等待期间继续写的新草稿。');
    const response = page.waitForResponse(item => new URL(item.url()).pathname === `/api/companion/sessions/${sessionId}/messages`); release(); await response;
    await page.getByTestId('companion-message').nth(3).waitFor();
    assert.equal(await page.getByTestId('companion-input').inputValue(), '这条是等待期间继续写的新草稿。');
    await page.unroute(pattern);
  });
  await check('切换 AI 会话重新确认授权，删除会话有明确确认', async () => {
    await page.getByTestId('companion-new').click(); assert.equal(await page.getByTestId('companion-consent').isChecked(), false);
    await page.getByRole('button', { name: '一起探索问题', exact: false }).click();
    await page.getByTestId('companion-consent').check();
    const second = await uiWrite('/companion/sessions', () => page.getByTestId('companion-create').click());
    await page.getByTestId('companion-input').waitFor();
    await page.getByTestId('companion-session').filter({ hasText: '与知识画像对话' }).click();
    assert.equal(await page.getByTestId('companion-consent').isChecked(), false);
    await page.getByTestId('companion-message').nth(3).waitFor();
    assert.equal(await page.getByTestId('companion-input').inputValue(), '这条是等待期间继续写的新草稿。');
    await page.getByTestId('companion-session').filter({ hasText: 'AI 知识伙伴' }).click();
    await page.getByRole('button', { name: '删除这段 AI 对话', exact: true }).click();
    await page.getByRole('dialog', { name: '删除这段 AI 对话？', exact: true }).waitFor();
    await uiWrite(`/companion/sessions/${second.id}`, () => page.getByTestId('companion-delete-confirm').click(), 'DELETE');
    await page.getByTestId('companion-create').waitFor();
    assert.equal((await read(page, '/companion/sessions')).items.length, 1);
  });
  await check('知识建议只允许勾选本人消息，人工确认后才更新画像', async () => {
    await goto('#profile'); await page.getByTestId('knowledge-report').waitFor();
    profileRevision = (await read(page, '/bootstrap')).profile.revision;
    await page.getByRole('button', { name: '待确认知识', exact: true }).click();
    await page.getByTestId('knowledge-source-type').selectOption('companion');
    await page.getByTestId('knowledge-source').selectOption(sessionId);
    await page.getByTestId('knowledge-load-messages').click();
    await page.getByTestId('knowledge-message-select').nth(1).waitFor();
    assert.equal(await page.getByTestId('knowledge-message-select').count(), 2);
    assert.equal(await page.locator('.tz-own-messages').getByText('本地规则提示', { exact: true }).count(), 0);
    await page.getByTestId('knowledge-message-select').first().check();
    await uiWrite('/knowledge/suggestions', () => page.getByTestId('knowledge-generate').click());
    await page.getByTestId('knowledge-suggestion').waitFor();
    assert.equal((await read(page, '/bootstrap')).profile.revision, profileRevision);
    const suggestion = (await read(page, '/knowledge/suggestions')).items.find(item => item.status === 'pending');
    await uiWrite(`/knowledge/suggestions/${suggestion.id}/accept`, () => page.getByTestId('knowledge-accept').click());
    assert.equal((await read(page, '/bootstrap')).profile.revision, profileRevision + 1);
    assert.equal((await read(page, '/knowledge/suggestions')).items[0].status, 'accepted');
  });
  await check('匹配支持七天请求、暂停与恢复，双方确认前不建私聊', async () => {
    await goto('#matching'); await page.getByTestId('matching-start').waitFor();
    await page.getByTestId('matching-question').fill('想围绕阅读和人工智能，交换可以验证的观点。');
    const started = await uiWrite('/matching/start', () => page.getByTestId('matching-start').click());
    assert.equal(started.request.status, 'searching'); assert.ok(new Date(started.request.expiresAt) - new Date(started.request.createdAt) >= 6.99 * 86400000);
    await page.getByTestId('matching-wait').waitFor();
    const paused = await uiWrite('/matching/pause', () => page.getByRole('button', { name: '暂停匹配', exact: true }).click()); assert.equal(paused.request.status, 'paused');
    await uiWrite('/matching/resume', () => page.getByRole('button', { name: '继续寻找', exact: true }).click());
    const otherContext = await context(); partnerPage = await otherContext.newPage();
    await read(partnerPage, '/bootstrap');
    const profile = (await write(partnerPage, '/profile', { input: { ...DEFAULT_INPUT, name: '同知浏览器乙' }, revision: 0, useAI: false })).profile;
    await write(partnerPage, '/matching/start', { mode: 'resonance', question: '阅读与人工智能应该如何互相帮助？', revision: profile.revision });
    await page.getByTestId('matching-proposal').waitFor();
    const accepted = await uiWrite('/matching/respond', () => page.getByTestId('matching-accept').click()); assert.equal(accepted.conversationId, null);
    assert.equal(accepted.proposal.acceptedByMe, true); assert.equal((await read(page, '/connections')).invitations.filter(item => item.status === 'accepted').length, 0);
    const theirMatch = await read(partnerPage, '/matching');
    conversationId = (await write(partnerPage, '/matching/respond', { proposalId: theirMatch.proposal.id, decision: 'accept' })).conversationId; assert.ok(conversationId);
    await page.getByTestId('matching-connected').waitFor(); await page.getByText('双方已确认', { exact: true }).waitFor();
  });
  await check('匹配对话与通知深链准确定位私聊，不会再次匹配', async () => {
    await page.getByRole('button', { name: '进入聊天', exact: true }).click();
    await page.locator('.conversation-composer textarea').waitFor();
    await page.locator('.conversation-composer textarea').fill('一起从一个阅读中的具体例子开始吧。');
    await uiWrite(`/conversations/${conversationId}/messages`, () => page.locator('.conversation-composer').getByRole('button', { name: '发送', exact: true }).click());
    for (const hash of [`#connections/${conversationId}`, `#connections?conversation=${conversationId}`]) { await goto(hash); await page.locator('.conversation-composer textarea').waitFor(); await page.locator('.conversation-message-list').getByText('一起从一个阅读中的具体例子开始吧。', { exact: true }).waitFor(); }
    await goto('#notifications'); await page.getByTestId('notification-item').first().waitFor();
    await uiWrite('/notifications/read', () => page.getByRole('button', { name: '全部已读', exact: true }).click());
    assert.equal((await read(page, '/notifications')).unread, 0);
    await goto('#matching'); await page.getByRole('button', { name: '再认识一位伙伴', exact: true }).click(); await page.getByTestId('matching-start').waitFor();
    assert.equal(requests.filter(item => /\/pairing\//.test(item.path)).length, 0);
  });
  await check('举报针对对方实际消息，处理记录可由当事人提交申诉', async () => {
    await write(partnerPage, `/conversations/${conversationId}/messages`, { text: '这是一条用于验证举报流程的测试发言，请结合讨论语境核对。', clientMessageId: randomUUID() });
    await goto(`#connections/${conversationId}`); await page.getByTestId('conversation-report').waitFor();
    assert.equal(await page.getByTestId('conversation-report').count(), 1);
    assert.equal(await page.locator('.conversation-message.is-mine').getByTestId('conversation-report').count(), 0);
    await page.getByTestId('conversation-report').click();
    await page.getByTestId('conversation-report-reason').fill('浏览器验收：希望工作人员结合这段发言的讨论语境进行复核。');
    await uiWrite('/reports', () => page.getByTestId('conversation-report-submit').click());
    assert.equal((await read(page, '/safety')).cases.length, 0);
    const safety = await read(partnerPage, '/safety'); assert.equal(safety.cases.length, 1);
    await partnerPage.goto('/#account', { waitUntil: 'domcontentloaded' }); await partnerPage.getByTestId('safety-case').waitFor();
    await partnerPage.getByTestId('safety-appeal-open').click();
    await partnerPage.getByTestId('safety-appeal-text').fill('这是隔离测试环境中的正常知识交流，请依据完整讨论语境重新核对。');
    await uiWrite(`/safety/${safety.cases[0].id}/appeal`, () => partnerPage.getByTestId('safety-appeal-submit').click(), 'POST', partnerPage);
    assert.match((await read(partnerPage, '/safety')).cases[0].appeal, /正常知识交流/);
  });
  await check('打开同题深链只查看公开概要，不会自动加入', async () => {
    const created = await write(partnerPage, '/circles', { title: '阅读之后，如何验证自己的理解？', question: '阅读之后，如何用一个可检验的小实验判断自己是否理解？', goal: '整理一份可以实际尝试的阅读验证清单', duration: '7d', aiConsent: false });
    const id = created.circle.id, previous = requests.filter(item => item.path.endsWith('/join')).length;
    await goto(`#circles/${id}`); await page.getByRole('heading', { name: '阅读之后，如何验证自己的理解？', exact: true }).waitFor();
    assert.equal((await read(page, `/circles/${id}`)).circle.joined, false);
    assert.equal(requests.filter(item => item.path.endsWith('/join')).length, previous);
  });
  await check('桌面、390 与 320 像素页面和导航均无横向溢出', async () => {
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      for (const hash of ['#discover', '#my-circles', '#matching', '#profile', '#connections', '#notifications', '#account', '#companion']) { await goto(hash); await noOverflow(`${width}px ${hash}`); }
      await goto('#discover'); await noOverflow(`${width}px screenshot`);
      await page.screenshot({ path: join(artifacts, `tongzhi-shell-${width}.png`), fullPage: true });
    }
  });
  await check('页面与静态资源无运行错误', async () => { assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.assetErrors, []); });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack;
  if (page) await page.screenshot({ path: join(artifacts, 'tongzhi-shell-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  report.finishedAt = new Date().toISOString(); save();
  await browser?.close(); service?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  rmSync(temporary, { recursive: true, force: true });
}
