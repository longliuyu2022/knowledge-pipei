import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runBrowserSuite } from './browser-harness.mjs';

// Synthetic values belong only to the temporary database and this in-process
// transport. The mock never delegates to fetch or performs an OAuth exchange.
const SYNTHETIC_ACCESS = 'synthetic-zhihu-browser-access-only';
const SYNTHETIC_FAVORITE = '969570047710216201';
const PRIVATE_TITLE = 'synthetic-private-title-never-in-report';
const PRIVATE_BODY = 'synthetic-private-body-never-in-report';
const PRIVATE_ERROR = 'synthetic-upstream-message-never-in-report';
const IMPORT_TITLE = '隔离样例：人工智能与阅读';
const IMPORT_SUMMARY = '这是选择导入之后才读取的隔离测试摘要。';
const CHECKS = ['contents', 'followees', 'favlists', 'favlist_contents', 'collections'];
const PATHS = CHECKS.map(id => `/api/v1/user/${id}`);
const scenarios = new Map();
const upstreamCalls = [];
const rejectedTargets = [];
let mockWindow = 0;

function response(value, status = 200) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

async function mockFetch(input, options = {}) {
  const url = new URL(input);
  const token = options.headers?.['X-OAuth-Token'];
  const fixture = scenarios.get(token);
  if (url.origin !== 'https://developer.zhihu.com' || !PATHS.includes(url.pathname) || !fixture) {
    rejectedTargets.push(`${url.origin}${url.pathname}`);
    throw new Error('The isolated browser fixture rejected an unexpected upstream request.');
  }
  assert.equal(options.headers.Authorization, `Bearer ${SYNTHETIC_ACCESS}`);
  assert.match(options.headers['X-Request-Timestamp'], /^\d+$/);
  const limit = url.searchParams.get('Limit');
  assert.ok(['1', '10'].includes(limit));
  upstreamCalls.push({ window: mockWindow, scenario: fixture.mode, user: fixture.userId, path: url.pathname, params: Object.fromEntries(url.searchParams), limit });
  if (limit === '10') {
    assert.equal(url.pathname, '/api/v1/user/contents', 'Selective import must request only the selected source.');
    return response({ Code: 0, Data: { Items: [{ Title: IMPORT_TITLE, Summary: IMPORT_SUMMARY, Url: 'https://www.zhihu.com/question/123456789' }] } });
  }
  if (fixture.mode === 'empty') return response({ Code: 0, Data: { Items: [] } });
  if (fixture.mode === 'failure' && url.pathname.endsWith('/contents')) return response({ Code: 90001, Message: PRIVATE_ERROR });
  if (fixture.mode === 'expired') return response({ Code: 20001, Message: PRIVATE_ERROR });
  if (fixture.mode === 'quota') return response({ Code: 30001, Message: PRIVATE_ERROR });
  return response(`{"Code":0,"Data":{"Items":[{"UrlToken":${SYNTHETIC_FAVORITE},"Title":"${PRIVATE_TITLE}","Summary":"${PRIVATE_BODY}","Content":"${PRIVATE_BODY}","Fullname":"synthetic-private-person","Headline":"${PRIVATE_BODY}","Url":"https://www.zhihu.com/question/987654321"}]}}`);
}

async function eventually(job, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try { return await job(); } catch (error) { lastError = error; }
    await new Promise(done => setTimeout(done, 100));
  } while (Date.now() < deadline);
  throw lastError || new Error('The browser did not reach the expected check state.');
}

function assertMetadata(report) {
  assert.deepEqual(Object.keys(report).sort(), ['checkedAt', 'items', 'status']);
  assert.equal(new Date(report.checkedAt).toISOString(), report.checkedAt);
  assert.ok(['passed', 'partial', 'failed'].includes(report.status));
  assert.deepEqual(report.items.map(item => item.id), CHECKS);
  for (const item of report.items) {
    assert.deepEqual(Object.keys(item).sort(), ['code', 'count', 'id', 'label', 'message', 'status']);
    assert.ok(['success', 'empty', 'error', 'skipped'].includes(item.status));
    assert.ok([null, 0, 1].includes(item.count));
  }
  const encoded = JSON.stringify(report);
  for (const value of [SYNTHETIC_ACCESS, SYNTHETIC_FAVORITE, PRIVATE_TITLE, PRIVATE_BODY, PRIVATE_ERROR, 'synthetic-oauth-', 'synthetic-private-person', 'FavlistUrlToken', 'X-OAuth-Token', 'Authorization']) {
    assert.equal(encoded.includes(value), false, 'The downloaded check must contain only status metadata.');
  }
}

await runBrowserSuite('zhihu', async ({ newContext, origin, check, artifactsDir, report, service }) => {
  service.zhihu.config.zhihu.accessSecret = SYNTHETIC_ACCESS;
  service.zhihu.config.zhihu.oauthConfigured = true;
  const actors = [];
  const externalBrowserRequests = [];
  const authRequests = [];

  function nextMockMinute() {
    // Model a fresh upstream minute without a real delay. The application rate
    // limit remains intact: each error scenario uses a different isolated user.
    mockWindow++;
    service.zhihu.calls = [];
    service.zhihu.cooldown = 0;
  }

  async function api(actor, method, path, body, expected = 200) {
    const result = await actor.context.request.fetch(origin + '/api' + path, {
      method,
      headers: { Origin: origin, ...(actor.csrf ? { 'X-CSRF-Token': actor.csrf } : {}) },
      ...(body === undefined ? {} : { data: body }),
    });
    const data = await result.json();
    assert.equal(result.status(), expected, `${method} ${path} returned an unexpected status.`);
    return data;
  }

  async function actorFor(mode, { existingImport = false } = {}) {
    nextMockMinute();
    const context = await newContext({ acceptDownloads: true });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) {
        externalBrowserRequests.push(`${url.origin}${url.pathname}`);
        await route.abort();
      } else await route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(18000);
    const actor = { context, page, id: '', csrf: '', mode, requests: [], beforeProfile: null, beforeImports: null };
    actors.push(actor);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/auth/zhihu')) authRequests.push(path);
      if (['/api/zhihu/validation', '/api/zhihu/import'].includes(path)) actor.requests.push({ path, method: request.method() });
    });
    const initial = await api(actor, 'GET', '/bootstrap');
    actor.id = initial.user.id; actor.csrf = initial.csrf;
    const identity = service.store.oauthUser(actor.id, { subject: `synthetic-subject-${actors.length}`, name: `数据检查样例 ${actors.length}`, avatar: '' });
    assert.equal(identity.id, actor.id);
    const token = `synthetic-oauth-browser-${actors.length}`;
    scenarios.set(token, { mode, userId: actor.id });
    service.zhihu.setToken(actor.id, token);
    if (existingImport) service.store.saveImports(actor.id, [{ kind: 'contents', title: '之前选择导入的阅读线索', summary: '已有的测试摘要必须在连接检查后保持原样。', url: '' }]);
    await api(actor, 'POST', '/profile', { revision: 0, useAI: false, input: {
      name: identity.name, topicIds: ['ai', 'reading', 'psychology'], about: '隔离浏览器样例，关注技术、阅读与日常提问。',
      question: '有哪些问题值得慢慢讨论？', styleId: 'deep', goals: ['conversation'],
    } });
    actor.beforeProfile = service.store.profile(actor.id);
    actor.beforeImports = service.store.imports(actor.id);
    await page.goto(origin + '/#profile');
    await page.getByRole('button', { name: '从知乎补充线索', exact: true }).waitFor({ state: 'visible' });
    return actor;
  }

  const modal = actor => actor.page.getByRole('dialog', { name: '从知乎，补充兴趣的线索', exact: true });
  const panel = actor => actor.page.getByTestId('zhihu-data-check');
  const checkReport = actor => actor.page.getByTestId('zhihu-check-report');
  const startButton = actor => actor.page.getByTestId('zhihu-check-start');
  const consent = actor => panel(actor).getByRole('checkbox', { name: '同意读取上述五类公开数据，每项最多一条' });
  const postCount = actor => actor.requests.filter(request => request.method === 'POST' && request.path === '/api/zhihu/validation').length;
  const callsFor = actor => upstreamCalls.filter(call => call.user === actor.id);
  function unchanged(actor) {
    assert.deepEqual(service.store.profile(actor.id), actor.beforeProfile);
    assert.deepEqual(service.store.imports(actor.id), actor.beforeImports);
  }

  async function openImport(actor) {
    await actor.page.getByRole('button', { name: '从知乎补充线索', exact: true }).click();
    await modal(actor).waitFor({ state: 'visible' });
  }

  async function expand(actor) {
    const response = actor.page.waitForResponse(result => new URL(result.url()).pathname === '/api/zhihu/validation' && result.request().method() === 'GET');
    await panel(actor).getByRole('button', { name: '检查知乎数据连接', exact: true }).click();
    assert.equal((await response).status(), 200);
    await eventually(async () => assert.equal(await panel(actor).locator('.loading-inline').count(), 0));
  }

  async function runCheck(actor) {
    await consent(actor).check();
    const response = actor.page.waitForResponse(result => new URL(result.url()).pathname === '/api/zhihu/validation' && result.request().method() === 'POST');
    await startButton(actor).click();
    const result = await response;
    assert.equal(result.status(), 200);
    const data = await result.json();
    assert.deepEqual(Object.keys(data).sort(), ['connected', 'report', 'retryAt']);
    assertMetadata(data.report);
    for (const value of [PRIVATE_TITLE, PRIVATE_BODY, PRIVATE_ERROR, SYNTHETIC_FAVORITE, SYNTHETIC_ACCESS, 'synthetic-oauth-']) {
      assert.equal(JSON.stringify(data).includes(value), false, 'The check response must not expose upstream content or credentials.');
    }
    await checkReport(actor).waitFor({ state: 'visible' });
    await eventually(async () => assert.equal(await checkReport(actor).locator('.zhihu-check-row').count(), 5));
    await eventually(async () => assert.equal(await modal(actor).getByRole('button', { name: '关闭弹窗', exact: true }).isEnabled(), true));
    for (const item of data.report.items) assert.equal(await checkReport(actor).locator(`[data-check="${item.id}"]`).getAttribute('data-status'), item.status);
    for (const value of [PRIVATE_TITLE, PRIVATE_BODY, PRIVATE_ERROR, SYNTHETIC_FAVORITE, SYNTHETIC_ACCESS]) assert.equal((await checkReport(actor).innerText()).includes(value), false);
    unchanged(actor);
    return data;
  }

  let full;
  try {
    await check('隔离 OAuth 样例默认不读取外部数据，展开连接检查只读取本地状态', async () => {
      full = await actorFor('full', { existingImport: true });
      assert.equal(upstreamCalls.length, 0);
      assert.equal(service.store.zhihuValidation(full.id), null);
      await openImport(full);
      assert.equal(await panel(full).getByRole('button', { name: '检查知乎数据连接', exact: true }).getAttribute('aria-expanded'), 'false');
      assert.equal(full.requests.length, 0);
      await expand(full);
      assert.deepEqual(full.requests, [{ path: '/api/zhihu/validation', method: 'GET' }]);
      assert.equal(upstreamCalls.length, 0);
      assert.equal(await checkReport(full).count(), 0);
      unchanged(full);
    });

    await check('用户未勾选五类数据的读取同意时，检查按钮不可提交且无业务请求', async () => {
      assert.equal(await consent(full).isChecked(), false);
      assert.equal(await startButton(full).isDisabled(), true);
      await startButton(full).evaluate(button => button.click());
      assert.equal(postCount(full), 0); assert.equal(upstreamCalls.length, 0);
      const importBoxes = modal(full).locator('.import-options input[type="checkbox"]');
      assert.equal(await importBoxes.count(), 3);
      for (const input of await importBoxes.all()) assert.equal(await input.isChecked(), false);
    });

    let fullState;
    await check('主动同意后五项各 Limit=1，结果只包含元数据，画像与已有导入保持原样', async () => {
      fullState = await runCheck(full);
      assert.equal(fullState.report.status, 'passed'); assert.equal(fullState.connected, true);
      assert.equal(postCount(full), 1);
      const calls = callsFor(full);
      assert.deepEqual(calls.map(call => call.path), PATHS);
      assert.ok(calls.every(call => call.limit === '1'));
      assert.equal(calls[3].params.FavlistUrlToken, SYNTHETIC_FAVORITE);
      assert.equal(Object.hasOwn(calls[4].params, 'Offset'), false);
      assert.ok(fullState.report.items.every(item => item.status === 'success' && item.count === 1));
      assert.deepEqual(service.store.zhihuValidation(full.id), fullState.report);
      assert.equal(await checkReport(full).getAttribute('data-status'), 'passed');
      await checkReport(full).scrollIntoViewIfNeeded();
      await full.page.screenshot({ path: resolve(artifactsDir, 'zhihu-check-desktop.png') });
    });

    await check('一分钟冷却内按钮不能重跑，直接重试也不会多读或覆盖上次报告', async () => {
      assert.ok(Date.parse(fullState.retryAt) > Date.now());
      assert.equal(await startButton(full).isDisabled(), true);
      assert.match(await panel(full).locator('.zhihu-check-wait').innerText(), /秒后可再次检查/);
      await startButton(full).evaluate(button => button.click());
      assert.equal(postCount(full), 1); assert.equal(callsFor(full).length, 5);
      const again = await api(full, 'POST', '/zhihu/validation', { consent: true }, 429);
      assert.equal(again.error.code, 'zhihu_rate_limited');
      assert.equal(callsFor(full).length, 5);
      assert.deepEqual(service.store.zhihuValidation(full.id), fullState.report);
      unchanged(full);
    });

    await check('下载的检查 JSON 仅包含时间、状态、条数与解释，不含正文、凭证或收藏夹标识', async () => {
      const download = full.page.waitForEvent('download');
      await full.page.getByTestId('zhihu-check-download').click();
      const file = await download;
      assert.match(file.suggestedFilename(), /^tongpin-zhihu-check-\d{4}-\d{2}-\d{2}\.json$/);
      const data = JSON.parse(readFileSync(await file.path(), 'utf8'));
      assert.deepEqual(Object.keys(data).sort(), ['checkedAt', 'items', 'kind', 'status', 'version']);
      assert.equal(data.kind, 'tongpin-zhihu-oauth-check'); assert.equal(data.version, 1);
      const { kind: _kind, version: _version, ...metadata } = data;
      assertMetadata(metadata); assert.deepEqual(metadata, fullState.report);
      unchanged(full);
    });

    for (const width of [390, 320]) {
      await check(`${width}px 连接检查五项报告、同意框与下载入口无横向溢出`, async () => {
        await full.page.setViewportSize({ width, height: 844 });
        await checkReport(full).scrollIntoViewIfNeeded();
        const boxes = await modal(full).evaluate(element => ({
          viewport: innerWidth, page: document.documentElement.scrollWidth,
          dialog: element.getBoundingClientRect().toJSON(),
          contentWidth: element.querySelector('.dialog-shell').scrollWidth,
          visibleWidth: element.querySelector('.dialog-shell').clientWidth,
          controls: [...element.querySelectorAll('.zhihu-check-report, .zhihu-check-row, .zhihu-check-consent, .zhihu-check-body button')].map(item => item.getBoundingClientRect().toJSON()),
        }));
        assert.ok(boxes.page <= boxes.viewport + 1);
        assert.ok(boxes.contentWidth <= boxes.visibleWidth + 1);
        assert.ok(boxes.dialog.left >= -1 && boxes.dialog.right <= boxes.viewport + 1);
        for (const box of boxes.controls) assert.ok(box.width > 0 && box.left >= -1 && box.right <= boxes.viewport + 1);
        await full.page.screenshot({ path: resolve(artifactsDir, `zhihu-check-mobile-${width}.png`) });
      });
    }
    await full.page.setViewportSize({ width: 1440, height: 1000 });

    await check('检查后重开导入仍需重新选择来源，下一模拟时间窗只导入明确勾选的创作', async () => {
      await modal(full).getByRole('button', { name: '关闭弹窗', exact: true }).click();
      await modal(full).waitFor({ state: 'hidden' });
      nextMockMinute();
      await openImport(full);
      const importBoxes = modal(full).locator('.import-options input[type="checkbox"]');
      for (const input of await importBoxes.all()) assert.equal(await input.isChecked(), false);
      assert.equal(await modal(full).getByRole('button', { name: /导入并更新画像/ }).isDisabled(), true);
      await expand(full);
      assert.equal(await consent(full).isChecked(), false);
      assert.equal(await checkReport(full).getAttribute('data-status'), 'passed');
      assert.equal(callsFor(full).length, 5);
      await modal(full).getByRole('checkbox', { name: /我的创作/ }).check();
      const importResponse = full.page.waitForResponse(result => new URL(result.url()).pathname === '/api/zhihu/import' && result.request().method() === 'POST');
      await modal(full).getByRole('button', { name: /导入并更新画像/ }).click();
      const result = await importResponse;
      assert.equal(result.status(), 200);
      assert.deepEqual(result.request().postDataJSON(), { sources: ['contents'], useAI: false });
      assert.equal((await result.json()).count, 1);
      await modal(full).getByRole('heading', { name: '收集到 1 条兴趣线索', exact: true }).waitFor({ state: 'visible' });
      const calls = callsFor(full);
      assert.equal(calls.length, 6); assert.equal(calls[5].path, '/api/v1/user/contents'); assert.equal(calls[5].limit, '10');
      const imported = service.store.imports(full.id).items;
      assert.equal(imported.length, 1); assert.equal(imported[0].title, IMPORT_TITLE); assert.equal(imported[0].summary, IMPORT_SUMMARY);
      assert.equal(service.store.profile(full.id).revision, full.beforeProfile.revision + 1);
      assert.deepEqual(service.store.zhihuValidation(full.id), fullState.report);
      await full.context.close();
    });

    await check('空收藏夹明确显示空数据，收藏夹内容按空记录且不发起虚构的内容请求', async () => {
      const actor = await actorFor('empty'); await openImport(actor); await expand(actor);
      const result = await runCheck(actor);
      assert.equal(result.report.status, 'passed');
      assert.ok(result.report.items.every(item => item.status === 'empty' && item.count === 0));
      assert.equal(result.report.items[3].code, 'no_favorite_list');
      assert.deepEqual(callsFor(actor).map(call => call.path), PATHS.filter(path => !path.endsWith('/favlist_contents')));
      assert.equal(await checkReport(actor).locator('[data-status="empty"]').count(), 5);
      assert.match(await checkReport(actor).locator('[data-check="favlist_contents"]').innerText(), /没有可读取的公开收藏夹/);
      await actor.context.close();
    });

    await check('独立接口失败显示读取失败，其余项目继续检查，服务错误不会当作空数据或泄露原文', async () => {
      const actor = await actorFor('failure'); await openImport(actor); await expand(actor);
      const result = await runCheck(actor);
      assert.equal(result.report.status, 'partial'); assert.equal(result.connected, true);
      assert.equal(result.report.items[0].status, 'error'); assert.equal(result.report.items[0].count, null);
      assert.ok(result.report.items.slice(1).every(item => item.status === 'success'));
      assert.equal(callsFor(actor).length, 5);
      assert.match(await checkReport(actor).locator('[data-check="contents"]').innerText(), /读取失败/);
      assert.equal(await checkReport(actor).locator('[data-status="empty"]').count(), 0);
      await actor.context.close();
    });

    await check('授权失效后停止后续读取，标记失败与尚未检查，并提供重新连接入口', async () => {
      const actor = await actorFor('expired'); await openImport(actor); await expand(actor);
      const result = await runCheck(actor);
      assert.equal(result.report.status, 'failed'); assert.equal(result.connected, false);
      assert.equal(result.report.items[0].status, 'error'); assert.equal(result.report.items[0].code, 'zhihu_expired');
      assert.ok(result.report.items.slice(1).every(item => item.status === 'skipped' && item.count === null));
      assert.equal(callsFor(actor).length, 1);
      assert.equal(await checkReport(actor).locator('[data-status="empty"]').count(), 0);
      await panel(actor).getByRole('button', { name: '重新连接知乎', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await startButton(actor).count(), 0);
      assert.equal(service.zhihu.token(actor.id), null);
      await actor.context.close();
    });

    await check('上游限流显示失败并进入冷却，不把受限项目标为空数据或继续消耗请求', async () => {
      const actor = await actorFor('quota'); await openImport(actor); await expand(actor);
      const result = await runCheck(actor);
      assert.equal(result.report.status, 'failed'); assert.equal(result.connected, true);
      assert.equal(result.report.items[0].code, 'zhihu_rate_limited'); assert.equal(callsFor(actor).length, 1);
      assert.ok(result.report.items.slice(1).every(item => item.status === 'skipped'));
      assert.equal(await startButton(actor).isDisabled(), true);
      assert.equal(await checkReport(actor).locator('[data-status="empty"]').count(), 0);
      assert.match(await panel(actor).locator('.zhihu-check-wait').innerText(), /秒后可再次检查/);
      await startButton(actor).evaluate(button => button.click());
      assert.equal(callsFor(actor).length, 1); assert.equal(postCount(actor), 1);
      await actor.context.close();
    });

    await check('全部样例没有真实 OAuth、外部浏览器请求或未获模拟许可的上游调用', async () => {
      assert.deepEqual(authRequests, []);
      assert.deepEqual(externalBrowserRequests, []);
      assert.deepEqual(rejectedTargets, []);
      const counts = new Map();
      for (const call of upstreamCalls) counts.set(call.window, (counts.get(call.window) || 0) + 1);
      assert.ok([...counts.values()].every(value => value <= 5));
      report.configuration = { database: 'temporary isolated SQLite', oauth: 'synthetic local grants only', upstream: 'in-process mock without network fallback', limiter: 'separate users and explicitly reset mock minute windows', scenarios: actors.map(actor => actor.mode) };
      report.screenshots = ['zhihu-check-desktop.png', 'zhihu-check-mobile-390.png', 'zhihu-check-mobile-320.png'];
    });
  } catch (error) {
    await Promise.allSettled(actors.filter(actor => !actor.page.isClosed()).map((actor, index) => actor.page.screenshot({ path: resolve(artifactsDir, `zhihu-check-failure-${index + 1}.png`), fullPage: true })));
    throw error;
  }
}, { fetchImpl: mockFetch });
