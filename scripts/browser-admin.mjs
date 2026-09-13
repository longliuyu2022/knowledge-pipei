import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { hashAdminPassword } from '../server/admin.js';
import { buildProfile } from '../server/matching.js';
import { DOMAINS } from '../shared/catalog.js';
import { runBrowserSuite } from './browser-harness.mjs';

const username = 'browser_admin_fixture';
const password = 'Browser-Fixture-Only!2026';
const passwordHash = await hashAdminPassword(password);
const realNow = Date.now.bind(Date);
const day = value => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
const defaults = { q: '', provider: 'all', profile: 'all', visibility: 'all', topic: 'all', page: 1 };

async function eventually(job, timeout = 18000) {
  const until = realNow() + timeout;
  let lastError;
  do {
    try { return await job(); } catch (error) { lastError = error; }
    await new Promise(done => setTimeout(done, 100));
  } while (realNow() < until);
  throw lastError || new Error('Administrator page did not reach the expected state.');
}

await runBrowserSuite('admin', async ({ newContext, origin, check, artifactsDir, report, service }) => {
  const records = [], pages = [], externalRequests = [], normalAdminRequests = [], responseJobs = [];
  const privateMarkers = [password, passwordHash, 'ADMIN_PRIVATE_IMPORT_TITLE', 'ADMIN_PRIVATE_IMPORT_BODY', 'ADMIN_PRIVATE_CHAT_BODY', 'ADMIN_PRIVATE_OAUTH_SUBJECT'];
  const screenshotNames = [];
  let filters = { ...defaults }, standardUserId, privatePerson, publicPerson, emptyPerson, historicalPerson;
  let sessionCount = 0;

  function track(context, administrator = true) {
    context.on('request', request => {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) externalRequests.push(url.origin + url.pathname);
      if (administrator && ['/api/bootstrap', '/api/events'].includes(url.pathname)) normalAdminRequests.push(url.pathname);
    });
    context.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith('/api/admin/') && !['/api/admin/session', '/api/admin/login', '/api/admin/logout'].includes(path)) {
        responseJobs.push(response.text().then(body => ({ path, body }), () => null));
      }
    });
  }

  const context = await newContext(); track(context);
  const page = await context.newPage(); page.setDefaultTimeout(18000); pages.push(page);
  const ordinary = await newContext(); track(ordinary, false);
  const outsider = await newContext(); track(outsider);

  const userCount = () => service.store.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  const ordinarySessionCount = () => service.store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
  function safeData(value) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    for (const marker of privateMarkers) assert.equal(serialized.includes(marker), false, 'An administrator data response exposed private fixture content or a credential.');
    if (typeof value !== 'object' || value === null) return;
    const forbidden = new Set(['password', 'passwordHash', 'password_hash', 'token', 'token_hash', 'accessToken', 'refreshToken', 'csrf', 'subject', 'evidence', 'evidenceIds', 'imports', 'raw']);
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      for (const [key, child] of Object.entries(node)) {
        assert.equal(forbidden.has(key), false, `Administrator data contains the private field ${key}.`);
        visit(child);
      }
    };
    visit(value);
  }

  async function api(actor, method, path, body, options = {}) {
    const response = await actor.request.fetch(origin + '/api/admin' + path, {
      method,
      headers: { Origin: origin, ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}), ...options.headers },
      ...(body === undefined ? {} : { data: body }),
    });
    const result = await response.json();
    const expected = options.status ?? 200;
    assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status()), `${method} /api/admin${path} returned unexpected status ${response.status()}.`);
    assert.match(response.headers()['cache-control'] || '', /no-store/);
    if (!['/session', '/login', '/logout'].includes(path)) safeData(result);
    return result;
  }

  async function active(target = page) {
    await target.getByTestId('admin-count-totalUsers').waitFor({ state: 'visible' });
    await eventually(async () => assert.equal(await target.getByTestId('admin-users').getAttribute('aria-busy'), 'false'));
    assert.equal(await target.getByTestId('admin-users-error').count(), 0);
  }

  async function login(target = page, suppliedPassword = password, success = true) {
    await target.getByTestId('admin-login-form').waitFor({ state: 'visible' });
    await target.getByTestId('admin-username').fill(username);
    await target.getByTestId('admin-password').fill(suppliedPassword);
    const response = target.waitForResponse(value => new URL(value.url()).pathname === '/api/admin/login' && value.request().method() === 'POST');
    await target.getByTestId('admin-login-submit').click();
    assert.equal((await response).status(), success ? 200 : 401);
    if (success) { await active(target); filters = { ...defaults }; }
    else await target.getByTestId('admin-login-error').waitFor({ state: 'visible' });
  }

  const rowIds = target => target.getByTestId('admin-user-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-user-id')));
  function expectedRecords(values = filters) {
    return records.filter(record => {
      const profile = record.profile;
      const searchable = [record.user.name, record.user.id, profile?.title || '', ...(profile?.interests || []).flatMap(topic => [topic.id, topic.label])].join(' ').toLowerCase();
      return (!values.q || searchable.includes(values.q.toLowerCase())) &&
        (values.provider === 'all' || values.provider === record.user.provider) &&
        (values.profile === 'all' || (values.profile === 'ready') === Boolean(profile)) &&
        (values.visibility === 'all' || (values.visibility === 'public') === Boolean(profile?.discoverable)) &&
        (values.topic === 'all' || profile?.interests.some(topic => topic.id === values.topic));
    });
  }
  const sortedIds = values => values.map(value => typeof value === 'string' ? value : value.user.id).sort();

  async function queryAction(action, nextFilters) {
    const response = page.waitForResponse(value => {
      const url = new URL(value.url());
      return url.pathname === '/api/admin/users' && value.request().method() === 'GET' &&
        Object.entries(nextFilters).every(([key, val]) => url.searchParams.get(key) === String(val));
    });
    await action();
    const result = await response;
    assert.equal(result.status(), 200);
    const data = await result.json(); safeData(data);
    filters = { ...nextFilters };
    await active();
    await eventually(async () => assert.deepEqual(await rowIds(page), data.items.map(item => item.id)));
    assert.equal(data.total, expectedRecords().length);
    return data;
  }
  const search = q => queryAction(async () => {
    await page.getByTestId('admin-user-search').fill(q);
    await page.getByTestId('admin-search-submit').click();
  }, { ...filters, q: q.trim(), page: 1 });
  const choose = (key, value) => queryAction(() => page.getByTestId(`admin-filter-${key}`).selectOption(value), { ...filters, [key]: value, page: 1 });
  const nextPage = () => queryAction(() => page.getByTestId('admin-page-next').click(), { ...filters, page: filters.page + 1 });
  async function reset() {
    if (Object.entries(defaults).every(([key, value]) => filters[key] === value)) {
      await page.getByTestId('admin-filter-reset').click(); await active();
      return api(context, 'GET', '/users');
    }
    return queryAction(() => page.getByTestId('admin-filter-reset').click(), { ...defaults });
  }
  async function details(record) {
    await reset(); await search(record.user.id);
    const response = page.waitForResponse(value => new URL(value.url()).pathname === `/api/admin/users/${record.user.id}`);
    await page.locator(`[data-testid="admin-user-detail"][data-user-id="${record.user.id}"]`).click();
    const result = await response; assert.equal(result.status(), 200);
    const data = await result.json(); safeData(data);
    await page.getByTestId(record.profile ? 'admin-detail-profile' : 'admin-detail-empty-profile').waitFor({ state: 'visible' });
    return data;
  }
  async function closeDetails() {
    await page.getByTestId('admin-detail-close').click();
    await page.getByTestId('admin-detail').waitFor({ state: 'hidden' });
  }
  async function screenshot(name, fullPage = false) {
    await page.screenshot({ path: resolve(artifactsDir, name), fullPage });
    screenshotNames.push(name);
  }
  async function noProtectedContent(target = page) {
    await target.getByTestId('admin-login-form').waitFor({ state: 'visible' });
    assert.equal(await target.getByTestId('admin-overview').count(), 0);
    assert.equal(await target.getByTestId('admin-user-row').count(), 0);
    assert.equal(await target.getByTestId('admin-detail').count(), 0);
    const content = await target.locator('body').innerText();
    for (const record of [privatePerson, publicPerson, emptyPerson]) assert.equal(content.includes(record.user.name), false);
  }

  try {
    await check('隔离 SQLite 准备多页访客与知乎用户、私密/公开/空画像，外部能力全部关闭', async () => {
      const bootstrapResponse = await ordinary.request.get(origin + '/api/bootstrap');
      assert.equal(bootstrapResponse.status(), 200);
      const bootstrap = await bootstrapResponse.json(); standardUserId = bootstrap.user.id;
      for (const capability of ['ai', 'embedding', 'oauth', 'zhihuData', 'zhihuSearch']) assert.equal(bootstrap.capabilities[capability], false);
      privateMarkers.push(bootstrap.csrf);
      records.push({ user: bootstrap.user, profile: null, createdAt: new Date().toISOString() });
      for (let index = 0; index < 65; index++) {
        const name = index === 1 ? '林知微<&"\'_%>' : index === 2 ? '公开画像知友' : index === 4 ? '只登录未建画像' : index === 5 ? '历史授权知友' : `验收伙伴${String(index).padStart(2, '0')}`;
        let user = service.store.createUser(name);
        if (index % 3 !== 0) user = service.store.oauthUser(user.id, { subject: `ADMIN_PRIVATE_OAUTH_SUBJECT-${index}`, name, avatar: '' });
        let profile = null;
        if (index % 4 !== 0) {
          const input = { name, topicIds: index % 2 ? ['ai', 'product', 'reading', 'psychology'] : ['nature', 'travel', 'biology'], about: `这是${name}主动提供的介绍，喜欢分享自己的发现。`, question: '怎样把一个好奇的问题聊得更深入？', styleId: 'deep', goals: ['conversation', 'learning'] };
          const imports = index === 1 ? [{ title: 'ADMIN_PRIVATE_IMPORT_TITLE', summary: 'ADMIN_PRIVATE_IMPORT_BODY', kind: 'answer', url: 'https://www.zhihu.com/question/100/answer/200' }] : [];
          if (imports.length) service.store.saveImports(user.id, imports);
          profile = service.store.saveProfile(user.id, buildProfile(input, imports), 0);
          if (index % 2 === 0) profile = service.store.setDiscoverable(user.id, true);
        }
        const ageDays = index === 2 ? 1 : index === 4 ? 8 : index === 5 ? 2 : 0;
        const createdAt = new Date(realNow() - ageDays * 86400000).toISOString();
        service.store.db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(createdAt, user.id);
        if (index === 5) service.store.db.prepare('UPDATE users SET registered_at = NULL WHERE id = ?').run(user.id);
        const record = { user, profile, createdAt }; records.push(record);
        if (index === 1) privatePerson = record;
        if (index === 2) publicPerson = record;
        if (index === 4) emptyPerson = record;
        if (index === 5) historicalPerson = record;
      }
      const session = service.store.createSession(privatePerson.user.id); privateMarkers.push(session.token, session.csrf);
      const conversationId = service.store.connectPairing(randomUUID(), privatePerson.user.id, publicPerson.user.id, privatePerson.profile.revision, publicPerson.profile.revision);
      service.store.sendMessage(privatePerson.user.id, conversationId, 'ADMIN_PRIVATE_CHAT_BODY', randomUUID());
      sessionCount = ordinarySessionCount();
      assert.equal(userCount(), records.length); assert.equal(records.length, 66); assert.equal(sessionCount, 2);
      report.configuration = { users: records.length, database: 'temporary isolated SQLite', identities: 'fictional guest and OAuth fixtures', ai: false, zhihu: false, authorization: 'real administrator API; no API mocks' };
    });

    await check('直接进入 /admin 只创建独立管理员登录凭证，不调用普通 bootstrap 或创建访客', async () => {
      await page.goto(origin + '/admin');
      await page.getByTestId('admin-login-form').waitFor({ state: 'visible' });
      await noProtectedContent();
      assert.equal(userCount(), records.length); assert.equal(ordinarySessionCount(), sessionCount);
      assert.deepEqual(normalAdminRequests, []);
      const cookies = await context.cookies(origin + '/api/admin/session');
      const cookie = cookies.find(value => value.name === 'soul_admin');
      assert.ok(cookie); assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Strict'); assert.equal(cookie.path, '/api/admin');
      assert.equal(cookies.some(value => value.name === 'soul_session'), false);
      assert.equal((await page.evaluate(() => document.cookie)).includes('soul_admin'), false);
    });

    await check('匿名及普通用户会话均无法读取管理概况、列表或画像详情', async () => {
      for (const actor of [outsider, ordinary]) {
        for (const path of ['/overview', '/users', `/users/${privatePerson.user.id}`]) {
          const denied = await api(actor, 'GET', path, undefined, { status: 401 });
          assert.equal(denied.error.code, 'admin_auth_required');
        }
      }
      await api(outsider, 'GET', '/not-a-real-admin-endpoint', undefined, { status: 404 });
      assert.equal(userCount(), records.length); assert.equal(ordinarySessionCount(), sessionCount);
    });

    await check('真实错误密码保留登录界面，缺少 CSRF 或跨站登录被服务器拒绝', async () => {
      await login(page, 'Incorrect-Fixture-Password!2026', false);
      assert.match(await page.getByTestId('admin-login-error').innerText(), /用户名或密码/);
      await noProtectedContent();
      const anonymous = await api(context, 'GET', '/session');
      assert.equal(anonymous.authenticated, false); assert.ok(anonymous.csrf);
      await api(context, 'POST', '/login', { username, password }, { status: 403 });
      await api(context, 'POST', '/login', { username, password }, { csrf: anonymous.csrf, headers: { Origin: 'https://untrusted.example' }, status: 403 });
    });

    await check('真实 UI 登录成功并轮换管理员凭证，普通访客和会话总数保持不变', async () => {
      const before = (await context.cookies(origin + '/api/admin/session')).find(value => value.name === 'soul_admin').value;
      const anonymous = await api(context, 'GET', '/session');
      await login();
      const after = (await context.cookies(origin + '/api/admin/session')).find(value => value.name === 'soul_admin').value;
      const current = await api(context, 'GET', '/session');
      assert.equal(current.authenticated, true); assert.equal(current.username, username);
      assert.notEqual(after, before); assert.notEqual(current.csrf, anonymous.csrf);
      assert.equal(userCount(), records.length); assert.equal(ordinarySessionCount(), sessionCount);
    });

    await check('概况区分知乎授权用户与自动访客，近七天按北京时间首次加入统计', async () => {
      const overview = await api(context, 'GET', '/overview');
      const today = day(new Date());
      const expected = {
        totalUsers: records.length, zhihuUsers: records.filter(record => record.user.provider === 'zhihu').length,
        guestUsers: records.filter(record => record.user.provider === 'guest').length,
        profileUsers: records.filter(record => record.profile).length,
        discoverableUsers: records.filter(record => record.profile?.discoverable).length,
        onlineUsers: 0, newUsersToday: records.filter(record => day(record.createdAt) === today).length, connections: 1, messages: 1,
      };
      assert.deepEqual(overview.counts, expected);
      for (const [key, value] of Object.entries(expected)) assert.equal(Number((await page.getByTestId(`admin-count-${key}`).innerText()).replaceAll(',', '')), value);
      assert.equal(overview.registrations.length, 7);
      assert.equal(new Set(overview.registrations.map(value => value.date)).size, 7);
      for (const entry of overview.registrations) for (const provider of ['guest', 'zhihu']) {
        assert.equal(entry[provider], records.filter(record => record.user.provider === provider && day(record.createdAt) === entry.date).length);
      }
      assert.equal(overview.registrations.reduce((sum, entry) => sum + entry.guest + entry.zhihu, 0), records.length - 1);
      assert.deepEqual(overview.pairing, { searching: 0, proposed: 0 });
      for (const interest of overview.interests) assert.equal(interest.count, records.filter(record => record.profile?.interests.some(topic => topic.id === interest.id)).length);
      await page.getByTestId('admin-registration-chart').waitFor({ state: 'visible' });
      await page.getByTestId('admin-interest-chart').waitFor({ state: 'visible' });
      await page.evaluate(() => window.scrollTo(0, 0));
      await screenshot('admin-desktop.png', true);
      report.counts = expected;
    });

    await check('真实用户列表逐页读取全部 66 位身份，无遗漏重复且首尾分页按钮正确', async () => {
      let data = await api(context, 'GET', '/users');
      assert.equal(data.pageSize, 20); assert.equal(data.totalPages, 4);
      assert.equal(await page.getByTestId('admin-page-prev').isDisabled(), true);
      const seen = await rowIds(page);
      while (data.page < data.totalPages) { data = await nextPage(); seen.push(...await rowIds(page)); }
      assert.equal(await page.getByTestId('admin-page-next').isDisabled(), true);
      assert.equal(new Set(seen).size, records.length); assert.deepEqual(sortedIds(seen), sortedIds(records));
      data = await queryAction(() => page.getByTestId('admin-page-prev').click(), { ...filters, page: 3 });
      assert.equal(data.page, 3); assert.equal(data.items.length, 20);
    });

    await check('特殊字符昵称按字面量搜索并安全展示，百分号和下划线不会扩大查询', async () => {
      await reset();
      for (const query of ['%', '_', privatePerson.user.name]) {
        const data = await search(query);
        assert.equal(data.total, 1); assert.equal(data.items[0].id, privatePerson.user.id);
        assert.ok((await page.getByTestId('admin-user-row').innerText()).includes(privatePerson.user.name));
      }
      assert.equal(await page.getByTestId('admin-user-row').locator('script, iframe, img[onerror], svg[onload]').count(), 0);
    });

    await check('身份、画像、公开状态和兴趣可组合筛选，修改条件会回到第一页', async () => {
      await reset(); await nextPage();
      let data = await choose('provider', 'zhihu'); assert.equal(data.page, 1);
      await choose('profile', 'ready'); await choose('visibility', 'private'); data = await choose('topic', 'ai');
      assert.ok(data.total > 1);
      const all = await api(context, 'GET', '/users?' + new URLSearchParams({ ...filters, page: '1', pageSize: '100' }));
      assert.deepEqual(sortedIds(all.items.map(item => item.id)), sortedIds(expectedRecords()));
      for (const item of data.items) { assert.equal(item.provider, 'zhihu'); assert.equal(item.profile.discoverable, false); assert.ok(item.profile.interests.some(topic => topic.id === 'ai')); }
      assert.equal(await page.getByTestId('admin-filter-provider').inputValue(), 'zhihu');
      assert.equal(await page.getByTestId('admin-filter-profile').inputValue(), 'ready');
      assert.equal(await page.getByTestId('admin-filter-visibility').inputValue(), 'private');
      assert.equal(await page.getByTestId('admin-filter-topic').inputValue(), 'ai');
    });

    await check('筛选无结果显示真实空态，清空搜索及全部条件恢复完整列表', async () => {
      const empty = await search('不存在的用户-" OR 1=1 --');
      assert.equal(empty.total, 0); assert.equal(await page.getByTestId('admin-user-row').count(), 0);
      await page.getByTestId('admin-users-empty').waitFor({ state: 'visible' });
      const data = await reset(); assert.equal(data.total, records.length); assert.equal(data.page, 1);
      assert.equal(await page.getByTestId('admin-user-search').inputValue(), '');
      for (const key of ['provider', 'profile', 'visibility', 'topic']) assert.equal(await page.getByTestId(`admin-filter-${key}`).inputValue(), 'all');
    });

    await check('私密画像详情展示真实六维兴趣与交流信息，只返回导入和聊天数量', async () => {
      const detail = await details(privatePerson);
      assert.equal(detail.profile.discoverable, false); assert.equal(detail.profile.analysisMode, 'rules');
      assert.equal(detail.user.id, privatePerson.user.id); assert.equal(detail.user.name, privatePerson.user.name);
      assert.equal(detail.activity.importedItems, 1); assert.equal(detail.activity.connections, 1); assert.equal(detail.activity.messages, 1);
      assert.equal(detail.profile.about, privatePerson.profile.input.about); assert.equal(detail.profile.question, privatePerson.profile.input.question);
      assert.deepEqual(detail.profile.dimensions.map(value => ({ id: value.id, value: value.value })), privatePerson.profile.dimensions.map(value => ({ id: value.id, value: value.value })));
      const radar = page.getByTestId('admin-detail-radar');
      for (const dimension of DOMAINS) assert.ok((await radar.innerText()).includes(dimension.label));
      assert.equal(await radar.locator('.admin-dimension-values li').count(), 6);
      safeData(await page.getByTestId('admin-detail').innerText());
      await screenshot('admin-detail-desktop.png');
      await closeDetails();
    });

    await check('未建画像用户不显示体验画像，历史授权时间缺失保持暂无记录', async () => {
      const empty = await details(emptyPerson);
      assert.equal(empty.profile, null); assert.equal(empty.user.provider, 'zhihu');
      assert.equal(await page.getByTestId('admin-detail-radar').count(), 0);
      assert.match(await page.getByTestId('admin-detail-empty-profile').innerText(), /尚未建立知识画像/);
      await closeDetails();
      const historical = await details(historicalPerson);
      assert.equal(historical.user.registeredAt, null);
      assert.equal(await page.getByTestId('admin-detail-registeredAt').innerText(), '暂无记录');
      await closeDetails();
    });

    await check('公开画像详情准确标记公开状态，后台查看不会改变任何用户资料', async () => {
      const detail = await details(publicPerson);
      assert.equal(detail.profile.discoverable, true);
      assert.match(await page.getByTestId('admin-detail-profile').innerText(), /画像公开，可被发现/);
      await closeDetails();
      for (const record of records) assert.equal(service.store.profile(record.user.id)?.discoverable ?? null, record.profile?.discoverable ?? null);
    });

    for (const width of [390, 320]) {
      await check(`${width}px 手机后台概况、筛选、用户卡片与六维详情无横向溢出`, async () => {
        await reset(); await page.setViewportSize({ width, height: 844 }); await active();
        await page.getByTestId('admin-user-search').scrollIntoViewIfNeeded();
        const layout = await page.evaluate(() => {
          const ids = ['admin-user-search', 'admin-search-submit', 'admin-filter-reset', 'admin-filter-provider', 'admin-filter-profile', 'admin-filter-visibility', 'admin-filter-topic', 'admin-pagination'];
          return { viewport: innerWidth, page: document.documentElement.scrollWidth, controls: ids.map(id => {
            const box = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
            return { id, left: box.left, right: box.right, width: box.width };
          }) };
        });
        assert.ok(layout.page <= width + 1, `Administrator page overflows at ${width}px.`);
        for (const control of layout.controls) assert.ok(control.width > 0 && control.left >= -1 && control.right <= width + 1, `${control.id} overflows at ${width}px.`);
        await screenshot(`admin-mobile-${width}.png`);
        await details(privatePerson);
        const dialog = await page.getByTestId('admin-detail').evaluate(element => ({ viewport: innerWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, scroll: element.scrollWidth, client: element.clientWidth }));
        assert.ok(dialog.left >= -1 && dialog.right <= width + 1 && dialog.scroll <= dialog.client + 1, `Administrator details overflow at ${width}px.`);
        assert.equal(await page.getByTestId('admin-detail-radar').locator('.admin-dimension-values li').count(), 6);
        await screenshot(`admin-detail-mobile-${width}.png`);
        await closeDetails();
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    await check('整页刷新保持管理员会话，浏览器存储不保存密码或用户资料', async () => {
      const before = (await context.cookies(origin + '/api/admin/session')).find(value => value.name === 'soul_admin').value;
      await page.reload(); filters = { ...defaults }; await active();
      const after = (await context.cookies(origin + '/api/admin/session')).find(value => value.name === 'soul_admin').value;
      assert.equal(after, before); assert.equal((await api(context, 'GET', '/session')).authenticated, true);
      const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      safeData(storage);
      for (const record of [privatePerson, publicPerson, emptyPerson]) assert.equal(storage.includes(record.user.id), false);
      assert.equal(userCount(), records.length); assert.equal(ordinarySessionCount(), sessionCount);
    });

    await check('真实 UI 退出立即销毁旧会话，并清除两个标签页中的列表和画像详情', async () => {
      await details(privatePerson);
      const oldCookie = (await context.cookies(origin + '/api/admin/session')).find(value => value.name === 'soul_admin');
      const replay = await newContext(); track(replay); await replay.addCookies([oldCookie]);
      const peer = await context.newPage(); peer.setDefaultTimeout(18000); pages.push(peer);
      await peer.goto(origin + '/admin'); await active(peer);
      const response = peer.waitForResponse(value => new URL(value.url()).pathname === '/api/admin/logout');
      await peer.getByTestId('admin-logout').click(); assert.equal((await response).status(), 200);
      await noProtectedContent(peer);
      await page.bringToFront(); await noProtectedContent(); filters = { ...defaults };
      await api(replay, 'GET', '/users', undefined, { status: 401 });
      await api(replay, 'GET', `/users/${privatePerson.user.id}`, undefined, { status: 401 });
      assert.equal((await api(context, 'GET', '/session')).authenticated, false);
      await peer.close(); await replay.close();
    });

    await check('退出后浏览器后退或刷新不会恢复受保护内容，也不会创建普通访客', async () => {
      await page.goto(origin + '/api/health');
      await page.goBack({ waitUntil: 'domcontentloaded' }); await noProtectedContent();
      await page.reload(); await noProtectedContent();
      assert.equal(userCount(), records.length); assert.equal(ordinarySessionCount(), sessionCount);
    });

    await check('服务端八小时绝对过期后真实刷新与标签页恢复都要求重新登录', async () => {
      await login();
      const oldCookie = (await context.cookies(origin + '/api/admin/session')).find(value => value.name === 'soul_admin');
      const replay = await newContext(); track(replay); await replay.addCookies([oldCookie]);
      const peer = await context.newPage(); peer.setDefaultTimeout(18000); pages.push(peer);
      await peer.goto(origin + '/admin'); await active(peer);
      const originalNow = Date.now;
      try {
        Date.now = () => realNow() + 8 * 3600000 + 1000;
        await api(replay, 'GET', '/overview', undefined, { status: 401 });
        await peer.getByTestId('admin-refresh').click(); await noProtectedContent(peer);
        await page.bringToFront(); await page.reload(); await noProtectedContent();
      } finally { Date.now = originalNow; }
      await peer.close(); await replay.close(); filters = { ...defaults };
    });

    await check('后台响应与页面未泄漏原始导入、聊天或凭据，访客会话及真实业务数据保持完整', async () => {
      for (const response of await Promise.all(responseJobs)) if (response) safeData(response.body);
      assert.deepEqual(externalRequests, []); assert.deepEqual(normalAdminRequests, []);
      assert.equal(userCount(), records.length); assert.equal(ordinarySessionCount(), sessionCount);
      const normal = await (await ordinary.request.get(origin + '/api/bootstrap')).json();
      assert.equal(normal.user.id, standardUserId);
      assert.equal(service.store.imports(privatePerson.user.id).items[0].summary, 'ADMIN_PRIVATE_IMPORT_BODY');
      assert.equal(service.store.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE text = ?').get('ADMIN_PRIVATE_CHAT_BODY').count, 1);
      assert.equal(service.store.profile(privatePerson.user.id).discoverable, false);
      report.screenshots = screenshotNames;
      report.expiration = { absoluteSessionMs: 8 * 3600000, clock: 'Date.now advanced only inside the isolated browser-test Node process, then restored' };
    });
  } catch (error) {
    await Promise.allSettled(pages.filter(value => !value.isClosed()).map((value, index) => value.screenshot({ path: resolve(artifactsDir, `admin-failure-${index + 1}.png`), fullPage: true })));
    throw error;
  }
}, { configOverrides: { SOUL_ADMIN_USERNAME: username, SOUL_ADMIN_PASSWORD_HASH: passwordHash } });
