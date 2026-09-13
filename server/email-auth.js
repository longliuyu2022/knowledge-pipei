import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { domainToASCII } from 'node:url';
import { AppError } from './errors.js';

export class AccountError extends AppError {}

export function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 320) throw new AccountError(400, 'invalid_email', '请输入有效的邮箱地址');
  const parts = value.trim().toLowerCase().split('@');
  const local = parts[0];
  const domain = parts.length === 2 ? domainToASCII(parts[1]) : '';
  const labels = domain.split('.');
  if (!local || local.length > 64 || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..') || labels.length < 2
    || !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || `${local}@${domain}`.length > 254) throw new AccountError(400, 'invalid_email', '请输入有效的邮箱地址');
  return `${local}@${domain}`;
}

export function passwordInput(value, { creating = false } = {}) {
  if (typeof value !== 'string' || value.length < (creating ? 8 : 1) || value.length > 128 || value.includes('\u0000')) {
    throw new AccountError(400, 'invalid_password', creating ? '密码须为 8–128 个字符' : '请输入密码');
  }
  if (creating && !value.trim()) throw new AccountError(400, 'invalid_password', '密码不能全部为空格');
  return value;
}

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const prefix = 'scrypt-v1';
let working = 0;
async function key(password, salt) {
  if (working >= 4) throw new AccountError(429, 'auth_busy', '登录服务繁忙，请稍后重试');
  working++;
  try { return await derive(password, salt, 64, options); }
  finally { working--; }
}

export async function hashPassword(password) {
  passwordInput(password, { creating: true });
  const salt = randomBytes(16).toString('hex');
  return `${prefix}$${salt}$${(await key(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  passwordInput(password);
  const parts = typeof encoded === 'string' ? encoded.split('$') : [];
  const valid = parts.length === 3 && parts[0] === prefix && /^[a-f0-9]{32}$/.test(parts[1]) && /^[a-f0-9]{128}$/.test(parts[2]);
  // Missing accounts still incur the password derivation cost.
  const derived = await key(password, valid ? parts[1] : '0'.repeat(32));
  const expected = valid ? Buffer.from(parts[2], 'hex') : Buffer.alloc(64);
  return timingSafeEqual(derived, expected) && valid;
}
