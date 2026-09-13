import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runBrowserSuite } from './browser-harness.mjs';

async function eventually(job, timeout = 16000) {
  const until = Date.now() + timeout;
  let last;
  do { try { return await job(); } catch (error) { last = error; } await new Promise(done => setTimeout(done, 100)); } while (Date.now() < until);
  throw last || new Error('The browser condition did not become true.');
}

await runBrowserSuite('circles', async ({ newContext, origin, check, artifactsDir, report, service }) => {
  const contexts = await Promise.all([newContext(), newContext(), newContext()]);
  const actors = await Promise.all(contexts.map(async (context, index) => ({ context, page: await context.newPage(), name: ['林知行', '许问舟', '未加入的访客'][index], csrf: '', id: '' })));
  const [a, b, visitor] = actors;
  actors.forEach(actor => actor.page.setDefaultTimeout(16000));
  await a.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const externalRequests = [], aiRequests = [], searchRequests = [], messageRequests = [];
  for (const actor of actors) actor.context.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) externalRequests.push(url.origin + url.pathname);
    if (/\/api\/circles\/[^/]+\/ai$/.test(url.pathname) && request.method() === 'POST') aiRequests.push(request.postDataJSON());
    if (/\/api\/circles\/[^/]+\/search$/.test(url.pathname)) searchRequests.push(url.pathname);
    if (/\/api\/circles\/[^/]+\/messages$/.test(url.pathname) && request.method() === 'POST') messageRequests.push(request.postDataJSON());
  });
  async function request(actor, method, path, body, expected = 200) {
    const response = await actor.context.request.fetch(origin + '/api' + path, { method, maxRetries: 0, headers: { Origin: origin, ...(actor.csrf ? { 'X-CSRF-Token': actor.csrf } : {}) }, ...(body === undefined ? {} : { data: body }) });
    const result = await response.json();
    assert.equal(response.status(), expected, `${method} ${path}: ${result?.error?.message || response.status()}`);
    return result;
  }
  const path = id => `/circles/${encodeURIComponent(id)}`;
  const dialog = actor => actor.page.locator('dialog.cz-dialog[open]');
  const tab = (actor, name) => actor.page.getByRole('tab', { name: new RegExp(`^${name}`) });
  const composer = actor => actor.page.locator('#cz-composer-input');
  const message = (actor, text) => actor.page.locator('.cz-message').filter({ has: actor.page.locator('.cz-message-text').filter({ hasText: text }) });
  async function send(actor, text) {
    await composer(actor).fill(text);
    await actor.page.getByRole('button', { name: '发送发言', exact: true }).click();
    await eventually(async () => assert.equal(await composer(actor).inputValue(), ''));
    await eventually(async () => assert.equal(await message(actor, text).count(), 1));
  }
  async function navigate(actor, circleId) {
    await actor.page.goto(`${origin}/#circles/${circleId}`);
    await actor.page.locator('.cz-question-card').waitFor({ state: 'visible' });
  }
  async function setPhase(phase) {
    await a.page.getByLabel('新的轮次阶段', { exact: true }).selectOption(phase);
    await a.page.getByRole('button', { name: '更新阶段', exact: true }).click();
    await dialog(a).getByRole('button', { name: '确认更新', exact: true }).click();
    await eventually(async () => assert.equal((await request(a, 'GET', path(circle.id))).circle.currentRound.status, phase));
    await dialog(a).waitFor({ state: 'hidden' });
  }
  let circle, secondCircle, firstMessage, outcome, invitationId;
  const firstText = '第一次访谈要先明确观察目标，再围绕真实经历追问，避免只问假设性意见。';
  const retryText = '这条发言模拟服务端已保存，但浏览器未收到响应的情况。';
  const urlId = '18446744073709551615';
  try {
    await check('三个隔离身份，真实空小组列表，关闭模型与知乎外部调用', async () => {
      for (const actor of actors) {
        const bootstrap = await request(actor, 'GET', '/bootstrap'); actor.csrf = bootstrap.csrf; actor.id = bootstrap.user.id;
        assert.equal(bootstrap.capabilities.ai, false); assert.equal(bootstrap.capabilities.zhihuSearch, false);
        if (actor !== visitor) await request(actor, 'POST', '/profile', { revision: 0, useAI: false, input: { name: actor.name, topicIds: ['ai', 'product', 'reading'], about: '希望通过真实访谈理解人的需要，用资料和实践共同验证问题。', question: '怎样提出能推进讨论的好问题？', styleId: 'deep', goals: ['conversation', 'learning'] } });
      }
      assert.equal(new Set(actors.map(actor => actor.id)).size, 3);
      await a.page.goto(origin + '/#discover');
      await a.page.getByRole('heading', { name: '第一场讨论，等你发起', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await a.page.locator('.cz-circle-card').count(), 0);
      assert.equal(aiRequests.length, 0); assert.equal(searchRequests.length, 0);
      report.configuration = { identities: 3, database: 'temporary isolated SQLite', ai: false, zhihu: false, noSeedCircles: true };
    });

    await check('模态框键盘边界与关闭后焦点恢复', async () => {
      const trigger = a.page.getByRole('button', { name: '发起问题小组', exact: true });
      await trigger.click(); await dialog(a).waitFor({ state: 'visible' });
      for (let count = 0; count < 36; count++) {
        await a.page.keyboard.press('Tab');
        assert.equal(await a.page.evaluate(() => { const open = document.querySelector('dialog.cz-dialog[open]'); return open?.contains(document.activeElement) || (document.activeElement === document.body && !document.hasFocus()); }), true);
      }
      await a.page.keyboard.press('Escape'); await dialog(a).waitFor({ state: 'hidden' });
      await eventually(async () => assert.equal(await trigger.evaluate(element => document.activeElement === element), true));
    });

    await check('明确创建问题与目标，分别确认连接和 AI 权限，保留长知乎问题 ID', async () => {
      await a.page.getByRole('button', { name: '发起问题小组', exact: true }).click();
      await dialog(a).getByLabel('小组名称', { exact: true }).fill('用户访谈实践小组');
      await dialog(a).getByLabel('这轮要讨论的问题', { exact: true }).fill('第一次做用户访谈，如何问出真实的问题？');
      await dialog(a).getByLabel('本轮共同目标', { exact: true }).fill('共同完成一份十问访谈提纲');
      await dialog(a).getByLabel(/关联的知乎问题链接/).fill(`https://m.zhihu.com/question/${urlId}/answer/123?from=fixture`);
      assert.equal(await dialog(a).getByRole('checkbox', { name: /订阅小组提醒/ }).isChecked(), true);
      assert.equal(await dialog(a).getByRole('checkbox', { name: /允许成员向我发出连接邀请/ }).isChecked(), false);
      assert.equal(await dialog(a).getByRole('checkbox', { name: /允许外部 AI 处理/ }).isChecked(), false);
      await dialog(a).getByRole('checkbox', { name: /允许成员向我发出连接邀请/ }).check();
      await dialog(a).getByRole('button', { name: '创建小组', exact: true }).click();
      await a.page.locator('.cz-question-card').waitFor({ state: 'visible' });
      circle = (await request(a, 'GET', '/circles?mine=1')).circles[0];
      assert.equal(circle.memberCount, 1); assert.equal(circle.questionId, urlId); assert.equal(circle.questionUrl, `https://www.zhihu.com/question/${urlId}`);
      assert.equal(circle.membership.duration, '7d'); assert.equal(circle.membership.allowConnections, true); assert.equal(circle.membership.aiConsent, false); assert.equal(circle.membership.subscribed, true);
      assert.equal(circle.autoSummary, false); assert.equal(circle.membership.role, 'host');
      await send(a, firstText);
      firstMessage = (await request(a, 'GET', path(circle.id))).circle.messages.find(item => item.text === firstText);
      assert.ok(firstMessage);
    });

    await check('公开邀请只显示公开概要，不自动加入或泄露发言和成员', async () => {
      await a.page.getByRole('button', { name: '邀请伙伴', exact: true }).click();
      await dialog(a).getByRole('button', { name: '复制链接', exact: true }).click();
      const inviteLink = await a.page.evaluate(() => navigator.clipboard.readText());
      assert.equal(inviteLink, `${origin}/#circles/${circle.id}`);
      await dialog(a).getByRole('button', { name: '关闭', exact: true }).click();
      await visitor.page.goto(inviteLink); await visitor.page.getByRole('button', { name: '选择期限并加入', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await visitor.page.locator('.cz-room-main').count(), 0); assert.equal(await visitor.page.getByText(firstText, { exact: true }).count(), 0);
      const visible = (await request(visitor, 'GET', path(circle.id))).circle;
      assert.equal(visible.joined, false); assert.equal(visible.memberCount, 1);
      for (const name of ['messages', 'members', 'sources', 'outcomes', 'rounds']) assert.deepEqual(visible[name], []);
    });

    await check('按知乎问题链接检索与本地推荐不会调用外部服务', async () => {
      await visitor.page.goto(origin + '/#discover');
      await visitor.page.getByRole('textbox', { name: '搜索问题小组', exact: true }).fill(`https://www.zhihu.com/question/${urlId}/answer/222`);
      await visitor.page.getByRole('button', { name: '搜索', exact: true }).click();
      await eventually(async () => assert.equal(await visitor.page.locator('.cz-circle-card').count(), 1));
      assert.match(await visitor.page.locator('.cz-circle-card').innerText(), /用户访谈实践小组/);
      assert.equal((await request(visitor, 'GET', '/circles/recommendations?goal=用户访谈')).profileUsed, false);
      assert.equal((await request(a, 'GET', '/circles/recommendations?goal=用户访谈')).profileUsed, true);
      assert.equal(aiRequests.length, 0); assert.equal(searchRequests.length, 0);
    });

    await check('24 小时加入、关闭提醒且保持私聊与 AI 未授权，人数实时同步', async () => {
      await navigate(b, circle.id);
      await b.page.getByRole('button', { name: '选择期限并加入', exact: true }).click();
      await dialog(b).getByRole('radio', { name: /24 小时/ }).check();
      await dialog(b).getByRole('checkbox', { name: /订阅小组提醒/ }).uncheck();
      await dialog(b).getByLabel(/你希望从这轮讨论获得什么/).fill('整理第一次访谈需要避免的误区');
      await dialog(b).getByLabel(/你目前的阶段/).fill('正在准备第一次访谈');
      assert.equal((await request(b, 'GET', path(circle.id))).circle.joined, false);
      await dialog(b).getByRole('button', { name: '确认加入', exact: true }).click();
      await composer(b).waitFor({ state: 'visible' });
      const joined = (await request(b, 'GET', path(circle.id))).circle;
      assert.equal(joined.memberCount, 2); assert.equal(joined.membership.duration, '24h');
      assert.equal(joined.membership.subscribed, false); assert.equal(joined.membership.aiConsent, false); assert.equal(joined.membership.allowConnections, false);
      assert.ok(Math.abs(Date.parse(joined.membership.expiresAt) - Date.now() - 86400000) < 20000);
      await eventually(async () => assert.match(await a.page.locator('.cz-room-heading').innerText(), /2 \/ 12 位成员/));
      await message(b, firstText).waitFor({ state: 'visible' });
    });

    await check('引用回复保留原发言；按小组保存草稿，切换后不会串写', async () => {
      await message(b, firstText).getByRole('button', { name: '回复', exact: true }).click();
      await send(b, '我会先让对方讲最近一次具体经历，再追问其中的选择依据。');
      const reply = (await request(b, 'GET', path(circle.id))).circle.messages.find(item => item.authorId === b.id);
      assert.equal(reply.replyTo, firstMessage.id); assert.equal(reply.reply.authorName, a.name);
      await composer(a).fill('留在第一个小组的未发送草稿');
      secondCircle = (await request(a, 'POST', '/circles', { title: '阅读记录的方法', question: '如何把阅读后的想法整理为可验证的问题？', goal: '记录三种阅读笔记方法', duration: 'ongoing' }, 201)).circle;
      await a.page.evaluate(id => { location.hash = `#circles/${id}`; }, secondCircle.id);
      await eventually(async () => { assert.match(await a.page.locator('.cz-room-heading').innerText(), /阅读记录的方法/); assert.equal(await composer(a).inputValue(), ''); });
      await composer(a).fill('第二个小组自己的草稿');
      await a.page.evaluate(id => { location.hash = `#circles/${id}`; }, circle.id);
      await eventually(async () => assert.equal(await composer(a).inputValue(), '留在第一个小组的未发送草稿'));
      assert.equal((await request(a, 'GET', path(secondCircle.id))).circle.messages.length, 0);
    });

    await check('网络丢失响应保留草稿，重试复用发送标识且只产生一条消息', async () => {
      const matcher = `**/api/circles/${circle.id}/messages`;
      let interrupted = false;
      await a.page.route(matcher, async route => {
        if (!interrupted && route.request().method() === 'POST') { interrupted = true; await route.fetch(); await route.abort('failed'); }
        else await route.continue();
      });
      await composer(a).fill(retryText); await a.page.getByRole('button', { name: '发送发言', exact: true }).click();
      await a.page.locator('.cz-composer .cz-error').waitFor({ state: 'visible' });
      assert.equal(await composer(a).inputValue(), retryText);
      await a.page.unroute(matcher);
      await a.page.getByRole('button', { name: '发送发言', exact: true }).click();
      await eventually(async () => assert.equal(await composer(a).inputValue(), ''));
      assert.equal((await request(a, 'GET', path(circle.id))).circle.messages.filter(item => item.text === retryText).length, 1);
      const attempts = messageRequests.filter(item => item.text === retryText); assert.equal(attempts.length, 2); assert.equal(attempts[0].clientMessageId, attempts[1].clientMessageId);
    });

    await check('讨论协助只在明确操作后运行，站内摘录展示引用与待核对状态', async () => {
      assert.equal(aiRequests.length, 0);
      await a.page.getByRole('button', { name: '梳理讨论', exact: true }).click();
      assert.equal(await dialog(a).getByRole('radio', { name: /在站内整理/ }).isChecked(), true);
      await dialog(a).getByRole('button', { name: '开始整理', exact: true }).click();
      await a.page.locator('.cz-ai-message').waitFor({ state: 'visible' });
      assert.equal(aiRequests.length, 1); assert.deepEqual(aiRequests[0], { action: 'summary', useAI: false });
      assert.match(await a.page.locator('.cz-ai-message').innerText(), /站内摘录 · 待核对/);
      await a.page.locator('.cz-ai-message .cz-citations summary').click();
      assert.ok(await a.page.locator('.cz-ai-message .cz-citations blockquote').count() >= 1);
    });

    await check('资料区区分链接与成员原文摘录；知乎查询必须主动点击', async () => {
      await tab(a, '资料').click();
      await a.page.getByRole('button', { name: '添加资料', exact: true }).click();
      await dialog(a).getByLabel('资料标题', { exact: true }).fill('访谈准备资料');
      await dialog(a).getByLabel('来源链接', { exact: true }).fill('https://example.org/research-guide');
      await dialog(a).getByRole('button', { name: '添加到本轮', exact: true }).click();
      await a.page.locator('.cz-source-card').filter({ hasText: '访谈准备资料' }).waitFor({ state: 'visible' });
      await a.page.getByRole('button', { name: '添加资料', exact: true }).click();
      await dialog(a).getByLabel('资料标题', { exact: true }).fill('访谈追问原文片段');
      await dialog(a).getByLabel('来源链接', { exact: true }).fill('https://example.org/interview-notes');
      await dialog(a).getByLabel(/保存方式/).selectOption('excerpt');
      await dialog(a).getByLabel('原文摘录', { exact: true }).fill('请描述你最近一次遇到这个问题的实际过程。');
      await dialog(a).getByRole('button', { name: '添加到本轮', exact: true }).click();
      await eventually(async () => assert.equal(await a.page.locator('.cz-source-card').count(), 2));
      const sources = (await request(a, 'GET', path(circle.id))).circle.sources;
      assert.deepEqual(sources.map(source => source.scope), ['link', 'excerpt']); assert.equal(sources[0].summary, '');
      assert.equal(searchRequests.length, 0);
      await a.page.getByRole('button', { name: '搜索知乎资料', exact: true }).click();
      assert.equal(searchRequests.length, 0);
      await a.page.getByRole('textbox', { name: '知乎资料关键词', exact: true }).fill('访谈方法');
      await a.page.getByRole('button', { name: '查询知乎', exact: true }).click();
      await eventually(async () => assert.equal(searchRequests.length, 1));
      await eventually(async () => assert.equal(await a.page.getByRole('button', { name: '查询知乎', exact: true }).isEnabled(), true));
      assert.equal(externalRequests.length, 0);
    });

    await check('手工成果保留发言与资料依据，署名核对后编辑生成新的草稿版本', async () => {
      await tab(a, '成果').click(); await a.page.getByRole('button', { name: '写一份成果', exact: true }).click();
      await dialog(a).getByLabel('成果标题', { exact: true }).fill('第一次访谈的准备清单');
      await dialog(a).getByLabel('正文', { exact: true }).fill('先明确目标，再追问真实经历。保留不同意见，用实际案例核对结论。');
      await dialog(a).getByText('为成果选择依据', { exact: true }).click();
      await dialog(a).locator('.cz-reference-choices input').first().check();
      await dialog(a).getByRole('checkbox', { name: '访谈准备资料', exact: true }).check();
      await dialog(a).getByRole('button', { name: '保存为待核对', exact: true }).click();
      await a.page.locator('.cz-outcome-card').waitFor({ state: 'visible' });
      outcome = (await request(a, 'GET', path(circle.id))).circle.outcomes[0];
      assert.equal(outcome.version, 1); assert.equal(outcome.status, 'draft'); assert.equal(outcome.citations[0].messageId, firstMessage.id); assert.equal(outcome.sourceIds.length, 1);
      await a.page.getByRole('button', { name: '我已核对', exact: true }).click();
      await dialog(a).getByRole('button', { name: '确认已核对', exact: true }).click();
      await a.page.locator('.cz-review-signature').waitFor({ state: 'visible' });
      assert.match(await a.page.locator('.cz-review-signature').innerText(), /林知行.*不代表全员共识/);
      await a.page.getByRole('button', { name: '编辑', exact: true }).click();
      await dialog(a).getByLabel('正文', { exact: true }).fill('修订：先记录观察目标，再逐项询问最近一次真实经历，注意适用条件。');
      await dialog(a).getByRole('button', { name: '保存为待核对', exact: true }).click();
      await eventually(async () => { outcome = (await request(a, 'GET', path(circle.id))).circle.outcomes[0]; assert.equal(outcome.version, 3); assert.equal(outcome.status, 'draft'); });
    });

    await check('并发版本冲突保留编辑草稿，历史与 Markdown 导出体现服务端最新版本', async () => {
      await a.page.getByRole('button', { name: '编辑', exact: true }).click();
      const localDraft = '我的本地编辑草稿仍需合并，不能直接覆盖另一位成员的新版本。';
      await dialog(a).getByLabel('正文', { exact: true }).fill(localDraft);
      outcome = (await request(b, 'PATCH', `${path(circle.id)}/outcomes/${outcome.id}`, { version: outcome.version, content: '另一位成员补充：先确认受访者经历，再记录适用条件和未解决的问题。' })).outcome;
      await dialog(a).getByRole('button', { name: '保存为待核对', exact: true }).click();
      await dialog(a).locator('.cz-error').waitFor({ state: 'visible' });
      assert.equal(await dialog(a).getByLabel('正文', { exact: true }).inputValue(), localDraft);
      assert.equal((await request(a, 'GET', path(circle.id))).circle.outcomes[0].version, 4);
      await dialog(a).getByRole('button', { name: '取消', exact: true }).click();
      await eventually(async () => assert.match(await a.page.locator('.cz-outcome-content').innerText(), /另一位成员补充/));
      await a.page.getByRole('button', { name: '版本记录', exact: true }).click();
      await eventually(async () => assert.equal(await dialog(a).locator('.cz-version').count(), 4));
      await dialog(a).getByRole('button', { name: '关闭', exact: true }).click();
      const downloadPromise = a.page.waitForEvent('download');
      await a.page.getByRole('button', { name: '导出', exact: true }).click();
      const download = await downloadPromise, markdown = await readFile(await download.path(), 'utf8');
      assert.match(markdown, /另一位成员补充/); assert.match(markdown, /版本：4/); assert.match(markdown, /仅链接/); assert.match(markdown, /访谈准备资料/); assert.equal(markdown.includes(localDraft), false);
    });

    await check('双方分别开放连接后发邀请；待确认邀请不打开私聊', async () => {
      await tab(a, '成员').click();
      const memberCard = a.page.locator('.cz-member-card').filter({ hasText: b.name });
      assert.equal(await memberCard.getByRole('button', { name: '邀请连接', exact: true }).isDisabled(), true);
      await b.page.getByRole('button', { name: '参与设置', exact: true }).click();
      const expiry = (await request(b, 'GET', path(circle.id))).circle.membership.expiresAt;
      await dialog(b).getByRole('checkbox', { name: /允许成员向我发出连接邀请/ }).check();
      await dialog(b).getByRole('button', { name: '保存设置', exact: true }).click();
      await eventually(async () => assert.equal(await memberCard.getByRole('button', { name: '邀请连接', exact: true }).isEnabled(), true));
      assert.equal((await request(b, 'GET', path(circle.id))).circle.membership.expiresAt, expiry);
      await memberCard.getByRole('button', { name: '邀请连接', exact: true }).click();
      await dialog(a).getByLabel('邀请留言', { exact: true }).fill('想继续讨论访谈中的追问方法，需要你确认这次连接。');
      await dialog(a).getByRole('button', { name: '发送邀请', exact: true }).click();
      await dialog(a).waitFor({ state: 'hidden' });
      assert.match(new URL(a.page.url()).hash, new RegExp(`^#circles/${circle.id}$`));
      const pending = (await request(a, 'GET', '/connections')).invitations.find(item => item.status === 'pending');
      assert.ok(pending); invitationId = pending.id;
      await request(a, 'GET', `/conversations/${invitationId}`, undefined, 404);
      await request(b, 'POST', `/invitations/${invitationId}/respond`, { action: 'accept' });
      const accepted = await request(a, 'GET', `/conversations/${invitationId}`);
      assert.equal(accepted.person.id, b.id); assert.deepEqual(accepted.items, []);
    });

    await check('举报可由主持处理；隐藏依据后成果、版本入口和导出同步收起', async () => {
      await tab(b, '讨论').click();
      await message(b, firstText).locator('.cz-message-menu summary').click();
      await message(b, firstText).getByRole('button', { name: '举报', exact: true }).click();
      await dialog(b).getByLabel('请说明原因', { exact: true }).fill('这条发言的适用条件需要核对，请主持检查引用依据。');
      await dialog(b).getByRole('button', { name: '提交举报', exact: true }).click();
      await dialog(b).waitFor({ state: 'hidden' });
      await a.page.getByRole('button', { name: '处理举报', exact: true }).click();
      await dialog(a).locator('.cz-report-card').waitFor({ state: 'visible' });
      await dialog(a).getByRole('button', { name: '隐藏发言', exact: true }).click();
      await eventually(async () => assert.match(await dialog(a).locator('.cz-report-card').innerText(), /已隐藏发言/));
      await dialog(a).getByRole('button', { name: '关闭', exact: true }).click();
      await tab(a, '成果').click();
      await eventually(async () => assert.match(await a.page.locator('.cz-outcome-card').innerText(), /需重新整理/));
      assert.equal(await a.page.getByRole('button', { name: '版本记录', exact: true }).count(), 0); assert.equal(await a.page.getByRole('button', { name: '导出', exact: true }).count(), 0); assert.equal(await a.page.getByText(outcome.content, { exact: true }).count(), 0);
    });

    await check('屏蔽成员移除可见发言并阻断连接，支持取消屏蔽', async () => {
      await tab(a, '成员').click(); const card = a.page.locator('.cz-member-card').filter({ hasText: b.name });
      await card.getByRole('button', { name: '屏蔽', exact: true }).click(); await dialog(a).getByRole('button', { name: '确认屏蔽', exact: true }).click();
      await card.getByRole('button', { name: '取消屏蔽', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await card.getByRole('button', { name: '邀请连接', exact: true }).isDisabled(), true);
      await tab(a, '讨论').click();
      assert.equal(await message(a, '我会先让对方讲最近一次具体经历').count(), 0);
      await tab(a, '成员').click(); await card.getByRole('button', { name: '取消屏蔽', exact: true }).click(); await dialog(a).getByRole('button', { name: '取消屏蔽', exact: true }).click();
      await card.getByRole('button', { name: '屏蔽', exact: true }).waitFor({ state: 'visible' });
    });

    await check('按阶段完成后开启新轮，历史轮次只读且保留原问题', async () => {
      await tab(a, '讨论').click(); await composer(a).fill('第一轮留下但未发送的草稿');
      await setPhase('reviewing'); await setPhase('completed');
      await eventually(async () => assert.equal(await composer(a).count(), 0));
      await a.page.getByRole('button', { name: '开启新一轮', exact: true }).click();
      await dialog(a).getByLabel('这一轮的问题', { exact: true }).fill('如何通过三次访谈验证我们最初的假设？');
      await dialog(a).getByLabel('这一轮的目标', { exact: true }).fill('整理验证结果和下一步计划');
      await dialog(a).getByRole('button', { name: '开启新一轮', exact: true }).click();
      await eventually(async () => assert.equal(await composer(a).inputValue(), ''));
      const current = (await request(a, 'GET', path(circle.id))).circle;
      assert.equal(current.currentRound.number, 2); assert.equal(current.messages.length, 0);
      await a.page.getByRole('combobox', { name: '查看讨论轮次', exact: true }).selectOption(circle.currentRound.id);
      await eventually(async () => { assert.equal(await composer(a).count(), 0); assert.match(await a.page.locator('.cz-question-card').innerText(), /第一次做用户访谈/); });
      await a.page.getByRole('button', { name: '回到当前轮次', exact: true }).click(); await composer(a).waitFor({ state: 'visible' });
      assert.match(await a.page.locator('.cz-question-card').innerText(), /三次访谈验证/);
    });

    await check('390 与 320 像素下内容不横溢，模态框可操作，桌面保留截图', async () => {
      await a.page.screenshot({ path: resolve(artifactsDir, 'circles-desktop.png'), fullPage: true });
      for (const width of [390, 320]) {
        await a.page.setViewportSize({ width, height: 844 });
        for (const section of ['讨论', '资料', '成果', '成员']) {
          await tab(a, section).click();
          assert.equal(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${width}px ${section} should fit the viewport`);
        }
        await a.page.getByRole('button', { name: '参与设置', exact: true }).click();
        assert.equal(await dialog(a).evaluate(element => element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= innerWidth), true);
        await dialog(a).getByRole('button', { name: '取消', exact: true }).click();
        await tab(a, '讨论').click();
        await a.page.screenshot({ path: resolve(artifactsDir, `circles-mobile-${width}.png`), fullPage: true });
      }
      await a.page.setViewportSize({ width: 1440, height: 1000 });
    });

    await check('主动退出立即撤去成员内容与提醒；有效期到期也回到公开介绍', async () => {
      await b.page.getByRole('button', { name: '退出小组', exact: true }).click(); await dialog(b).getByRole('button', { name: '确认退出', exact: true }).click();
      await b.page.getByRole('button', { name: '选择期限并加入', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await b.page.locator('.cz-room-main').count(), 0);
      const left = (await request(b, 'GET', path(circle.id))).circle; assert.equal(left.membership, null); assert.equal(left.memberCount, 1); assert.deepEqual(left.messages, []);
      await navigate(a, secondCircle.id);
      service.store.db.prepare('UPDATE circle_memberships SET expires_at=? WHERE circle_id=? AND user_id=?').run(Date.now() + 2200, secondCircle.id, a.id);
      await a.page.reload(); await composer(a).waitFor({ state: 'visible' });
      await a.page.getByRole('button', { name: '选择期限并加入', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await a.page.locator('.cz-room-main').count(), 0); assert.equal((await request(a, 'GET', path(secondCircle.id))).circle.joined, false);
      assert.equal(externalRequests.length, 0);
    });
  } finally { await Promise.all(contexts.map(context => context.close().catch(() => {}))); }
});
