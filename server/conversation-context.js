import express from 'express';
import { createHash } from 'node:crypto';
import { fail } from './errors.js';
import { compareProfiles, publicProfile } from './matching.js';
import { basicProfile } from './knowledge-store.js';
import { modelNotice, ruleIcebreakers } from './ai.js';
import { safeZhihuUrl } from './zhihu.js';

const sourceText = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
function searchSources(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 3).map(source => ({
    id: sourceText(source?.id, 100), title: sourceText(source?.title, 200), summary: sourceText(source?.summary, 600),
    author: sourceText(source?.author, 80), url: safeZhihuUrl(source?.url), scope: sourceText(source?.scope, 80) || '搜索摘要',
  })).filter(source => source.id && source.title && source.url);
}

export function createConversationContextRouter({ store, ai, zhihu, rate, emit = () => {} }) {
  const router = express.Router(), db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_ai_consents (
    conversation_id TEXT NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY(conversation_id,user_id)
  ); CREATE TABLE IF NOT EXISTS conversation_icebreakers (
    conversation_id TEXT NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    input_key TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(conversation_id,user_id)
  );`);
  function consent(id, userId) {
    return db.prepare('SELECT enabled,revision FROM conversation_ai_consents WHERE conversation_id=? AND user_id=?').get(id,userId) || {enabled:0,revision:0};
  }
  function access(req) {
    const userId = req.viewer?.id, id = req.params.id;
    const session = store.session(req.cookies?.tongzhi_session);
    if (!userId || session?.user?.id !== userId || session.csrf !== req.csrf) fail(401, 'session_expired', '会话已结束，请刷新页面');
    if (typeof id !== 'string' || !id.length || id.length > 100) fail(400, 'invalid_conversation', '对话标识无效');
    const conversation = store.conversation(userId, id);
    const partnerId = conversation.sender_id === userId ? conversation.recipient_id : conversation.sender_id;
    const own = store.profile(userId), partner = store.profile(partnerId), identity = store.user(partnerId);
    const origin = db.prepare('SELECT origin,question FROM connection_context WHERE invitation_id=?').get(id);
    if (!identity || ((!own || !partner) && origin?.origin !== 'circle')) fail(409, 'conversation_profile_required', '双方都需要先生成自己的知识画像，才能查看聊天灵感');
    return {id,userId,partnerId,own,partner,identity,origin,myConsent:consent(id,userId),theirConsent:consent(id,partnerId)};
  }
  function unchanged(req, original) {
    const current = access(req);
    if (current.partnerId !== original.partnerId) fail(404, 'conversation_missing', '这段对话暂时无法访问');
    if (current.own?.revision !== original.own?.revision || current.partner?.revision !== original.partner?.revision) fail(409, 'conversation_profile_changed', '一方的知识画像已经更新，请刷新聊天灵感后重试');
    if (current.myConsent.revision !== original.myConsent.revision || current.theirConsent.revision !== original.theirConsent.revision) fail(409, 'conversation_consent_changed', '一方已调整 AI 话题授权，本次结果未保存');
    return current;
  }
  function matchFor(context) {
    if (context.own && context.partner) return compareProfiles(context.own, publicProfile(context.partner,context.identity));
    // Accepted circle connections retain the question shared with the invitation.
    // A missing profile never causes a sample persona to be substituted.
    return {...basicProfile(context.identity), shared:[], question:context.origin?.question || '',
      reasons:['你们已同意围绕共同参与的问题继续交流。','尚未发布的画像不用于推断知识水平或交流偏好。','可以先交换已有证据、不同解释与下一步验证方法。']};
  }
  function inputKey(context) {
    return createHash('sha256').update(JSON.stringify([context.id,context.userId,context.own?.revision,context.partner?.revision,context.myConsent.revision,context.theirConsent.revision,context.origin?.question])).digest('hex');
  }
  function cached(context) {
    if (!context.myConsent.enabled || !context.theirConsent.enabled) return null;
    const row = db.prepare('SELECT data FROM conversation_icebreakers WHERE conversation_id=? AND user_id=? AND input_key=? AND expires_at>?').get(context.id,context.userId,inputKey(context),Date.now());
    if (!row) return null;
    try { return JSON.parse(row.data); } catch { return null; }
  }
  function contextResult(context) {
    const match = matchFor(context), generated = cached(context);
    return {shared:match.shared,reasons:match.reasons,questions:ruleIcebreakers(match),mode:'rules',
      aiConsent:{mine:Boolean(context.myConsent.enabled),other:Boolean(context.theirConsent.enabled)},
      generated,generationKey:inputKey(context),autoGenerate:Boolean(context.myConsent.enabled && context.theirConsent.enabled && !generated)};
  }
  router.get('/:id/context', (req,res) => res.json(contextResult(access(req))));
  router.post('/:id/ai-consent', (req,res) => {
    const context = access(req);
    if (typeof req.body.enabled !== 'boolean') fail(400,'invalid_consent','请选择是否允许 AI 整理本段对话的知识话题');
    rate(`conversation-consent:${context.userId}`,20);
    if (Boolean(context.myConsent.enabled) !== req.body.enabled) {
      store.transaction(() => {
        db.prepare('INSERT INTO conversation_ai_consents VALUES (?,?,?,1,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET enabled=excluded.enabled,revision=conversation_ai_consents.revision+1,updated_at=excluded.updated_at').run(context.id,context.userId,Number(req.body.enabled),new Date().toISOString());
        db.prepare('DELETE FROM conversation_icebreakers WHERE conversation_id=?').run(context.id);
      });
      ai.clearCache?.(); emit(context.userId); emit(context.partnerId);
    }
    res.json(contextResult(access(req)));
  });
  router.post('/:id/icebreakers', async (req,res) => {
    const context = access(req), match = matchFor(context);
    if (!context.myConsent.enabled || !context.theirConsent.enabled) fail(403,'icebreaker_consent_required','双方都同意后，才会将共享兴趣和问题交给 AI 生成话题');
    const previous = cached(context);
    if (previous) return res.json(previous);
    rate(`conversation-ice:${context.userId}`,12);
    const query = match.shared.slice(0,2).map(topic => topic.label).join(' ') || context.origin?.question || match.interests[0]?.label || '知识交流';
    let references;
    try { references = await zhihu.search(query); }
    catch { references = {items:[],notice:'知乎参考内容暂时不可用，本次仅依据双方提供的兴趣与问题。'}; }
    unchanged(req,context);
    const sources = searchSources(references?.items);
    let generated;
    try { generated = await ai.icebreakers(context.own || {input:{question:context.origin?.question || ''}},match,sources); }
    catch { generated = {mode:'rules',questions:ruleIcebreakers(match),sourceIds:[],notice:modelNotice()}; }
    unchanged(req,context);
    const result = {mode:generated.mode,questions:generated.questions,sourceIds:generated.sourceIds,
      ...(generated.notice ? {notice:generated.notice} : {}),sources,sourceNotice:sourceText(references?.notice,500) || null};
    db.prepare('INSERT INTO conversation_icebreakers VALUES (?,?,?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET input_key=excluded.input_key,data=excluded.data,expires_at=excluded.expires_at').run(context.id,context.userId,inputKey(context),JSON.stringify(result),Date.now()+(generated.mode==='model'?15:2)*60000);
    res.json(result);
  });
  return router;
}
