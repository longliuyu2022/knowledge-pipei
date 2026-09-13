export type Page = 'discover' | 'profile' | 'graph' | 'connections';
export type Pool = 'demo' | 'people';
export type Mode = 'resonance' | 'complement';
export type AnalysisMode = 'model' | 'rules';
export interface Input {
  name: string; topicIds: string[]; about: string; question: string; styleId: string; goals: string[];
}
export interface Interest { id: string; label: string; weight: number }
export interface Dimension { id: string; label: string; color: string; value: number }
export interface Evidence { id: string; label: string; text: string; kind: string; topicIds: string[]; url?: string }
export interface Profile {
  input: Input; title: string; summary: string; highlights: string[];
  interests: Interest[]; dimensions: Dimension[]; vector: number[];
  style: { id: string; label: string; values: number[] };
  evidence: Evidence[]; evidenceIds: string[];
  analysis: { mode: AnalysisMode; notice?: string };
  revision: number; discoverable: boolean; updatedAt: string;
}
export interface Person {
  id: string; name: string; provider: string; avatar: string; avatarSeed: string;
  about: string; question: string; goals: string[]; selectedTopicIds: string[];
  title: string; summary: string; highlights: string[]; interests: Interest[];
  dimensions: Dimension[]; vector: number[]; style: Profile['style'];
  analysis: { mode: AnalysisMode }; demo: boolean;
}
export interface Match extends Person {
  score: number; shared: { id: string; label: string }[]; newTopics: Interest[];
  reasons: string[]; breakdown: { id: string; label: string; value: number; weight: number }[];
  matchingMode: Mode; algorithm: 'topics' | 'embedding'; saved: boolean;
}
export interface Bootstrap {
  user: { id: string; name: string; provider: string; avatar: string };
  csrf: string; profile: Profile | null; sampleProfile: Profile;
  capabilities: { ai: boolean; embedding: boolean; oauth: boolean; zhihuData: boolean; zhihuSearch: boolean };
  zhihuConnected: boolean; imports: { count: number; fetchedAt: string | null };
  savedIds: string[]; incomingCount: number;
}
export interface Explanation { mode: AnalysisMode; reasons: string[]; bridge: string; notice?: string }
export interface Source { id: string; title: string; summary: string; author: string; url: string; scope: string }
export interface Icebreakers { mode: AnalysisMode; questions: string[]; sourceIds: string[]; sources: Source[]; notice?: string; sourceNotice?: string }
export interface Invitation {
  id: string; direction: 'incoming' | 'outgoing'; status: 'pending' | 'accepted';
  message: string; createdAt: string; person: Person;
  lastMessage: { text: string; createdAt: string } | null;
}
export interface Message { id: string; authorId: string; text: string; createdAt: string }
export interface Conversation { person: Person; invitation: string; items: Message[]; hasMore: boolean; nextBefore: string | null }
export interface PageActions {
  data: Bootstrap; refresh: () => Promise<void>; notify: (text: string, error?: boolean) => void;
  onCreate: () => void; onLogin: () => void; onImport: () => void;
  onSelect: (match: Match) => void; onSave: (match: Match) => Promise<void>;
  navigate: (page: Page, pool?: Pool) => void;
}
