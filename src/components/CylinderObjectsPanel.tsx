import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { request } from '../api';
import {
  applyCylinderEdits, canUseCylinderPublication, fieldKey, fieldText, GLOBAL_FIELDS,
  OBJECT_GROUPS, objectFields, setCylinderEdit,
  type CylinderEdits, type CylinderField, type CylinderObjectModel, type CylinderRevision,
} from './cylinder-objects-state';
import './CylinderObjectsPanel.css';

type Publication = { source: string; preview: string; revision: CylinderRevision; manifest?: unknown };
type Job = { id: string; state: string; log?: string; error?: string; stage?: string };
type ObjectState = {
  model?: CylinderObjectModel | null; revision?: CylinderRevision;
  job?: Job | null; published?: Publication | null;
};
type Base = { model: CylinderObjectModel; revision: CylinderRevision };
export type CylinderObjectsPanelProps = {
  projectId: string; selectedId?: string;
  onSelect: (id: string) => void; onPreview: (path: string) => void;
  onSimulate: (source: string) => void; onChanged: () => Promise<void>;
};
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const isRunning = (job?: Job | null) => !!job && ['running', 'queued', 'preparing'].includes(job.state);
const selectedKey = (id: string) => 'castudio:cylinder-selection:' + id;
function rememberedSelection(id: string) {
  try { return localStorage.getItem(selectedKey(id)) || 'skin'; } catch { return 'skin'; }
}
function jobLabel(job?: Job | null) {
  if (isRunning(job)) return '正在重建与校验';
  if (job?.state === 'failed') return '构建未完成';
  if (job?.state === 'cancelled') return '构建已取消';
  if (job?.state === 'interrupted') return '构建已中断';
  return job?.state === 'succeeded' ? 'CAD 已发布' : '';
}

// Project key discards pending local draft state when moving to another project.
export function CylinderObjectsPanel(props: CylinderObjectsPanelProps) {
  return <CylinderObjectSession key={props.projectId} {...props} />;
}
function CylinderObjectSession(props: CylinderObjectsPanelProps) {
  const { projectId } = props;
  const prefix = useId();
  const apiBase = '/api/projects/' + encodeURIComponent(projectId) + '/cylinder-objects';
  const [server, setServer] = useState<ObjectState | null>(null);
  const [base, setBase] = useState<Base | null>(null);
  const [edits, setEdits] = useState<CylinderEdits>({});
  const [selected, setSelected] = useState(() => props.selectedId || rememberedSelection(projectId));
  const [groups, setGroups] = useState<Record<string, boolean>>({ skin: true, flange: true, longitudinal: false, ring: false });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [showIssues, setShowIssues] = useState(false);
  const callbacks = useRef(props); callbacks.current = props;
  const editsRef = useRef(edits); editsRef.current = edits;
  const busyRef = useRef(busy); busyRef.current = busy;
  const live = useRef(true);
  const serial = useRef(0);
  const lastPublication = useRef<string | null | undefined>(undefined);

  const fetchSnapshot = useCallback(async (forceDraft = false) => {
    const sequence = ++serial.current;
    const next = await request<ObjectState>(apiBase);
    if (!live.current || sequence !== serial.current) return next;
    setServer(next); setConnectionError('');
    if (forceDraft || Object.keys(editsRef.current).length === 0) {
      setBase(next.model && next.revision !== undefined ? { model: next.model, revision: next.revision } : null);
    }
    const publication = next.published;
    const key = publication ? String(publication.revision) + ':' + publication.source : null;
    const previous = lastPublication.current; lastPublication.current = key;
    if (previous !== undefined && key && key !== previous && publication && next.job?.state === 'succeeded') {
      callbacks.current.onPreview(publication.preview);
      void callbacks.current.onChanged().catch(e => live.current && setError('CAD 已发布，文件列表刷新失败：' + (e as Error).message));
    }
    return next;
  }, [apiBase]);

  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { if (!busyRef.current) await fetchSnapshot(); }
      catch (e) { if (live.current) setConnectionError((e as Error).message); }
      if (live.current) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { live.current = false; ++serial.current; clearTimeout(timer); };
  }, [fetchSnapshot]);

  useEffect(() => {
    if (props.selectedId && base?.model.components.some(c => c.id === props.selectedId)) setSelected(props.selectedId);
  }, [props.selectedId, base?.model.components]);
  const object = base?.model.components.find(c => c.id === selected) || base?.model.components[0];
  useEffect(() => {
    if (!object) return;
    setGroups(value => value[object.kind] ? value : { ...value, [object.kind]: true });
    try { localStorage.setItem(selectedKey(projectId), object.id); } catch { /* optional preference */ }
  }, [object?.id, object?.kind, projectId]);

  const dirty = Object.keys(edits).length > 0;
  const checked = base ? applyCylinderEdits(base.model, edits) : null;
  const running = isRunning(server?.job);
  const conflict = !!base && server?.revision !== undefined && server.revision !== base.revision;
  const current = canUseCylinderPublication(base?.revision, server?.published?.revision, dirty || conflict);
  const locked = !!busy || running;
  const selectObject = (id: string) => { setSelected(id); callbacks.current.onSelect(id); };
  const edit = (id: string, field: string, value: string, original: unknown) => {
    const next = setCylinderEdit(editsRef.current, fieldKey(id, field), value, original);
    editsRef.current = next; setEdits(next); setError('');
  };
  const act = async (action: string) => {
    busyRef.current = action; setBusy(action); setError('');
    try {
      if (action === 'initialize') await request(apiBase + '/initialize', json('POST', {}));
      else if (action === 'save') {
        if (!base || !checked || checked.issues.length) { setShowIssues(true); return; }
        await request(apiBase + '/model', json('PATCH', { revision: base.revision, model: checked.model }));
        if (!live.current) return;
        editsRef.current = {}; setEdits({}); setShowIssues(false);
      } else if (action === 'build') {
        if (!base || dirty || conflict) return;
        await request(apiBase + '/build', json('POST', { revision: base.revision }));
      } else if (action === 'cancel') await request(apiBase + '/cancel', json('POST', {}));
      else if (action === 'reload') {
        editsRef.current = {}; setEdits({}); setShowIssues(false);
      }
      await fetchSnapshot(action === 'save' || action === 'reload' || action === 'initialize');
    } catch (e) { if (live.current) setError((e as Error).message); }
    finally { busyRef.current = ''; if (live.current) setBusy(''); }
  };
  const input = (id: string, title: string, field: CylinderField, value: unknown) => {
    const key = fieldKey(id, field.key);
    const invalid = !!showIssues && !!checked?.issues.some(issue => issue.key === key);
    const inputId = prefix + '-' + key;
    return <label key={key} className={'cylinder-object-field' + (key in edits ? ' edited' : '')} htmlFor={inputId}>
      <span>{field.label}</span>
      <span className="cylinder-object-input">
        <input id={inputId} aria-label={title + ' · ' + field.label}
          aria-invalid={invalid || undefined} type="number" step={field.step}
          value={edits[key] ?? fieldText(value)} disabled={locked}
          onChange={event => edit(id, String(field.key), event.target.value, value)} />
        <span aria-hidden="true">{field.unit}</span>
      </span>
    </label>;
  };

  return <section className="cylinder-objects-panel" aria-label="圆柱对象编辑">
    <header className="cylinder-objects-heading">
      <div><strong>圆柱对象</strong><p>选中一个对象，调整它的尺寸</p></div>
      {base && <span className={'cylinder-object-badge' + (dirty ? ' pending' : '')}>{dirty ? '未保存' : current ? '已发布' : '待重建'}</span>}
    </header>
    {connectionError && <div className="cylinder-objects-alert" role="alert">{connectionError}<button type="button" onClick={() => void fetchSnapshot().catch(e => setConnectionError(e.message))}>重试连接</button></div>}
    {!server && !connectionError && <p className="cylinder-objects-empty" role="status">正在读取对象…</p>}
    {server && !base && <div className="cylinder-objects-empty">
      <p>将蒙皮、端框和每根加强筋保存为独立对象，修改后可重新仿真。</p>
      <button type="button" className="cylinder-primary" disabled={!!busy} onClick={() => void act('initialize')}>{busy ? '正在创建…' : '创建可编辑圆柱'}</button>
    </div>}
    {base && <>
      <div className="cylinder-objects-scroll">
        <details className="cylinder-global">
          <summary>整体尺寸 <span>Ø{base.model.diameter_mm} × {base.model.height_mm} mm</span></summary>
          <div className="cylinder-object-fields">{GLOBAL_FIELDS.map(field => input('$global', '整体尺寸', field, base.model[field.key as 'diameter_mm' | 'height_mm']))}</div>
          <p className="cylinder-object-hint">整体尺寸影响所有对象；环筋中心高度从底端面量起。</p>
        </details>
        <div className="cylinder-object-tree" aria-label="圆柱对象分组">
          {OBJECT_GROUPS.map(group => {
            const objects = base.model.components.filter(c => c.kind === group.kind);
            return <details key={group.kind} open={groups[group.kind]} onToggle={event => {
              const open = event.currentTarget.open; setGroups(value => value[group.kind] === open ? value : { ...value, [group.kind]: open });
            }}>
              <summary aria-label={group.label + '，' + objects.length + ' 个对象'}>{group.label}<span>{objects.length}</span></summary>
              <div className="cylinder-object-list" role="group" aria-label={group.label}>
                {objects.map(c => {
                  const changed = Object.keys(edits).some(key => key.startsWith(c.id + ':'));
                  return <button key={c.id} type="button" className={object?.id === c.id ? 'selected' : ''} aria-pressed={object?.id === c.id}
                    onClick={() => selectObject(c.id)} title={c.name}>
                    <span className={'cylinder-object-marker ' + c.kind} aria-hidden="true" />
                    <span>{c.name}</span>{changed && <span className="cylinder-object-dirty" aria-label="有未保存修改">•</span>}
                  </button>;
                })}
              </div>
            </details>;
          })}
        </div>
        {object && <form className="cylinder-object-editor" noValidate onSubmit={event => { event.preventDefault(); void act('save'); }}>
          <div className="cylinder-object-editor-heading"><strong>{object.name}</strong><span>对象参数</span></div>
          <div className="cylinder-object-fields">{objectFields(object).map(field => input(object.id, object.name, field, object[field.key as keyof typeof object]))}</div>
          {object.kind === 'flange' && <p className="cylinder-object-hint">此端框的孔阵列与厚度独立保存。</p>}
          {object.kind === 'longitudinal' && <p className="cylinder-object-hint">角度从 +X 方向起，沿圆周逆时针增加。</p>}
          {object.kind === 'ring' && <p className="cylinder-object-hint">中心高度为距底端面的轴向距离。</p>}
          <button className="cylinder-object-enter-submit" type="submit" tabIndex={-1} aria-hidden="true">保存参数</button>
        </form>}
        {showIssues && !!checked?.issues.length && <div role="alert" className="cylinder-objects-alert"><p>请检查以下参数：</p><ul>{checked.issues.map(issue => <li key={issue.key}>{issue.message}</li>)}</ul></div>}
        {conflict && <div className="cylinder-objects-alert" role="alert">其他操作已更新了模型。当前草稿仍保留。<button type="button" disabled={!!busy} onClick={() => void act('reload')}>放弃草稿并载入最新参数</button></div>}
        {error && <details className="cylinder-object-error" open><summary role="alert">操作未完成</summary><p>{error}</p></details>}
        {server?.job && <details className={'cylinder-object-job' + (running ? ' running' : '')}>
          <summary><span>{running && <i aria-hidden="true" />}{jobLabel(server.job)}</span><span>详情</span></summary>
          {server.job.error && <p className="cylinder-object-job-error">{server.job.error}</p>}
          {server.job.log && <pre>{server.job.log}</pre>}
          {!server.job.log && !server.job.error && <p>构建状态会自动更新。</p>}
        </details>}
      </div>
      <footer className="cylinder-objects-actions">
        <p aria-live="polite">{running ? '正在生成新几何，完成后更新三维模型。' : dirty ? '先保存参数，再重建模型。已有结果对应之前的几何。' : !current && server?.published ? '几何参数已更新；重新仿真前需重建 CAD。' : current ? '当前几何已发布，可以送入结构分析。' : '保存的参数需要重建为 CAD，才能送入结构分析。'}</p>
        <div className="cylinder-objects-action-row">
          {running ? <button type="button" disabled={!!busy} onClick={() => void act('cancel')}>取消构建</button> : <>
            <button type="button" disabled={locked || !dirty || conflict} onClick={() => void act('save')}>{busy === 'save' ? '正在保存…' : '保存参数'}</button>
            <button type="button" className="cylinder-primary" disabled={locked || dirty || conflict} onClick={() => void act('build')}>{busy === 'build' ? '正在启动…' : '重建并发布'}</button>
          </>}
        </div>
        <div className="cylinder-objects-action-row secondary">
          <button type="button" disabled={!server?.published || running} onClick={() => server?.published && props.onPreview(server.published.preview)}>查看已发布模型</button>
          <button type="button" disabled={!current || locked} onClick={() => server?.published && props.onSimulate(server.published.source)}>重新仿真</button>
        </div>
      </footer>
    </>}
    {!base && error && <p className="cylinder-objects-alert" role="alert">{error}</p>}
  </section>;
}
