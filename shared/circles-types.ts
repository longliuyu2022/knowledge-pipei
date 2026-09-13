export type CircleDuration = '24h' | '7d' | 'ongoing';
export type CirclePhase = 'recruiting' | 'discussing' | 'reviewing' | 'completed' | 'archived' | 'dormant';
export type CircleAIAction = 'opener' | 'summary' | 'outcome';
export interface CircleAuthor { id: string; name: string; avatar: string; avatarHue: number }
export interface CircleRound {
  id: string; circleId: string; number: number; question: string; goal: string;
  status: CirclePhase; createdAt: string; updatedAt: string;
}
export interface CircleMembership {
  userId: string; role: 'host' | 'member'; active: boolean; duration: CircleDuration;
  goal: string; stage: string; subscribed: boolean; allowConnections: boolean; aiConsent: boolean;
  joinedAt: string; expiresAt: string | null;
}
export interface CircleSummary {
  id: string; title: string; description: string; questionId: string | null; questionUrl: string | null;
  tags: string[]; capacity: number; memberCount: number; currentRound: CircleRound;
  joined: boolean; membership: CircleMembership | null; unreadCount: number;
  aiEnabled: boolean; autoSummary: boolean;
  aiStatus: { pending: boolean; lastRunAt: string | null; lastSummaryAt: string | null };
  createdAt: string; updatedAt: string;
}
export interface CircleMember extends CircleAuthor {
  role: 'host' | 'member'; goal: string; stage: string; joinedAt: string;
  expiresAt: string | null; blocked: boolean; canConnect: boolean;
}
export interface CircleCitation { messageId: string; name: string; quote: string; label?: string }
export interface CircleSource {
  id: string; circleId: string; roundId: string; title: string; url: string; author: string;
  summary: string; scope: 'link' | 'excerpt' | 'zhihu-search'; createdBy: string | null; createdAt: string;
}
export interface CircleMessage {
  id: string; circleId: string; roundId: string; kind: 'human' | 'ai' | 'system';
  authorId: string | null; author: CircleAuthor | null; text: string;
  replyTo: string | null; reply: { id: string; text: string; authorName: string } | null;
  action: CircleAIAction | null; aiMode: 'model' | 'rules' | null;
  citations: CircleCitation[]; sourceIds: string[]; hidden: boolean; redacted: boolean; createdAt: string;
}
export interface CircleOutcome {
  id: string; circleId: string; roundId: string; title: string; content: string;
  status: 'draft' | 'reviewed'; version: number; aiMode: 'model' | 'rules' | null;
  citations: CircleCitation[]; sourceIds: string[]; redacted: boolean;
  createdBy: string | null; updatedBy: string | null; reviewedBy: string | null;
  reviewedByName: string | null; reviewedAt: string | null; createdAt: string; updatedAt: string;
}
export interface CircleDetail extends CircleSummary {
  selectedRoundId: string; rounds: CircleRound[]; members: CircleMember[];
  messages: CircleMessage[]; sources: CircleSource[]; outcomes: CircleOutcome[];
  hasMoreMessages: boolean; nextBefore: string | null;
}
export interface CircleRecommendation extends CircleSummary { reasons: string[] }
export interface CircleRecommendations {
  circles: CircleRecommendation[]; mode: 'rules'; notice: string | null; profileUsed: boolean;
}
export interface CircleSearchItem {
  id: string; title: string; url: string; author: string; summary: string;
  searchResultToken: string; scope: 'zhihu-search';
}
export interface CircleReport {
  id: string; messageId: string; reason: string; status: 'open' | 'hidden' | 'dismissed';
  reporterId: string | null; createdAt: string; resolvedAt: string | null;
  message: { text: string; authorName: string; hidden: boolean };
}
export interface CircleAIResult {
  message: CircleMessage; outcome: CircleOutcome | null; mode: 'model' | 'rules'; notice: string | null;
}
