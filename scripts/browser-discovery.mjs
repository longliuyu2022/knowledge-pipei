import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runBrowserSuite } from './browser-harness.mjs';

async function completeOnboarding(page) {
  await page.getByRole('button', { name: '手动填写兴趣', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: '认识你，从好奇心开始', exact: true });
  for (const name of ['人工智能', '阅读与写作', '心理学']) await wizard.getByRole('button', { name, exact: true }).click();
  await wizard.getByRole('button', { name: '继续', exact: true }).click();
  await wizard.getByRole('button', { name: '继续', exact: true }).click();
  await wizard.getByRole('textbox', { name: /你的昵称/ }).fill('发现页访客');
  await wizard.getByRole('button', { name: '生成我的知识人格', exact: true }).click();
  const card = page.getByRole('dialog', { name: '我的人格卡片', exact: true });
  await card.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.evaluate(() => { location.hash = 'discover'; });
}

await runBrowserSuite('discovery', async ({ newContext, origin, check, artifactsDir }) => {
  const context = await newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.goto(origin); await completeOnboarding(page); await page.locator('.match-card').first().waitFor();
  await page.evaluate(() => document.fonts.ready);

  await check('桌面首页真实加载八位虚构体验伙伴与个人画像', async () => {
    assert.match(await page.title(), /同频/);
    assert.equal(await page.locator('.match-card').count(), 8);
    assert.match(await page.locator('.pool-note').textContent(), /虚构/);
    assert.match(await page.locator('.mini-profile').textContent(), /规则分析/);
    assert.equal(await page.locator('.sample-footnote').count(), 0);
    await page.screenshot({ path: resolve(artifactsDir, 'homepage-desktop.png'), fullPage: true });
  });
  await check('伙伴关键词和兴趣筛选以及空态可清除', async () => {
    await page.getByRole('button', { name: '体验伙伴', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.match-card').length === 8);
    await page.getByRole('textbox', { name: '搜索伙伴' }).fill('林屿');
    await page.waitForFunction(() => document.querySelectorAll('.match-card').length === 1);
    assert.match(await page.locator('.match-card h3').textContent(), /林屿/);
    await page.getByRole('button', { name: '清空搜索' }).click();
    await page.getByRole('combobox', { name: '筛选兴趣' }).selectOption('biology');
    assert.equal(await page.locator('.match-card').count(), 1);
    assert.match(await page.locator('.match-card h3').textContent(), /陆青禾/);
    await page.getByRole('textbox', { name: '搜索伙伴' }).fill('无此话题验证词');
    await page.getByRole('heading', { name: '还没有找到这个方向的伙伴' }).waitFor();
    await page.getByRole('button', { name: '清除筛选' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.match-card').length === 8);
  });
  await check('互补视角使用独立评分并能切回推荐', async () => {
    const response = page.waitForResponse(r => r.url().includes('/api/matches?') && r.url().includes('mode=complement'));
    await page.getByRole('button', { name: '互补视角', exact: true }).click(); await response;
    await page.waitForFunction(() => document.querySelector('.match-score>span')?.textContent === '互补指数');
    assert.equal(await page.locator('.match-card').count(), 8);
    const normal = page.waitForResponse(r => r.url().includes('/api/matches?') && r.url().includes('mode=resonance'));
    await page.getByRole('button', { name: '为你推荐', exact: true }).click(); await normal;
    await page.waitForFunction(() => document.querySelector('.match-score>span')?.textContent === '同频指数');
  });
  await check('收藏状态、收藏筛选与刷新持久化', async () => {
    await page.getByRole('button', { name: '收藏林屿', exact: true }).click();
    await page.getByRole('button', { name: '取消收藏林屿', exact: true }).waitFor();
    await page.getByRole('button', { name: '已收藏', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.match-card').length === 1);
    await page.reload(); await page.getByRole('button', { name: '取消收藏林屿', exact: true }).waitFor();
  });
  await check('详情含真实规则标注、四项评分和虚构人物边界', async () => {
    const card = page.locator('.match-card').filter({ has: page.getByRole('heading', { name: /林屿/ }) });
    await card.getByRole('button', { name: '为什么同频' }).click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor();
    await dialog.getByText('规则分析', { exact: true }).first().waitFor();
    assert.match(await dialog.textContent(), /虚构|体验人物/);
    assert.equal(await dialog.getByRole('button', { name: '发送连接邀请', exact: true }).count(), 0);
    for (const label of ['知识领域', '具体兴趣', '交流节奏', '交流期待']) await dialog.getByRole('meter', { name: label, exact: true }).waitFor();
  });
  await check('按需生成三种破冰问题，可复制且不伪造知乎原文', async () => {
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '生成破冰问题', exact: true }).click();
    await dialog.locator('.icebreaker-card').last().waitFor();
    assert.equal(await dialog.locator('.icebreaker-card').count(), 3);
    assert.equal(await dialog.getByRole('link', { name: '查看原文' }).count(), 0);
    const firstQuestion = await dialog.locator('.icebreaker-card>p').first().textContent();
    await dialog.getByRole('button', { name: '复制轻松开场' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), firstQuestion);
    await page.screenshot({ path: resolve(artifactsDir, 'match-detail-desktop.png'), fullPage: true });
    await dialog.getByRole('button', { name: '关闭弹窗' }).click();
  });
  await check('兴趣星图可筛选、缩放、重置和打开伙伴详情', async () => {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '同频星图' }).click();
    await page.locator('.star-person').first().waitFor();
    assert.equal(await page.locator('.star-person').count(), 8);
    await page.getByRole('button', { name: '放大星图' }).click();
    assert.match(await page.locator('.graph-controls').textContent(), /125%/);
    await page.getByRole('button', { name: '重置星图' }).click();
    assert.match(await page.locator('.graph-controls').textContent(), /100%/);
    await page.locator('.graph-topic-filters').getByRole('button', { name: '人工智能', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.star-person').length === 3);
    await page.locator('.graph-topic-filters').getByRole('button', { name: '全部星点' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.star-person').length === 8);
    await page.screenshot({ path: resolve(artifactsDir, 'star-map-desktop.png'), fullPage: true });
    await page.getByRole('button', { name: '查看林屿的匹配' }).click();
    await page.getByRole('dialog').waitFor(); await page.getByRole('button', { name: '关闭弹窗' }).click();
  });
  await check('真实参与者空池不填入虚构伙伴', async () => {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '发现同频' }).click();
    await page.getByRole('button', { name: '真实参与者', exact: true }).click();
    await page.getByRole('heading', { name: '第一场同频，等你开启' }).waitFor();
    assert.equal(await page.locator('.match-card').count(), 0);
  });
  for (const width of [390, 320]) {
    await check(`${width}px 手机首页、匹配弹窗和星图无横向溢出`, async () => {
      const phone = await newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      const mobile = await phone.newPage(); await mobile.goto(origin); await completeOnboarding(mobile); await mobile.locator('.match-card').first().waitFor(); await mobile.evaluate(() => document.fonts.ready);
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (width === 390) await mobile.screenshot({ path: resolve(artifactsDir, 'homepage-mobile.png'), fullPage: true });
      await mobile.locator('.match-card').first().getByRole('button', { name: '为什么同频' }).click();
      await mobile.getByRole('dialog').waitFor();
      assert.equal(await mobile.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      await mobile.getByRole('dialog').getByRole('button', { name: '关闭弹窗' }).click();
      await mobile.getByRole('navigation', { name: '快捷导航' }).getByRole('link', { name: '同频星图' }).click();
      await mobile.locator('.star-person').first().waitFor();
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await phone.close();
    });
  }
});
