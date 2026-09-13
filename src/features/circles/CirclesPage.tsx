import { CircleDirectory } from './CircleDirectory';
import { CircleRoom } from './CircleRoom';
import type { Notify } from './CirclesCommon';
import './circles.css';

export interface CirclesPageProps {
  view?: 'discover' | 'mine';
  version?: number;
  initialCircleId?: string;
  onNavigate: (page: string) => void;
  onProfile: () => void;
  notify: Notify;
  onConversation?: (conversationId: string) => void;
}

export function CirclesPage({ view = 'discover', version = 0, initialCircleId, onNavigate, onProfile, notify, onConversation }: CirclesPageProps) {
  return <div className="cz-page">{initialCircleId ? <CircleRoom key={initialCircleId} circleId={initialCircleId} version={version} onNavigate={onNavigate} onConversation={onConversation} notify={notify}/> : <CircleDirectory key={view} view={view} version={version} onNavigate={onNavigate} onProfile={onProfile} notify={notify}/>}</div>;
}
