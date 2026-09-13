import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { DEFAULT_INPUT } from '../shared/catalog.js';

export function testConfig(overrides = {}) {
  return loadConfig('/tmp/tongpin-no-private-config', {
    SOUL_DB_PATH: ':memory:', SOUL_AI_ENABLED: 'false', SOUL_USE_LOCAL_MODEL: 'false',
    ...overrides,
  });
}

export async function startService(t, { config = testConfig(), ...options } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tongpin-test-'));
  config.root = root;
  const service = createApp(config, options);
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  config.allowedOrigins.add(base);
  t.after(async () => {
    service.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  return { ...service, base, config, client: () => makeClient(base) };
}

export function makeClient(base) {
  const jar = new Map();
  const client = {
    csrf: '', jar,
    async request(path, { method = 'GET', body, headers = {}, raw } = {}) {
      const outgoing = { origin: base, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers };
      if (!['GET', 'HEAD'].includes(method) && !Object.hasOwn(outgoing, 'x-csrf-token')) outgoing['x-csrf-token'] = client.csrf;
      if (body !== undefined || raw !== undefined) outgoing['content-type'] = 'application/json';
      const response = await fetch(`${base}${path}`, { method, headers: outgoing, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0], equals = pair.indexOf('=');
        const key = pair.slice(0, equals), value = pair.slice(equals + 1);
        if (value) jar.set(key, value); else jar.delete(key);
      }
      const text = await response.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      if (data?.csrf) client.csrf = data.csrf;
      return { status: response.status, data, headers: response.headers };
    },
    async bootstrap() {
      const response = await client.request('/api/bootstrap');
      assert.equal(response.status, 200); return response.data;
    },
    async profile(name = '测试伙伴', publish = true, changes = {}) {
      const before = await client.bootstrap();
      const saved = await client.request('/api/profile', { method: 'POST', body: { input: { ...DEFAULT_INPUT, name, ...changes }, revision: before.profile?.revision || 0, useAI: false } });
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
      if (!publish) return saved.data.profile;
      const visible = await client.request('/api/profile/visibility', { method: 'POST', body: { discoverable: true, revision: saved.data.profile.revision } });
      assert.equal(visible.status, 200); return visible.data.profile;
    },
  };
  return client;
}

export const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
