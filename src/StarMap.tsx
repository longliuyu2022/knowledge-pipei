import { useEffect, useMemo, useRef, useState } from 'react';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum, type SimulationLinkDatum } from 'd3-force';
import { ArrowUpRight, Compass, Minus, Move, Plus, RotateCcw, Sparkles } from 'lucide-react';
import { Avatar, Empty, PageTitle, PoolToggle, Spinner } from './components';
import type { Match, Pool, Profile } from './types';

interface Node extends SimulationNodeDatum { id: string; label: string; kind: 'self' | 'topic' | 'person'; score?: number; color: string }
interface Link extends SimulationLinkDatum<Node> { source: string | Node; target: string | Node }
interface Props { profile: Profile; matches: Match[]; onSelect: (match: Match) => void; preview: boolean; pool: Pool; onPoolChange: (pool: Pool) => void; loading: boolean; onCreate: () => void }
const colors = ['#9186ce', '#c4a37e', '#8eaa98', '#829eae', '#bc8f9f'];
export function StarMap({ profile, matches, onSelect, preview, pool, onPoolChange, loading, onCreate }: Props) {
  const [zoom, setZoom] = useState(1), [activeTopic, setActiveTopic] = useState('all');
  const [focused, setFocused] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null);
  const chosen = useMemo(() => matches.filter(m => activeTopic === 'all' || m.interests.some(t => t.id === activeTopic)).slice(0, 12), [matches, activeTopic]);
  const layout = useMemo(() => {
    const topics = profile.interests.slice(0, 5);
    const nodes: Node[] = [{ id: 'self', label: preview ? '好奇的你' : profile.input.name, kind: 'self', color: '#8375c6', fx: 400, fy: 265, x: 400, y: 265 },
      ...topics.map((t, i) => ({ id: `topic-${t.id}`, label: t.label, kind: 'topic' as const, color: colors[i], x: 400 + Math.cos(i * 1.25 - 1.5) * 145, y: 265 + Math.sin(i * 1.25 - 1.5) * 135 })),
      ...chosen.map((m, i) => ({ id: m.id, label: m.name, kind: 'person' as const, color: colors[i % 5], score: m.score, x: 400 + Math.cos(i / Math.max(chosen.length, 1) * Math.PI * 2) * 260, y: 265 + Math.sin(i / Math.max(chosen.length, 1) * Math.PI * 2) * 190 }))];
    const links: Link[] = topics.map(t => ({ source: 'self', target: `topic-${t.id}` }));
    for (const match of chosen) {
      const shared = topics.filter(t => match.interests.some(i => i.id === t.id));
      for (const topic of shared.slice(0, 2)) links.push({ source: `topic-${topic.id}`, target: match.id });
      if (!shared.length) links.push({ source: 'self', target: match.id });
    }
    const simulation = forceSimulation(nodes).force('link', forceLink<Node, Link>(links).id(d => d.id).distance(link => (link.source as Node).id === 'self' ? 130 : 105).strength(.4)).force('charge', forceManyBody().strength(-500)).force('collide', forceCollide<Node>().radius(n => n.kind === 'self' ? 72 : n.kind === 'person' ? 48 : 53)).force('x', forceX<Node>(400).strength(.035)).force('y', forceY<Node>(265).strength(.045)).stop();
    for (let i = 0; i < 180; i++) simulation.tick();
    for (const node of nodes) { node.x = Math.max(72, Math.min(728, node.x || 400)); node.y = Math.max(65, Math.min(465, node.y || 265)); }
    return { nodes, links };
  }, [profile, chosen, preview]);
  const [positions, setPositions] = useState<Record<string, [number, number]>>({});
  useEffect(() => { setPositions({}); setFocused(null); }, [layout]);
  const position = (node: Node) => positions[node.id] || [node.x || 400, node.y || 265];
  const select = (node: Node) => { if (node.kind === 'person') { const person = chosen.find(m => m.id === node.id); if (person) onSelect(person); } else if (node.kind === 'topic') setActiveTopic(value => value === node.id.slice(6) ? 'all' : node.id.slice(6)); else if (preview) onCreate(); };
  const width = 800 / zoom, height = 530 / zoom;
  return <div className="star-page"><PageTitle eyebrow="YOUR CONSTELLATION OF CURIOSITY" title="每一种好奇，都有回响。" description="看看你的兴趣，如何和另一个人的世界连在一起。"><PoolToggle value={pool} onChange={onPoolChange}/></PageTitle>
    <div className="graph-legend-row"><div className="graph-topic-filters"><button className={`tag ${activeTopic === 'all' ? 'tag-purple' : ''}`} onClick={() => setActiveTopic('all')}>全部星点</button>{profile.interests.slice(0, 5).map((topic, i) => <button className={`tag ${activeTopic === topic.id ? 'tag-purple' : ''}`} onClick={() => setActiveTopic(value => value === topic.id ? 'all' : topic.id)} key={topic.id}><i style={{ background: colors[i] }}/>{topic.label}</button>)}</div><span><Move size={13}/>拖动星点 · 点击认识伙伴</span></div>
    <section className="constellation-panel"><div className="graph-top-note"><span><i/>{preview ? '体验兴趣星图' : '你的兴趣星图'}</span><span>{pool === 'demo' ? '虚构伙伴 · 体验示例' : `${matches.length} 位自愿参与者`}</span></div>
      {loading && !matches.length ? <div className="graph-loading"><Spinner text="正在连接好奇的星点…"/></div> : !chosen.length && !matches.length && pool === 'people' ? <Empty title="一片等待相遇的星空" text="还没有其他参与者。邀请朋友来生成画像并主动加入，就能看见兴趣之间的连线。" action={preview ? '生成我的知识人格' : '看看体验星图'} onAction={preview ? onCreate : () => onPoolChange('demo')}/> : <svg ref={svg} className="constellation" viewBox={`${400 - width / 2} ${265 - height / 2} ${width} ${height}`} role="group" aria-label="兴趣关系图，连线代表共同兴趣，不代表双方已认识" onPointerMove={event => {
        if (!drag.current || !svg.current) return;
        const point = svg.current.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
        const matrix = svg.current.getScreenCTM(); if (!matrix) return;
        const at = point.matrixTransform(matrix.inverse());
        if (Math.hypot(event.clientX - drag.current.startX, event.clientY - drag.current.startY) > 5) drag.current.moved = true;
        const id = drag.current.id; setPositions(current => ({ ...current, [id]: [Math.max(45, Math.min(755, at.x)), Math.max(45, Math.min(485, at.y))] }));
      }} onPointerUp={() => { setTimeout(() => { drag.current = null; }, 0); }} onPointerCancel={() => { drag.current = null; }}>
        <defs><radialGradient id="star-glow"><stop stopColor="#e8e1f6"/><stop offset="1" stopColor="#faf9fc" stopOpacity="0"/></radialGradient><pattern id="stars" width="37" height="37" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".7" fill="#c4bdce" opacity=".6"/></pattern></defs>
        <rect x="-400" y="-300" width="1600" height="1100" fill="url(#stars)"/><circle cx="400" cy="265" r="248" fill="url(#star-glow)"/>
        {[100, 182, 250].map(r => <circle key={r} cx="400" cy="265" r={r} fill="none" stroke="#e9e5ed" strokeDasharray="4 7"/>)}
        {layout.links.map((link, i) => { const source = link.source as Node, target = link.target as Node, a = position(source), b = position(target); const lit = !focused || focused === source.id || focused === target.id; return <path key={i} d={`M${a[0]},${a[1]} Q${(a[0] + b[0]) / 2 + 12},${(a[1] + b[1]) / 2 - 16} ${b[0]},${b[1]}`} stroke={target.color} strokeWidth={lit && focused ? 2 : 1.2} strokeOpacity={lit ? .42 : .12} fill="none"/>; })}
        {layout.nodes.map(node => { const [x, y] = position(node), r = node.kind === 'self' ? 43 : node.kind === 'person' ? 27 : 8; return <g className={`star-node star-${node.kind}`} key={node.id} transform={`translate(${x} ${y})`} tabIndex={0} role="button" aria-label={node.kind === 'person' ? `查看${node.label}的匹配` : node.kind === 'self' ? '我的兴趣中心' : `筛选${node.label}`} onPointerEnter={() => setFocused(node.id)} onPointerLeave={() => setFocused(null)} onFocus={() => setFocused(node.id)} onBlur={() => setFocused(null)} onClick={() => { if (!drag.current?.moved) select(node); }} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(node); } }} onPointerDown={e => { if (node.kind === 'self') return; drag.current = { id: node.id, startX: e.clientX, startY: e.clientY, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }}>
          {node.kind === 'self' && <><circle r="54" fill="none" stroke="#d9d0ec"/><circle r="66" fill="none" stroke="#e6deef" strokeDasharray="2 5"/></>}
          <circle r={r} fill={node.kind === 'self' ? '#8c80c5' : node.kind === 'person' ? '#fff' : node.color} stroke={node.kind === 'person' ? node.color : '#ffffff'} strokeWidth={node.kind === 'person' ? 1.5 : 3}/>
          {node.kind === 'self' ? <><text y="0" textAnchor="middle" fontSize="20" fill="white">我</text><text y="20" textAnchor="middle" fontSize="10" fill="#f0eafb">保持好奇</text><text y="83" textAnchor="middle" fontSize="13" fill="#6b637e">{node.label}</text></> : node.kind === 'person' ? <><text y="5" textAnchor="middle" fontSize="17" fill={node.color}>{node.label.slice(0, 1)}</text><text y="45" textAnchor="middle" fontSize="13" fontWeight="500" fill="#4b4657">{node.label}</text><text y="61" textAnchor="middle" fontSize="10" fill="#98909f">{node.score}° 同频</text></> : <text y="27" textAnchor="middle" fontSize="12" fill="#827587">{node.label}</text>}
        </g>; })}
      </svg>}
      <div className="graph-bottom"><span><Sparkles size={14}/>连线代表共同兴趣，不代表双方已经认识</span><div className="graph-controls"><button className="icon-button" aria-label="缩小星图" disabled={zoom <= .75} onClick={() => setZoom(z => Math.max(.75, z - .25))}><Minus size={17}/></button><span>{Math.round(zoom * 100)}%</span><button className="icon-button" aria-label="放大星图" disabled={zoom >= 1.75} onClick={() => setZoom(z => Math.min(1.75, z + .25))}><Plus size={17}/></button><button className="icon-button" aria-label="重置星图" onClick={() => { setZoom(1); setPositions({}); setActiveTopic('all'); }}><RotateCcw size={16}/></button></div></div>
    </section>
    <section className="graph-people"><div className="section-heading"><div><h2>在你的兴趣轨道上</h2><p>{preview ? '先探索这份体验画像的共同话题。' : '从一个熟悉的兴趣，走进一段新的对话。'}</p></div><Compass size={21}/></div><div className="graph-people-list">{chosen.slice(0, 6).map(match => <button key={match.id} onClick={() => onSelect(match)} className="graph-person"><Avatar name={match.name} seed={match.id} src={match.avatar} size={39}/><span><strong>{match.name}</strong><small>{match.shared.slice(0, 2).map(t => t.label).join(' · ') || '发现新的视角'}</small></span><ArrowUpRight size={16}/></button>)}</div></section>
  </div>;
}
