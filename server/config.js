import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { parse as parseYaml } from 'yaml';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(root = projectRoot, environment = process.env) {
  let files = {};
  for (const file of ['.env', '.env.local']) {
    try { files = { ...files, ...parseEnv(readFileSync(resolve(root, file), 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const env = { ...files, ...environment };
  let project = {};
  try { project = JSON.parse(readFileSync(resolve(root, 'hackathon.config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('hackathon.config.json 不是有效的项目配置'); }
  const credential = (name, systemdName) => {
    if (env[name]) return env[name];
    const explicitFile = env[`${name}_FILE`];
    const file = explicitFile || (env.CREDENTIALS_DIRECTORY ? resolve(env.CREDENTIALS_DIRECTORY, systemdName) : null);
    if (!file) return '';
    try { return readFileSync(file, 'utf8').trim(); }
    catch (error) {
      if (!explicitFile && error.code === 'ENOENT') return '';
      throw new Error(`${name} 的服务端凭证文件不可读取`);
    }
  };
  const port = Number(env.SOUL_PORT || 3022);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SOUL_PORT 必须是 1–65535 的整数');
  let ai = {
    key: env.SOUL_AI_API_KEY || '', baseUrl: env.SOUL_AI_BASE_URL || '',
    model: env.SOUL_AI_MODEL || '', protocol: env.SOUL_AI_PROTOCOL || 'openai',
    userAgent: env.SOUL_AI_USER_AGENT || '', source: 'environment',
  };
  if (!ai.key && env.SOUL_AI_CONFIG_FILE) {
    try {
      const data = JSON.parse(readFileSync(env.SOUL_AI_CONFIG_FILE, 'utf8'));
      if (!data.api_key || !data.base_url || !data.model) throw new Error();
      ai = { key: data.api_key, baseUrl: data.base_url, model: data.model, protocol: data.protocol || 'openai', userAgent: data.user_agent || '', source: 'local-file' };
    } catch { throw new Error('SOUL_AI_CONFIG_FILE 指向的模型配置不存在或不完整'); }
  }
  if (!ai.key && env.SOUL_USE_LOCAL_MODEL !== 'false') {
    try {
      const settings = parseYaml(readFileSync(env.SOUL_LOCAL_MODEL_CONFIG || resolve(homedir(), '.hermes/config.yaml'), 'utf8'));
      const provider = settings?.providers?.[settings.default_provider];
      if (provider?.api_key && provider?.base_url && settings.default_model) {
        ai = { key: provider.api_key, baseUrl: provider.base_url, model: settings.default_model, protocol: provider.protocol || 'openai', userAgent: provider.user_agent || '', source: 'local-config' };
      }
    } catch { /* An optional local model never prevents an offline start. */ }
  }
  if (env.SOUL_AI_ENABLED === 'false') ai.key = '';
  ai.configured = Boolean(ai.key && ai.model && /^https?:\/\//.test(ai.baseUrl));
  ai.timeoutMs = Math.min(55000, Math.max(5000, Number(env.SOUL_AI_TIMEOUT_MS) || 40000));
  ai.jsonMode = env.SOUL_AI_JSON_MODE !== 'false';
  ai.disableThinking = env.SOUL_AI_DISABLE_THINKING === 'true';
  const embedding = {
    key: env.SOUL_EMBEDDING_API_KEY || ai.key,
    baseUrl: env.SOUL_EMBEDDING_BASE_URL || ai.baseUrl,
    model: env.SOUL_EMBEDDING_MODEL || '',
  };
  embedding.configured = Boolean(embedding.key && embedding.model && /^https?:\/\//.test(embedding.baseUrl));
  const oauth = {
    appId: env.ZHIHU_OAUTH_APP_ID ?? (project.oauth?.enabled ? project.oauth.appId || '' : ''),
    appKey: credential('ZHIHU_OAUTH_APP_KEY', 'zhihu_app_key'),
    redirectUri: env.ZHIHU_OAUTH_REDIRECT_URI ?? (project.oauth?.enabled ? project.oauth.redirectUri || '' : ''),
  };
  const publicOrigin = (env.SOUL_PUBLIC_ORIGIN || '').replace(/\/$/, '');
  if (publicOrigin && !/^https?:\/\/[^/]+$/.test(publicOrigin)) throw new Error('SOUL_PUBLIC_ORIGIN 只包含协议和域名（可带端口）');
  return {
    root, port, host: env.SOUL_HOST || '127.0.0.1',
    databasePath: env.SOUL_DB_PATH || resolve(root, 'data/soulmatch.sqlite'),
    publicOrigin, secureCookies: publicOrigin.startsWith('https://'),
    allowedOrigins: new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5176', 'http://localhost:5176', publicOrigin].filter(Boolean)),
    ai, embedding,
    zhihu: { accessSecret: credential('ZHIHU_ACCESS_SECRET', 'zhihu_access_secret'), oauth, oauthConfigured: Boolean(oauth.appId && oauth.appKey && oauth.redirectUri) },
  };
}

export function capabilities(config) {
  return {
    ai: config.ai.configured, embedding: config.embedding.configured,
    oauth: config.zhihu.oauthConfigured,
    zhihuData: Boolean(config.zhihu.accessSecret && config.zhihu.oauthConfigured),
    zhihuSearch: Boolean(config.zhihu.accessSecret),
  };
}
