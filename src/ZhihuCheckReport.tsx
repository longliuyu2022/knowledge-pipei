import { Check, CircleHelp, Clock3, Download, Info } from 'lucide-react';
import { formatTime } from './api';
import type { ZhihuValidationReport } from './types';
import './zhihu-check.css';

const statusLabels = { success: '读取成功', empty: '空数据', error: '读取失败', skipped: '尚未检查' };
const reportLabels = { passed: '五项检查已完成', partial: '部分检查尚未完成', failed: '暂未完成数据检查' };

export function ZhihuCheckReport({ report, downloadable = false }: { report: ZhihuValidationReport; downloadable?: boolean }) {
  function download() {
    const blob = new Blob([JSON.stringify({ kind: 'tongpin-zhihu-oauth-check', version: 1, ...report }, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `tongpin-zhihu-check-${report.checkedAt.slice(0, 10)}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="zhihu-check-report" data-testid="zhihu-check-report" data-status={report.status} aria-label="知乎数据检查结果">
    <div className="zhihu-check-report-title"><strong>{reportLabels[report.status]}</strong><time dateTime={report.checkedAt}>{formatTime(report.checkedAt)}</time></div>
    <ul>{report.items.map(item => <li key={item.id} className={`zhihu-check-row is-${item.status}`} data-check={item.id} data-status={item.status}>
      <span className="zhihu-check-icon" aria-hidden="true">{item.status === 'success' ? <Check size={16}/> : item.status === 'empty' ? <Info size={16}/> : item.status === 'error' ? <CircleHelp size={16}/> : <Clock3 size={16}/>}</span>
      <div><strong>{item.label}</strong><p>{item.message}</p></div><span className="zhihu-check-status">{statusLabels[item.status]}</span>
    </li>)}</ul>
    {downloadable && <button type="button" className="text-button" onClick={download} data-testid="zhihu-check-download"><Download size={14}/>下载检查结果</button>}
  </section>;
}
