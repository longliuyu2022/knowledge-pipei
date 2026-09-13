import express from 'express';
import { randomUUID } from 'node:crypto';
import { compareProfiles } from './matching.js';
import { fail, optionalText } from './errors.js';

const ACTIVE = ['searching', 'proposed'];
const iso = value => value ? new Date(value).toISOString() : null;

export class PersistentMatching {
  constructor(store, { now = Date.now, emit = () => {}, requestMs = 7 * 86400000, proposalMs = 48 * 3600000, intervalMs = 15000 } = {}) {
    this.store = store; this.db = store.db; this.now = now; this.emit = emit;
    this.requestMs = requestMs; this.proposalMs = proposalMs; this.running = false;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS match_requests (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL, mode TEXT NOT NULL, question TEXT NOT NULL, profile_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS match_proposals (
        id TEXT PRIMARY KEY, a_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        b_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, a_request TEXT NOT NULL,b_request TEXT NOT NULL,
        a_revision INTEGER NOT NULL,b_revision INTEGER NOT NULL, a_accepted INTEGER NOT NULL DEFAULT 0,
        b_accepted INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, conversation_id TEXT REFERENCES invitations(id) ON DELETE SET NULL,
        CHECK(a_id != b_id)
      );
      CREATE TABLE IF NOT EXISTS match_slots (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        proposal_id TEXT NOT NULL REFERENCES match_proposals(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS match_state ON match_requests(status,created_at);
      CREATE INDEX IF NOT EXISTS match_proposal_people ON match_proposals(a_id,b_id,created_at);
    `);
    this.db.prepare("INSERT OR IGNORE INTO jobs(id,kind,scope_id,payload,run_at,created_at,updated_at) VALUES (?,'matching','global','{}',?,?,?)").run(randomUUID(), this.now(), iso(this.now()), iso(this.now()));
    this.timer = setInterval(() => this.tick(), intervalMs); this.timer.unref();
  }
  close() { clearInterval(this.timer); }
  request(userId) { return this.db.prepare('SELECT * FROM match_requests WHERE user_id=?').get(userId); }
  valid(request) {
    return request && this.store.isActive(request.user_id) && this.store.profile(request.user_id)?.revision === request.profile_revision && request.expires_at > this.now();
  }
  notify(userId, data) { this.store.notify(userId, data); this.emit(userId, 'matching'); this.emit(userId); }
  release(proposal, status = 'cancelled', stoppedId = null, stoppedStatus = 'cancelled', reason = '') {
    if (proposal.status !== 'pending') return;
    this.db.prepare("UPDATE match_proposals SET status=? WHERE id=? AND status='pending'").run(status, proposal.id);
    this.db.prepare('DELETE FROM match_slots WHERE proposal_id=?').run(proposal.id);
    for (const userId of [proposal.a_id, proposal.b_id]) {
      const req = this.request(userId);
      if (!req || req.id !== (userId === proposal.a_id ? proposal.a_request : proposal.b_request)) continue;
      const state = userId === stoppedId ? stoppedStatus : this.valid(req) ? 'searching' : req.expires_at <= this.now() ? 'expired' : 'paused';
      this.db.prepare('UPDATE match_requests SET status=?,reason=? WHERE user_id=?').run(state, reason || (state === 'searching' ? '上次提案未建立连接，继续寻找合适的人。' : '匹配条件已改变，请检查后重新开始。'), userId);
      this.emit(userId, 'matching');
    }
  }
  invalidate(userId, reason = 'profile_changed') {
    if (reason === 'preferences_changed') return;
    const req = this.request(userId);
    if (!req || !ACTIVE.includes(req.status)) return;
    this.store.transaction(() => {
      const proposal = this.db.prepare("SELECT p.* FROM match_slots s JOIN match_proposals p ON p.id=s.proposal_id WHERE s.user_id=? AND p.status='pending'").get(userId);
      if (proposal) this.release(proposal, 'cancelled', userId, reason === 'deleted' ? 'cancelled' : 'paused', '画像、账号或屏蔽状态已更新，请确认后继续匹配。');
      else this.db.prepare("UPDATE match_requests SET status='paused',reason=? WHERE user_id=?").run('画像或账号状态已改变，请确认后继续。', userId);
    });
  }
  tick() {
    if (this.running) return;
    this.running = true;
    try {
      this.store.transaction(() => {
        const now = this.now();
        this.db.prepare("UPDATE jobs SET status='running',lease_until=?,attempts=attempts+1,updated_at=? WHERE kind='matching' AND scope_id='global'").run(now + 30000, iso(now));
        const proposals = this.db.prepare("SELECT * FROM match_proposals WHERE status='pending'").all();
        for (const p of proposals) {
          const a = this.request(p.a_id), b = this.request(p.b_id);
          if (p.expires_at <= now) this.release(p, 'expired');
          else if (!this.valid(a) || !this.valid(b) || a.id !== p.a_request || b.id !== p.b_request || this.store.isBlocked(p.a_id, p.b_id) || this.store.activeInvitationBetween(p.a_id, p.b_id)) this.release(p, 'cancelled');
        }
        const waiting = this.db.prepare("SELECT * FROM match_requests WHERE status='searching' ORDER BY created_at,user_id LIMIT 500").all();
        for (const req of waiting) if (!this.valid(req)) this.db.prepare('UPDATE match_requests SET status=?,reason=? WHERE user_id=?').run(req.expires_at <= now ? 'expired' : 'paused', '本轮已到期或画像更新，请确认后再开始。', req.user_id);
        const queue = waiting.filter(req => this.valid(req));
        for (const a of queue) {
          if (this.request(a.user_id)?.status !== 'searching') continue;
          const own = this.store.profile(a.user_id);
          const candidates = queue.filter(b => b.user_id !== a.user_id && this.request(b.user_id)?.status === 'searching'
            && !this.store.isBlocked(a.user_id, b.user_id) && !this.store.activeInvitationBetween(a.user_id, b.user_id)
            && !this.db.prepare("SELECT 1 FROM match_proposals WHERE ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?)) AND created_at>? AND status IN ('declined','expired','cancelled')").get(a.user_id, b.user_id, b.user_id, a.user_id, now - 7 * 86400000))
            .map(b => {
              const peer = this.store.profile(b.user_id);
              const ab = compareProfiles(own, this.store.privateProfileCard(b.user_id), a.mode);
              const ba = compareProfiles(peer, this.store.privateProfileCard(a.user_id), b.mode);
              return { b, score: (ab.score + ba.score) / 2, shared: ab.shared.length };
            }).filter(item => item.shared > 0).sort((x, y) => y.score - x.score || x.b.created_at - y.b.created_at || x.b.user_id.localeCompare(y.b.user_id));
          const b = candidates[0]?.b;
          if (!b) continue;
          const proposalId = randomUUID();
          this.db.prepare('INSERT INTO match_proposals(id,a_id,b_id,a_request,b_request,a_revision,b_revision,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)').run(proposalId, a.user_id, b.user_id, a.id, b.id, a.profile_revision, b.profile_revision, now, Math.min(now + this.proposalMs, a.expires_at, b.expires_at));
          for (const userId of [a.user_id, b.user_id]) {
            this.db.prepare('INSERT INTO match_slots VALUES (?,?)').run(userId, proposalId);
            this.db.prepare("UPDATE match_requests SET status='proposed',reason='' WHERE user_id=?").run(userId);
            this.notify(userId, { kind: 'match', title: '找到一位知识兴趣相近的伙伴', body: '查看具体共同点，双方确认后才建立聊天。你无需保持在线。', href: '#matching', key: `proposal:${proposalId}` });
          }
        }
        this.db.prepare("UPDATE jobs SET status='queued',lease_until=NULL,run_at=?,error=NULL,updated_at=? WHERE kind='matching' AND scope_id='global'").run(now + 15000, iso(now));
      });
    } finally { this.running = false; }
  }
  snapshot(userId) {
    const req = this.request(userId);
    let p = this.db.prepare("SELECT p.* FROM match_proposals p WHERE ((p.a_id=? AND p.a_request=?) OR (p.b_id=? AND p.b_request=?)) AND p.status IN ('pending','accepted') ORDER BY p.created_at DESC LIMIT 1").get(userId, req?.id || '', userId, req?.id || '');
    const partnerId = p && (p.a_id === userId ? p.b_id : p.a_id);
    if (partnerId && (this.store.isBlocked(userId, partnerId) || !this.store.isActive(partnerId))) p = null;
    const own = this.store.profile(userId), person = p && this.store.privateProfileCard(partnerId);
    const match = own && person ? { ...compareProfiles(own, person, req.mode), saved: this.store.savedIds(userId).includes(partnerId) } : null;
    const reasons = match ? [...match.reasons.slice(0, 2), req.question ? `你希望讨论：${req.question}` : '可以从共同兴趣中的一个具体问题开始。'] : [];
    const counts = Object.fromEntries(this.db.prepare("SELECT status,COUNT(*) AS n FROM match_requests WHERE status IN ('searching','proposed') AND expires_at>? GROUP BY status").all(this.now()).map(row => [row.status, row.n]));
    return {
      request: req ? { id: req.id, status: req.status, question: req.question, mode: req.mode, expiresAt: iso(req.expires_at), createdAt: iso(req.created_at) } : null,
      proposal: p && match ? { id: p.id, person: match, reasons, acceptedByMe: Boolean(p.a_id === userId ? p.a_accepted : p.b_accepted), acceptedByOther: Boolean(p.a_id === userId ? p.b_accepted : p.a_accepted), expiresAt: iso(p.expires_at) } : null,
      counts: { searching: counts.searching || 0, proposed: counts.proposed || 0 },
      conversationId: p?.status === 'accepted' ? p.conversation_id : null,
      notice: req?.reason || (req?.status === 'searching' ? '正在后台寻找合适的人，关闭页面也会继续。' : null),
    };
  }
  state(userId) { this.tick(); return this.snapshot(userId); }
  start(userId, { revision, mode = 'resonance', question = '' } = {}) {
    this.tick();
    const profile = this.store.profile(userId);
    if (!profile) fail(400, 'profile_required', '先生成并确认知识画像，再发起匹配');
    if (!this.store.isActive(userId) || revision !== profile.revision) fail(409, 'profile_changed', '画像或账号已改变，请刷新后重试');
    if (!['resonance', 'complement'].includes(mode)) fail(400, 'invalid_mode', '请选择同频或互补匹配');
    question = optionalText(question, '希望讨论的问题', 200) || profile.input.question;
    const current = this.request(userId);
    if (current && ACTIVE.includes(current.status)) {
      if (current.mode !== mode || current.question !== question) fail(409, 'matching_active', '请先取消当前请求再修改匹配目标');
      return this.snapshot(userId);
    }
    const now = this.now();
    this.db.prepare("INSERT INTO match_requests VALUES (?,?,'searching',?,?,?,?,?,'') ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,status='searching',mode=excluded.mode,question=excluded.question,profile_revision=excluded.profile_revision,created_at=excluded.created_at,expires_at=excluded.expires_at,reason=''").run(userId, randomUUID(), mode, question, profile.revision, now, now + this.requestMs);
    return this.state(userId);
  }
  control(userId, requestId, action) {
    this.tick();
    const req = this.request(userId);
    if (!req || req.id !== requestId) fail(409, 'matching_changed', '这轮请求已改变，请刷新');
    if (action === 'resume') {
      if (req.status !== 'paused') fail(409, 'matching_changed', '只有暂停的请求可以继续');
      const profile = this.store.profile(userId);
      if (!profile || !this.store.isActive(userId) || req.expires_at <= this.now()) fail(409, 'matching_expired', '本轮已到期，请重新发起');
      this.db.prepare("UPDATE match_requests SET status='searching',profile_revision=?,reason='' WHERE user_id=?").run(profile.revision, userId);
    } else {
      if (!ACTIVE.includes(req.status) && req.status !== 'paused') return this.snapshot(userId);
      this.store.transaction(() => {
        const p = this.db.prepare('SELECT p.* FROM match_slots s JOIN match_proposals p ON p.id=s.proposal_id WHERE s.user_id=?').get(userId);
        if (p) this.release(p, 'cancelled', userId, action === 'pause' ? 'paused' : 'cancelled');
        this.db.prepare('UPDATE match_requests SET status=?,reason=? WHERE user_id=?').run(action === 'pause' ? 'paused' : 'cancelled', action === 'pause' ? '匹配已暂停，你可以在本轮有效期内继续。' : '本轮匹配已取消。', userId);
      });
    }
    return this.state(userId);
  }
  respond(userId, proposalId, decision) {
    if (!['accept', 'decline'].includes(decision)) fail(400, 'invalid_decision', '请选择接受或婉拒');
    this.tick();
    const p = this.db.prepare('SELECT * FROM match_proposals WHERE id=? AND (a_id=? OR b_id=?)').get(proposalId, userId, userId);
    if (!p) fail(404, 'proposal_missing', '找不到这份提案');
    if (p.status === 'accepted') return this.snapshot(userId);
    if (p.status !== 'pending' || p.expires_at <= this.now()) fail(409, 'proposal_expired', '提案已失效，尚未建立聊天');
    this.store.transaction(() => {
      if (decision === 'decline') { this.release(p, 'declined'); return; }
      const a = this.request(p.a_id), b = this.request(p.b_id);
      if (!this.valid(a) || !this.valid(b) || this.store.isBlocked(p.a_id, p.b_id)) fail(409, 'proposal_changed', '一方的匹配条件已改变');
      this.db.prepare(`UPDATE match_proposals SET ${p.a_id === userId ? 'a_accepted' : 'b_accepted'}=1 WHERE id=?`).run(p.id);
      const updated = this.db.prepare('SELECT * FROM match_proposals WHERE id=?').get(p.id);
      if (updated.a_accepted && updated.b_accepted) {
        if (this.store.activeInvitationBetween(p.a_id, p.b_id)) fail(409, 'connection_exists', '你们之间已有连接或邀请');
        const at = iso(this.now());
        const text = '通过知识匹配相遇，双方已确认交流。';
        this.db.prepare("INSERT INTO invitations(id,sender_id,recipient_id,message,status,created_at,updated_at) VALUES (?,?,?,?,'accepted',?,?)").run(p.id, p.a_id, p.b_id, text, at, at);
        this.db.prepare('INSERT INTO connection_context VALUES (?,?,?,?,?)').run(p.id, 'matching', null, a.question || b.question, at);
        this.db.prepare("UPDATE match_proposals SET status='accepted',conversation_id=? WHERE id=?").run(p.id, p.id);
        this.db.prepare('DELETE FROM match_slots WHERE proposal_id=?').run(p.id);
        this.db.prepare("UPDATE match_requests SET status='fulfilled',reason='' WHERE user_id IN (?,?)").run(p.a_id, p.b_id);
        for (const id of [p.a_id, p.b_id]) this.notify(id, { kind: 'connection', title: '双方已确认，可以开始交流', body: '从共同问题的一个细节开始，话题建议已为你准备。', href: `#connections/${p.id}`, key: `connected:${p.id}` });
      }
    });
    this.emit(p.a_id, 'matching'); this.emit(p.b_id, 'matching'); this.emit(p.a_id); this.emit(p.b_id);
    return this.state(userId);
  }
  router(rate) {
    const router = express.Router();
    router.get('/', (req, res) => res.json(this.state(req.viewer.id)));
    router.post('/start', (req, res) => { rate(`match-start:${req.viewer.id}`, 8); res.json(this.start(req.viewer.id, req.body)); });
    for (const action of ['pause', 'resume', 'cancel']) router.post(`/${action}`, (req, res) => { rate(`match-control:${req.viewer.id}`, 30); res.json(this.control(req.viewer.id, req.body.requestId, action)); });
    router.post('/respond', (req, res) => { rate(`match-response:${req.viewer.id}`, 20); res.json(this.respond(req.viewer.id, req.body.proposalId, req.body.decision)); });
    return router;
  }
}
