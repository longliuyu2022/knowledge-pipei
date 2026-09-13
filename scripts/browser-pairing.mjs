import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runBrowserSuite } from './browser-harness.mjs';

let clockOffset = 0;
const testNow = () => Date.now() + clockOffset;
function advanceTo(time) {
  assert.ok(time >= testNow() - 50, 'The pairing test clock must not move backwards.');
  clockOffset = time - Date.now();
}

async function eventually(job, timeout = 18000) {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try { return await job(); }
    catch (error) { lastError = error; }
    await new Promise(done => setTimeout(done, 100));
  } while (Date.now() < deadline);
  throw lastError || new Error('Pairing condition did not become true before the deadline.');
}

await runBrowserSuite('pairing', async ({ newContext, origin, check, artifactsDir, report, service }) => {
  const actors = [];
  const externalRequests = [];
  const names = ['沈星河', '顾青禾', '程见山'];
  for (const name of names) {
    const context = await newContext();
    context.on('request', request => {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) externalRequests.push(url.origin + url.pathname);
    });
    const page = await context.newPage(); page.setDefaultTimeout(18000);
    actors.push({ name, context, page, id: '', csrf: '', profile: null });
  }
  const [alice, bob, carol] = actors;

  async function api(actor, method, path, body, expectedStatus = 200) {
    const response = await actor.context.request.fetch(origin + '/api' + path, {
      method, headers: { Origin: origin, ...(actor.csrf ? { 'X-CSRF-Token': actor.csrf } : {}) },
      ...(body === undefined ? {} : { data: body }),
    });
    const result = await response.json();
    const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    assert.ok(statuses.includes(response.status()), `${method} ${path}: ${response.status()} ${result?.error?.message || 'unexpected response'}`);
    return result;
  }
  const snapshot = actor => api(actor, 'GET', '/pairing');
  const pairStatus = actor => actor.page.getByTestId('pairing-status');
  const candidate = actor => actor.page.getByTestId('pairing-candidate');
  const startButton = actor => actor.page.getByTestId('pairing-start');
  let conversationId = '';

  async function waitStatus(actor, value) {
    await eventually(async () => assert.equal(await pairStatus(actor).getAttribute('data-status'), value));
  }

  async function showPairing(actor) {
    if (actor.page.isClosed()) { actor.page = await actor.context.newPage(); actor.page.setDefaultTimeout(18000); }
    if (actor.page.url() !== origin + '/#pairing') await actor.page.goto(origin + '/#pairing');
    await actor.page.getByTestId('pairing-page').waitFor({ state: 'visible' });
    await pairStatus(actor).waitFor({ state: 'visible' });
  }

  async function start(actor) {
    await showPairing(actor);
    await startButton(actor).click();
    return await eventually(async () => {
      const state = await snapshot(actor);
      assert.ok(['searching', 'proposed'].includes(state.status), `Start returned ${state.status}`);
      assert.ok(state.attemptId);
      return state;
    });
  }

  async function getProposed(first, second) {
    await Promise.all([waitStatus(first, 'proposed'), waitStatus(second, 'proposed')]);
    const [one, two] = await Promise.all([snapshot(first), snapshot(second)]);
    assert.equal(one.status, 'proposed'); assert.equal(two.status, 'proposed');
    assert.ok(one.pair?.id); assert.equal(one.pair.id, two.pair.id);
    assert.equal(one.pair.person.id, second.id); assert.equal(two.pair.person.id, first.id);
    assert.equal(one.pair.person.demo, false); assert.equal(two.pair.person.demo, false);
    assert.equal(one.conversationId, null); assert.equal(two.conversationId, null);
    await candidate(first).waitFor({ state: 'visible' }); await candidate(second).waitFor({ state: 'visible' });
    assert.match(await candidate(first).innerText(), new RegExp(second.name));
    assert.match(await candidate(second).innerText(), new RegExp(first.name));
    return [one, two];
  }

  async function heartbeat(actor) {
    const state = await snapshot(actor);
    return api(actor, 'POST', '/pairing/heartbeat', { attemptId: state.attemptId });
  }

  async function staleConfirmation(actor, pairId) {
    const before = await snapshot(actor);
    const after = await api(actor, 'POST', '/pairing/respond', { pairId, decision: 'accept' });
    assert.equal(after.status, before.status);
    assert.equal(after.attemptId, before.attemptId);
    assert.equal(after.pair?.id || null, before.pair?.id || null);
    assert.equal(after.conversationId, before.conversationId);
    assert.equal(after.pair?.acceptedByMe, before.pair?.acceptedByMe);
    return after;
  }

  async function cancelAll() {
    for (const actor of actors) {
      const state = await snapshot(actor);
      if (state.attemptId) await api(actor, 'POST', '/pairing/cancel', { attemptId: state.attemptId });
    }
  }

  async function expireAvoidance() {
    await cancelAll();
    advanceTo(testNow() + 301000);
    service.pairing.tick();
  }

  async function enterChat(actor, id) {
    await waitStatus(actor, 'connected');
    await actor.page.getByTestId('pairing-open-chat').click();
    const textarea = actor.page.locator('.conversation-composer textarea');
    await textarea.waitFor({ state: 'visible' });
    assert.equal(await textarea.getAttribute('id'), `message-${id}`);
    assert.equal(new URL(actor.page.url()).hash, '#connections');
    await actor.page.locator('.conversation-origin').waitFor({ state: 'visible' });
  }

  async function send(actor, text) {
    const composer = actor.page.locator('.conversation-composer');
    await composer.locator('textarea').fill(text);
    await composer.getByRole('button', { name: '发送', exact: true }).click();
    await eventually(async () => assert.equal(await composer.locator('textarea').inputValue(), ''));
  }

  async function captureCandidate(actor, filename) {
    const canceledNotice = actor.page.locator('.toast').filter({ hasText: '本轮配对已取消' });
    if (await canceledNotice.isVisible()) {
      await canceledNotice.getByRole('button', { name: '关闭提示', exact: true }).click();
    }
    await canceledNotice.waitFor({ state: 'hidden' });
    await actor.page.screenshot({ path: resolve(artifactsDir, filename), fullPage: true });
  }

  try {
    await check('三个隔离浏览器身份以规则 API 准备私密画像，无模型或知乎外部调用', async () => {
      for (const [index, actor] of actors.entries()) {
        const bootstrap = await api(actor, 'GET', '/bootstrap');
        actor.id = bootstrap.user.id; actor.csrf = bootstrap.csrf;
        assert.equal(bootstrap.profile, null);
        for (const capability of ['ai', 'embedding', 'oauth', 'zhihuSearch']) assert.equal(bootstrap.capabilities[capability], false);
        const input = {
          name: actor.name, topicIds: ['ai', 'product', 'psychology', 'reading', index === 2 ? 'education' : 'design'],
          about: ['喜欢从产品和阅读中寻找人的选择，想和保持好奇的人聊聊技术。', '在心理学和设计之间寻找新视角，愿意从具体问题开始交流。', '关注学习、技术和日常经验，喜欢交换各自正在思考的问题。'][index],
          question: '当 AI 能快速回答问题，什么样的提问仍然值得认真对待？',
          styleId: 'deep', goals: ['conversation', 'learning'],
        };
        actor.profile = (await api(actor, 'POST', '/profile', { input, revision: 0, useAI: false })).profile;
        assert.equal(actor.profile.discoverable, false); assert.equal(actor.profile.analysis.mode, 'rules');
      }
      assert.equal(new Set(actors.map(actor => actor.id)).size, 3);
      await Promise.all(actors.map(showPairing));
      await Promise.all(actors.map(actor => waitStatus(actor, 'idle')));
      report.configuration = { identities: 3, database: 'temporary isolated SQLite', ai: false, zhihu: false, expiryClock: 'injected into this isolated pairing service only' };
    });

    let firstAttempt;
    await check('没有其他人开始时真实等待，不用 demo 补位；点击开始不公开画像', async () => {
      const state = await start(alice); firstAttempt = state.attemptId;
      assert.equal(state.status, 'searching'); assert.equal(state.pair, null); assert.equal(state.conversationId, null);
      await waitStatus(alice, 'searching');
      assert.equal(await candidate(alice).count(), 0);
      assert.equal((await snapshot(bob)).status, 'idle'); assert.equal((await snapshot(carol)).status, 'idle');
      for (const actor of actors) assert.equal((await api(actor, 'GET', '/bootstrap')).profile.discoverable, false);
      assert.equal((await api(alice, 'GET', '/matches?pool=people')).matches.length, 0);
    });

    await check('取消等待后新轮次更换 attemptId，迟到取消和重复开始不会破坏新轮次', async () => {
      await alice.page.getByTestId('pairing-cancel').click();
      await waitStatus(alice, 'idle');
      assert.equal((await snapshot(alice)).status, 'idle');
      const restarted = await start(alice);
      assert.notEqual(restarted.attemptId, firstAttempt);
      const late = await api(alice, 'POST', '/pairing/cancel', { attemptId: firstAttempt });
      assert.equal(late.status, 'searching'); assert.equal(late.attemptId, restarted.attemptId);
      const repeated = await api(alice, 'POST', '/pairing/start', { revision: alice.profile.revision, mode: 'resonance', topic: null });
      assert.equal(repeated.attemptId, restarted.attemptId); assert.equal(repeated.status, 'searching');
      await waitStatus(alice, 'searching');
    });

    let proposedPairId;
    await check('第二个真实在线用户开始后双方通过 SSE 收到同一候选，私密画像只供当次双方查看', async () => {
      await start(bob);
      const [one, two] = await getProposed(alice, bob); proposedPairId = one.pair.id;
      assert.equal(one.pair.acceptedByMe, false); assert.equal(two.pair.acceptedByMe, false);
      assert.equal(one.pair.acceptedByOther, false); assert.equal(two.pair.acceptedByOther, false);
      await api(alice, 'GET', `/people/${bob.id}`, undefined, 404);
      await api(bob, 'GET', `/people/${alice.id}`, undefined, 404);
      for (const actor of [alice, bob]) assert.equal((await api(actor, 'GET', '/bootstrap')).profile.discoverable, false);
      await captureCandidate(alice, 'pairing-desktop.png');
    });

    await check('第三人无法读出或确认他人的配对，已保留的双方不会被重复分配', async () => {
      await start(carol); await waitStatus(carol, 'searching');
      const outsider = await snapshot(carol);
      assert.equal(outsider.status, 'searching'); assert.equal(outsider.pair, null); assert.equal(outsider.conversationId, null);
      for (const value of [alice.id, bob.id, alice.name, bob.name, proposedPairId]) assert.equal(JSON.stringify(outsider).includes(value), false);
      const denied = await api(carol, 'POST', '/pairing/respond', { pairId: proposedPairId, decision: 'accept' }, [403, 404, 409]);
      assert.ok(denied.error);
      await api(carol, 'GET', `/people/${alice.id}`, undefined, 404);
      await api(carol, 'GET', `/people/${bob.id}`, undefined, 404);
      const [one, two] = await getProposed(alice, bob);
      assert.equal(one.pair.id, proposedPairId); assert.equal(two.pair.id, proposedPairId);
      assert.equal(one.pair.acceptedByMe, false); assert.equal(two.pair.acceptedByMe, false);
    });

    for (const width of [390, 320]) {
      await check(`${width}px 手机真实候选、确认与换人按钮无横向溢出`, async () => {
        await alice.page.setViewportSize({ width, height: 844 });
        await candidate(alice).waitFor({ state: 'visible' });
        const sizes = await alice.page.evaluate(() => {
          const rect = document.querySelector('[data-testid="pairing-candidate"]').getBoundingClientRect();
          const controls = ['pairing-accept', 'pairing-skip', 'pairing-cancel'].map(id => {
            const element = document.querySelector(`[data-testid="${id}"]`);
            const box = element.getBoundingClientRect();
            return { id, left: box.left, right: box.right, width: box.width };
          });
          const navigation = [...document.querySelectorAll('.mobile-bottom-nav > a')].map(element => {
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, width: box.width };
          });
          return { viewport: innerWidth, page: document.documentElement.scrollWidth, candidate: { left: rect.left, right: rect.right }, controls, navigation };
        });
        assert.ok(sizes.page <= sizes.viewport + 1, `Page overflows at ${width}px.`);
        assert.ok(sizes.candidate.left >= -1 && sizes.candidate.right <= sizes.viewport + 1);
        for (const control of sizes.controls) assert.ok(control.width > 0 && control.left >= -1 && control.right <= sizes.viewport + 1, `${control.id} overflows at ${width}px.`);
        assert.equal(sizes.navigation.length, 5);
        for (const item of sizes.navigation) assert.ok(item.width > 0 && item.left >= -1 && item.right <= sizes.viewport + 1, `Mobile navigation overflows at ${width}px.`);
        await captureCandidate(alice, `pairing-mobile-${width}.png`);
      });
    }
    await alice.page.setViewportSize({ width: 1440, height: 1000 });

    await check('只有一方确认时保持候选等待，不提前建立聊天或冒充另一方确认', async () => {
      await alice.page.getByTestId('pairing-accept').click();
      await eventually(async () => assert.equal(await alice.page.getByTestId('pairing-accept').isDisabled(), true));
      const [one, two] = await getProposed(alice, bob);
      assert.equal(one.pair.acceptedByMe, true); assert.equal(one.pair.acceptedByOther, false);
      assert.equal(two.pair.acceptedByMe, false); assert.equal(two.pair.acceptedByOther, true);
      for (const actor of [alice, bob]) {
        assert.equal((await api(actor, 'GET', '/connections')).invitations.length, 0);
        assert.equal(await actor.page.locator('.conversation-panel').count(), 0);
        assert.equal((await snapshot(actor)).conversationId, null);
      }
      assert.equal((await snapshot(carol)).status, 'searching');
    });

    await check('双方确认后仅建立一条真实连接，按钮让两人进入同一 conversationId', async () => {
      await bob.page.getByTestId('pairing-accept').click();
      await Promise.all([waitStatus(alice, 'connected'), waitStatus(bob, 'connected')]);
      const [one, two] = await Promise.all([snapshot(alice), snapshot(bob)]);
      conversationId = one.conversationId;
      assert.ok(conversationId); assert.equal(conversationId, two.conversationId);
      for (const actor of [alice, bob]) {
        const invitations = (await api(actor, 'GET', '/connections')).invitations;
        assert.equal(invitations.length, 1); assert.equal(invitations[0].id, conversationId); assert.equal(invitations[0].status, 'accepted');
      }
      await api(carol, 'GET', `/conversations/${conversationId}`, undefined, 404);
      await api(carol, 'POST', `/conversations/${conversationId}/messages`, { text: '不属于第三人的对话', clientMessageId: randomUUID() }, 404);
      await enterChat(alice, conversationId); await enterChat(bob, conversationId);
      assert.equal(await alice.page.locator('.conversation-message-content > p').count(), 0);
      assert.equal(await bob.page.locator('.conversation-message-content > p').count(), 0);
    });

    await check('实时配对建立的会话可双向发送，并通过 SSE 展示真实对方消息', async () => {
      const first = '很高兴这次真的遇见你。你最近在想哪个和技术有关的问题？';
      const second = '我在想，产品给出一个答案时，能不能也为不同看法留一点空间。';
      await send(alice, first);
      await eventually(async () => assert.equal(await bob.page.locator('.conversation-message:not(.is-mine)').filter({ hasText: first }).count(), 1));
      await send(bob, second);
      await eventually(async () => assert.equal(await alice.page.locator('.conversation-message:not(.is-mine)').filter({ hasText: second }).count(), 1));
      const messages = (await api(alice, 'GET', `/conversations/${conversationId}`)).items;
      assert.equal(messages.length, 2);
      assert.deepEqual(messages.map(item => item.authorId), [alice.id, bob.id]);
      assert.deepEqual(messages.map(item => item.text), [first, second]);
      assert.equal((await snapshot(carol)).status, 'searching');
    });

    await check('只有自己等待的队列在三分钟过期，保持心跳也不会无限自动续排', async () => {
      const waiting = await snapshot(carol);
      assert.equal(waiting.status, 'searching');
      const deadline = Date.parse(waiting.expiresAt);
      assert.ok(Number.isFinite(deadline));
      while (testNow() < deadline) {
        const next = Math.min(testNow() + 25000, deadline + 100);
        advanceTo(next);
        if (next < deadline) assert.equal((await heartbeat(carol)).status, 'searching');
        else service.pairing.tick();
      }
      await waitStatus(carol, 'idle');
      const expired = await snapshot(carol);
      assert.equal(expired.status, 'idle'); assert.equal(expired.pair, null); assert.equal(expired.reason, 'queue_expired');
      assert.equal(await startButton(carol).isEnabled(), true);
    });

    await check('换一个会释放双方并避开刚见的人，第三人可接替且每人只占一组候选', async () => {
      await start(bob); await start(carol);
      const [before] = await getProposed(bob, carol);
      await bob.page.getByTestId('pairing-skip').click();
      await Promise.all([waitStatus(bob, 'searching'), waitStatus(carol, 'searching')]);
      assert.equal((await snapshot(bob)).pair, null); assert.equal((await snapshot(carol)).pair, null);
      await staleConfirmation(bob, before.pair.id);
      await start(alice);
      const states = await eventually(async () => {
        const current = await Promise.all(actors.map(snapshot));
        assert.equal(current.filter(state => state.status === 'proposed').length, 2);
        assert.equal(current.filter(state => state.status === 'searching').length, 1);
        return current;
      });
      const held = states.filter(state => state.status === 'proposed');
      assert.equal(new Set(held.map(state => state.pair.id)).size, 1);
      assert.notEqual(held[0].pair.id, before.pair.id);
      assert.equal(states[0].status, 'proposed');
      const partnerId = states[0].pair.person.id;
      assert.ok([bob.id, carol.id].includes(partnerId));
      const partner = actors.find(actor => actor.id === partnerId);
      await getProposed(alice, partner);
    });

    await check('候选阶段取消会立即退出，其他在线用户回队而不会被代为确认', async () => {
      await alice.page.getByTestId('pairing-cancel').click();
      await waitStatus(alice, 'idle');
      await Promise.all([waitStatus(bob, 'searching'), waitStatus(carol, 'searching')]);
      assert.equal((await snapshot(alice)).status, 'idle');
      for (const actor of [bob, carol]) { const state = await snapshot(actor); assert.equal(state.pair, null); assert.equal(state.conversationId, null); }
      assert.equal((await api(alice, 'GET', `/conversations/${conversationId}`)).items.length, 2);
    });

    await check('真实关闭一方页面停止心跳，45秒掉线后另一方回队，旧确认失效', async () => {
      await expireAvoidance();
      await start(bob); await start(carol);
      const [offline] = await getProposed(bob, carol);
      const offlineDeadline = Date.parse(offline.heartbeatExpiresAt);
      assert.ok(Number.isFinite(offlineDeadline));
      await bob.page.close();
      advanceTo(offlineDeadline - 5000);
      await heartbeat(carol);
      advanceTo(offlineDeadline + 1000);
      service.pairing.tick();
      await waitStatus(carol, 'searching');
      const [gone, remaining] = await Promise.all([snapshot(bob), snapshot(carol)]);
      assert.equal(gone.status, 'idle'); assert.equal(remaining.status, 'searching');
      assert.equal(remaining.pair, null); assert.equal(gone.reason, 'offline'); assert.equal(remaining.reason, 'peer_left');
      await staleConfirmation(bob, offline.pair.id);
      await showPairing(bob); await waitStatus(bob, 'idle');
      assert.equal(await startButton(bob).isEnabled(), true);
    });

    await check('单方确认后60秒超时，双方仍在线也不建立连接；旧 pairId 无法迟到确认', async () => {
      await expireAvoidance();
      await start(bob); await start(carol);
      const [proposal] = await getProposed(bob, carol);
      await bob.page.getByTestId('pairing-accept').click();
      await eventually(async () => assert.equal((await snapshot(bob)).pair.acceptedByMe, true));
      const deadline = Date.parse(proposal.expiresAt);
      advanceTo(deadline - 35000);
      assert.equal((await heartbeat(bob)).status, 'proposed'); assert.equal((await heartbeat(carol)).status, 'proposed');
      advanceTo(deadline + 100);
      service.pairing.tick();
      await Promise.all([waitStatus(bob, 'searching'), waitStatus(carol, 'searching')]);
      for (const actor of [bob, carol]) {
        const state = await snapshot(actor);
        assert.equal(state.pair, null); assert.equal(state.conversationId, null); assert.equal(state.reason, 'proposal_expired');
        await staleConfirmation(actor, proposal.pair.id);
      }
      assert.equal((await api(carol, 'GET', '/connections')).invitations.length, 0);
      assert.equal((await api(bob, 'GET', '/connections')).invitations.length, 1);
    });

    await check('配对全过程不改变私密设置、不调用外部服务，已有聊天在换轮和过期后仍保留', async () => {
      await cancelAll();
      for (const actor of actors) assert.equal((await api(actor, 'GET', '/bootstrap')).profile.discoverable, false);
      assert.deepEqual(externalRequests, []);
      assert.equal((await api(alice, 'GET', `/conversations/${conversationId}`)).items.length, 2);
      assert.equal((await api(bob, 'GET', `/conversations/${conversationId}`)).items.length, 2);
      report.screenshots = ['pairing-desktop.png', 'pairing-mobile-390.png', 'pairing-mobile-320.png'];
      report.expiration = { offlineMs: 45000, queueMs: 180000, proposalMs: 60000, clock: 'advanced only in the isolated in-memory pairing manager' };
    });
  } catch (error) {
    await Promise.allSettled(actors.filter(actor => !actor.page.isClosed()).map(actor => actor.page.screenshot({ path: resolve(artifactsDir, `pairing-failure-${actors.indexOf(actor) + 1}.png`), fullPage: true })));
    throw error;
  }
}, { pairingOptions: { now: testNow, offlineMs: 45000, queueMs: 180000, proposalMs: 60000, sweepMs: 250 } });
