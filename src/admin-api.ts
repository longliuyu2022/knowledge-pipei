let adminCsrf: string | null = null;

export function setAdminCsrf(value: string | null) { adminCsrf = value; }

export class AdminAPIError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message);
    this.name = 'AdminAPIError';
  }
}

interface AdminRequestOptions {
  method?: 'GET' | 'POST';
  json?: unknown;
  signal?: AbortSignal;
  csrf?: string | null;
}

// The administrator has an independent cookie and CSRF token. Never import api.ts here.
export async function adminApi<T>(path: string, options: AdminRequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const headers = new Headers({ Accept: 'application/json' });
  if (options.json !== undefined) headers.set('Content-Type', 'application/json');
  if (options.method === 'POST') headers.set('X-CSRF-Token', options.csrf === undefined ? adminCsrf || '' : options.csrf || '');
  try {
    const response = await fetch(`/api/admin${path}`, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers,
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data === null) {
      throw new AdminAPIError(data?.error?.message || '暂时无法读取管理数据，请稍后重试。', data?.error?.code || 'admin_request_failed', response.status);
    }
    return data as T;
  } catch (error) {
    if (error instanceof AdminAPIError) throw error;
    if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    throw new AdminAPIError(timedOut ? '请求超时，请检查网络后重试。' : '网络连接失败，请检查网络后重试。', timedOut ? 'admin_timeout' : 'admin_network_error', 0);
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export function adminMessage(error: unknown) {
  return error instanceof AdminAPIError ? error.message : '暂时无法完成操作，请稍后重试。';
}

export function isAdminUnauthorized(error: unknown) {
  return error instanceof AdminAPIError && error.status === 401;
}
