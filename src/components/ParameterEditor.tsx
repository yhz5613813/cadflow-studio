import { useEffect, useState } from 'react';
import { withParameterValues, type ParameterState } from '../../shared/parameters';
import { api } from '../api';
export function ParameterEditor({ projectId, source, disabled, run, changed, editState }: {
  projectId: string; source: string; disabled: boolean;
  run: (hash: string | null) => Promise<void>; changed: () => Promise<void>;
  editState: (state: { dirty: boolean; working: boolean }) => void;
}) {
  const [state, setState] = useState<ParameterState | null>(null), [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [working, setWorking] = useState(false);
  const dirty = !!state?.document?.parameters.some(p => draft[p.name] !== String(p.value));
  const accept = (value: ParameterState) => { setState(value); setDraft(Object.fromEntries(value.document?.parameters.map(p => [p.name, String(p.value)]) || [])); };
  useEffect(() => {
    let live = true;
    void api.parameters(projectId, source).then(value => { if (live) accept(value); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [projectId, source]);
  useEffect(() => { editState({ dirty, working }); return () => editState({ dirty: false, working: false }); }, [dirty, working, editState]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (dirty || working) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave);
  }, [dirty, working]);
  let validation = ''; const values: Record<string, number> = {};
  if (state?.document) {
    try {
      for (const p of state.document.parameters) { if (!draft[p.name]?.trim()) throw new Error(`${p.label}：请输入数值`); values[p.name] = Number(draft[p.name]); }
      withParameterValues(state.document, values);
    } catch (e) { validation = (e as Error).message; }
  }
  const reload = async () => {
    if (dirty && !window.confirm('重新载入会放弃尚未保存的参数修改，继续吗？')) return;
    setWorking(true); setError(''); setNotice('');
    try { accept(await api.parameters(projectId, source)); } catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  };
  const save = async (build: boolean) => {
    if (!state || validation) return;
    setWorking(true); setError(''); setNotice('');
    try {
      let saved = state;
      if (dirty && state.hash) { saved = await api.saveParameters(projectId, source, state.hash, values); accept(saved); setNotice('参数已保存，修改前后版本已保留。'); await changed(); }
      if (build) await run(saved.hash);
    } catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  };
  return <div className="parameter-editor">
    {state?.document ? <>
      <h4>{state.document.title}</h4><div className="parameter-grid">{state.document.parameters.map(p => <label key={p.name}>{p.label}<span className="parameter-input"><input aria-label={`参数 ${p.label}`} type="number" value={draft[p.name] ?? ''} min={p.min} max={p.max} step={p.step ?? 'any'} disabled={disabled || working} onChange={e => { setDraft(old => ({ ...old, [p.name]: e.target.value })); setNotice(''); }}/><span>{p.unit === 'unitless' ? '无量纲' : p.unit}</span></span><small>{p.min}–{p.max}{p.type === 'integer' ? ' · 整数' : ''}</small></label>)}</div>
      {state.document.constraints.length > 0 && <details><summary>参数约束（{state.document.constraints.length}）</summary>{state.document.constraints.map((c, i) => <small key={i}>{c.message}</small>)}</details>}
      {validation && <p role="alert" className="form-error">{validation}</p>}
      <small>参数保存在 {state.path}。保存后需重新构建，模型才会更新。</small>
    </> : state && <small>这份源码没有参数表。可新建参数化板件，或让 Agent 为源码声明并读取参数文件。</small>}
    {error && <p role="alert" className="form-error">{error}</p>}{notice && <p role="status" className="positive">{notice}</p>}
    <div className="build-actions">
      {state?.document && <button className="button" disabled={disabled || working || !dirty || !!validation} onClick={() => void save(false)}>保存参数</button>}
      <button className="button primary" disabled={disabled || working || !state || !!validation} onClick={() => void save(true)}>{working ? '正在处理…' : dirty ? '保存参数并构建' : '运行已保存源码'}</button>
      <button className="button" disabled={working || disabled} onClick={() => void reload()}>重新载入参数</button>
      {dirty && <small>有未保存的参数修改</small>}
    </div>
  </div>;
}
