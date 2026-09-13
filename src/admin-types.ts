import type { Dimension, ZhihuValidationReport } from './types';

export interface AdminSession {
  configured: boolean;
  authenticated: boolean;
  username: string | null;
  csrf: string | null;
  expiresAt: string | null;
}

export interface AdminOverview {
  generatedAt: string;
  counts: {
    totalUsers: number;
    zhihuUsers: number;
    emailUsers: number;
    disabledUsers: number;
    guestUsers: number;
    profileUsers: number;
    discoverableUsers: number;
    onlineUsers: number;
    newUsersToday: number;
    connections: number;
    messages: number;
  };
  pairing: { searching: number; proposed: number };
  matching: { searching: number; proposed: number; paused: number; fulfilled: number; cancelled: number; expired: number };
  circles: { total: number; active: number; outcomes: number; openReports: number };
  moderation: { pending: number; restrictions: number };
  interests: { id: string; label: string; count: number }[];
  registrations: { date: string; zhihu: number; guest: number; email: number }[];
}

export interface AdminUserRow {
  id: string;
  name: string;
  avatar: string;
  provider: string;
  status: 'active' | 'disabled';
  emailMasked: string | null;
  hasEmail: boolean;
  createdAt: string;
  registeredAt: string | null;
  lastSeenAt: string | null;
  online: boolean;
  profile: null | {
    title: string;
    interests: { id: string; label: string }[];
    discoverable: boolean;
    analysisMode: string;
    updatedAt: string;
  };
  pairingStatus: string;
}

export interface AdminUserFilters {
  q: string;
  provider: 'all' | 'zhihu' | 'guest' | 'email';
  profile: 'all' | 'ready' | 'empty';
  visibility: 'all' | 'public' | 'private';
  topic: string;
  page: number;
}

export interface AdminUsers {
  items: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AdminUserDetail {
  governance: { sanctions: { id: string; kind: string; reason: string; expiresAt: string | null }[]; circles: number };
  zhihuValidation: ZhihuValidationReport | null;
  user: AdminUserRow;
  profile: null | {
    title: string;
    summary: string;
    highlights: string[];
    interests: { id: string; label: string; weight?: number }[];
    dimensions: Dimension[];
    style: { id: string; label: string; values: number[] };
    goals: string[];
    about: string;
    question: string;
    analysisMode: string;
    revision: number;
    discoverable: boolean;
    updatedAt: string;
  };
  activity: {
    connections: number;
    pendingInvitations: number;
    messages: number;
    saved: number;
    importedItems: number;
    importedAt: string | null;
  };
}

export interface AdminModerationCase {
  id: string;
  userId: string | null;
  userName: string | null;
  scope: string;
  scopeId: string;
  reason: string;
  decision: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  appeal: string | null;
  delivered: boolean | number;
}

export interface AdminOpenedCase {
  case: AdminModerationCase & { text: string };
  context: { speaker: 'subject' | 'other'; text: string }[];
}

export interface AdminCircleReport {
  id: string;
  circleId: string;
  circleTitle: string;
  messageId: string;
  reason: string;
  status: string;
  createdAt: string;
  text: string;
}
