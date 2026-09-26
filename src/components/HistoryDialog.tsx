import { useEffect, useRef, useState } from 'react';
import { Check, Columns2, Download, History, LoaderCircle, Plus, RefreshCw, RotateCcw, X } from 'lucide-react';
import type { Revision, RevisionComparison, RevisionFileDiff } from '../../shared/types';
import { api } from '../api';

const bytes = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
const kinds: Record<string, string> = { manual: '手动', 'before-save': '保存前', 'after-save': '保存后', 'before-agent': 'Agent 前', 'after-agent': 'Agent 后', 'before-import': '导入前', 'after-import': '导入后', 'before-restore': '恢复前', 'after-restore': '已恢复' };
function DiffText({ value, other, side }: { value: string | null; other: string | null; side: 'before' | 'after' }) {
  if (value === null) return <div className="small-empty">此版本无此文件</div>;
  const lines = value.split('\n'), opposite = (other ?? '').split('\n');
  let first = 0, suffix = 0;
  while (first < Math.min(lines.length, opposite.length) && lines[first] === opposite[first]) first++;
  while (suffix < Math.min(lines.length, opposite.length) - first && lines[lines.length - suffix - 1] === opposite[opposite.length - suffix - 1]) suffix++;
  return <pre className="revision-code">{lines.map((line, index) => <span key={index} className={index >= first && index < lines.length - suffix ? `changed ${side}` : ''}><i>{index + 1}</i>{line || ' '}</span>)}</pre>;
}
export function HistoryDialog({ projectId, busy, close, restored, preview }: { projectId: string; busy: boolean; close: () => void; restored: () => Promise<void>; preview: (revision: Revision, file: { path: string; size: number }) => void }) {
  const [revisions, setRevisions] = useState<Revision[]>([]), [selected, setSelected] = useState(''), [label, setLabel] = useState('');
  const [comparison, setComparison] = useState<RevisionComparison | null>(null), [diff, setDiff] = useState<RevisionFileDiff | null>(null), [file, setFile] = useState('');
  const [loading, setLoading] = useState(false), [working, setWorking] = useState(false), [confirm, setConfirm] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState(''), [refresh, setRefresh] = useState(0);
  const requestNumber = useRef(0);
  useEffect(() => { let live = true; void api.history(projectId).then(items => { if (live) { setRevisions(items); setSelected(old => old || items[0]?.id || ''); } }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, [projectId, refresh]);
  useEffect(() => {
    if (!selected) return;
    let live = true; setLoading(true); setComparison(null); setFile(''); setDiff(null); setConfirm(false); setError(''); requestNumber.current++;
    void api.compareRevision(projectId, selected).then(value => { if (live) setComparison(value); }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectId, selected, refresh]);
  const inspect = async (relative: string) => {
    const request = ++requestNumber.current; setFile(relative); setDiff(null); setError('');
    try { const value = await api.revisionDiff(projectId, selected, relative); if (request === requestNumber.current) setDiff(value); }
    catch (e) { if (request === requestNumber.current) setError((e as Error).message); }
  };
  const save = async () => {
    setWorking(true); setError(''); setSuccess('');
    try { const revision = await api.checkpoint(projectId, label || '手动保存版本'); setSelected(revision.id); setLabel(''); setRefresh(n => n + 1); setSuccess('版本已保存'); }
    catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  };
  const restore = async () => {
    if (!comparison) return;
    setWorking(true); setError(''); setSuccess('');
    try { await api.restoreRevision(projectId, selected, comparison.fingerprint); await restored(); setRefresh(n => n + 1); setSuccess('已恢复项目文件。恢复前的成果也保留在历史中。'); setConfirm(false); }
    catch (e) { setError((e as Error).message); setConfirm(false); } finally { setWorking(false); }
  };
  return <div className="modal-scrim"><section className="modal history-modal" role="dialog" aria-modal="true" aria-label="项目历史">
    <header><div><h2><History size={19}/>项目历史</h2><p>比较源码和模型，随时回到一个已保存的版本。</p></div><button className="icon-button" aria-label="关闭项目历史" disabled={working} onClick={close}><X size={20}/></button></header>
    <form className="history-save" onSubmit={e => { e.preventDefault(); void save(); }}><input aria-label="版本说明" placeholder="例如：调整相机孔径前" maxLength={160} value={label} onChange={e => setLabel(e.target.value)}/><button className="button primary" disabled={busy || working}><Plus size={14}/>保存当前版本</button><button type="button" className="icon-button" aria-label="刷新历史" disabled={working} onClick={() => setRefresh(n => n + 1)}><RefreshCw size={15}/></button></form>
    {busy && <p className="hint">Agent 正在运行，完成后会自动保存版本。停止任务后可以恢复。</p>}
    <div className="history-layout"><nav className="revision-list" aria-label="已保存版本">{!revisions.length && <div className="small-empty">还没有版本。保存当前成果作为起点。</div>}{revisions.map(revision => <button key={revision.id} disabled={working} className={selected === revision.id ? 'active' : ''} onClick={() => setSelected(revision.id)}><span className="revision-kind">{kinds[revision.kind]}</span><strong>{revision.label}</strong><small>{new Date(revision.createdAt).toLocaleString()} · {revision.files} 个文件 · {bytes(revision.bytes)}</small></button>)}</nav>
      <div className="revision-detail">{loading && <div className="small-empty"><LoaderCircle className="spin" size={16}/>正在比较项目文件…</div>}{comparison && <>
        <div className="revision-summary"><div><strong>{comparison.revision.label}</strong><p>相对此版本，当前项目有 {comparison.changes.length} 个文件变化</p></div><button className="button" disabled={busy || working || !comparison.changes.length} onClick={() => setConfirm(!confirm)}><RotateCcw size={14}/>恢复此版本</button></div>
        {confirm && <div className="restore-review"><p>将恢复该版本的源码和模型，并撤回此后新增的项目文件。当前成果会先保存为「恢复前」版本，对话记录保留。</p><button className="button primary" disabled={working || busy} onClick={() => void restore()}>{working ? <LoaderCircle className="spin" size={14}/> : <Check size={14}/>}备份当前成果并恢复</button><button className="text-button" disabled={working} onClick={() => setConfirm(false)}>取消</button></div>}
        {!!comparison.models.length && <details className="revision-models"><summary><Columns2 size={14}/>查看此版本的模型（{comparison.models.length}）</summary>{comparison.models.map(model => <div key={model.path}><span title={model.path}>{model.path.split('/').pop()}</span><button className="text-button" disabled={working} onClick={() => preview(comparison.revision, model)}>设为对比参考</button><a className="icon-button" aria-label={`下载历史 ${model.path}`} download={model.path.split('/').pop()} href={api.revisionFileUrl(projectId, selected, model.path)}><Download size={14}/></a></div>)}</details>}
        <div className="revision-changes">{comparison.changes.map(change => <button key={change.path} disabled={working} className={file === change.path ? 'active' : ''} onClick={() => void inspect(change.path)}><span className={`change-status ${change.status}`}>{change.status === 'added' ? '新增' : change.status === 'deleted' ? '删除' : '修改'}</span><span>{change.path}</span><small>{bytes(change.beforeSize)} → {bytes(change.afterSize)}</small></button>)}{!comparison.changes.length && <div className="small-empty"><Check size={16}/>项目文件与此版本一致</div>}</div>
        {file && !diff && !error && <div className="small-empty">正在读取文件差异…</div>}{diff && <div className="revision-diff"><h3>{diff.path}</h3>{diff.binary || diff.truncated ? <p className="hint">{diff.binary ? '二进制文件：可下载历史文件，或将历史模型设为对比参考。' : '文件较大，请下载历史文件对比。'}</p> : <div className="revision-diff-columns"><div><h4>保存的版本</h4><DiffText value={diff.before} other={diff.after} side="before"/></div><div><h4>当前项目</h4><DiffText value={diff.after} other={diff.before} side="after"/></div></div>}</div>}
      </>}</div></div>
    {error && <p className="form-error" role="alert">{error}</p>}{success && <p className="history-success" role="status"><Check size={14}/>{success}</p>}
    <p className="history-footnote">自动记录保存、导入和 Agent 修改。历史包含源码、模型和产物；隐藏文件、虚拟环境和依赖目录不参与恢复。</p>
  </section></div>;
}
