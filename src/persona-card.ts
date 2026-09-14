import { GOALS } from '../shared/catalog.js';
import { personaFor } from '../shared/personas.js';
import type { Profile } from './types';

function drawWrapped(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number) {
  const chars = [...value.replace(/\s+/g, ' ').trim()];
  let line = '', row = 0;
  for (let index = 0; index < chars.length; index++) {
    const next = line + chars[index];
    if (ctx.measureText(next).width > maxWidth && line) {
      if (row === maxLines - 1) {
        while (line && ctx.measureText(`${line}…`).width > maxWidth) line = line.slice(0, -1);
        ctx.fillText(`${line}…`, x, y + row * lineHeight);
        return;
      }
      ctx.fillText(line, x, y + row * lineHeight);
      line = chars[index]; row++;
    } else line = next;
  }
  if (line) ctx.fillText(line, x, y + row * lineHeight);
}

export async function createPersonaCard(profile: Profile, sample: boolean) {
  const persona = personaFor(profile.input);
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  canvas.width = 1600; canvas.height = 2200;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器无法生成图片，请换一个浏览器重试。');
  ctx.scale(2, 2);
  const font = '"Tongpin Sans", "PingFang SC", "Microsoft YaHei", sans-serif';
  const rounded = (x: number, y: number, width: number, height: number, radius: number, fill: string) => {
    ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fillStyle = fill; ctx.fill();
  };
  const background = ctx.createLinearGradient(0, 0, 800, 1100);
  background.addColorStop(0, '#fbf6ec'); background.addColorStop(.5, '#fffdf8'); background.addColorStop(1, '#eee7f8');
  ctx.fillStyle = background; ctx.fillRect(0, 0, 800, 1100);
  ctx.strokeStyle = '#e5e0ee'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(28, 28, 744, 1044, 25); ctx.stroke();
  ctx.fillStyle = '#38294f'; ctx.font = `600 27px ${font}`; ctx.fillText('同知', 72, 87);
  ctx.fillStyle = '#a8a0b3'; ctx.font = `12px ${font}`; ctx.textAlign = 'right'; ctx.fillText('KNOWLEDGE PERSONA', 726, 85); ctx.textAlign = 'left';
  rounded(72, 115, sample ? 188 : 146, 32, 16, '#eae5f6');
  ctx.font = `13px ${font}`; ctx.fillStyle = '#8277ae'; ctx.fillText(sample ? '知识人格 · 体验示例' : '我的知识人格卡', 86, 136);
  ctx.fillStyle = '#85808c'; ctx.font = `21px ${font}`; drawWrapped(ctx, `${profile.input.name}的好奇心宇宙`, 72, 197, 650, 28, 1);
  let titleSize = 42;
  ctx.font = `600 ${titleSize}px ${font}`;
  while (ctx.measureText(profile.title).width > 652 && titleSize > 23) { titleSize--; ctx.font = `600 ${titleSize}px ${font}`; }
  ctx.fillStyle = '#38294f'; ctx.fillText(profile.title, 72, 255);
  ctx.fillStyle = '#625475'; ctx.font = `18px ${font}`; drawWrapped(ctx, persona ? `如何评价「${persona.name}」这种人格？\n${persona.tagline}` : profile.summary, 72, 305, 650, 29, 3);
  const center = { x: 400, y: 573 }, radius = 133;
  const point = (index: number, fraction: number) => ({ x: center.x + Math.sin(index * Math.PI * 2 / profile.dimensions.length) * radius * fraction, y: center.y - Math.cos(index * Math.PI * 2 / profile.dimensions.length) * radius * fraction });
  const polygon = (values: number[]) => {
    ctx.beginPath(); values.forEach((value, index) => { const p = point(index, value); if (index === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); }); ctx.closePath();
  };
  for (const fraction of [1, .75, .5, .25]) { polygon(profile.dimensions.map(() => fraction)); ctx.strokeStyle = '#ded9e9'; ctx.stroke(); }
  profile.dimensions.forEach((_dimension, index) => { const p = point(index, 1); ctx.beginPath(); ctx.moveTo(center.x, center.y); ctx.lineTo(p.x, p.y); ctx.strokeStyle = '#e7e2ee'; ctx.stroke(); });
  polygon(profile.dimensions.map(dimension => Math.max(0, Math.min(100, dimension.value)) / 100));
  ctx.fillStyle = '#7353a232'; ctx.fill(); ctx.strokeStyle = '#7353a2'; ctx.lineWidth = 2; ctx.stroke();
  profile.dimensions.forEach((dimension, index) => {
    const p = point(index, Math.max(0, Math.min(100, dimension.value)) / 100);
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fillStyle = '#7353a2'; ctx.fill();
    const label = point(index, 1.38); ctx.fillStyle = '#807687'; ctx.font = `17px ${font}`; ctx.textAlign = 'center'; ctx.fillText(dimension.label, label.x, label.y + 6);
  });
  ctx.textAlign = 'left';
  let chipX = 72, chipY = 787;
  ctx.font = `15px ${font}`;
  for (const interest of (persona ? persona.keywords.map(label => ({ label })) : profile.interests.slice(0, 8))) {
    const width = ctx.measureText(interest.label).width + 28;
    if (chipX + width > 728) { chipX = 72; chipY += 44; }
    if (chipY > 875) break;
    rounded(chipX, chipY, width, 32, 16, '#efebf5'); ctx.fillStyle = '#817491'; ctx.fillText(interest.label, chipX + 14, chipY + 22); chipX += width + 9;
  }
  ctx.fillStyle = '#6f657a'; ctx.font = `16px ${font}`;
  drawWrapped(ctx, `${profile.style.label}  ·  ${GOALS.filter(goal => profile.input.goals.includes(goal.id)).map(goal => goal.short).join(' / ')}`, 72, 937, 650, 23, 1);
  ctx.beginPath(); ctx.moveTo(72, 972); ctx.lineTo(728, 972); ctx.strokeStyle = '#e0dae8'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = '#867d91'; ctx.font = `17px ${font}`; ctx.fillText('从一个问题，走向彼此。', 72, 1007);
  ctx.fillStyle = '#9c95a4'; ctx.font = `12px ${font}`; ctx.fillText(sample ? '体验示例，不代表你的个人分析结果' : '兴趣探索参考，不代表能力评分或人格诊断', 72, 1040);
  ctx.textAlign = 'right'; ctx.fillText(profile.analysis.mode === 'model' ? 'AI 兴趣解读' : '基于所选兴趣', 728, 1040);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片生成失败，请重试。')), 'image/png'));
  return blob;
}

export function savePersonaCard(blob: Blob, sample = false) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `同知-${sample ? '体验示例' : '知识人格卡'}.png`; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
