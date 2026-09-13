import { useState, type FormEvent } from 'react';
import { Bell, CheckCheck, Link2, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { api, APIError, copyText } from '../../api';
import type { CircleAIAction, CircleAIResult, CircleDetail, CircleDuration, CircleOutcome, CircleSummary } from '../../../shared/circles-types';
import { circlePath, CircleModal, dateTime, ErrorNote, Notice, SubmitButton, useTask, type Notify } from './CirclesCommon';

type MembershipValues = { duration: CircleDuration; goal: string; stage: string; subscribed: boolean; allowConnections: boolean; aiConsent: boolean };
const defaultMembership = (): MembershipValues => ({ duration: '7d', goal: '', stage: '', subscribed: true, allowConnections: false, aiConsent: false });

function DurationField({ value, onChange }: { value: CircleDuration; onChange: (value: CircleDuration) => void }) {
  return <fieldset className="cz-fieldset"><legend>这次参与多久</legend><div className="cz-duration-options">{([['24h', '24 小时', '集中聊一轮'], ['7d', '7 天', '留出深入讨论的时间'], ['ongoing', '持续参与', '由我主动退出']] as const).map(([duration, title, note]) => <label key={duration} className={value === duration ? 'is-selected' : ''}><input type="radio" name="duration" value={duration} checked={value === duration} onChange={() => onChange(duration)}/><span><strong>{title}</strong><small>{note}</small></span></label>)}</div></fieldset>;
}

function Permissions({ values, onChange }: { values: Pick<MembershipValues, 'subscribed' | 'allowConnections' | 'aiConsent'>; onChange: (value: Partial<MembershipValues>) => void }) {
  return <fieldset className="cz-fieldset cz-permissions"><legend>分别选择你的参与权限</legend>
    <label className="cz-check"><input type="checkbox" checked={values.subscribed} onChange={event => onChange({ subscribed: event.target.checked })}/><span><strong><Bell size={15}/>订阅小组提醒</strong><small>接收新讨论和成果提醒；退出或到期后停止。</small></span></label>
    <label className="cz-check"><input type="checkbox" checked={values.allowConnections} onChange={event => onChange({ allowConnections: event.target.checked })}/><span><strong><Users size={15}/>允许成员向我发出连接邀请</strong><small>仍需我确认后才能私聊，可以随时关闭。</small></span></label>
    <label className="cz-check"><input type="checkbox" checked={values.aiConsent} onChange={event => onChange({ aiConsent: event.target.checked })}/><span><strong><Sparkles size={15}/>允许外部 AI 处理我的小组发言与资料</strong><small>用于梳理本轮讨论和成果；关闭后相关 AI 内容会重新核对。未勾选也可参与讨论。</small></span></label>
  </fieldset>;
}

export function CreateCircleDialog({ onClose, onCreated, initialQuestionUrl = '' }: { onClose: () => void; onCreated: (circle: CircleDetail) => void; initialQuestionUrl?: string }) {
  const task = useTask();
  const [title, setTitle] = useState(''), [question, setQuestion] = useState(''), [goal, setGoal] = useState('');
  const [questionUrl, setQuestionUrl] = useState(initialQuestionUrl), [description, setDescription] = useState(''), [tags, setTags] = useState(''), [capacity, setCapacity] = useState(12);
  const [membership, setMembership] = useState(defaultMembership);
  function submit(event: FormEvent) {
    event.preventDefault();
    const tagList = tags.split(/[,，、]/).map(item => item.trim()).filter(Boolean);
    if (tagList.length > 8 || tagList.some(item => item.length > 24)) { task.setError('最多填写 8 个标签，每个标签不超过 24 字。'); return; }
    task.run(() => api<{ circle: CircleDetail }>('/circles', { method: 'POST', json: { title: title.trim(), question: question.trim(), goal: goal.trim(), description: description.trim(), questionUrl: questionUrl.trim() || undefined, tags: tagList, capacity, duration: membership.duration, aiConsent: membership.aiConsent, subscribed: membership.subscribed, allowConnections: membership.allowConnections } }), result => onCreated(result.circle));
  }
  return <CircleModal title="围绕一个问题，发起小组" onClose={onClose} busy={task.busy} wide><form className="cz-form" onSubmit={submit}>
    <p className="cz-form-intro">先把想解决的问题和本轮产出说清楚，让合适的人带着目标加入。</p>
    <label className="cz-field">小组名称<input autoFocus value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：第一次做用户访谈，怎么开始？" required minLength={2} maxLength={100}/></label>
    <label className="cz-field">这轮要讨论的问题<textarea value={question} onChange={event => setQuestion(event.target.value)} placeholder="写清背景、困惑和你希望听到的经验" required minLength={5} maxLength={500} rows={3}/></label>
    <label className="cz-field">本轮共同目标<textarea value={goal} onChange={event => setGoal(event.target.value)} placeholder="例如：整理一份可以直接使用的访谈提纲" required minLength={2} maxLength={500} rows={2}/></label>
    <label className="cz-field">关联的知乎问题链接 <span>选填</span><input type="url" value={questionUrl} onChange={event => setQuestionUrl(event.target.value)} placeholder="https://www.zhihu.com/question/…" maxLength={500}/><small>仅关联问题，不会自动抓取回答全文。</small></label>
    <details className="cz-form-details"><summary>补充介绍、标签与人数上限</summary><label className="cz-field">小组介绍<textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={1200} rows={3}/></label><div className="cz-two-fields"><label className="cz-field">话题标签<input value={tags} onChange={event => setTags(event.target.value)} placeholder="用户研究，产品实践" maxLength={200}/><small>用逗号分隔，最多 8 个。</small></label><label className="cz-field">人数上限<input type="number" min={2} max={30} required value={capacity} onChange={event => setCapacity(Number(event.target.value))}/></label></div></details>
    <DurationField value={membership.duration} onChange={duration => setMembership(current => ({ ...current, duration }))}/>
    <Permissions values={membership} onChange={value => setMembership(current => ({ ...current, ...value }))}/>
    <Notice><ShieldCheck size={17}/><p>创建后你是本轮主持，可以推进轮次、处理举报和组织资料。小组名称、问题和目标公开；发言、成员、资料与成果仅有效成员可见。</p></Notice>
    <ErrorNote text={task.error}/><div className="cz-form-actions"><button type="button" className="cz-button" onClick={onClose} disabled={task.busy}>取消</button><SubmitButton busy={task.busy}>创建小组</SubmitButton></div>
  </form></CircleModal>;
}

export function MembershipDialog({ circle, onClose, onSaved }: { circle: CircleSummary; onClose: () => void; onSaved: (circle: CircleDetail) => void }) {
  const task = useTask(), editing = !!circle.joined;
  const [values, setValues] = useState<MembershipValues>(() => circle.membership ? { duration: circle.membership.duration, goal: circle.membership.goal, stage: circle.membership.stage, subscribed: circle.membership.subscribed, allowConnections: circle.membership.allowConnections, aiConsent: circle.membership.aiConsent } : defaultMembership());
  const [renew, setRenew] = useState(false);
  const set = (value: Partial<MembershipValues>) => setValues(current => ({ ...current, ...value }));
  function submit(event: FormEvent) {
    event.preventDefault();
    const json = { ...values, duration: editing && !renew ? undefined : values.duration };
    task.run(() => api<{ circle: CircleDetail }>(`${circlePath(circle.id)}/${editing ? 'membership' : 'join'}`, { method: editing ? 'PATCH' : 'POST', json }), result => onSaved(result.circle));
  }
  return <CircleModal title={editing ? '我的参与设置' : '加入问题小组'} onClose={onClose} busy={task.busy}><form className="cz-form" onSubmit={submit}>
    <div className="cz-join-summary"><span className="cz-eyebrow">{circle.memberCount} / {circle.capacity} 位成员</span><h3>{circle.title}</h3><p>{circle.currentRound.goal}</p></div>
    {editing && <><Notice><p>{circle.membership?.expiresAt ? `本次参与至 ${dateTime(circle.membership.expiresAt)}，普通保存不会延长有效期。` : '你当前选择持续参与，可以随时退出。'}</p></Notice><label className="cz-check"><input type="checkbox" checked={renew} onChange={event => setRenew(event.target.checked)}/><span>重新选择参与期限（从本次保存起计算）</span></label></>}
    {(!editing || renew) && <DurationField value={values.duration} onChange={duration => set({ duration })}/>}
    <label className="cz-field">你希望从这轮讨论获得什么 <span>选填</span><textarea aria-label="你希望从这轮讨论获得什么" value={values.goal} onChange={event => set({ goal: event.target.value })} placeholder="让其他成员了解你的目标" maxLength={500} rows={2}/></label>
    <label className="cz-field">你目前的阶段 <span>选填</span><input value={values.stage} onChange={event => set({ stage: event.target.value })} placeholder="例如：刚开始学习 / 已经在实践" maxLength={100}/></label>
    <Permissions values={values} onChange={set}/>
    <Notice><ShieldCheck size={17}/><p>有效成员可以阅读组内讨论、提交资料、协作整理成果。邀请链接只展示公开介绍，打开链接不会自动加入。</p></Notice>
    <ErrorNote text={task.error}/><div className="cz-form-actions"><button type="button" className="cz-button" onClick={onClose} disabled={task.busy}>取消</button><SubmitButton busy={task.busy} disabled={!editing && (circle.memberCount >= circle.capacity || circle.currentRound.status === 'archived')}>{editing ? '保存设置' : '确认加入'}</SubmitButton></div>
  </form></CircleModal>;
}

export function NewRoundDialog({ circle, onClose, onSaved }: { circle: CircleDetail; onClose: () => void; onSaved: () => void }) {
  const task = useTask(); const [question, setQuestion] = useState(''), [goal, setGoal] = useState('');
  return <CircleModal title={`开启第 ${circle.currentRound.number + 1} 轮`} onClose={onClose} busy={task.busy}><form className="cz-form" onSubmit={event => { event.preventDefault(); task.run(() => api(`${circlePath(circle.id)}/rounds`, { method: 'POST', json: { question: question.trim(), goal: goal.trim() } }), onSaved); }}>
    <p className="cz-form-intro">上一轮的问题、讨论和成果会保留，新一轮从新的目标开始。</p><label className="cz-field">这一轮的问题<textarea autoFocus value={question} onChange={event => setQuestion(event.target.value)} required minLength={5} maxLength={500} rows={3}/></label><label className="cz-field">这一轮的目标<textarea value={goal} onChange={event => setGoal(event.target.value)} required minLength={2} maxLength={500} rows={2}/></label><ErrorNote text={task.error}/><div className="cz-form-actions"><button className="cz-button" type="button" disabled={task.busy} onClick={onClose}>取消</button><SubmitButton busy={task.busy}>开启新一轮</SubmitButton></div>
  </form></CircleModal>;
}

export function FacilitationDialog({ circle, initialAction, onClose, onSaved }: { circle: CircleDetail; initialAction: CircleAIAction; onClose: () => void; onSaved: (result: CircleAIResult) => void }) {
  const task = useTask(), [action, setAction] = useState(initialAction), [useAI, setUseAI] = useState(false);
  return <CircleModal title="协助本轮讨论" onClose={onClose} busy={task.busy}><form className="cz-form" onSubmit={event => { event.preventDefault(); task.run(() => api<CircleAIResult>(`${circlePath(circle.id)}/ai`, { method: 'POST', json: { action, useAI } }), onSaved); }}>
    <label className="cz-field">这次需要什么帮助<select aria-label="这次需要什么帮助" value={action} onChange={event => setAction(event.target.value as CircleAIAction)}><option value="opener">设计破冰提问</option><option value="summary">梳理本轮讨论</option><option value="outcome">整理成果草稿</option></select></label>
    <div className="cz-choice-list"><label className="cz-check"><input type="radio" name="ai-mode" checked={!useAI} onChange={() => setUseAI(false)}/><span><strong>在站内整理</strong><small>按已有发言与资料组织摘录，不调用外部模型。</small></span></label><label className="cz-check"><input type="radio" name="ai-mode" checked={useAI} disabled={!circle.aiEnabled} onChange={() => setUseAI(true)}/><span><strong>请 AI 协助</strong><small>{circle.aiEnabled ? '仅向外部模型提供已同意处理的成员发言和资料。' : '主持已关闭外部 AI 协助。'}</small></span></label></div>
    <Notice><Sparkles size={17}/><p>结果会标明整理方式和引用依据，由成员继续核对；不表示所有人已达成共识。相邻两次协助至少间隔 30 秒。</p></Notice><ErrorNote text={task.error}/><div className="cz-form-actions"><button className="cz-button" type="button" disabled={task.busy} onClick={onClose}>取消</button><SubmitButton busy={task.busy}>开始整理</SubmitButton></div>
  </form></CircleModal>;
}

export function HostSettingsDialog({ circle, onClose, onSaved }: { circle: CircleDetail; onClose: () => void; onSaved: () => void }) {
  const task = useTask(), [aiEnabled, setAIEnabled] = useState(circle.aiEnabled), [autoSummary, setAutoSummary] = useState(circle.autoSummary), [capacity, setCapacity] = useState(circle.capacity);
  return <CircleModal title="小组主持设置" onClose={onClose} busy={task.busy}><form className="cz-form" onSubmit={event => { event.preventDefault(); task.run(() => api(circlePath(circle.id), { method: 'PATCH', json: { aiEnabled, autoSummary, capacity } }), onSaved); }}>
    <label className="cz-field">人数上限<input type="number" min={Math.max(2, circle.memberCount)} max={30} value={capacity} onChange={event => setCapacity(Number(event.target.value))} required/></label>
    <label className="cz-check"><input type="checkbox" checked={aiEnabled} onChange={event => { setAIEnabled(event.target.checked); if (!event.target.checked) setAutoSummary(false); }}/><span><strong>开放 AI 协助</strong><small>成员可主动请求协助，各成员的资料授权仍分别生效。</small></span></label>
    <label className="cz-check"><input type="checkbox" checked={autoSummary} disabled={!aiEnabled} onChange={event => setAutoSummary(event.target.checked)}/><span><strong>自动梳理阶段讨论</strong><small>本轮新增至少 20 条成员发言、且距上次整理至少 30 分钟后触发。默认关闭。</small></span></label>
    <ErrorNote text={task.error}/><div className="cz-form-actions"><button className="cz-button" type="button" disabled={task.busy} onClick={onClose}>取消</button><SubmitButton busy={task.busy}>保存主持设置</SubmitButton></div>
  </form></CircleModal>;
}

export function OutcomeEditor({ circle, outcome, onClose, onSaved, notify }: { circle: CircleDetail; outcome?: CircleOutcome; onClose: () => void; onSaved: () => void; notify: Notify }) {
  const task = useTask(), [title, setTitle] = useState(outcome?.title || ''), [content, setContent] = useState(outcome?.content || '');
  const [messageIds, setMessageIds] = useState<string[]>([]), [sourceIds, setSourceIds] = useState<string[]>([]), [conflict, setConflict] = useState(false);
  const toggle = (values: string[], id: string) => values.includes(id) ? values.filter(value => value !== id) : [...values, id];
  function submit(event: FormEvent) {
    event.preventDefault();
    task.run(() => api(outcome ? `${circlePath(circle.id)}/outcomes/${encodeURIComponent(outcome.id)}` : `${circlePath(circle.id)}/outcomes`, { method: outcome ? 'PATCH' : 'POST', json: outcome ? { version: outcome.version, title: title.trim(), content: content.trim(), status: 'draft' } : { title: title.trim(), content: content.trim(), messageIds, sourceIds } }), onSaved, error => { if (error instanceof APIError && error.status === 409) setConflict(true); });
  }
  return <CircleModal title={outcome ? `编辑成果 · v${outcome.version}` : '整理一份成果草稿'} onClose={onClose} busy={task.busy} wide><form className="cz-form" onSubmit={submit}>
    <label className="cz-field">成果标题<input autoFocus value={title} onChange={event => setTitle(event.target.value)} required minLength={2} maxLength={120}/></label><label className="cz-field">正文<textarea aria-label="正文" className="cz-outcome-editor" value={content} onChange={event => setContent(event.target.value)} required minLength={5} maxLength={16000} rows={12} placeholder="整理已确认的发现、仍有分歧的观点与接下来的行动。支持 Markdown 文本。"/></label>
    {!outcome && <details className="cz-form-details"><summary>为成果选择依据</summary><fieldset className="cz-fieldset"><legend>引用成员发言</legend><div className="cz-reference-choices">{circle.messages.filter(message => message.kind === 'human' && !message.hidden && !message.redacted).map(message => <label key={message.id} className="cz-check"><input type="checkbox" checked={messageIds.includes(message.id)} onChange={() => setMessageIds(current => toggle(current, message.id))}/><span><strong>{message.author?.name || '成员'}</strong><small>{message.text.slice(0, 180)}</small></span></label>)}{!circle.messages.some(message => message.kind === 'human' && !message.hidden && !message.redacted) && <p className="cz-muted">本轮还没有可引用的成员发言。</p>}</div></fieldset><fieldset className="cz-fieldset"><legend>引用小组资料</legend>{circle.sources.map(source => <label key={source.id} className="cz-check"><input type="checkbox" checked={sourceIds.includes(source.id)} onChange={() => setSourceIds(current => toggle(current, source.id))}/><span>{source.title}</span></label>)}{!circle.sources.length && <p className="cz-muted">本轮还没有资料。</p>}</fieldset></details>}
    <Notice><CheckCheck size={17}/><p>保存后为待核对草稿。成员核对会署名，不代表全体成员共同确认。</p></Notice><ErrorNote text={task.error}/>{conflict && <div className="cz-notice"><p>这份成果已有新版本。你的编辑仍保留在这里，请复制草稿，关闭后重新打开最新版本核对。</p><button type="button" className="cz-text-button" onClick={() => copyText(`# ${title}\n\n${content}`).then(() => notify('草稿已复制。', 'success')).catch(error => task.setError(error.message))}><Link2 size={14}/>复制当前草稿</button></div>}
    <div className="cz-form-actions"><button type="button" className="cz-button" onClick={onClose} disabled={task.busy}>取消</button><SubmitButton busy={task.busy} disabled={conflict}>保存为待核对</SubmitButton></div>
  </form></CircleModal>;
}
