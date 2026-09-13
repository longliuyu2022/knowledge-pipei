import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runBrowserSuite } from './browser-harness.mjs';

async function eventually(job, timeout = 18000) {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try { return await job(); }
    catch (error) { lastError = error; }
    await new Promise(done => setTimeout(done, 120));
  } while (Date.now() < deadline);
  throw lastError || new Error('Condition did not become true before the deadline.');
}

async function within(promise, label, timeout = 18000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish before the deadline.`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

await runBrowserSuite('connections', async ({ newContext, origin, check, artifactsDir, report, service }) => {
  const contexts = await Promise.all([newContext(), newContext(), newContext()]);
  const [contextA, contextB, contextC] = contexts;
  const [pageA, pageB, pageC] = await Promise.all(contexts.map(context => context.newPage()));
  for (const page of [pageA, pageB, pageC]) page.setDefaultTimeout(18000);
  await contextA.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const externalRequests = [], iceRequests = [], messageRequests = [], conversationContextRequests = [];
  for (const context of contexts) {
    context.on('request', request => {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) externalRequests.push(url.origin + url.pathname);
    });
  }
  pageA.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && /^\/api\/conversations\/[^/]+\/context$/.test(path)) conversationContextRequests.push(path);
    if (request.method() !== 'POST') return;
    if (path.endsWith('/icebreakers')) iceRequests.push(path);
    if (/\/api\/conversations\/[^/]+\/messages$/.test(path)) messageRequests.push(request.postDataJSON());
  });

  async function request(actor, method, path, body, status = 200) {
    const response = await actor.context.request.fetch(origin + '/api' + path, {
      method,
      maxRetries: method === 'GET' ? 1 : 0,
      headers: { Origin: origin, ...(actor.csrf ? { 'X-CSRF-Token': actor.csrf } : {}) },
      ...(body === undefined ? {} : { data: body }),
    });
    const result = await response.json();
    assert.equal(response.status(), status, `${method} ${path}: ${result?.error?.message || 'unexpected status'}`);
    return result;
  }

  const actorA = { context: contextA, page: pageA, name: '林清和', csrf: '', id: '', profile: null };
  const actorB = { context: contextB, page: pageB, name: '许知遥', csrf: '', id: '', profile: null };
  const actorC = { context: contextC, page: pageC, name: '程见山', csrf: '', id: '', profile: null };
  const connectionMessages = id => `/conversations/${encodeURIComponent(id)}`;
  const sendButton = page => page.locator('.conversation-composer').getByRole('button', { name: '发送', exact: true });
  const composer = page => page.locator('.conversation-composer textarea');
  const renderedMessages = page => page.locator('.conversation-message-content > p');
  const tabs = (page, label) => page.getByRole('tab', { name: new RegExp(label) });
  const messageWithText = (page, text) => renderedMessages(page).filter({ hasText: text });
  const starter = page => page.getByTestId('conversation-starter');
  const starterQuestions = page => page.getByTestId('conversation-starter-question');
  const starterTexts = page => starterQuestions(page).locator('span:nth-child(2)').allTextContents();
  const chatIceRequests = () => iceRequests.filter(path => path.startsWith('/api/conversations/'));
  let conversationId = '', declinedId = '';

  async function openPartner(actor, partner) {
    const card = actor.page.locator('.match-card').filter({ hasText: partner.name });
    await card.waitFor({ state: 'visible' });
    await card.getByRole('button', { name: '为什么同频', exact: true }).click();
    const dialog = actor.page.getByRole('dialog');
    await dialog.getByRole('heading', { name: partner.name, exact: true }).waitFor({ state: 'visible' });
    return dialog;
  }

  async function openConversation(actor, partner) {
    await tabs(actor.page, '我的对话').click();
    const item = actor.page.locator('.conversation-list-item').filter({ hasText: partner.name });
    await item.waitFor({ state: 'visible' });
    await item.click();
    await actor.page.locator('.conversation-origin').waitFor({ state: 'visible' });
  }

  async function sendThroughUI(actor, text) {
    await composer(actor.page).fill(text);
    await sendButton(actor.page).click();
    await eventually(async () => assert.equal(await messageWithText(actor.page, text).count(), 1));
    await eventually(async () => assert.equal(await composer(actor.page).inputValue(), ''));
  }

  async function expandStarter(page) {
    await starter(page).waitFor({ state: 'visible' });
    const toggle = page.getByTestId('conversation-starter-toggle');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await starterQuestions(page).first().waitFor({ state: 'visible' });
  }

  try {
    await check('三个独立浏览器身份，隔离 SQLite 且模型与知乎外部能力关闭', async () => {
      for (const actor of [actorA, actorB, actorC]) {
        const bootstrap = await request(actor, 'GET', '/bootstrap');
        actor.csrf = bootstrap.csrf; actor.id = bootstrap.user.id;
        assert.equal(bootstrap.profile, null);
        assert.equal(bootstrap.capabilities.ai, false);
        assert.equal(bootstrap.capabilities.embedding, false);
        assert.equal(bootstrap.capabilities.oauth, false);
        assert.equal(bootstrap.capabilities.zhihuSearch, false);
        const input = actor === actorA ? {
          name: actor.name, topicIds: ['ai', 'psychology', 'reading', 'philosophy', 'product'],
          about: '在技术与日常的交界处寻找好问题，想一起讨论有温度的产品。',
          question: 'AI 帮我们做选择时，怎样把最终决定留给人？',
          styleId: 'deep', goals: ['conversation', 'learning'],
        } : actor === actorB ? {
          name: actor.name, topicIds: ['ai', 'product', 'reading', 'design', 'photography'],
          about: '喜欢研究人如何与技术相处，也在摄影和阅读中收集新的灵感。',
          question: '解释一个决定，应该帮助人理解，还是帮助人做出选择？',
          styleId: 'deep', goals: ['conversation', 'learning'],
        } : {
          name: actor.name, topicIds: ['nature', 'space', 'sports'],
          about: '喜欢沿着山路看星星，记录每次徒步遇见的风景。',
          question: '你最近在哪片山野看到了星空？',
          styleId: 'hands-on', goals: ['building', 'learning'],
        };
        actor.profile = (await request(actor, 'POST', '/profile', { input, revision: 0, useAI: false })).profile;
        assert.equal(actor.profile.discoverable, false);
        assert.equal(actor.profile.analysis.mode, 'rules');
      }
      assert.equal(new Set([actorA.id, actorB.id, actorC.id]).size, 3);
      report.configuration = { identities: 3, database: 'temporary isolated SQLite', ai: false, embedding: false, zhihu: false };
    });

    await check('未公开画像互不可见；真实匹配页不混入体验人物', async () => {
      for (const [actor, partner] of [[actorA, actorB], [actorB, actorA]]) {
        assert.equal((await request(actor, 'GET', '/matches?pool=people')).matches.length, 0);
        await request(actor, 'GET', `/people/${partner.id}`, undefined, 404);
      }
      await Promise.all([pageA.goto(origin + '/#discover'), pageB.goto(origin + '/#connections')]);
      await pageA.getByRole('button', { name: '真实参与者', exact: true }).click();
      await pageA.getByRole('heading', { name: '第一场同频，等你开启', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await pageA.locator('.match-card').count(), 0);
      await tabs(pageB, '连接邀请').click();
    });

    await check('伙伴明确公开后由 SSE 出现在真实匹配；我的画像仍保持私密', async () => {
      await request(actorB, 'POST', '/profile/visibility', { discoverable: true, revision: actorB.profile.revision });
      await pageA.locator('.match-card').filter({ hasText: actorB.name }).waitFor({ state: 'visible' });
      assert.equal(await pageA.locator('.match-card').count(), 1);
      assert.equal((await request(actorA, 'GET', '/bootstrap')).profile.discoverable, false);
      assert.equal((await request(actorB, 'GET', '/matches?pool=people')).matches.length, 0);
    });

    await check('真实伙伴详情、规则来源、四项评分与雷达；破冰仅在点击后生成', async () => {
      const dialog = await openPartner(actorA, actorB);
      await eventually(async () => assert.equal(await dialog.locator('.match-explain-loading').count(), 0));
      assert.equal(await dialog.locator('.match-reasons > li').count(), 3);
      assert.equal(await dialog.getByRole('meter').count(), 4);
      assert.equal(await dialog.locator('.match-radar-panel .radar').count(), 1);
      assert.match(await dialog.locator('.match-score-note').innerText(), /不代表关系成功概率/);
      assert.match(await dialog.locator('.match-explanation .source-badge').innerText(), /规则分析/);
      assert.equal(await dialog.locator('.source-ai').count(), 0);
      assert.equal(iceRequests.length, 0);
      await dialog.getByRole('button', { name: '生成破冰问题', exact: true }).click();
      await eventually(async () => assert.equal(await dialog.locator('.icebreaker-card').count(), 3));
      assert.equal(iceRequests.length, 1);
      assert.match(await dialog.locator('.match-icebreakers').innerText(), /知乎参考内容尚未接入/);
      assert.equal(await dialog.locator('.icebreaker-source').count(), 0);
      const question = await dialog.locator('.icebreaker-card > p').first().innerText();
      await dialog.getByRole('button', { name: '复制轻松开场', exact: true }).click();
      assert.equal(await pageA.evaluate(() => navigator.clipboard.readText()), question);
      assert.equal((await request(actorA, 'GET', '/bootstrap')).profile.discoverable, false);
      await dialog.getByRole('button', { name: '收藏这位伙伴', exact: true }).click();
      await eventually(async () => assert.ok((await request(actorA, 'GET', '/bootstrap')).savedIds.includes(actorB.id)));
    });

    await check('明确点击加入匹配并发送邀请才公开本人；收件人实时收到真实邀请', async () => {
      const dialog = pageA.getByRole('dialog');
      const invitationText = '想和你聊聊：AI 产品如何保留人的独立判断？';
      await dialog.getByLabel(`你想和 ${actorB.name} 聊什么？`).fill(invitationText);
      await dialog.getByRole('button', { name: '加入匹配并发送邀请', exact: true }).click();
      await dialog.getByRole('heading', { name: '邀请已发出，等待对方接受', exact: true }).waitFor({ state: 'visible' });
      assert.equal((await request(actorA, 'GET', '/bootstrap')).profile.discoverable, true);
      assert.ok((await request(actorB, 'GET', '/matches?pool=people')).matches.some(item => item.id === actorA.id));
      const sent = (await request(actorA, 'GET', '/connections')).invitations;
      assert.equal(sent.length, 1); assert.equal(sent[0].message, invitationText); assert.equal(sent[0].status, 'pending');
      declinedId = sent[0].id;
      await request(actorA, 'GET', connectionMessages(declinedId), undefined, 404);
      await request(actorA, 'GET', `${connectionMessages(declinedId)}/context`, undefined, 404);
      await request(actorA, 'POST', `${connectionMessages(declinedId)}/icebreakers`, {}, 404);
      assert.equal(await starter(pageA).count(), 0); assert.equal(await starter(pageB).count(), 0);
      await pageB.locator('.connection-invitation-card').filter({ hasText: invitationText }).waitFor({ state: 'visible' });
      assert.equal(await pageB.locator('.connection-invitation-card').count(), 1);
      await dialog.getByRole('button', { name: '查看我的连接', exact: true }).click();
      await tabs(pageA, '收藏的伙伴').click();
      await pageA.locator('.connections-saved-grid .match-card').filter({ hasText: actorB.name }).waitFor({ state: 'visible' });
      await tabs(pageA, '连接邀请').click();
      await pageA.locator('.connection-invitation-card').waitFor({ state: 'visible' });
    });

    await check('婉拒邀请后双方待处理列表同步移除，未产生可访问的对话', async () => {
      await pageB.locator('.connection-invitation-card').getByRole('button', { name: '婉拒', exact: true }).click();
      await eventually(async () => assert.equal(await pageA.locator('.connection-invitation-card').count(), 0));
      await eventually(async () => assert.equal(await pageB.locator('.connection-invitation-card').count(), 0));
      for (const actor of [actorA, actorB]) {
        assert.equal((await request(actor, 'GET', '/connections')).invitations.length, 0);
        await request(actor, 'GET', connectionMessages(declinedId), undefined, 404);
      }
    });

    await check('再次邀请并由另一身份接受；双方通过 SSE 获得空白真实会话', async () => {
      await pageA.getByRole('button', { name: '发现真实伙伴', exact: true }).click();
      assert.equal(await pageA.getByRole('button', { name: '真实参与者', exact: true }).getAttribute('aria-pressed'), 'true');
      const dialog = await openPartner(actorA, actorB);
      const invitationText = '这次想从一个具体例子出发，一起聊聊有温度的 AI 产品。';
      await dialog.getByLabel(`你想和 ${actorB.name} 聊什么？`).fill(invitationText);
      await dialog.getByRole('button', { name: '发送连接邀请', exact: true }).click();
      await dialog.getByRole('heading', { name: '邀请已发出，等待对方接受', exact: true }).waitFor({ state: 'visible' });
      conversationId = (await request(actorA, 'GET', '/connections')).invitations[0].id;
      assert.notEqual(conversationId, declinedId);
      await dialog.getByRole('button', { name: '查看我的连接', exact: true }).click();
      await tabs(pageA, '我的对话').click();
      const incoming = pageB.locator('.connection-invitation-card').filter({ hasText: invitationText });
      await incoming.waitFor({ state: 'visible' });
      await incoming.getByRole('button', { name: '接受邀请', exact: true }).click();
      await pageB.locator('.conversation-origin').waitFor({ state: 'visible' });
      await pageA.locator('.conversation-list-item').filter({ hasText: actorB.name }).waitFor({ state: 'visible' });
      await openConversation(actorA, actorB);
      for (const actor of [actorA, actorB]) {
        assert.equal(await renderedMessages(actor.page).count(), 0);
        assert.equal((await request(actor, 'GET', connectionMessages(conversationId))).items.length, 0);
        assert.match(await actor.page.locator('.conversation-origin').innerText(), /这次想从一个具体例子出发/);
      }
    });

    await check('已建立聊天自动展示真实共同兴趣和三条本地话题，无关身份不可读取且不自动请求 AI', async () => {
      for (const [actor, partner] of [[actorA, actorB], [actorB, actorA]]) {
        await expandStarter(actor.page);
        const data = await request(actor, 'GET', `${connectionMessages(conversationId)}/context`);
        const expected = actor.profile.interests.filter(topic => partner.profile.interests.some(value => value.id === topic.id)).map(topic => topic.id).sort();
        assert.equal(data.mode, 'rules'); assert.equal(data.questions.length, 3); assert.equal(data.reasons.length, 3);
        assert.deepEqual(data.shared.map(topic => topic.id).sort(), expected);
        assert.equal(await starterQuestions(actor.page).count(), 3);
        assert.deepEqual(await starterTexts(actor.page), data.questions);
        const displayed = await actor.page.getByTestId('conversation-starter-shared').locator('[data-topic-id]').evaluateAll(items => items.map(item => item.getAttribute('data-topic-id')));
        assert.deepEqual(displayed.sort(), expected);
        assert.equal(await starter(actor.page).getAttribute('data-conversation-id'), conversationId);
      }
      assert.ok(conversationContextRequests.length >= 1); assert.equal(chatIceRequests().length, 0);
      await request(actorC, 'GET', `${connectionMessages(conversationId)}/context`, undefined, 404);
      await request(actorC, 'POST', `${connectionMessages(conversationId)}/icebreakers`, {}, 404);
      await pageC.goto(origin + '/#connections'); await tabs(pageC, '我的对话').click();
      assert.equal(await starter(pageC).count(), 0);
      assert.equal((await request(actorA, 'GET', connectionMessages(conversationId))).items.length, 0);
      await pageA.screenshot({ path: resolve(artifactsDir, 'conversation-starter-desktop.png'), fullPage: true });
    });

    await check('点击话题只追加草稿并聚焦，保留原文；达到 2000 字时整条拒绝且不自动发消息', async () => {
      const questions = await starterTexts(pageA);
      await composer(pageA).fill('我原本想先分享一个观察。');
      await starterQuestions(pageA).first().click();
      const appended = '我原本想先分享一个观察。\n\n' + questions[0];
      await eventually(async () => assert.equal(await composer(pageA).inputValue(), appended));
      await eventually(async () => assert.equal(await composer(pageA).evaluate(element => element === document.activeElement), true));
      assert.equal(await pageA.getByTestId('conversation-starter-toggle').getAttribute('aria-expanded'), 'false');
      assert.match(await pageA.getByTestId('conversation-starter-notice').innerText(), /已加入草稿/);
      await expandStarter(pageA); await starterQuestions(pageA).nth(1).click();
      assert.equal(await composer(pageA).inputValue(), appended + '\n\n' + questions[1]);
      const fullDraft = '稿'.repeat(1999);
      await composer(pageA).fill(fullDraft); await expandStarter(pageA); await starterQuestions(pageA).first().click();
      assert.equal(await composer(pageA).inputValue(), fullDraft);
      assert.match(await pageA.getByTestId('conversation-starter-notice').innerText(), /2000/);
      assert.equal(messageRequests.length, 0); assert.equal(chatIceRequests().length, 0);
      assert.equal((await request(actorA, 'GET', connectionMessages(conversationId))).items.length, 0);
      await composer(pageA).fill('');
    });

    await check('话题读取与生成失败不阻塞输入，手动重试才请求更多灵感并保留草稿', async () => {
      const contextPattern = `**/api/conversations/${conversationId}/context`;
      let failContext = true;
      const contextHandler = async route => {
        if (failContext) { failContext = false; await route.abort('failed'); }
        else await route.continue();
      };
      await pageA.route(contextPattern, contextHandler);
      try {
        await tabs(pageA, '收藏的伙伴').click(); await tabs(pageA, '我的对话').click();
        await pageA.getByTestId('conversation-starter-error').waitFor({ state: 'visible' });
        assert.equal(await composer(pageA).isEnabled(), true);
        await composer(pageA).fill('这段草稿要在话题重试后继续保留。');
        await pageA.getByTestId('conversation-starter-retry').click(); await expandStarter(pageA);
        assert.equal(await composer(pageA).inputValue(), '这段草稿要在话题重试后继续保留。');
      } finally { await pageA.unroute(contextPattern, contextHandler); }
      const originalQuestions = await starterTexts(pageA);
      const icePattern = `**/api/conversations/${conversationId}/icebreakers`;
      const failGeneration = route => route.abort('failed');
      await pageA.route(icePattern, failGeneration);
      try {
        await pageA.getByTestId('conversation-starter-generate').click();
        await pageA.getByTestId('conversation-starter-generation-error').waitFor({ state: 'visible' });
        assert.deepEqual(await starterTexts(pageA), originalQuestions);
        assert.equal(await composer(pageA).isEnabled(), true);
        assert.equal(await composer(pageA).inputValue(), '这段草稿要在话题重试后继续保留。');
      } finally { await pageA.unroute(icePattern, failGeneration); }
      const response = pageA.waitForResponse(value => new URL(value.url()).pathname === `/api/conversations/${conversationId}/icebreakers`);
      await pageA.getByTestId('conversation-starter-generate').click();
      const result = await response; assert.equal(result.status(), 200);
      const generated = await result.json(); assert.equal(generated.mode, 'rules'); assert.equal(generated.questions.length, 3);
      await eventually(async () => assert.deepEqual(await starterTexts(pageA), generated.questions));
      assert.equal(await starter(pageA).getAttribute('data-mode'), 'rules');
      assert.equal(await composer(pageA).inputValue(), '这段草稿要在话题重试后继续保留。');
      assert.equal(chatIceRequests().length, 2); assert.equal(messageRequests.length, 0);
      assert.equal((await request(actorA, 'GET', connectionMessages(conversationId))).items.length, 0);
    });

    await check('切换真实会话取消旧灵感请求，空共同兴趣不冒充重合，两段草稿与上下文保持独立', async () => {
      const secondId = service.store.connectPairing(randomUUID(), actorA.id, actorC.id, actorA.profile.revision, actorC.profile.revision);
      await pageA.getByRole('button', { name: '刷新我的连接', exact: true }).click();
      await pageA.locator('.conversation-list-item').filter({ hasText: actorC.name }).waitFor({ state: 'visible' });
      await expandStarter(pageA);
      const draftAB = '留给许知遥的草稿。', draftAC = '留给程见山的草稿。';
      await composer(pageA).fill(draftAB);
      const pattern = `**/api/conversations/${conversationId}/icebreakers`;
      let releaseResponse, markLanded, markReleased;
      const release = new Promise(done => { releaseResponse = done; });
      const landed = new Promise(done => { markLanded = done; });
      const released = new Promise(done => { markReleased = done; });
      const handler = async route => {
        const response = await route.fetch(); assert.equal(response.status(), 200); markLanded();
        await release;
        try { await route.fulfill({ response }); } catch { /* The old conversation intentionally aborts this browser request. */ }
        finally { markReleased(); }
      };
      await pageA.route(pattern, handler);
      try {
        const before = chatIceRequests().length;
        await pageA.getByTestId('conversation-starter-generate').evaluate(button => { button.click(); button.click(); });
        await within(landed, 'Delayed conversation inspiration');
        assert.equal(chatIceRequests().length, before + 1);
        await pageA.locator('.conversation-list-item').filter({ hasText: actorC.name }).click();
        await expandStarter(pageA);
        const otherContext = await request(actorA, 'GET', `${connectionMessages(secondId)}/context`);
        assert.deepEqual(otherContext.shared, []); assert.equal(otherContext.questions.length, 3);
        assert.equal(await starter(pageA).getAttribute('data-conversation-id'), secondId);
        assert.deepEqual(await starterTexts(pageA), otherContext.questions);
        assert.match(await pageA.getByTestId('conversation-starter-shared').innerText(), /暂未重合/);
        assert.equal(await composer(pageA).inputValue(), ''); await composer(pageA).fill(draftAC);
        releaseResponse(); await within(released, 'Cancelled conversation inspiration cleanup');
        assert.equal(await starter(pageA).getAttribute('data-conversation-id'), secondId);
        assert.deepEqual(await starterTexts(pageA), otherContext.questions);
        assert.equal(await composer(pageA).inputValue(), draftAC);
        await openConversation(actorA, actorB); await expandStarter(pageA);
        assert.equal(await composer(pageA).inputValue(), draftAB);
        assert.equal(await starter(pageA).getAttribute('data-conversation-id'), conversationId);
        const originalContext = await request(actorA, 'GET', `${connectionMessages(conversationId)}/context`);
        assert.deepEqual(await starterTexts(pageA), originalContext.questions);
      } finally { releaseResponse(); await pageA.unroute(pattern, handler); }
      await pageC.reload(); await openConversation(actorC, actorA); await expandStarter(pageC);
      assert.equal((await request(actorC, 'GET', '/bootstrap')).profile.discoverable, false);
      assert.equal(await starter(pageC).getAttribute('data-conversation-id'), secondId);
      await request(actorA, 'POST', `/blocked/${actorC.id}`, {});
      await eventually(async () => assert.equal(await starter(pageC).count(), 0));
      await eventually(async () => assert.equal((await request(actorA, 'GET', '/connections')).invitations.length, 1));
      assert.equal(await starter(pageA).getAttribute('data-conversation-id'), conversationId);
      assert.equal((await request(actorA, 'GET', connectionMessages(conversationId))).items.length, 0);
      await composer(pageA).fill('');
    });

    await check('空白消息禁发；双方真实发送与 SSE 同步，Enter 发送及 Shift+Enter 换行', async () => {
      await composer(pageA).fill('   \n  ');
      assert.equal(await sendButton(pageA).isDisabled(), true);
      await composer(pageA).press('Enter');
      assert.equal((await request(actorA, 'GET', connectionMessages(conversationId))).items.length, 0);
      const first = '我最近在想，AI 帮我们做选择时，怎样把最终决定留给人？';
      await sendThroughUI(actorA, first);
      await eventually(async () => assert.equal(await messageWithText(pageB, first).count(), 1));
      assert.equal(await pageA.locator('.conversation-message.is-mine').filter({ hasText: first }).count(), 1);
      assert.equal(await pageB.locator('.conversation-message:not(.is-mine)').filter({ hasText: first }).count(), 1);
      const firstLine = '我会先从一个具体场景开始，讲清楚选择背后的理由。';
      const secondLine = '比如推荐一篇文章时，也把不同视角放在旁边。';
      await composer(pageB).fill(firstLine);
      await composer(pageB).press('Shift+Enter');
      await composer(pageB).pressSequentially(secondLine);
      assert.equal(await composer(pageB).inputValue(), firstLine + '\n' + secondLine);
      assert.equal((await request(actorB, 'GET', connectionMessages(conversationId))).items.length, 1);
      await composer(pageB).press('Enter');
      await eventually(async () => assert.equal(await messageWithText(pageA, secondLine).count(), 1));
      assert.equal((await request(actorA, 'GET', connectionMessages(conversationId))).items.length, 2);
    });

    await check('快速连续点击发送只产生一次请求与一条持久化消息', async () => {
      const text = '这个例子很好。产品给出的理由，也许比结果本身更重要。';
      await composer(pageA).fill(text);
      await sendButton(pageA).evaluate(button => { button.click(); button.click(); });
      await eventually(async () => assert.equal(await messageWithText(pageB, text).count(), 1));
      assert.equal(messageRequests.filter(item => item.text === text).length, 1);
      assert.equal((await request(actorA, 'GET', connectionMessages(conversationId))).items.filter(item => item.text === text).length, 1);
    });

    await check('模拟消息已落库但响应丢失：保留草稿并以同一 UUID 重试，不重复落库或显示', async () => {
      const text = '那我们各挑一篇相关的文章，交换一个赞同的观点和一个还没想明白的问题？';
      const pattern = `**/api/conversations/${conversationId}/messages`;
      let dropNext = true;
      const handler = async route => {
        if (route.request().postDataJSON().text === text && dropNext) {
          dropNext = false;
          const response = await route.fetch();
          assert.equal(response.status(), 201);
          await route.abort('failed');
        } else await route.continue();
      };
      await pageA.route(pattern, handler);
      try {
        await composer(pageA).fill(text);
        await sendButton(pageA).click();
        await pageA.locator('.conversation-composer .form-error').waitFor({ state: 'visible' });
        assert.equal(await composer(pageA).inputValue(), text);
        assert.equal((await request(actorA, 'GET', connectionMessages(conversationId))).items.filter(item => item.text === text).length, 1);
        await sendButton(pageA).click();
        await eventually(async () => assert.equal(await composer(pageA).inputValue(), ''));
        const attempts = messageRequests.filter(item => item.text === text);
        assert.equal(attempts.length, 2);
        assert.match(attempts[0].clientMessageId, /^[0-9a-f-]{36}$/i);
        assert.equal(attempts[0].clientMessageId, attempts[1].clientMessageId);
        assert.equal((await request(actorA, 'GET', connectionMessages(conversationId))).items.filter(item => item.text === text).length, 1);
        await eventually(async () => assert.equal(await messageWithText(pageA, text).count(), 1));
        await eventually(async () => assert.equal(await messageWithText(pageB, text).count(), 1));
      } finally { await pageA.unroute(pattern, handler); }
    });

    const nextDraft = '我还想听听你从摄影里得到的灵感。';
    await check('发送响应延迟时继续编辑，成功后保留新草稿；切换连接标签和刷新列表不丢草稿', async () => {
      const text = '好呀，先从「解释应该帮人理解，还是帮人做决定」这个问题开始。';
      const pattern = `**/api/conversations/${conversationId}/messages`;
      let releaseResponse, markLanded;
      const release = new Promise(done => { releaseResponse = done; });
      const landed = new Promise(done => { markLanded = done; });
      const handler = async route => {
        if (route.request().postDataJSON().text !== text) { await route.continue(); return; }
        const response = await route.fetch();
        assert.equal(response.status(), 201); markLanded();
        await release;
        await route.fulfill({ response });
      };
      await pageA.route(pattern, handler);
      try {
        await composer(pageA).fill(text);
        await sendButton(pageA).click();
        await within(landed, 'Delayed message request');
        assert.equal(await composer(pageA).isEnabled(), true);
        await composer(pageA).fill(nextDraft);
        releaseResponse();
        await eventually(async () => assert.equal(await sendButton(pageA).isEnabled(), true));
        assert.equal(await composer(pageA).inputValue(), nextDraft);
        await tabs(pageA, '收藏的伙伴').click();
        await tabs(pageA, '我的对话').click();
        await pageA.locator('.conversation-origin').waitFor({ state: 'visible' });
        assert.equal(await composer(pageA).inputValue(), nextDraft);
        await pageA.getByRole('button', { name: '刷新我的连接', exact: true }).click();
        await eventually(async () => assert.equal(await pageA.getByRole('button', { name: '刷新我的连接', exact: true }).isEnabled(), true));
        assert.equal(await composer(pageA).inputValue(), nextDraft);
      } finally { releaseResponse(); await pageA.unroute(pattern, handler); }
    });

    await check('桌面和 390/320px 聊天话题可折叠，输入框完整可见且往返列表保留草稿', async () => {
      assert.equal(await pageA.locator('.conversation-mobile-back').isVisible(), false);
      await pageA.screenshot({ path: resolve(artifactsDir, 'connections-desktop.png'), fullPage: true });
      for (const width of [390, 320]) {
        await pageA.setViewportSize({ width, height: 844 });
        await pageA.locator('.conversation-mobile-back').waitFor({ state: 'visible' });
        await pageA.locator('.conversation-mobile-back').click();
        const listItem = pageA.locator('.conversation-list-item').filter({ hasText: actorB.name });
        await listItem.waitFor({ state: 'visible' }); assert.match(await listItem.innerText(), /草稿/);
        await listItem.click(); await pageA.locator('.conversation-origin').waitFor({ state: 'visible' });
        await expandStarter(pageA);
        assert.equal(await composer(pageA).inputValue(), nextDraft); assert.equal(await starterQuestions(pageA).count(), 3);
        const sizes = await pageA.evaluate(() => {
          const rect = document.querySelector('.conversation-composer').getBoundingClientRect();
          const body = document.querySelector('.conversation-starter-body');
          return {
            viewport: innerWidth, page: document.documentElement.scrollWidth,
            panel: document.querySelector('.conversation-panel').getBoundingClientRect().width,
            panelScroll: document.querySelector('.conversation-panel').scrollWidth,
            starter: { width: body.clientWidth, scroll: body.scrollWidth, height: body.getBoundingClientRect().height },
            questions: [...document.querySelectorAll('[data-testid="conversation-starter-question"]')].map(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })),
            composer: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
            messagesHeight: document.querySelector('.conversation-messages').clientHeight,
            navigationTop: document.querySelector('.mobile-bottom-nav').getBoundingClientRect().top,
          };
        });
        assert.ok(sizes.page <= sizes.viewport + 1, `Mobile page overflow: ${sizes.page} > ${sizes.viewport}`);
        assert.ok(sizes.panelScroll <= sizes.panel + 1, `Mobile chat overflow: ${sizes.panelScroll} > ${sizes.panel}`);
        assert.ok(sizes.starter.scroll <= sizes.starter.width + 1 && sizes.starter.height <= 191);
        for (const question of sizes.questions) assert.ok(question.left >= 0 && question.right <= width + 1);
        assert.ok(sizes.messagesHeight > 80, 'Expanded topics must leave room to read the conversation.');
        assert.ok(sizes.composer.right <= sizes.viewport + 1 && sizes.composer.left >= 0);
        assert.ok(sizes.composer.top >= 0 && sizes.composer.bottom <= sizes.navigationTop + 1, 'Mobile composer must fit above the fixed bottom navigation.');
        await pageA.screenshot({ path: resolve(artifactsDir, width === 390 ? 'connections-mobile.png' : 'connections-mobile-320.png'), fullPage: true });
        await pageA.getByTestId('conversation-starter-toggle').click();
        assert.equal(await pageA.locator('.conversation-starter-body').isVisible(), false);
        assert.equal(await composer(pageA).inputValue(), nextDraft);
      }
    });

    await check('浏览器整页刷新后已发送消息仍持久化，两方读取相同消息历史', async () => {
      await composer(pageA).fill('');
      const before = (await request(actorA, 'GET', connectionMessages(conversationId))).items;
      assert.equal(before.length, 5);
      await pageA.reload();
      await openConversation(actorA, actorB);
      await eventually(async () => assert.equal(await renderedMessages(pageA).count(), before.length));
      const after = (await request(actorB, 'GET', connectionMessages(conversationId))).items;
      assert.deepEqual(after, before);
      report.draftScope = 'Unsent drafts survive tab changes, conversation list navigation, and list refresh within this page. Browser reload persistence is verified for sent messages only.';
    });

    await check('超过 100 条真实库消息按 before 分页读取，补齐历史且无重复', async () => {
      const existing = (await request(actorA, 'GET', connectionMessages(conversationId))).items.length;
      for (let index = 0; index < 105; index++) {
        service.store.sendMessage(index % 2 ? actorA.id : actorB.id, conversationId, `分页准备的历史交流 ${String(index + 1).padStart(3, '0')}：从一个好问题继续展开。`, randomUUID());
      }
      await pageA.locator('.conversation-mobile-back').click();
      await pageA.getByRole('button', { name: '刷新我的连接', exact: true }).click();
      await openConversation(actorA, actorB);
      const latest = await request(actorA, 'GET', connectionMessages(conversationId));
      assert.equal(latest.items.length, 100); assert.equal(latest.hasMore, true); assert.ok(latest.nextBefore);
      await pageA.getByRole('button', { name: '查看更早的消息', exact: true }).waitFor({ state: 'visible' });
      await pageA.getByRole('button', { name: '查看更早的消息', exact: true }).click();
      await eventually(async () => assert.equal(await renderedMessages(pageA).count(), existing + 105));
      const texts = await renderedMessages(pageA).allTextContents();
      assert.equal(new Set(texts).size, texts.length);
      assert.deepEqual(texts.filter(text => text.startsWith('分页准备的历史交流')).map(text => Number(text.match(/历史交流 (\d+)/)[1])), Array.from({ length: 105 }, (_, index) => index + 1));
      assert.equal(await pageA.getByRole('button', { name: '查看更早的消息', exact: true }).count(), 0);
      const older = await request(actorA, 'GET', `${connectionMessages(conversationId)}?before=${latest.nextBefore}`);
      assert.equal(older.items.length, existing + 5); assert.equal(older.hasMore, false);
      report.pagination = { fixtureMessages: 105, totalMessages: existing + 105, firstPage: latest.items.length, olderPage: older.items.length };
    });

    await check('屏蔽需明确确认，双方通过 SSE 移除连接并禁止访问原会话、画像和匹配', async () => {
      await pageA.locator('.conversation-header').getByRole('button', { name: `屏蔽${actorB.name}`, exact: true }).click();
      const dialog = pageA.getByRole('dialog');
      await dialog.getByRole('heading', { name: `屏蔽 ${actorB.name}？`, exact: true }).waitFor({ state: 'visible' });
      assert.equal((await request(actorA, 'GET', '/connections')).invitations.length, 1);
      await dialog.getByRole('button', { name: '确认屏蔽', exact: true }).click();
      await eventually(async () => assert.equal(await pageA.locator('.conversation-panel').count(), 0));
      await eventually(async () => assert.equal(await pageB.locator('.conversation-panel').count(), 0));
      assert.equal(await starter(pageA).count(), 0); assert.equal(await starter(pageB).count(), 0);
      for (const [actor, partner] of [[actorA, actorB], [actorB, actorA]]) {
        await request(actor, 'GET', connectionMessages(conversationId), undefined, 404);
        await request(actor, 'GET', `${connectionMessages(conversationId)}/context`, undefined, 404);
        await request(actor, 'POST', `${connectionMessages(conversationId)}/icebreakers`, {}, 404);
        await request(actor, 'GET', `/people/${partner.id}`, undefined, 404);
        await request(actor, 'POST', `${connectionMessages(conversationId)}/messages`, { text: '屏蔽后不应送达的消息', clientMessageId: randomUUID() }, 404);
        assert.equal((await request(actor, 'GET', '/connections')).invitations.length, 0);
        assert.equal((await request(actor, 'GET', '/matches?pool=people')).matches.some(item => item.id === partner.id), false);
      }
      assert.ok((await request(actorA, 'GET', '/blocked')).people.some(item => item.id === actorB.id));
    });

    await check('全流程没有浏览器外部网络请求或虚构消息', async () => {
      assert.deepEqual(externalRequests, []);
      assert.equal(iceRequests.filter(path => path.startsWith('/api/people/')).length, 1);
      assert.equal(chatIceRequests().length, 3);
      report.screenshots = ['conversation-starter-desktop.png', 'connections-desktop.png', 'connections-mobile.png', 'connections-mobile-320.png'];
      report.conversationStarters = { automaticMode: 'rules', automaticQuestions: 3, manualRequests: chatIceRequests().length, draftLimit: 2000, crossConversationCancellation: true };
    });
  } catch (error) {
    await Promise.allSettled([
      pageA.screenshot({ path: resolve(artifactsDir, 'connections-failure-a.png'), fullPage: true }),
      pageB.screenshot({ path: resolve(artifactsDir, 'connections-failure-b.png'), fullPage: true }),
    ]);
    throw error;
  }
});
