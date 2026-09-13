import { randomUUID, createHash } from 'node:crypto';
import { fail } from '../errors.js';

export const makeId = type => `${type}_${randomUUID()}`;
export const digest = text => createHash('sha256').update(text).digest('hex');
export const json = value => JSON.stringify(value);
export function parse(value, fallback = []) { try { return JSON.parse(value); } catch { return fallback; } }
export function text(value, label, max, min = 0) {
  if (value === undefined && min === 0) return '';
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(400, 'invalid_input', `${label}需为 ${min}–${max} 字的文本`);
  return value.trim();
}
export function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(400, 'invalid_input', '选项需为 true 或 false');
  return value;
}
export function oneOf(value, options, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!options.includes(value)) fail(400, 'invalid_input', '所选状态或类型无效');
  return value;
}
export function identifier(value, label = '标识') { return text(value, label, 100, 1); }
export function ids(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some(item => typeof item !== 'string' || !item || item.length > 100)) fail(400, 'invalid_reference', '引用列表无效');
  return [...new Set(value)];
}
export function capacity(value, fallback = 12) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 2 || value > 30) fail(400, 'invalid_capacity', '小组人数需在 2–30 人之间');
  return value;
}
export function tags(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) fail(400, 'invalid_tags', '最多填写 8 个主题标签');
  return [...new Set(value.map(tag => text(tag, '标签', 24, 1)))];
}
export function sourceUrl(value) {
  const raw = text(value, '资料链接', 2000, 1);
  let url; try { url = new URL(raw); } catch { fail(400, 'invalid_url', '请填写完整的 HTTP 或 HTTPS 链接'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail(400, 'invalid_url', '资料链接格式无效');
  return url.href;
}
export function normalizeQuestionUrl(value) {
  if (value === undefined || value === null || value === '') return { questionId: null, questionUrl: null };
  let url; try { url = new URL(text(value, '知乎问题链接', 2000, 1)); } catch (error) { if (error.status) throw error; fail(400, 'invalid_question_url', '请填写知乎问题页链接'); }
  const match = /^\/question\/(\d{1,30})(?:\/answer\/\d{1,30})?\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !['zhihu.com', 'www.zhihu.com', 'm.zhihu.com'].includes(url.hostname) || url.port || url.username || url.password || !match) fail(400, 'invalid_question_url', '仅支持 HTTPS 知乎问题页或该问题的回答链接');
  const questionId = match[1].replace(/^0+(?=\d)/, '');
  if (questionId === '0') fail(400, 'invalid_question_url', '知乎问题标识无效');
  return { questionId, questionUrl: `https://www.zhihu.com/question/${questionId}` };
}
