import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBrowserSuite } from './browser-harness.mjs';

const initialName = '书与星光';
const updatedName = '书与星光 · 新篇';
const initialAbout = '这是浏览器验收资料。喜欢人工智能与阅读，也关注心理学在日常中的应用。';
const updatedAbout = `${initialAbout}\n最近也开始观察星空，记录自己的好奇。`;
const question = '当 AI 可以解释一切，我们该如何保留自己的好奇心？';

async function bootstrap(page) {
  const response = await page.request.get('/api/bootstrap');
  assert.equal(response.status(), 200, '应能读取当前浏览器会话的资料');
  return response.json();
}

async function waitForMutation(page, path, action, method = 'POST') {
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === `/api${path}` && response.request().method() === method);
  // Consume a potential rejection even if the UI action fails first.
  waiting.catch(() => {});
  await action();
  const response = await waiting;
  assert.equal(response.status(), 200, `${method} ${path} 应成功`);
  return response.json();
}

async function assertNoHorizontalOverflow(page, label) {
  const measured = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    dialogs: [...document.querySelectorAll('dialog[open]')].map(dialog => {
      const rect = dialog.getBoundingClientRect(), shell = dialog.querySelector('.dialog-shell');
      return { left: rect.left, right: rect.right, shellWidth: shell?.clientWidth || 0, shellScrollWidth: shell?.scrollWidth || 0 };
    }),
  }));
  assert.ok(measured.document <= measured.viewport + 1, `${label} 文档不应横向溢出：${JSON.stringify(measured)}`);
  assert.ok(measured.body <= measured.viewport + 1, `${label} 页面不应横向溢出：${JSON.stringify(measured)}`);
  for (const dialog of measured.dialogs) {
    assert.ok(dialog.left >= -1 && dialog.right <= measured.viewport + 1, `${label} 弹窗应位于视口内：${JSON.stringify(measured)}`);
    assert.ok(dialog.shellScrollWidth <= dialog.shellWidth + 1, `${label} 弹窗内容不应横向溢出：${JSON.stringify(measured)}`);
  }
}

async function openSettings(page, mobile = false) {
  if (mobile) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '账号与数据设置', exact: true });
  await dialog.waitFor({ state: 'visible' });
  return dialog;
}

async function closeDialog(dialog) {
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function checkShareDialog(page) {
  const dialog = page.getByRole('dialog', { name: '我的人格卡片', exact: true });
  await dialog.waitFor();
  await dialog.locator('.persona-share-image').waitFor();
  for (const name of ['保存图片', '复制文案', '微信 / 朋友圈', '知乎 / 小红书', '更多分享']) {
    assert.equal(await dialog.getByRole('button', { name, exact: true }).isEnabled(), true);
  }
  assert.equal(await dialog.locator('.persona-options').count(), 0);
  await assertNoHorizontalOverflow(page, '人格分享弹窗');
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: '微信 / 朋友圈', exact: true }).click()]);
  assert.equal(await download.failure(), null);
  assert.match(await dialog.getByRole('status').innerText(), /请打开微信/);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__shareCopy = value; } } });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async value => { window.__sharePayload = { text: value.text, count: value.files?.length || 0 }; } });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  });
  await dialog.getByRole('button', { name: '复制文案', exact: true }).click();
  assert.match(await page.evaluate(() => window.__shareCopy), /我的知识人格是/);
  await dialog.getByRole('button', { name: '更多分享', exact: true }).click();
  await dialog.getByText('已完成系统分享操作。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__sharePayload.count), 1);
  await page.evaluate(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); });
  await dialog.getByRole('button', { name: '更多分享', exact: true }).click();
  await dialog.getByText('当前浏览器不支持系统分享，可保存图片或复制文案后分享。', { exact: true }).waitFor();
  await closeDialog(dialog);
}

function assertNoSensitiveKeys(value, trail = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/csrf|secret|(?:^|_)token$|access.?token|refresh.?token|api.?key|app.?key|password|authorization/i.test(key), `数据导出不应包含凭证字段：${trail}${key}`);
    assertNoSensitiveKeys(child, `${trail}${key}.`);
  }
}

await runBrowserSuite('profile', async ({ newContext, origin, check, artifactsDir, report, service }) => {
  const context = await newContext({ baseURL: origin });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(20000);
  let initial, created, updated;
  const artifacts = [];

  await check('新访客先进入引导，尚未创建个人资料', async () => {
    await page.goto('/#profile', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: /先认识你/ }).waitFor();
    await page.getByRole('button', { name: '手动填写兴趣', exact: true }).waitFor();
    assert.equal(await page.locator('.profile-sample-notice').count(), 0);
    initial = await bootstrap(page);
    assert.equal(initial.profile, null);
    assert.equal(initial.capabilities.ai, false);
    assert.equal(initial.capabilities.oauth, false);
    assert.equal(initial.capabilities.zhihuData, false);
    assert.equal(initial.zhihuConnected, false);
  });

  await check('画像向导限制 3–8 个兴趣，达到上限后可取消选择', async () => {
    await page.getByRole('button', { name: '手动填写兴趣', exact: true }).click();
    const wizard = page.getByRole('dialog', { name: '认识你，从好奇心开始', exact: true });
    await wizard.waitFor();
    const next = wizard.getByRole('button', { name: '继续', exact: true });
    assert.equal(await next.isDisabled(), true);
    for (const label of ['人工智能', '阅读与写作']) await wizard.getByRole('button', { name: label, exact: true }).click();
    assert.equal(await next.isDisabled(), true, '只选 2 个兴趣时不应进入下一步');
    await wizard.getByRole('button', { name: '心理学', exact: true }).click();
    assert.equal(await next.isEnabled(), true);
    const extra = ['产品设计', '哲学思辨', '编程技术', '游戏世界', '历史'];
    for (const label of extra) await wizard.getByRole('button', { name: label, exact: true }).click();
    assert.equal(await wizard.locator('.wizard-topic[aria-pressed="true"]').count(), 8);
    assert.equal(await wizard.getByRole('button', { name: '社会观察', exact: true }).isDisabled(), true);
    assert.match(await wizard.locator('.wizard-selection-count').innerText(), /8\s*\/\s*8/);
    for (const label of extra) await wizard.getByRole('button', { name: label, exact: true }).click();
    assert.equal(await wizard.locator('.wizard-topic[aria-pressed="true"]').count(), 3);
    assert.equal(await wizard.getByRole('button', { name: '社会观察', exact: true }).isEnabled(), true);
    await next.click();
    await wizard.getByRole('heading', { name: '你想怎样与世界交换想法？', exact: true }).waitFor();
  });

  await check('交流目标、文本与昵称经三步向导真实保存，规则生成正常', async () => {
    const wizard = page.getByRole('dialog', { name: '认识你，从好奇心开始', exact: true });
    const next = wizard.getByRole('button', { name: '继续', exact: true });
    await wizard.getByRole('checkbox', { name: '深度交流', exact: true }).uncheck();
    assert.equal(await next.isDisabled(), true, '至少需要一种交流期待');
    for (const label of ['深度交流', '共同学习', '合作创造']) await wizard.getByRole('checkbox', { name: label, exact: true }).check();
    await wizard.getByRole('radio', { name: /从例子出发，边做边聊/ }).check();
    await wizard.getByRole('radio', { name: /共情.*理解人与感受/ }).check();
    await wizard.getByRole('radio', { name: /深度交流.*在认真来回的对话里靠近/ }).check();
    const about = wizard.getByRole('textbox', { name: /^关于你/ });
    const questionField = wizard.getByRole('textbox', { name: /^一个你想和别人聊的问题/ });
    assert.equal(await about.getAttribute('maxlength'), '360');
    assert.equal(await questionField.getAttribute('maxlength'), '200');
    await about.fill(initialAbout);
    await questionField.fill(question);
    await next.click();
    await wizard.getByRole('heading', { name: '为你的好奇心，签个名', exact: true }).waitFor();
    const generate = wizard.getByRole('button', { name: '生成我的知识人格', exact: true });
    assert.equal(await generate.isDisabled(), true, '空昵称不应提交');
    const ai = wizard.getByRole('checkbox', { name: /使用 AI 解读兴趣/ });
    assert.equal(await ai.isDisabled(), true);
    assert.equal(await ai.isChecked(), false);
    assert.equal(await wizard.getByRole('checkbox', { name: /生成后，让伙伴发现我/ }).isChecked(), false);
    await wizard.getByRole('textbox', { name: /^你的昵称/ }).fill(`  ${initialName}  `);
    const response = await waitForMutation(page, '/profile', () => generate.click());
    assert.equal(response.profile.analysis.mode, 'rules');
    await wizard.waitFor({ state: 'hidden' });
    await checkShareDialog(page);
    await page.getByRole('button', { name: '编辑画像', exact: true }).waitFor();
    created = await bootstrap(page);
    assert.equal(created.user.id, initial.user.id);
    assert.equal(created.user.name, initialName);
    assert.equal(created.profile.input.name, initialName);
    assert.equal(created.profile.input.about, initialAbout);
    assert.equal(created.profile.input.question, question);
    assert.deepEqual(new Set(created.profile.input.topicIds), new Set(['ai', 'reading', 'psychology']));
    assert.deepEqual(new Set(created.profile.input.goals), new Set(['conversation', 'learning', 'building']));
    assert.equal(created.profile.input.styleId, 'hands-on');
    assert.equal(created.profile.input.personaDrive, 'empathy');
    assert.equal(created.profile.input.personaConnection, 'duo');
    assert.equal(created.profile.title, '深夜接话人');
    assert.equal(created.profile.revision, 1);
  });

  await check('个人页显示真实填写昵称与规则标签，初始不进入匹配池', async () => {
    assert.equal(await page.locator('.profile-persona-user strong').innerText(), initialName);
    assert.match(await page.locator('.profile-persona .source-badge').innerText(), /规则分析/);
    assert.equal(await page.locator('.profile-sample-notice').count(), 0);
    assert.equal(created.profile.discoverable, false);
    await page.locator('.profile-visibility-panel').getByRole('button', { name: '让伙伴发现我', exact: true }).waitFor();
    assert.match(await page.locator('.profile-visibility-panel').innerText(), /没有加入匹配池/);
    assert.match(await page.locator('.profile-visibility-panel').innerText(), /已建立连接的伙伴仍可查看/);
    await page.getByRole('button', { name: /^查看全部 \d+ 条依据$/ }).click();
    await page.getByText(initialAbout, { exact: true }).waitFor();
    assert.ok(await page.locator('.profile-evidence-item').count() >= 5);
    await page.getByRole('button', { name: '收起依据', exact: true }).click();
  });

  await check('个人认识只显示自己的类型，分享弹窗可再次打开', async () => {
    assert.equal(await page.locator('.persona-options button').count(), 0);
    assert.match(await page.locator('#persona-reading').innerText(), /我的人格解读/);
    assert.equal(await page.locator('.persona-analysis-grid article').count(), 6);
    assert.equal(await page.getByText('人间观察员', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '分享人格卡', exact: true }).click();
    await checkShareDialog(page);
  });

  await check('可在资料页显式加入匹配，并在设置中撤回', async () => {
    const published = await waitForMutation(page, '/profile/visibility', () => page.locator('.profile-visibility-panel').getByRole('button', { name: '让伙伴发现我', exact: true }).click());
    assert.equal(published.profile.discoverable, true);
    assert.equal(published.profile.revision, created.profile.revision);
    await page.locator('.profile-visibility-panel').getByRole('button', { name: '暂时退出匹配', exact: true }).waitFor();
    assert.equal((await bootstrap(page)).profile.discoverable, true);
    const settings = await openSettings(page);
    const visibility = settings.getByRole('switch', { name: '让伙伴发现我', exact: true });
    assert.equal(await visibility.isChecked(), true);
    const withdrawn = await waitForMutation(page, '/profile/visibility', () => visibility.click());
    assert.equal(withdrawn.profile.discoverable, false);
    await settings.getByText('暂不加入匹配', { exact: true }).waitFor();
    assert.equal((await bootstrap(page)).profile.discoverable, false);
    await closeDialog(settings);
  });

  await check('编辑保留输入，重新生成会增加版本并取消公开', async () => {
    await waitForMutation(page, '/profile/visibility', () => page.locator('.profile-visibility-panel').getByRole('button', { name: '让伙伴发现我', exact: true }).click());
    await page.locator('.profile-visibility-panel').getByRole('button', { name: '暂时退出匹配', exact: true }).waitFor();
    await page.getByRole('button', { name: '编辑画像', exact: true }).click();
    const wizard = page.getByRole('dialog', { name: '编辑我的知识人格', exact: true });
    await wizard.waitFor();
    assert.equal(await wizard.locator('.wizard-topic[aria-pressed="true"]').count(), 3);
    await wizard.getByRole('button', { name: '宇宙与天文', exact: true }).click();
    await wizard.getByRole('button', { name: '继续', exact: true }).click();
    const about = wizard.getByRole('textbox', { name: /^关于你/ });
    assert.equal(await about.inputValue(), initialAbout);
    assert.equal(await wizard.getByRole('textbox', { name: /^一个你想和别人聊的问题/ }).inputValue(), question);
    assert.equal(await wizard.getByRole('radio', { name: /从例子出发，边做边聊/ }).isChecked(), true);
    assert.equal(await wizard.getByRole('radio', { name: /共情.*理解人与感受/ }).isChecked(), true);
    assert.equal(await wizard.getByRole('radio', { name: /深度交流.*在认真来回的对话里靠近/ }).isChecked(), true);
    await wizard.getByRole('radio', { name: /创造.*把想法变成现实/ }).check();
    await wizard.getByRole('radio', { name: /独立沉淀.*先自己想一想，再分享发现/ }).check();
    await about.fill(updatedAbout);
    await wizard.getByRole('button', { name: '继续', exact: true }).click();
    assert.equal(await wizard.getByRole('textbox', { name: /^你的昵称/ }).inputValue(), initialName);
    assert.equal(await wizard.getByRole('checkbox', { name: /生成后，让伙伴发现我/ }).isChecked(), false, '编辑不能自动沿用旧公开授权');
    await wizard.getByRole('textbox', { name: /^你的昵称/ }).fill(updatedName);
    const response = await waitForMutation(page, '/profile', () => wizard.getByRole('button', { name: '更新我的画像', exact: true }).click());
    assert.equal(response.profile.discoverable, false);
    assert.equal(response.profile.revision, created.profile.revision + 1);
    await wizard.waitFor({ state: 'hidden' });
    await checkShareDialog(page);
    await page.locator('.profile-persona-user strong').filter({ hasText: updatedName }).waitFor();
    updated = await bootstrap(page);
    assert.equal(updated.profile.input.about, updatedAbout);
    assert.equal(updated.profile.input.name, updatedName);
    assert.equal(updated.profile.title, '平行宇宙设计师');
    assert.ok(updated.profile.input.topicIds.includes('space'));
    assert.equal(updated.profile.discoverable, false);
  });

  await check('刷新后昵称、画像版本与私密设置保持一致', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '编辑画像', exact: true }).waitFor();
    const persisted = await bootstrap(page);
    assert.equal(persisted.user.id, initial.user.id);
    assert.deepEqual(persisted.profile, updated.profile);
    assert.equal(await page.locator('.profile-persona-user strong').innerText(), updatedName);
    assert.equal(await page.locator('.profile-persona .source-badge').innerText(), '规则分析');
    await assertNoHorizontalOverflow(page, '1440px 资料页');
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.screenshot({ path: join(artifactsDir, 'profile-desktop.png'), fullPage: true, animations: 'disabled' });
    artifacts.push('profile-desktop.png');
  });

  await check('人格卡按钮下载有效且非空的 1600×2200 PNG', async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下载人格卡', exact: true }).click()]);
    assert.match(download.suggestedFilename(), /\.png$/i);
    assert.equal(await download.failure(), null);
    const target = join(artifactsDir, 'profile-card.png');
    await download.saveAs(target);
    const png = readFileSync(target);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(png.length > 15000, '人格卡应包含实际绘制的内容');
    assert.equal(png.readUInt32BE(16), 1600);
    assert.equal(png.readUInt32BE(20), 2200);
    report.png = { bytes: png.length, width: 1600, height: 2200, file: 'profile-card.png' };
    artifacts.push('profile-card.png');
  });

  await check('设置导出真实 JSON 资料，不包含 CSRF、会话或模型凭证', async () => {
    const settings = await openSettings(page);
    await settings.getByText('目前没有屏蔽的伙伴', { exact: true }).waitFor();
    assert.equal(await settings.getByRole('button', { name: '清除导入', exact: true }).isDisabled(), true);
    const [download] = await Promise.all([page.waitForEvent('download'), settings.getByRole('button', { name: '导出', exact: true }).click()]);
    assert.match(download.suggestedFilename(), /\.json$/i);
    assert.equal(await download.failure(), null);
    const target = join(artifactsDir, 'profile-my-data.json');
    await download.saveAs(target);
    const text = readFileSync(target, 'utf8'), value = JSON.parse(text);
    assert.equal(value.user.name, updatedName);
    assert.equal(value.profile.input.name, updatedName);
    assert.equal(value.profile.input.about, updatedAbout);
    assert.equal(value.profile.revision, updated.profile.revision);
    assert.deepEqual(value.imports.items, []);
    assert.deepEqual(value.savedIds, []);
    assertNoSensitiveKeys(value);
    assert.equal(text.includes(initial.csrf), false, 'CSRF 值不得出现在导出文件');
    for (const cookie of await context.cookies()) {
      if (cookie.httpOnly && cookie.value) assert.equal(text.includes(cookie.value), false, '应用会话值不得出现在导出文件');
    }
    artifacts.push('profile-my-data.json');
    await closeDialog(settings);
  });

  await check('未配置知乎时明确说明现状，并可继续编辑自己的兴趣', async () => {
    await page.getByRole('button', { name: /连接知乎/ }).click();
    const login = page.getByRole('dialog', { name: '连接知乎，延伸你的好奇心', exact: true });
    await login.getByText('知乎登录暂未开放', { exact: true }).waitFor();
    assert.match(await login.innerText(), /本站尚未启用知乎登录/);
    assert.equal(await login.getByRole('button', { name: '前往知乎授权', exact: true }).count(), 0);
    assert.equal(await login.locator('input').count(), 0);
    assert.doesNotMatch(await login.innerText(), /Access Secret|App Key|ZHIHU_OAUTH|api[_ -]?key/i);
    await login.getByRole('button', { name: '继续完善我的画像', exact: true }).click();
    const wizard = page.getByRole('dialog', { name: '编辑我的知识人格', exact: true });
    await wizard.waitFor();
    assert.equal(await wizard.locator('.wizard-topic[aria-pressed="true"]').count(), 4);
    await closeDialog(wizard);
  });

  for (const width of [390, 320]) {
    await check(`${width}px 手机资料页和三步弹窗可完成操作且无横向溢出`, async () => {
      const mobileContext = await newContext({ baseURL: origin, viewport: { width, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      const mobilePage = await mobileContext.newPage();
      mobilePage.setDefaultTimeout(15000);
      try {
        await mobilePage.goto('/#profile', { waitUntil: 'domcontentloaded' });
        await mobilePage.getByRole('button', { name: '手动填写兴趣', exact: true }).waitFor();
        await assertNoHorizontalOverflow(mobilePage, `${width}px 引导页`);
        await mobilePage.getByRole('button', { name: '手动填写兴趣', exact: true }).click();
        const wizard = mobilePage.getByRole('dialog', { name: '认识你，从好奇心开始', exact: true });
        for (const label of ['人工智能', '摄影', '自然与户外']) await wizard.getByRole('button', { name: label, exact: true }).click();
        await assertNoHorizontalOverflow(mobilePage, `${width}px 兴趣步骤`);
        if (width === 390) {
          await mobilePage.screenshot({ path: join(artifactsDir, 'profile-wizard-mobile.png'), animations: 'disabled' });
          artifacts.push('profile-wizard-mobile.png');
        }
        await wizard.getByRole('button', { name: '继续', exact: true }).click();
        await wizard.getByRole('textbox', { name: /^关于你/ }).fill('用照片记录散步，也用技术保存生活的好奇。');
        await wizard.getByRole('textbox', { name: /^一个你想和别人聊的问题/ }).fill('什么样的日常细节值得被认真记录？');
        await assertNoHorizontalOverflow(mobilePage, `${width}px 交流步骤`);
        await wizard.getByRole('button', { name: '继续', exact: true }).click();
        await wizard.getByRole('textbox', { name: /^你的昵称/ }).fill(`掌心的好奇 ${width}`);
        assert.equal(await wizard.getByRole('checkbox', { name: /生成后，让伙伴发现我/ }).isChecked(), false);
        await assertNoHorizontalOverflow(mobilePage, `${width}px 保存步骤`);
        await waitForMutation(mobilePage, '/profile', () => wizard.getByRole('button', { name: '生成我的知识人格', exact: true }).click());
        await wizard.waitFor({ state: 'hidden' });
        await checkShareDialog(mobilePage);
        await mobilePage.getByRole('button', { name: '编辑画像', exact: true }).waitFor();
        await assertNoHorizontalOverflow(mobilePage, `${width}px 已生成资料页`);
        assert.equal((await bootstrap(mobilePage)).profile.discoverable, false);
        await mobilePage.evaluate(async () => { await document.fonts.ready; });
        const shot = width === 390 ? 'profile-mobile.png' : 'profile-mobile-320.png';
        await mobilePage.screenshot({ path: join(artifactsDir, shot), fullPage: true, animations: 'disabled' });
        artifacts.push(shot);
        const settings = await openSettings(mobilePage, true);
        await assertNoHorizontalOverflow(mobilePage, `${width}px 设置弹窗`);
        const visibility = settings.getByRole('switch', { name: '让伙伴发现我', exact: true });
        await waitForMutation(mobilePage, '/profile/visibility', () => visibility.click());
        await settings.getByText('已加入真实参与者匹配', { exact: true }).waitFor();
        await waitForMutation(mobilePage, '/profile/visibility', () => visibility.click());
        await settings.getByText('暂不加入匹配', { exact: true }).waitFor();
        await settings.getByRole('button', { name: '删除我在同频的全部数据', exact: true }).click();
        const confirmation = settings.getByRole('textbox', { name: '请输入「删除」以确认', exact: true });
        await confirmation.fill('删除');
        assert.equal(await settings.getByRole('button', { name: '永久删除我的数据', exact: true }).isEnabled(), true);
        await assertNoHorizontalOverflow(mobilePage, `${width}px 删除确认弹窗`);
        await settings.getByRole('button', { name: '取消', exact: true }).click();
        await closeDialog(settings);
      } finally { await mobileContext.close(); }
    });
  }

  await check('删除需要填写确认，确认后清除账号与画像并进入新访客会话', async () => {
    const before = await bootstrap(page);
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: '删除我在同频的全部数据', exact: true }).click();
    const remove = settings.getByRole('button', { name: '永久删除我的数据', exact: true });
    const confirmation = settings.getByRole('textbox', { name: '请输入「删除」以确认', exact: true });
    assert.equal(await remove.isDisabled(), true);
    await confirmation.fill('保留');
    assert.equal(await remove.isDisabled(), true);
    assert.equal((await bootstrap(page)).user.id, before.user.id);
    await confirmation.fill('删除');
    assert.equal(await remove.isEnabled(), true);
    const response = await waitForMutation(page, '/account', () => remove.click(), 'DELETE');
    assert.equal(response.ok, true);
    await settings.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '手动填写兴趣', exact: true }).waitFor();
    const after = await bootstrap(page);
    assert.notEqual(after.user.id, before.user.id);
    assert.equal(after.user.provider, 'guest');
    assert.equal(after.profile, null);
    assert.equal(after.imports.count, 0);
    assert.deepEqual(after.savedIds, []);
    assert.equal(after.zhihuConnected, false);
    assert.equal(service.store.user(before.user.id), null);
    assert.equal(service.store.profile(before.user.id), null);
    assert.equal(service.store.imports(before.user.id).items.length, 0);
    await page.goto('/#profile', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '手动填写兴趣', exact: true }).waitFor();
    assert.equal(await page.locator('.onboarding-page').count(), 1);
  });

  report.artifacts = artifacts;
  await context.close();
});
