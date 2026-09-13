import { fail } from './errors.js';

export const ZHIHU_CHECKS = Object.freeze([
  { id: 'contents', label: '我的创作', path: '/api/v1/user/contents', params: { ContentType: 'all', SortField: 'ts', SortOrder: 'desc', Offset: 0 } },
  { id: 'followees', label: '我关注的人', path: '/api/v1/user/followees', params: { Offset: 0 } },
  { id: 'favlists', label: '我的收藏夹', path: '/api/v1/user/favlists', params: {} },
  { id: 'favlist_contents', label: '收藏夹中的内容', path: '/api/v1/user/favlist_contents', params: { Offset: 0 } },
  { id: 'collections', label: '我的近期收藏', path: '/api/v1/user/collections', params: {} },
]);

const messages = {
  zhihu_expired: '知乎连接已失效，请重新连接后检查。',
  zhihu_unconfigured: '知乎数据连接尚未配置。',
  zhihu_rate_limited: '知乎请求次数或额度受限，请稍后再检查。',
  zhihu_response_invalid: '知乎返回的数据不完整，请稍后重试。',
  zhihu_unavailable: '知乎服务暂时没有回应，请稍后重试。',
};

// A five-request check begins only when the entire local one-minute budget is free.
// The normal limiter still applies to every individual request, including concurrent callers.
export function zhihuCheckRetryAt(zhihu, timestamp = Date.now()) {
  const recent = zhihu.calls.filter(at => timestamp - at < 60000);
  const next = Math.max(zhihu.cooldown || 0, ...recent.map(at => at + 60001));
  return next > timestamp ? new Date(next).toISOString() : null;
}

function favlistToken(value) {
  const token = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : '';
  return /^[1-9]\d{0,18}$/.test(token) && BigInt(token) <= 9223372036854775807n ? token : null;
}

export async function checkZhihuData(zhihu, userId, assertCurrent = () => {}) {
  if (!zhihu.config.zhihu.accessSecret) fail(503, 'zhihu_unconfigured', '知乎内容连接暂未开放');
  const originalToken = zhihu.token(userId);
  if (!originalToken) fail(401, 'zhihu_expired', '请先重新连接知乎，再检查可用数据');
  const originalGrant = zhihu.tokens.get(userId);
  if (zhihuCheckRetryAt(zhihu)) fail(429, 'zhihu_rate_limited', '刚刚读取过知乎数据，请稍后再检查，避免重复消耗额度');
  const rows = [];
  let listResult = null, stopped = null;
  const ensureCurrent = () => {
    assertCurrent();
    const token = zhihu.token(userId);
    if (token && (token !== originalToken || zhihu.tokens.get(userId) !== originalGrant)) fail(401, 'session_changed', '知乎连接已更新，请重新打开检查');
  };
  for (const check of ZHIHU_CHECKS) {
    ensureCurrent();
    const row = { id: check.id, label: check.label, status: 'skipped', count: null, code: null, message: '' };
    rows.push(row);
    if (stopped) { row.code = stopped; row.message = '前面的检查遇到授权或额度问题，本项尚未读取。'; continue; }
    if (check.id === 'favlist_contents' && !listResult) {
      row.code = 'dependency_failed'; row.message = '尚未取得收藏夹，本项尚未读取。'; continue;
    }
    if (check.id === 'favlist_contents' && listResult.Items.length === 0) {
      Object.assign(row, { status: 'empty', count: 0, code: 'no_favorite_list', message: '没有可读取的公开收藏夹，本项按空数据记录。' }); continue;
    }
    try {
      const params = { ...check.params, Limit: 1 };
      if (check.id === 'favlist_contents') {
        params.FavlistUrlToken = favlistToken(listResult.Items[0]?.UrlToken);
        if (!params.FavlistUrlToken) fail(502, 'zhihu_response_invalid', '收藏夹标识格式不完整');
      }
      const result = await zhihu.business(check.path, params, userId);
      ensureCurrent();
      if (check.id === 'favlists') listResult = result;
      const count = Math.min(1, result.Items.length);
      Object.assign(row, { status: count ? 'success' : 'empty', count, message: count ? '可读取，已检查 1 条。' : '接口正常，当前范围没有公开数据。' });
    } catch (error) {
      ensureCurrent();
      if (error.code === 'session_changed' || error.code === 'session_expired') throw error;
      const code = Object.hasOwn(messages, error.code) ? error.code : 'zhihu_unavailable';
      Object.assign(row, { status: 'error', code, message: messages[code] });
      if (error.status === 401 || error.status === 429 || error.status === 503) stopped = code;
    }
  }
  ensureCurrent();
  const ready = rows.filter(row => row.status === 'success' || row.status === 'empty').length;
  return { checkedAt: new Date().toISOString(), status: ready === ZHIHU_CHECKS.length ? 'passed' : ready ? 'partial' : 'failed', items: rows };
}
