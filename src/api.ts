let csrf = '';
export function setCSRF(value: string) { csrf = value; }
export class APIError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export async function api<T>(path: string, options: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...init } = options;
  const headers = new Headers(init.headers);
  if (json !== undefined) headers.set('Content-Type', 'application/json');
  if (init.method && !['GET', 'HEAD'].includes(init.method)) headers.set('X-CSRF-Token', csrf);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, headers, body: json === undefined ? init.body : JSON.stringify(json), credentials: 'same-origin', signal: init.signal || AbortSignal.timeout(80000) });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new APIError('网络暂时没有回应，请稍后再试。', 'network_error', 0);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || result === null) throw new APIError(result?.error?.message || '服务暂时无法响应，请稍后再试。', result?.error?.code || 'server_error', response.status);
  return result as T;
}
export const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请稍后再试。';
export function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
export async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return; }
  const input = document.createElement('textarea'); input.value = text;
  input.style.position = 'fixed'; input.style.opacity = '0'; document.body.appendChild(input); input.select();
  const copied = document.execCommand('copy'); input.remove();
  if (!copied) throw new Error('无法自动复制，请选中文字手动复制。');
}
