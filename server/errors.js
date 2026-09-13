export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new AppError(status, code, message); };

export function requiredText(value, label, max = 500, min = 1) {
  if (typeof value !== 'string') fail(400, 'invalid_input', `${label}格式不正确`);
  const text = value.trim();
  if (text.length < min || text.length > max) fail(400, 'invalid_input', `${label}需要 ${min}–${max} 个字符`);
  return text;
}

export function optionalText(value, label, max = 500) {
  return value === undefined || value === '' ? '' : requiredText(value, label, max, 0);
}
