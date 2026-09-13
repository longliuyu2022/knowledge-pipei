import express from 'express';
import { fail } from '../errors.js';
import { Circles } from './service.js';
import { identifier } from './validation.js';

export { normalizeQuestionUrl } from './validation.js';

export function createCircles(options) {
  const circles = new Circles(options), router = express.Router();
  router.use(async (req, res, next) => {
    circles.guard();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!req.viewer) fail(401, 'login_required', '请先登录再参与小组');
      if (req.body === undefined) req.body = {};
      if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object') fail(400, 'invalid_input', '请求需为 JSON 对象');
    }
    if (req.viewer) await circles.assertRequest(req, req.viewer.id);
    next();
  });
  router.get('/', (req, res) => res.json({ circles: circles.list(req.viewer?.id, req.query) }));
  router.get('/recommendations', (req, res) => res.json(circles.recommendations(req.viewer?.id, req.query)));
  router.post('/', (req, res) => res.status(201).json({ circle: circles.create(req.viewer.id, req.body) }));
  router.get('/:id', (req, res) => res.json({ circle: circles.detail(req.params.id, req.viewer?.id, req.query.roundId) }));
  router.patch('/:id', (req, res) => res.json({ circle: circles.settings(req.params.id, req.viewer.id, req.body) }));
  router.post('/:id/join', (req, res) => res.json({ circle: circles.join(req.params.id, req.viewer.id, req.body) }));
  router.patch('/:id/membership', (req, res) => res.json({ circle: circles.preferences(req.params.id, req.viewer.id, req.body) }));
  router.post('/:id/leave', (req, res) => res.json({ circle: circles.leave(req.params.id, req.viewer.id) }));
  router.post('/:id/read', (req, res) => res.json(circles.markRead(req.params.id, req.viewer.id, req.body)));
  router.patch('/:id/rounds/:roundId', (req, res) => res.json({ circle: circles.changePhase(req.params.id, req.viewer.id, req.params.roundId, req.body.status) }));
  router.post('/:id/rounds', (req, res) => res.status(201).json({ circle: circles.nextRound(req.params.id, req.viewer.id, req.body) }));
  router.get('/:id/messages', (req, res) => res.json(circles.page(req.params.id, req.viewer?.id, req.query)));
  router.post('/:id/messages', async (req, res) => { const result = await circles.sendMessage(req, req.params.id, req.body); res.status(result.deduplicated ? 200 : 201).json(result); });
  router.post('/:id/messages/:messageId/hide', (req, res) => res.json(circles.hideMessage(req.params.id, req.viewer.id, req.params.messageId)));
  router.delete('/:id/messages/:messageId', (req, res) => res.json(circles.hideMessage(req.params.id, req.viewer.id, req.params.messageId, true)));
  router.get('/:id/search', async (req, res) => res.json(await circles.search(req, req.params.id, req.query.q)));
  router.post('/:id/sources', (req, res) => res.status(201).json({ source: circles.addSource(req.params.id, req.viewer.id, req.body) }));
  router.delete('/:id/sources/:sourceId', (req, res) => res.json(circles.deleteSource(req.params.id, req.viewer.id, req.params.sourceId)));
  router.post('/:id/ai', async (req, res) => res.json(await circles.runAI(req, req.params.id, req.body)));
  router.post('/:id/outcomes', (req, res) => res.status(201).json({ outcome: circles.addOutcome(req.params.id, req.viewer.id, req.body) }));
  router.patch('/:id/outcomes/:outcomeId', (req, res) => res.json({ outcome: circles.editOutcome(req.params.id, req.viewer.id, req.params.outcomeId, req.body) }));
  router.get('/:id/outcomes/:outcomeId/versions', (req, res) => res.json({ versions: circles.outcomeVersions(req.params.id, req.viewer?.id, req.params.outcomeId) }));
  router.get('/:id/outcomes/:outcomeId/export', (req, res) => {
    const markdown = circles.exportOutcome(req.params.id, req.viewer?.id, req.params.outcomeId);
    res.type('text/markdown; charset=utf-8').attachment(`tongzhi-outcome-${identifier(req.params.outcomeId).replace(/[^a-zA-Z0-9_-]/g, '')}.md`).send(markdown);
  });
  router.post('/:id/blocks', (req, res) => res.json(circles.block(req.params.id, req.viewer.id, req.body.targetId)));
  router.delete('/:id/blocks/:targetId', (req, res) => res.json(circles.block(req.params.id, req.viewer.id, req.params.targetId, false)));
  router.post('/:id/reports', (req, res) => res.status(201).json({ reportId: circles.report(req.params.id, req.viewer.id, req.body) }));
  router.get('/:id/reports', (req, res) => res.json({ reports: circles.reports(req.params.id, req.viewer?.id) }));
  router.post('/:id/reports/:reportId/resolve', (req, res) => res.json(circles.resolveReport(req.params.id, req.viewer.id, req.params.reportId, req.body.action)));
  router.post('/:id/connect', async (req, res) => res.json(await circles.connect(req, req.params.id, req.body)));
  return {
    router, close: () => circles.close(), exportUser: userId => circles.exportUser(userId), deleteUser: userId => circles.deleteUser(userId),
    canConnect: (userId, targetId, circleId) => circles.canConnect(userId, targetId, circleId),
    recommendations: (userId, input) => circles.recommendations(userId, input),
    profileEvidence: (userId, circleId, messageIds) => circles.profileEvidence(userId, circleId, messageIds),
  };
}
