import express from 'express';
import { fail } from './errors.js';
import { compareProfiles, publicProfile } from './matching.js';
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

export function createConversationContextRouter({ store, ai, zhihu, rate }) {
  const router = express.Router();

  function access(req) {
    const userId = req.viewer?.id;
    const session = store.session(req.cookies?.soul_session);
    if (!userId || session?.user?.id !== userId || session.csrf !== req.csrf) fail(401, 'session_expired', '会话已结束，请刷新页面');
    if (typeof req.params.id !== 'string' || !req.params.id.length || req.params.id.length > 100) fail(400, 'invalid_conversation', '对话标识无效');
    const conversation = store.conversation(userId, req.params.id);
    const partnerId = conversation.sender_id === userId ? conversation.recipient_id : conversation.sender_id;
    const own = store.profile(userId), partner = store.profile(partnerId), identity = store.user(partnerId);
    if (!own || !partner || !identity) fail(409, 'conversation_profile_required', '双方都需要先生成自己的知识画像，才能查看聊天灵感');
    return { userId, partnerId, own, partner, identity };
  }

  function unchanged(req, original) {
    // Re-read the original browser session, accepted relationship and both profile
    // revisions after each external await, including calls that use an AI cache.
    const current = access(req);
    if (current.partnerId !== original.partnerId) fail(404, 'conversation_missing', '这段对话暂时无法访问');
    if (current.own.revision !== original.own.revision || current.partner.revision !== original.partner.revision) fail(409, 'conversation_profile_changed', '一方的知识画像已经更新，请刷新聊天灵感后重试');
  }

  function matchFor(context) {
    // An accepted connection grants access even when either profile is private.
    // This uses only the two stored profiles and never substitutes demo content.
    return compareProfiles(context.own, publicProfile(context.partner, context.identity));
  }

  router.get('/:id/context', (req, res) => {
    const match = matchFor(access(req));
    res.json({ shared: match.shared, reasons: match.reasons, questions: ruleIcebreakers(match), mode: 'rules' });
  });

  router.post('/:id/icebreakers', async (req, res) => {
    const context = access(req), match = matchFor(context);
    rate(`conversation-ice:${context.userId}`, 12);
    const query = match.shared.slice(0, 2).map(topic => topic.label).join(' ') || match.interests[0]?.label || '知识交流';
    let references;
    try { references = await zhihu.search(query); }
    catch { references = { items: [], notice: '知乎参考内容暂时不可用，本次仅依据双方提供的兴趣。' }; }
    unchanged(req, context);
    const sources = searchSources(references?.items);
    let generated;
    try { generated = await ai.icebreakers(context.own, match, sources); }
    catch { generated = { mode: 'rules', questions: ruleIcebreakers(match), sourceIds: [], notice: modelNotice() }; }
    unchanged(req, context);
    // Return the existing Icebreakers contract, without either stored profile or
    // any of its private evidence, source imports, vectors or authentication data.
    res.json({ mode: generated.mode, questions: generated.questions, sourceIds: generated.sourceIds,
      ...(generated.notice ? { notice: generated.notice } : {}), sources, sourceNotice: sourceText(references?.notice, 500) || null });
  });

  return router;
}
