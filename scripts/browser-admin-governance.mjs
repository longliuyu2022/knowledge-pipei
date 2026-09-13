import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { hashAdminPassword } from '../server/admin.js';
import { runBrowserSuite } from './browser-harness.mjs';

const username = 'governance_fixture';
const password = 'Governance-Fixture-Only!2026';
const passwordHash = await hashAdminPassword(password);
async function eventually(job, timeout = 18000) {
  let last; const until = Date.now() + timeout;
  do { try { return await job(); } catch (error) { last = error; } await new Promise(done => setTimeout(done, 100)); } while (Date.now() < until);
  throw last || new Error('Administrator UI did not reach the expected state.');
}

await runBrowserSuite('admin-governance', async ({ newContext, origin, check, artifactsDir, report, service }) => {
  const context = await newContext(), userContext = await newContext(), otherContext = await newContext();
  const page = await context.newPage(); page.setDefaultTimeout(18000);
  const user = { context: userContext, csrf: '', id: '' }, other = { context: otherContext, csrf: '', id: '' };
  const external = [], openings = [], reviews = [], stateUpdates = [];
  context.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== origin && ['http:', 'https:'].includes(url.protocol)) external.push(url.origin + url.pathname);
    if (/\/moderation\/[^/]+\/open$/.test(url.pathname)) openings.push(request.postDataJSON());
    if (/\/moderation\/[^/]+\/review$/.test(url.pathname)) reviews.push(request.postDataJSON());
    if (/\/users\/[^/]+\/status$/.test(url.pathname)) stateUpdates.push(request.postDataJSON());
  });
  async function normal(actor, method, path, body, expected = 200) {
    const response = await actor.context.request.fetch(origin + '/api' + path, { method, maxRetries: 0, headers: { Origin: origin, ...(actor.csrf ? { 'X-CSRF-Token': actor.csrf } : {}) }, ...(body === undefined ? {} : { data: body }) });
    const data = await response.json(); assert.equal(response.status(), expected, data?.error?.message || `${method} ${path}`); return data;
  }
  async function admin(path) { const response = await context.request.get(origin + '/api/admin' + path); const data = await response.json(); assert.equal(response.status(), 200, data?.error?.message); return data; }
  const caseBody = 'ADMIN_CASE_BODY_ONLY_AFTER_REASON：这段内容只在登记复核原因后读取。';
  const contextBody = 'ADMIN_REVIEW_CONTEXT_ON_DEMAND：先提供具体情况，再核对沟通边界。';
  const secondBody = 'ADMIN_SESSION_SCOPED_CASE_BODY：会话失效后不得继续展示这段内容。';
  const email = 'governance.fixture@example.test';
  const firstCaseId = randomUUID(), secondCaseId = randomUUID(), conversationId = randomUUID();
  let circle, circleMessageId, circleOutcomeId;
  const caseDialog = () => page.getByTestId('admin-case-dialog');
  const detail = () => page.getByTestId('admin-detail');
  const auditCount = (action, target) => service.store.db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE action=? AND target=?').get(action, target).n;
  async function login() {
    await page.getByTestId('admin-login-form').waitFor({ state: 'visible' });
    await page.getByTestId('admin-username').fill(username); await page.getByTestId('admin-password').fill(password);
    await page.getByTestId('admin-login-submit').click(); await page.getByTestId('admin-count-emailUsers').waitFor({ state: 'visible' });
  }
  try {
    await check('隔离邮箱账号、小组与实际待复核案件，不读取生产数据或外部模型', async () => {
      for (const actor of [user, other]) { const boot = await normal(actor, 'GET', '/bootstrap'); actor.csrf = boot.csrf; actor.id = boot.user.id; assert.equal(boot.capabilities.ai, false); }
      const registered = await normal(user, 'POST', '/auth/email/register', { email, password: 'Account-Fixture-Only!2026', name: '温知安' }, 201); user.csrf = registered.csrf;
      circle = (await normal(user, 'POST', '/circles', { title: '管理验证问题小组', question: '如何核对协作成果中的发言来源与适用条件？', goal: '建立一份可追溯的核对记录', duration: 'ongoing' }, 201)).circle;
      await normal(other, 'POST', `/circles/${circle.id}/join`, { duration: 'ongoing' });
      const original = await normal(user, 'POST', `/circles/${circle.id}/messages`, { text: '这条组内发言是临时测试数据，请保留明确的适用条件。', clientMessageId: randomUUID() }, 201); circleMessageId = original.message.id;
      const outcome = await normal(user, 'POST', `/circles/${circle.id}/outcomes`, { title: '临时核对成果', content: '这份测试成果引用了待核对发言，需要保持来源一致。', messageIds: [circleMessageId] }, 201); circleOutcomeId = outcome.outcome.id;
      await normal(other, 'POST', `/circles/${circle.id}/reports`, { messageId: circleMessageId, reason: '需要核对这条发言的适用条件与引用出处。' }, 201);
      const at = new Date().toISOString();
      service.store.db.prepare("INSERT INTO invitations(id,sender_id,recipient_id,message,status,created_at,updated_at) VALUES (?,?,?,?,'accepted',?,?)").run(conversationId, user.id, other.id, '临时会话，用于必要上下文核对。', at, at);
      service.store.db.prepare('INSERT INTO messages(id,conversation_id,author_id,text,created_at) VALUES (?,?,?,?,?)').run(randomUUID(), conversationId, other.id, contextBody, at);
      const insert = service.store.db.prepare('INSERT INTO moderation_cases(id,user_id,scope,scope_id,text,reason,decision,created_at,delivered) VALUES (?,?,?,?,?,?,?,?,?)');
      insert.run(firstCaseId, user.id, 'conversation', conversationId, caseBody, '测试案件：需要核对交流边界。', 'warn', at, 1);
      insert.run(secondCaseId, user.id, 'conversation', conversationId, secondBody, '测试案件：验证管理员会话隔离。', 'hold', at, 0);
      report.configuration = { database: 'temporary isolated SQLite', adminCredentials: 'generated fixture only', externalAI: false, emailAccounts: 1, cases: 2 };
    });

    await check('邮箱、异步匹配、小组与治理指标来自真实管理 API，列表不含私聊正文', async () => {
      await page.goto(origin + '/admin'); await login();
      const overview = await admin('/overview');
      assert.equal(overview.counts.emailUsers, 1); assert.equal(overview.counts.disabledUsers, 0);
      assert.equal(await page.getByTestId('admin-count-emailUsers').innerText(), '1');
      assert.equal(await page.getByTestId('admin-circles-total').innerText(), String(overview.circles.total));
      assert.equal(await page.getByTestId('admin-circles-outcomes').innerText(), '1');
      assert.equal(await page.getByTestId('admin-moderation-pending').innerText(), '2');
      for (const [key, value] of Object.entries(overview.matching)) assert.equal(await page.getByTestId(`admin-matching-${key}`).innerText(), String(value));
      assert.equal(overview.registrations.reduce((sum, row) => sum + row.email, 0), 1);
      const cases = await admin('/moderation?status=pending'); assert.equal(cases.items.length, 2);
      for (const marker of [caseBody, contextBody, secondBody]) { assert.equal(JSON.stringify(cases).includes(marker), false); assert.equal((await page.locator('body').innerText()).includes(marker), false); }
      assert.equal(openings.length, 0);
    });

    await check('邮箱筛选和绑定信息只展示脱敏地址，用户详情不成为私聊读取入口', async () => {
      await page.getByTestId('admin-filter-provider').selectOption('email');
      await eventually(async () => assert.equal(await page.getByTestId('admin-user-row').count(), 1));
      const row = page.getByTestId('admin-user-row'); assert.equal(await row.getAttribute('data-user-id'), user.id);
      await row.getByTestId('admin-user-detail').click(); await page.locator('.admin-detail-email').waitFor({ state: 'visible' });
      const visibleEmail = await page.locator('.admin-detail-email').innerText(); assert.ok(visibleEmail.includes('@')); assert.equal(visibleEmail.includes(email), false);
      for (const marker of [caseBody, contextBody, secondBody]) assert.equal((await detail().innerText()).includes(marker), false);
      assert.match(await detail().locator('.admin-user-governance').innerText(), /当前参与 1 个小组/);
      await page.getByTestId('admin-detail-close').click();
    });

    await check('管理员填写复核原因后才读取案件和最小上下文，并产生审计', async () => {
      const card = page.getByTestId('admin-case-row').filter({ hasText: '测试案件：需要核对交流边界。' });
      await card.getByTestId('admin-case-open').click();
      assert.equal(auditCount('moderation:read', firstCaseId), 0); assert.equal(openings.length, 0);
      await caseDialog().getByRole('button', { name: '读取必要上下文', exact: true }).click();
      assert.equal(openings.length, 0); assert.equal(await page.getByTestId('admin-case-content').count(), 0);
      await caseDialog().getByRole('textbox', { name: '本次复核原因', exact: true }).fill('核对用户说明及必要的交流边界上下文。');
      await caseDialog().getByRole('button', { name: '读取必要上下文', exact: true }).click();
      await page.getByTestId('admin-case-content').waitFor({ state: 'visible' });
      assert.equal(openings.length, 1); assert.equal(auditCount('moderation:read', firstCaseId), 1);
      assert.match(await page.getByTestId('admin-case-content').innerText(), /ADMIN_CASE_BODY_ONLY_AFTER_REASON/);
      assert.match(await page.getByTestId('admin-case-content').innerText(), /ADMIN_REVIEW_CONTEXT_ON_DEMAND/);
      assert.equal(await caseDialog().locator('.admin-case-context > div').count(), 1);
    });

    await check('复核处置有忙态并落库，24 小时禁言不自动重发内容', async () => {
      const matcher = `**/api/admin/moderation/${firstCaseId}/review`;
      await page.route(matcher, async route => { await new Promise(done => setTimeout(done, 650)); await route.continue(); });
      await caseDialog().getByRole('combobox', { name: '复核处理', exact: true }).selectOption('mute');
      await page.getByTestId('admin-case-review').click();
      assert.equal(await page.getByTestId('admin-case-review').isDisabled(), true);
      assert.equal(await caseDialog().getByRole('button', { name: '关闭治理复核', exact: true }).isDisabled(), true);
      await caseDialog().waitFor({ state: 'hidden' }); await page.unroute(matcher);
      assert.equal(reviews.length, 1); assert.equal(reviews[0].action, 'mute');
      const sanction = service.store.db.prepare("SELECT * FROM sanctions WHERE user_id=? AND kind='mute' AND revoked_at IS NULL").get(user.id);
      assert.ok(sanction); assert.ok(Math.abs(Date.parse(sanction.expires_at) - Date.now() - 86400000) < 20000);
      assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE text=?').get(caseBody).n, 0);
      assert.equal(auditCount('moderation:mute', firstCaseId), 1);
      await eventually(async () => assert.equal(await page.getByTestId('admin-moderation-pending').innerText(), '1'));
    });

    await check('账号停用与恢复都要求原因，停用撤会话，恢复解除限制', async () => {
      await page.locator(`[data-testid="admin-user-detail"][data-user-id="${user.id}"]`).click();
      await page.getByTestId('admin-account-status-submit').waitFor({ state: 'visible' });
      assert.match(await detail().locator('.admin-user-governance').innerText(), /限制发言/);
      await page.getByTestId('admin-account-status-submit').click(); assert.equal(stateUpdates.length, 0);
      await detail().getByRole('textbox', { name: '账号状态处理原因', exact: true }).fill('根据已核对的案件暂时停用此测试账号。');
      await page.getByTestId('admin-account-status-submit').click();
      await detail().getByRole('button', { name: '确认恢复账号', exact: true }).waitFor({ state: 'visible' });
      assert.equal(service.store.isActive(user.id), false); assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(user.id).n, 0);
      await detail().getByRole('textbox', { name: '账号状态处理原因', exact: true }).fill('已完成重新核对，恢复账号并解除现有约束。');
      await detail().getByRole('button', { name: '确认恢复账号', exact: true }).click();
      await detail().getByRole('button', { name: '确认停用账号', exact: true }).waitFor({ state: 'visible' });
      assert.equal(service.store.isActive(user.id), true); assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM sanctions WHERE user_id=? AND revoked_at IS NULL').get(user.id).n, 0);
      assert.deepEqual(stateUpdates.map(item => item.status), ['disabled', 'active']);
      assert.equal(auditCount('account:disabled', user.id), 1); assert.equal(auditCount('account:active', user.id), 1);
      await page.getByTestId('admin-detail-close').click();
    });

    await check('管理端处理真实小组举报，隐藏发言并保护依赖它的成果', async () => {
      await page.getByRole('button', { name: '小组举报', exact: true }).click();
      const card = page.getByTestId('admin-circle-report'); await card.waitFor({ state: 'visible' });
      assert.match(await card.innerText(), /管理验证问题小组/); assert.match(await card.innerText(), /适用条件与引用出处/);
      await card.getByRole('button', { name: '隐藏发言', exact: true }).click();
      await page.getByRole('heading', { name: '没有待处理的小组举报', exact: true }).waitFor({ state: 'visible' });
      assert.ok(service.store.db.prepare('SELECT hidden_at FROM circle_messages WHERE id=?').get(circleMessageId).hidden_at);
      const current = (await normal(other, 'GET', `/circles/${circle.id}`)).circle;
      assert.equal(current.outcomes.find(item => item.id === circleOutcomeId).redacted, true);
      assert.equal((await admin('/overview')).circles.openReports, 0);
    });

    await check('治理后台桌面、390 与 320 像素可操作且无横向溢出', async () => {
      await page.getByRole('button', { name: '治理案件', exact: true }).click();
      await page.getByRole('combobox', { name: '案件范围', exact: true }).selectOption('all');
      await eventually(async () => assert.equal(await page.getByTestId('admin-case-row').count(), 2));
      await page.screenshot({ path: resolve(artifactsDir, 'admin-governance-desktop.png'), fullPage: true });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `admin at ${width}px should fit`);
        await page.screenshot({ path: resolve(artifactsDir, `admin-governance-mobile-${width}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    });

    await check('管理员会话失效时，正在查看的案件内容立即卸载且不能继续处置', async () => {
      await page.getByTestId('admin-case-row').filter({ hasText: '测试案件：验证管理员会话隔离。' }).getByTestId('admin-case-open').click();
      await caseDialog().getByRole('textbox', { name: '本次复核原因', exact: true }).fill('验证此案件在管理员会话中的必要读取边界。');
      await caseDialog().getByRole('button', { name: '读取必要上下文', exact: true }).click();
      await page.getByTestId('admin-case-content').waitFor({ state: 'visible' });
      await caseDialog().getByRole('combobox', { name: '复核处理', exact: true }).selectOption('dismiss');
      await context.clearCookies(); await page.getByTestId('admin-case-review').click();
      await page.getByTestId('admin-login-form').waitFor({ state: 'visible' });
      assert.equal(await page.getByTestId('admin-case-content').count(), 0); assert.equal(await page.getByTestId('admin-overview').count(), 0);
      assert.equal((await page.locator('body').innerText()).includes(secondBody), false);
      assert.equal(service.store.db.prepare('SELECT status FROM moderation_cases WHERE id=?').get(secondCaseId).status, 'pending');
      assert.equal(external.length, 0);
    });
  } finally { await Promise.all([context, userContext, otherContext].map(item => item.close().catch(() => {}))); }
}, { configOverrides: { SOUL_ADMIN_USERNAME: username, SOUL_ADMIN_PASSWORD_HASH: passwordHash } });
