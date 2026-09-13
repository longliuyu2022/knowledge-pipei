import type { Dimension } from './types';

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
    guestUsers: number;
    profileUsers: number;
    discoverableUsers: number;
    onlineUsers: number;
    newUsersToday: number;
    connections: number;
    messages: number;
  };
  pairing: { searching: number; proposed: number };
  interests: { id: string; label: string; count: number }[];
  registrations: { date: string; zhihu: number; guest: number }[];
}

export interface AdminUserRow {
  id: string;
  name: string;
  avatar: string;
  provider: string;
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
  provider: 'all' | 'zhihu' | 'guest';
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
