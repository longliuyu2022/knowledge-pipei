import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Store } from '../server/store.js';
import { createCircles } from '../server/circles/index.js';
import { AppError } from '../server/errors.js';

test('router integrates JSON DTOs, member permissions and the shared CSRF boundary', async t => {
  const store = new Store(':memory:'), alice = store.createUser('请求者甲'), bob = store.createUser('请求者乙');
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    const userId = req.get('x-test-user'); req.viewer = userId ? store.user(userId) : null;
    if (!['GET', 'HEAD'].includes(req.method) && req.get('x-csrf-token') !== 'test-token') return next(new AppError(403, 'csrf_mismatch', 'csrf'));
    next();
  });
  const feature = createCircles({ store, intervalMs: 0, assertSession: req => { if (!store.user(req.viewer.id)) throw new AppError(401, 'session_expired', 'expired'); }, moderate: async () => ({ allowed: true }) });
  app.use('/api/circles', feature.router);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: { code: error.code || 'internal', message: error.message } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { feature.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/circles`;
  async function call(path = '', { user = alice, method = 'GET', body, csrf = true } = {}) {
    const headers = { 'content-type': 'application/json', ...(user ? { 'x-test-user': user.id } : {}), ...(csrf ? { 'x-csrf-token': 'test-token' } : {}) };
    const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  const draft = { title: '接口验证小组', question: '如何确保成员权限不会泄漏？', goal: '验证一条完整讨论路径' };
  assert.equal((await call('', { method: 'POST', body: draft, csrf: false })).status, 403);
  const created = await call('', { method: 'POST', body: draft }); assert.equal(created.status, 201);
  const id = created.body.circle.id;
  assert.equal((await call(`/${id}`, { user: null })).body.circle.messages.length, 0);
  assert.equal((await call(`/${id}/search?q=privacy`, { user: null })).status, 401);
  assert.equal((await call(`/${id}/messages`, { user: bob })).status, 403);
  assert.equal((await call(`/${id}/join`, { user: bob, method: 'POST', body: { duration: '7d' } })).body.circle.membership.role, 'member');
  const body = { text: '通过真实请求提交可见的发言。', clientMessageId: 'http-message-01' };
  const sent = await call(`/${id}/messages`, { user: bob, method: 'POST', body }); assert.equal(sent.status, 201);
  assert.equal((await call(`/${id}/messages`, { user: bob, method: 'POST', body })).status, 200);
  assert.equal((await call(`/${id}/messages/${sent.body.message.id}/hide`, { user: bob, method: 'POST', body: {} })).status, 403);
  assert.equal((await call(`/${id}/messages/${sent.body.message.id}/hide`, { method: 'POST', body: {} })).status, 200);
  const visible = await call(`/${id}`, { user: bob }); assert.equal(visible.body.circle.messages[0].hidden, true);
  assert.equal((await call('/recommendations', { user: bob })).body.mode, 'rules');
  assert.equal((await call(`/${id}/leave`, { user: bob, method: 'POST', body: {} })).body.circle.joined, false);
  assert.equal((await call(`/${id}/messages`, { user: bob })).status, 403);
});
