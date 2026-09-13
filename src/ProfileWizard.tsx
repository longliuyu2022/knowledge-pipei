import { useId, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Compass, Eye, LockKeyhole, Sparkles } from 'lucide-react';
import { DOMAINS, GOALS, STYLES, TOPICS } from '../shared/catalog.js';
import { api, APIError, messageOf, setCSRF } from './api';
import { Dialog, Spinner } from './components';
import type { Bootstrap, Input, Profile } from './types';
import './profile.css';

interface WizardProps {
  data: Bootstrap;
  onClose: () => void;
  onComplete: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}

const cloneInput = (input: Input): Input => ({ ...input, topicIds: [...input.topicIds], goals: [...input.goals] });

export function ProfileWizard({ data, onClose, onComplete, notify }: WizardProps) {
  const uid = useId();
  const [step, setStep] = useState(0);
  const [input, setInput] = useState<Input>(() => data.profile ? cloneInput(data.profile.input) : {
    name: data.user.provider === 'zhihu' ? data.user.name : '', topicIds: [], about: '', question: '', styleId: 'deep', goals: ['conversation'],
  });
  const [revision, setRevision] = useState(data.profile?.revision || 0);
  const [useAI, setUseAI] = useState(false);
  const [discoverable, setDiscoverable] = useState(false);
  const [savedProfile, setSavedProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  function update<K extends keyof Input>(key: K, value: Input[K]) {
    setInput(current => ({ ...current, [key]: value }));
    setSavedProfile(null);
    setError('');
  }

  function toggleTopic(id: string) {
    if (input.topicIds.includes(id)) update('topicIds', input.topicIds.filter(topic => topic !== id));
    else if (input.topicIds.length < 8) update('topicIds', [...input.topicIds, id]);
  }

  function move(next: number) {
    setError('');
    setStep(next);
    requestAnimationFrame(() => heading.current?.focus());
  }

  async function loadLatest() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const latest = await api<Bootstrap>('/bootstrap');
      setCSRF(latest.csrf);
      if (latest.user.id !== data.user.id) {
        await onComplete();
        notify('当前账号已变化，请在新会话中重新编辑。', true);
        onClose();
        return;
      }
      if (latest.profile) setInput(cloneInput(latest.profile.input));
      setRevision(latest.profile?.revision || 0);
      setSavedProfile(null);
      setDiscoverable(false);
      setConflict(false);
      move(0);
      notify('已载入最新资料，可以继续编辑。');
    } catch (cause) { setError(messageOf(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    if (step === 0) {
      if (input.topicIds.length < 3 || input.topicIds.length > 8) { setError('请选择 3–8 个让你好奇的兴趣。'); return; }
      move(1);
      return;
    }
    if (step === 1) {
      if (!input.goals.length) { setError('至少选择一种你期待的交流。'); return; }
      move(2);
      return;
    }
    if (!input.name.trim()) { setError('给自己起一个昵称吧。'); return; }
    inFlight.current = true;
    setBusy(true);
    setError('');
    setConflict(false);
    let phase: 'save' | 'visibility' | 'refresh' = 'save';
    try {
      let profile = savedProfile;
      if (!profile) {
        const response = await api<{ profile: Profile }>('/profile', {
          method: 'POST', json: { input: { ...input, name: input.name.trim(), about: input.about.trim(), question: input.question.trim() }, revision, useAI },
        });
        profile = response.profile;
        setRevision(profile.revision);
        setSavedProfile(profile);
      }
      if (discoverable !== profile.discoverable) {
        phase = 'visibility';
        const response = await api<{ profile: Profile }>('/profile/visibility', { method: 'POST', json: { discoverable, revision: profile.revision } });
        profile = response.profile;
        setSavedProfile(profile);
      }
      phase = 'refresh';
      await onComplete();
      notify(discoverable ? '知识画像已保存，伙伴们可以发现你了。' : '知识画像已保存，当前未加入匹配池。');
      onClose();
    } catch (cause) {
      const prefix = phase === 'visibility' ? '画像已保存，但发现设置未更新。' : phase === 'refresh' ? '画像已保存，但页面还未同步。' : '';
      setError(prefix + messageOf(cause));
      setConflict(cause instanceof APIError && cause.code === 'profile_changed');
    } finally { inFlight.current = false; setBusy(false); }
  }

  return <Dialog title={data.profile ? '编辑我的知识人格' : '认识你，从好奇心开始'} onClose={onClose} wide busy={busy} className="profile-wizard">
    <ol className="wizard-progress" aria-label="创建进度">
      {['兴趣坐标', '交流偏好', '生成画像'].map((label, index) => <li key={label} className={index === step ? 'current' : index < step ? 'complete' : ''} aria-current={index === step ? 'step' : undefined}>
        <span>{index < step ? <Check size={13} /> : index + 1}</span>{label}
      </li>)}
    </ol>
    <form onSubmit={submit}>
      <fieldset disabled={busy} className="wizard-fieldset">
        <div className="wizard-step-heading">
          <span className="wizard-step-icon">{step === 0 ? <Compass size={22} /> : step === 1 ? <Sparkles size={22} /> : <LockKeyhole size={22} />}</span>
          <h3 ref={heading} tabIndex={-1}>{['哪些话题，让你眼睛一亮？', '你想怎样与世界交换想法？', '为你的好奇心，签个名'][step]}</h3>
          <p>{['选择 3–8 个兴趣。不必是专家，喜欢就足够。', '没有标准答案，舒服的交流方式最重要。', '这份画像属于你，是否让伙伴发现也由你决定。'][step]}</p>
        </div>

        {step === 0 && <div className="wizard-topics">
          <div className="wizard-selection-count" aria-live="polite"><span>我的兴趣坐标</span><strong>{input.topicIds.length}<span> / 8 已选择</span></strong></div>
          {DOMAINS.map(domain => <fieldset key={domain.id} className="wizard-domain">
            <legend><span style={{ background: domain.color }} />{domain.label}</legend>
            <div className="wizard-topic-options">{TOPICS.filter(topic => topic.domain === domain.id).map(topic => {
              const selected = input.topicIds.includes(topic.id);
              return <button type="button" key={topic.id} aria-pressed={selected} disabled={!selected && input.topicIds.length >= 8} onClick={() => toggleTopic(topic.id)} className={`wizard-topic ${selected ? 'selected' : ''}`}>
                {topic.label}{selected && <Check size={13} />}
              </button>;
            })}</div>
          </fieldset>)}
          <p className="wizard-small-note">兴趣会变化，你随时可以回来调整。</p>
        </div>}

        {step === 1 && <div className="wizard-preferences">
          <fieldset className="wizard-choice-group"><legend>更喜欢的交流方式 <span>单选</span></legend>
            <div className="wizard-style-options">{STYLES.map(style => <label key={style.id} className={`wizard-choice ${input.styleId === style.id ? 'selected' : ''}`}>
              <input type="radio" name={`${uid}-style`} checked={input.styleId === style.id} onChange={() => update('styleId', style.id)} />
              <span><strong>{style.label}</strong><small>{style.description}</small></span>
            </label>)}</div>
          </fieldset>
          <fieldset className="wizard-choice-group"><legend>期待遇见怎样的交流 <span>可选 1–3 项</span></legend>
            <div className="wizard-goal-options">{GOALS.map(goal => <label key={goal.id} className={`wizard-goal ${input.goals.includes(goal.id) ? 'selected' : ''}`}>
              <input type="checkbox" checked={input.goals.includes(goal.id)} onChange={event => update('goals', event.target.checked ? [...input.goals, goal.id] : input.goals.filter(id => id !== goal.id))} />
              <span>{goal.short}</span>
            </label>)}</div>
          </fieldset>
          <label className="field wizard-text-field"><span>关于你 <small>选填 · {input.about.length}/360</small></span>
            <textarea rows={3} maxLength={360} value={input.about} onChange={event => update('about', event.target.value)} placeholder="最近在看什么、喜欢思考什么，或者一件让你很投入的小事……" />
          </label>
          <label className="field wizard-text-field"><span>一个你想和别人聊的问题 <small>选填 · {input.question.length}/200</small></span>
            <textarea rows={2} maxLength={200} value={input.question} onChange={event => update('question', event.target.value)} placeholder="例如：当 AI 能替我们回答问题，什么样的提问更有价值？" />
          </label>
        </div>}

        {step === 2 && <div className="wizard-finish">
          <label className="field wizard-text-field"><span>你的昵称 <small>{input.name.length}/24</small></span>
            <input autoComplete="nickname" maxLength={24} value={input.name} onChange={event => update('name', event.target.value)} placeholder="让新伙伴怎么称呼你？" autoFocus />
          </label>
          <div className="wizard-review"><span>你的好奇心关键词</span><div className="tags">{input.topicIds.map(id => <span className="tag tag-purple" key={id}>{TOPICS.find(topic => topic.id === id)?.label}</span>)}</div><p>{STYLES.find(style => style.id === input.styleId)?.short} · {GOALS.filter(goal => input.goals.includes(goal.id)).map(goal => goal.short).join(' / ')}</p></div>
          <label className={`wizard-consent ${!data.capabilities.ai ? 'unavailable' : ''}`}>
            <input type="checkbox" checked={useAI} disabled={!data.capabilities.ai} onChange={event => { setUseAI(event.target.checked); setSavedProfile(null); }} />
            <span><strong><Sparkles size={16} />使用 AI 解读兴趣</strong><small>{data.capabilities.ai ? '允许将所选兴趣、自述和已导入摘要交给 AI 生成兴趣解读；关闭后按兴趣规则生成。' : 'AI 解读暂不可用，仍可按兴趣规则正常生成画像。'}</small></span>
          </label>
          <label className="wizard-consent">
            <input type="checkbox" checked={discoverable} onChange={event => setDiscoverable(event.target.checked)} />
            <span><strong><Eye size={16} />生成后，让伙伴发现我</strong><small>公开知识名片，让参与者查看你的昵称、画像、自述和交流偏好；后台异步匹配需要你另行点击开始。</small></span>
          </label>
          <div className="wizard-privacy-note"><LockKeyhole size={15} /><p>{discoverable ? '已选择公开知识名片。原始导入摘要仅自己可见。' : '默认保持名片私有。你可以带着这份画像开始异步匹配或参加问题小组；已建立连接的伙伴可查看你分享的名片。'}</p></div>
        </div>}
      </fieldset>
      {error && <div className="form-error wizard-error" role="alert"><p>{error}</p>{conflict && <button type="button" className="text-button" disabled={busy} onClick={loadLatest}>载入最新资料后继续</button>}</div>}
      <div className="wizard-footer">
        <button type="button" className="button ghost" disabled={busy} onClick={() => step > 0 ? move(step - 1) : onClose()}>{step > 0 && <ArrowLeft size={16} />}{step > 0 ? '上一步' : '稍后再说'}</button>
        <span className="wizard-footer-step">{step + 1} / 3</span>
        <button type="submit" className="button primary" disabled={busy || (step === 0 && input.topicIds.length < 3) || (step === 1 && !input.goals.length) || (step === 2 && !input.name.trim())}>
          {busy ? <Spinner text={step === 2 ? '正在整理你的好奇心…' : '正在同步…'} /> : <>{step < 2 ? '继续' : savedProfile ? '完成保存' : data.profile ? '更新我的画像' : '生成我的知识人格'}{step < 2 ? <ArrowRight size={16} /> : <Sparkles size={16} />}</>}
        </button>
      </div>
    </form>
  </Dialog>;
}
