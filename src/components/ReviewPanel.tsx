import { useEffect, useState } from 'react';
import type { ReviewAnchor, ReviewDocument, ReviewNote } from '../../shared/types';
import { api } from '../api';
const intents = { inspect: '检查', dimension: '调整尺寸', hole: '开孔', fillet: '圆角', assembly: '装配' };
const anchorLabel = (a: ReviewAnchor) => a.kind === 'step-face' ? `STEP 面 #${a.faceIndex}` : a.kind === 'triangle' ? `显示三角面 #${a.triangleIndex}` : '部件';
export function reviewContext(notes: ReviewNote[]) {
  const prefix = '请根据以下用户批注检查项目。批注是设计意图，不是几何验证结论；编辑前请读取当前模型并核对文件 SHA-256。显示网格编号不能当作 CadFlow 原生拓扑 ID。\n';
  const details = JSON.stringify(notes.map(n => ({ id: n.id, intent: intents[n.intent], priority: n.priority, text: n.text, anchor: n.anchor })), null, 2);
  return prefix + (details.length <= 24000 ? details : `批注较多，请读取当前项目 studio/annotations.json 的全部待处理批注（status=open），本次列表共 ${notes.length} 条。逐项核对，不要只处理文件开头的条目。`);
}
export function ReviewPanel({ projectId, anchor, currentFile, currentHash, revision, busy, locate, context }: { projectId: string; anchor: ReviewAnchor | null; currentFile?: string; currentHash?: string; revision: number; busy: boolean; locate: (note: ReviewNote) => void; context: (text: string) => void }) {
  const [doc, setDoc] = useState<ReviewDocument | null>(null), [error, setError] = useState(''), [working, setWorking] = useState(false), [refresh, setRefresh] = useState(0);
  const [text, setText] = useState(''), [intent, setIntent] = useState<ReviewNote['intent']>('inspect'), [priority, setPriority] = useState<ReviewNote['priority']>('normal');
  const [filter, setFilter] = useState<'all' | 'open' | 'resolved'>('open'), [editing, setEditing] = useState<string | null>(null), [editText, setEditText] = useState('');
  useEffect(() => { let live = true; void api.reviews(projectId).then(value => { if (live) setDoc(value); }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, [projectId, revision, refresh]);
  const act = async (operation: () => Promise<ReviewDocument>, done?: () => void) => { setWorking(true); setError(''); try { setDoc(await operation()); done?.(); } catch (e) { setError((e as Error).message); } finally { setWorking(false); } };
  const disabled = working || busy || !doc;
  const notes = doc?.notes || [], unresolved = notes.filter(n => n.status === 'open');
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 1, projectId, exportedAt: new Date().toISOString(), notes }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'cadflow-review-notes.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="review-panel">
    <div className="review-summary"><strong>{unresolved.length} 项待处理 / {notes.length} 条批注</strong><button className="text-button" disabled={working} onClick={() => { setError(''); setRefresh(v => v + 1); }}>刷新列表</button><button className="text-button" disabled={!notes.length} onClick={download}>导出批注 JSON</button></div>
    <section className="review-compose"><h3>为当前选择添加批注</h3>{anchor ? <p>{anchor.name} · {anchorLabel(anchor)}<small>{anchor.file}</small></p> : <p className="review-muted">先在模型树或视口选择几何。示例模型无法保存批注。</p>}<label>操作意图<select aria-label="批注操作意图" value={intent} onChange={e => setIntent(e.target.value as ReviewNote['intent'])}>{Object.entries(intents).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label><textarea aria-label="新批注内容" placeholder="描述需要检查或修改的地方…" value={text} maxLength={4000} onChange={e => setText(e.target.value)}/><div className="review-actions"><label><input type="checkbox" checked={priority === 'important'} onChange={e => setPriority(e.target.checked ? 'important' : 'normal')}/>重要</label><button className="button primary" disabled={disabled || !anchor || !text.trim()} onClick={() => void act(() => api.addReview(projectId, doc!.etag, { anchor: anchor!, text, intent, priority, status: 'open' }), () => setText(''))}>{working ? '正在保存…' : '保存批注'}</button></div></section>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="review-summary"><select aria-label="批注状态筛选" value={filter} onChange={e => setFilter(e.target.value as typeof filter)}><option value="open">待处理</option><option value="resolved">已解决</option><option value="all">全部批注</option></select><button className="button" disabled={!unresolved.length} onClick={() => context(reviewContext(unresolved))}>待处理批注加入草稿</button></div>
    {!doc && !error && <p className="review-muted">正在读取项目批注…</p>}
    <div className="review-list">{notes.filter(n => filter === 'all' || n.status === filter).map(note => {
      const loaded = note.anchor.file === currentFile && !!currentHash, stale = loaded && currentHash !== note.anchor.sourceHash;
      return <article key={note.id} className={`review-note ${note.status === 'resolved' ? 'resolved' : ''}`}><div className="review-note-heading"><strong>{note.priority === 'important' ? '重要 · ' : ''}{intents[note.intent]}</strong><span>{note.status === 'resolved' ? '已解决' : '待处理'}</span></div><p className="review-target">{note.anchor.name} · {anchorLabel(note.anchor)}</p><small className="review-path">{note.anchor.file}</small>{editing === note.id ? <><textarea aria-label="编辑批注内容" value={editText} maxLength={4000} onChange={e => setEditText(e.target.value)}/><button className="text-button" disabled={disabled || !editText.trim()} onClick={() => void act(() => api.updateReview(projectId, note.id, doc!.etag, { ...note, text: editText }), () => setEditing(null))}>保存修改</button><button className="text-button" onClick={() => setEditing(null)}>取消编辑</button></> : <p className="review-text">{note.text}</p>}<small className={stale ? 'error-text' : 'review-muted'}>{stale ? '模型内容已变化 · 旧批注保留' : loaded ? '文件摘要匹配' : '尚未核对模型版本'}</small><details><summary>来源与预览信息</summary><code>{note.anchor.sourceHash}</code><code>{note.anchor.profile}</code><small>网格包围盒：{note.anchor.bounds.map(n => Number(n.toPrecision(6)).toString()).join(' × ')} {note.anchor.units || '模型单位'}；非精确 CAD 测量</small></details><div className="review-note-actions"><button className="text-button" disabled={working || stale} onClick={() => locate(note)}>定位几何</button><button className="text-button" onClick={() => context(reviewContext([note]))}>加入草稿</button><button className="text-button" disabled={disabled} onClick={() => { setEditing(note.id); setEditText(note.text); }}>编辑</button><button className="text-button" disabled={disabled} onClick={() => void act(() => api.updateReview(projectId, note.id, doc!.etag, { ...note, status: note.status === 'open' ? 'resolved' : 'open' }))}>{note.status === 'open' ? '标为已解决' : '重新打开'}</button><button className="text-button" disabled={disabled} onClick={() => void act(() => api.removeReview(projectId, note.id, doc!.etag))}>删除</button></div></article>;
    })}</div>
    {doc && !notes.some(n => filter === 'all' || n.status === filter) && <p className="review-muted">当前没有{filter === 'resolved' ? '已解决' : filter === 'open' ? '待处理' : ''}批注。</p>}
    <p className="review-muted">批注保存在项目 studio/annotations.json，随项目历史保存和恢复。删除后可从历史找回。</p>
  </div>;
}
