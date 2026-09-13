import express from 'express';
import { hashPassword, verifyPassword, normalizeEmail, passwordInput } from './email-auth.js';
import { fail, requiredText } from './errors.js';

export function createAccounts({ store, rate, assertSession, cookieOptions, emit, zhihu }) {
  const router = express.Router();
  function signIn(req, res, userId) {
    store.endSession(req.cookies.tongzhi_session);
    const next = store.createSession(userId);
    res.cookie('tongzhi_session', next.token, { ...cookieOptions, maxAge: 30 * 86400000 });
    emit(userId);
    return { ok: true, csrf: next.csrf };
  }
  router.get('/account', (req, res) => res.json(store.account(req.viewer.id)));
  router.post('/auth/email/register', async (req, res) => {
    rate(`email-register:${req.ip}`, 5, 15 * 60000);
    const email = normalizeEmail(req.body.email), password = passwordInput(req.body.password, { creating: true });
    const name = requiredText(req.body.name, '站内昵称', 24);
    const hash = await hashPassword(password);
    assertSession(req);
    store.registerEmail(req.viewer.id, email, hash, name);
    res.status(201).json(signIn(req, res, req.viewer.id));
  });
  router.post('/auth/email/login', async (req, res) => {
    rate(`email-login:${req.ip}`, 12, 15 * 60000);
    const email = normalizeEmail(req.body.email), password = passwordInput(req.body.password);
    rate(`email-account:${email}`, 8, 15 * 60000);
    const account = store.db.prepare('SELECT * FROM email_accounts WHERE email=?').get(email);
    const valid = await verifyPassword(password, account?.password_hash);
    assertSession(req);
    const fresh = account && store.db.prepare('SELECT * FROM email_accounts WHERE user_id=?').get(account.user_id);
    if (!valid || !fresh || fresh.password_hash !== account.password_hash || !store.isActive(account.user_id)) fail(401, 'login_failed', '邮箱或密码不正确，或账号已停用');
    res.json(signIn(req, res, account.user_id));
  });
  router.post('/auth/email/password', async (req, res) => {
    rate(`email-password:${req.viewer.id}`, 4, 15 * 60000);
    const current = store.db.prepare('SELECT * FROM email_accounts WHERE user_id=?').get(req.viewer.id);
    if (!current) fail(400, 'email_required', '请先绑定邮箱');
    const nextPassword = passwordInput(req.body.newPassword, { creating: true });
    const valid = await verifyPassword(passwordInput(req.body.currentPassword), current.password_hash);
    if (!valid) fail(401, 'password_wrong', '当前密码不正确');
    const next = await hashPassword(nextPassword);
    assertSession(req);
    const changed = store.db.prepare('UPDATE email_accounts SET password_hash=?,updated_at=? WHERE user_id=? AND password_hash=?').run(next, new Date().toISOString(), req.viewer.id, current.password_hash);
    if (!changed.changes) fail(409, 'account_changed', '账号已改变，请重新登录');
    store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.viewer.id);
    zhihu.forget(req.viewer.id);
    res.json(signIn(req, res, req.viewer.id));
  });
  router.get('/preferences', (req, res) => res.json(store.preferences(req.viewer.id)));
  router.put('/preferences', (req, res) => {
    const result = store.setPreferences(req.viewer.id, req.body.preferences, req.body.revision);
    emit(req.viewer.id);
    res.json(result);
  });
  router.get('/notifications', (req, res) => res.json(store.notifications(req.viewer.id)));
  router.post('/notifications/read', (req, res) => { const result = store.markNotifications(req.viewer.id, req.body.ids); emit(req.viewer.id); res.json(result); });
  return router;
}
