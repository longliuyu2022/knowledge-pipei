import JSONbigFactory from 'json-bigint';
import { AppError, fail } from './errors.js';

const losslessJSON = JSONbigFactory({ storeAsString: true, strict: true });
const clean = (value, limit = 500) => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim().slice(0, limit) : '';

export function safeZhihuUrl(value, avatar = false) {
  try {
    const url = new URL(value);
    const domain = avatar ? 'zhimg.com' : 'zhihu.com';
    return url.protocol === 'https:' && (url.hostname === domain || url.hostname.endsWith(`.${domain}`)) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function parseZhihuJSON(text) {
  if (text.length > 2000000) fail(502, 'zhihu_response_invalid', '知乎返回的数据过大，请稍后重试');
  try { return losslessJSON.parse(text); }
  catch { fail(502, 'zhihu_response_invalid', '知乎返回的数据格式暂时无法读取'); }
}

function oauthPayload(data) {
  if (!data || typeof data !== 'object') fail(502, 'zhihu_response_invalid', '知乎授权响应不完整');
  if (data.code !== undefined && ![0, 20000, '0', '20000'].includes(data.code)) fail(401, 'zhihu_auth_failed', '知乎授权未完成，请重新连接');
  return data.data && typeof data.data === 'object' ? data.data : data;
}

export class Zhihu {
  constructor(config, { fetchImpl = fetch } = {}) {
    this.config = config; this.fetch = fetchImpl;
    this.tokens = new Map(); this.cache = new Map(); this.pending = new Map();
    this.calls = []; this.cooldown = 0;
  }
  setToken(userId, token, expiresIn = 3600) {
    this.forget(userId);
    const seconds = Number(expiresIn);
    this.tokens.set(userId, { token, expiresAt: Date.now() + Math.min(86400, Math.max(0, Number.isFinite(seconds) ? seconds : 3600)) * 1000 });
  }
  token(userId) {
    const value = this.tokens.get(userId);
    if (!value || value.expiresAt <= Date.now()) { this.forget(userId); return null; }
    return value.token;
  }
  forget(userId) {
    this.tokens.delete(userId);
    for (const key of this.cache.keys()) if (key.startsWith(`user:${userId}:`)) this.cache.delete(key);
  }
  async raw(url, options = {}) {
    try {
      const response = await this.fetch(url, { ...options, signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) {
        if ([401, 403].includes(response.status)) fail(401, 'zhihu_expired', '知乎授权已失效，请重新连接');
        if (response.status === 429) { this.cooldown = Date.now() + 60000; fail(429, 'zhihu_rate_limited', '知乎请求较多，请稍后再试'); }
        fail(502, 'zhihu_unavailable', '知乎服务暂时不可用，请稍后再试');
      }
      return parseZhihuJSON(await response.text());
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail(502, 'zhihu_unavailable', '知乎服务暂时不可用，请稍后再试');
    }
  }
  async exchange(code) {
    const oauth = this.config.zhihu.oauth;
    const form = new URLSearchParams({ app_id: oauth.appId, app_key: oauth.appKey, grant_type: 'authorization_code', redirect_uri: oauth.redirectUri, code });
    const tokenData = oauthPayload(await this.raw('https://openapi.zhihu.com/access_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form }));
    if (typeof tokenData.access_token !== 'string' || tokenData.access_token.length < 5) fail(401, 'zhihu_auth_failed', '知乎授权未完成，请重新连接');
    const profile = oauthPayload(await this.raw('https://openapi.zhihu.com/user', { headers: { Authorization: `Bearer ${tokenData.access_token}` } }));
    const hashSubject = clean(profile.hash_id,128);
    const subject = hashSubject || (typeof profile.uid === 'string' && /^\d+$/.test(profile.uid) ? profile.uid : Number.isSafeInteger(profile.uid) && profile.uid > 0 ? String(profile.uid) : '');
    if (!subject) fail(401, 'zhihu_identity_missing', '知乎未返回有效用户身份，请重新连接');
    return { identity: { subject, subjectKind:hashSubject?'hash':'uid', name: clean(profile.fullname, 24) || '知乎用户', avatar: safeZhihuUrl(profile.avatar_path, true) }, token: tokenData.access_token, expiresIn: tokenData.expires_in };
  }
  async business(path, params, userId = null, waitForSlot = false) {
    if (!this.config.zhihu.accessSecret) fail(503, 'zhihu_unconfigured', '知乎内容连接暂未开放，可以先填写兴趣');
    const token = userId ? this.token(userId) : null;
    const grant = userId ? this.tokens.get(userId) : null;
    if (userId && !token) fail(401, 'zhihu_expired', '请重新连接知乎后再导入');
    this.calls = this.calls.filter(t => Date.now() - t < 60000);
    if (waitForSlot && this.calls.length >= 5 && this.cooldown <= Date.now()) {
      await new Promise(resolve => setTimeout(resolve, Math.max(1, this.calls[0] + 60050 - Date.now())));
      this.calls = this.calls.filter(t => Date.now() - t < 60000);
    }
    if (this.cooldown > Date.now() || this.calls.length >= 5) fail(429, 'zhihu_rate_limited', '知乎请求较多或今日额度已用完，请稍后再试');
    this.calls.push(Date.now());
    const url = new URL(`https://developer.zhihu.com${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const headers = { Authorization: `Bearer ${this.config.zhihu.accessSecret}`, 'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)), 'Content-Type': 'application/json' };
    if (userId) headers['X-OAuth-Token'] = token;
    try {
      const response = await this.raw(url, { headers });
      if (userId && (this.token(userId) !== token || this.tokens.get(userId) !== grant)) fail(401, 'zhihu_expired', '知乎授权已失效，请重新连接');
      const code = Number(response.Code);
      if (code === 20001) fail(401, 'zhihu_expired', '知乎授权或内容连接已失效，请重新连接');
      if (code === 30001 || code === 30002) {
        this.cooldown = code === 30002 ? (Math.floor((Date.now() + 28800000) / 86400000) + 1) * 86400000 - 28800000 : Date.now() + 60000;
        fail(429, 'zhihu_rate_limited', code === 30002 ? '知乎今日额度已用完，暂时无法读取新内容' : '知乎请求较多，请稍后再试');
      }
      if (code !== 0 || !response.Data || !Array.isArray(response.Data.Items)) fail(502, 'zhihu_response_invalid', '知乎内容响应不完整，请稍后再试');
      return response.Data;
    } catch (error) {
      if (error.status === 401 && userId && this.tokens.get(userId) === grant) this.forget(userId);
      throw error;
    }
  }
  async cached(key, job) {
    const existing = this.cache.get(key);
    if (existing && existing.expires > Date.now()) return existing.value;
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = job().then(value => {
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, { value, expires: Date.now() + 900000 }); return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise); return promise;
  }
  async import(userId, sources) {
    if (!this.token(userId)) fail(401, 'zhihu_expired', '请先连接知乎，再选择导入的内容');
    const items = [], counts = {};
    const pages = async (path, params = {}) => {
      const result = []; let offset = '0', page = 0;
      while (page++ < 1000) {
        const data = await this.business(path, { ...params, Limit: 50, Offset: offset }, userId, true);
        result.push(...data.Items);
        if (!data.Paging || data.Paging.IsEnd !== false) break;
        const next = String(data.Paging.NextOffset ?? '');
        if (!/^\d+$/.test(next) || next === offset) fail(502, 'zhihu_response_invalid', '知乎分页信息不完整，本次导入已停止');
        offset = next;
      }
      return result;
    };
    for (const source of sources) {
      const sourceItems = await this.cached(`user:${userId}:${source}:all`, async () => {
        if (source === 'contents') return pages('/api/v1/user/contents', { ContentType: 'all', SortField: 'ts', SortOrder: 'desc' });
        if (source === 'followees') return pages('/api/v1/user/followees');
        const lists = await this.business('/api/v1/user/favlists', { Limit: 50 }, userId, true), collected = [];
        for (const list of lists.Items.filter(item => item.IsPublic !== false && /^\d+$/.test(String(item.UrlToken)))) collected.push(...await pages('/api/v1/user/favlist_contents', { FavlistUrlToken: String(list.UrlToken) }));
        if (!lists.Items.length) collected.push(...(await this.business('/api/v1/user/collections', { Limit: 50 }, userId, true)).Items);
        return [...new Map(collected.map((item, index) => [safeZhihuUrl(item.Url) || `item:${index}`, item])).values()];
      });
      counts[source] = sourceItems.length;
      for (const item of sourceItems) {
        const title = clean(source === 'followees' ? item.Fullname : item.Title, 160);
        const summary = clean(source === 'followees' ? item.Headline : item.Summary, 500);
        if (!title && !summary) continue;
        items.push({ kind: source, title: title || '无标题内容', summary, url: safeZhihuUrl(item.Url) });
      }
    }
    return { items, counts };
  }
  async search(query) {
    if (!this.config.zhihu.accessSecret) return { items: [], notice: '知乎参考内容尚未接入，破冰问题仅依据双方提供的兴趣。' };
    try {
      const data = await this.cached(`search:${query}`, () => this.business('/api/v1/content/zhihu_search', { Query: query, Count: 3 }));
      const items = data.Items.slice(0, 3).map((item, index) => ({ id: `source-${index + 1}`, title: clean(item.Title, 200), summary: clean(item.ContentText, 600), author: clean(item.AuthorName, 80), url: safeZhihuUrl(item.Url), scope: '搜索摘要' })).filter(item => item.title && item.url);
      return { items, notice: items.length ? null : '本次没有找到合适的知乎参考内容。' };
    } catch (error) { return { items: [], notice: error.message }; }
  }
}
