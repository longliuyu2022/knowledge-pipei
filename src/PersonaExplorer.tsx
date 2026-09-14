import { PERSONA_DRIVES, PERSONA_CONNECTIONS, personaFor, personaAnalysis } from '../shared/personas.js';
import type { Profile } from './types';
import './persona.css';

export function PersonaExplorer({ profile, sample, onEdit }: { profile: Profile; sample: boolean; onEdit: () => void }) {
  const own = personaFor(profile.input);
  if (sample || !own) return <section className="panel persona-explorer"><h2>认识自己，从你的选择开始</h2><p className="persona-intro">选择核心追求和连接方式，生成属于你的称号与解读。</p><button className="button secondary" onClick={onEdit}>{sample ? '开始认识自己' : '补充我的人格选择'}</button></section>;
  const drive = PERSONA_DRIVES.find(item => item.id === own.driveId)!;
  const connection = PERSONA_CONNECTIONS.find(item => item.id === own.connectionId)!;
  return <section className="panel persona-explorer" aria-labelledby="persona-explorer-title">
    <div className="section-heading"><h2 id="persona-explorer-title">更认识一点自己</h2><button className="button secondary" onClick={onEdit}>调整我的人格</button></div>
    <div id="persona-reading" className="persona-reading">
      <p className="persona-eyebrow">我的人格解读 · {drive.label} × {connection.label}</p>
      <h3>如何评价「{own.name}」这种人格？</h3><p className="persona-quote">{own.tagline}</p>
      <div className="persona-basis"><strong>从你的选择出发</strong><p>你主动选择了「{drive.label}」与「{connection.label}」。当前画像的兴趣线索包括{profile.interests.slice(0, 3).map(item => item.label).join('、')}，交流偏好是「{profile.style.label}」。</p><p>从「{profile.interests[0]?.label || '最近的兴趣'}」找一个真实经历：什么时候这个称号很像你，什么时候又不像？</p></div>
      <div className="persona-analysis-grid">{personaAnalysis(profile.input).map(item => <article key={item.title}><h4>{item.title}</h4><p>{item.text}</p></article>)}</div>
      <p className="persona-footnote">这些提示供自我探索参考，不是心理测评。可以记录一个支持或反驳的经历，再回来调整选择。</p>
    </div>
  </section>;
}
