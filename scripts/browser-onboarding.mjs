import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runBrowserSuite } from './browser-harness.mjs';

await runBrowserSuite('onboarding', async ({ newContext, origin, check, artifactsDir }) => {
  for (const width of [1440, 390]) {
    const context = await newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await check(`${width}px 新访客先选择接入或填写，取消后仍回到入口`, async () => {
      await page.goto(`${origin}/#profile`);
      await page.getByRole('button', { name: '接入知乎', exact: true }).click();
      const login = page.getByRole('dialog');
      await login.getByText('知乎登录暂未开放', { exact: true }).waitFor();
      await login.getByRole('button', { name: '关闭弹窗' }).click();
      assert.equal(await page.locator('.mini-profile').count(), 0);
      await page.getByRole('button', { name: '手动填写兴趣' }).click();
      await page.getByRole('button', { name: '稍后再说' }).click();
      await page.getByRole('button', { name: '手动填写兴趣' }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(artifactsDir, `onboarding-${width}.png`), fullPage: true });
    });
    await check(`${width}px 填写确认后自动弹出人格卡，刷新后保留画像`, async () => {
      await page.getByRole('button', { name: '手动填写兴趣' }).click();
      const wizard = page.getByRole('dialog');
      for (const name of ['人工智能', '阅读与写作', '心理学']) await wizard.getByRole('button', { name, exact: true }).click();
      await wizard.getByRole('button', { name: '继续', exact: true }).click();
      await wizard.getByRole('button', { name: '继续', exact: true }).click();
      await wizard.getByRole('textbox', { name: /你的昵称/ }).fill('好奇的朋友');
      await wizard.getByRole('button', { name: '生成我的知识人格', exact: true }).click();
      const card = page.getByRole('dialog', { name: '我的人格卡片', exact: true });
      await card.locator('.persona-share-image').waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(artifactsDir, `onboarding-card-${width}.png`), fullPage: true });
      await card.getByRole('button', { name: '关闭弹窗' }).click();
      await page.reload();
      await page.locator('.app-shell').waitFor();
      assert.equal(await page.locator('.onboarding-page').count(), 0);
    });
    await context.close();
  }
});
