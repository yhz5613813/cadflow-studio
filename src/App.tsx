import { choosePreview } from './scene/preview-file';
import { ConversationMessages } from './components/ConversationMessages';
import { ParametricPanel } from './components/ParametricPanel';
import { CylinderObjectsPanel } from './components/CylinderObjectsPanel';
import { cylinderMeshId } from './scene/cylinder-selection';
import { StructuralPanel } from './components/StructuralPanel';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PanelLeft, PanelRight, MoreHorizontal, SlidersHorizontal, FlaskConical, Thermometer, ArrowDownToLine, ArrowUp, Box, Boxes, Braces, Camera, Check, ChevronDown, ChevronRight, Circle, CircleDot, Columns2, Crosshair, Download, Eye, EyeOff, FileCode2, FilePlus2, FileText, FolderOpen, Grid2X2, History, Layers3, LoaderCircle, Maximize, MessageSquare, Minus, MousePointer2, Package, PanelBottom, Plus, Rotate3d, Save, ScanLine, Scissors, Settings2, Square, Terminal, Upload, Workflow, X } from 'lucide-react';
import type { Artifact, Message, Plugin, Project, Status, StudioEvent } from '../shared/types';
import { api, request as apiRequest } from './api';
import { Viewport, type ViewportHandle } from './components/Viewport';
import { BrandIcon } from './components/BrandIcon';
import { ModelTree } from './components/ModelTree';
import { ReviewPanel } from './components/ReviewPanel';
import { ThermalPanel } from './components/ThermalPanel';
import { BuildPanel } from './components/BuildPanel';
import { MeasurementPanel } from './components/MeasurementPanel';
import type { ReviewNote } from '../shared/types';
import type { PreviewState } from './scene/review-selection';
import { SceneInspector } from './components/SceneInspector';
import type { PackageInfo } from './scene/package';
import { HistoryDialog } from './components/HistoryDialog';
import { SelectionProperties } from './components/SelectionProperties';
import { SourceEditor } from './components/SourceEditor';
import { Dialog, PluginDialog, SettingsDialog } from './components/Dialogs';
import type { MeshInfo, Selection, ViewOptions } from './scene/renderer';

const initialOptions: ViewOptions = { edges: true, grid: true, ortho: false, section: 100, explode: 0, mode: 'component' };
const sizeLabel = (bytes: number) => bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
function ToolButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) { return <button className={`tool-button ${active ? 'active' : ''}`} title={label} aria-label={label} aria-pressed={active} onClick={onClick}>{children}</button>; }
export default function App() {
  const [structuralSource,setStructuralSource]=useState('');
  const [publishedStructuralSource, setPublishedStructuralSource] = useState('');
  const [structuralSourceRequest, setStructuralSourceRequest] = useState(0);
  type Workspace = 'model' | 'parametric' | 'structural' | 'thermal';
  const [workspaceMode, setWorkspaceMode] = useState<Workspace>('model');
  const [visited, setVisited] = useState<Workspace[]>(['model']);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 760);
  const [assistantOpen, setAssistantOpen] = useState(() => window.innerWidth >= 1200);
  const openWorkspace = (mode: Workspace) => {
    setWorkspaceMode(mode); setVisited(old => old.includes(mode) ? old : [...old, mode]);
    if (window.innerWidth < 760) setSidebarOpen(false);
  };
  const workspaceTitle = {model:'模型预览', parametric:'参数化建模', structural:'结构仿真', thermal:'热仿真'}[workspaceMode];
  const [projects, setProjects] = useState<Project[]>([]), [project, setProject] = useState<Project | null>(null), [status, setStatus] = useState<Status | null>(null), [plugins, setPlugins] = useState<Plugin[]>([]);
  const [files, setFiles] = useState<Artifact[]>([]), [messages, setMessages] = useState<Message[]>([]), [busy, setBusy] = useState(false), [draft, setDraft] = useState('');
  const [asset, setAsset] = useState<Artifact | null>(null), [reference, setReference] = useState<(Artifact & { revision?: string; revisionLabel?: string }) | null>(null), [comparison, setComparison] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null), [pendingReview, setPendingReview] = useState<ReviewNote | null>(null), [reviewRevision, setReviewRevision] = useState(0);
  const [scenePackage, setScenePackage] = useState<PackageInfo | null>(null);
  const [cylinderObjectsOpen, setCylinderObjectsOpen] = useState(false);
  const [cylinderObjectsVisited, setCylinderObjectsVisited] = useState(false);
  const [cylinderSelectedId, setCylinderSelectedId] = useState('skin');
  const cylinderSelectedRef = useRef('skin');
  const cylinderPanelPreference = useRef<boolean | null>(null);
  const requestedPreview = useRef<{ projectId: string; path: string } | null>(null);
  const [meshes, setMeshes] = useState<MeshInfo[]>([]), [selection, setSelection] = useState<Selection | null>(null), [options, setOptions] = useState(initialOptions);
  const [dialog, updateDialog] = useState<'plugins' | 'settings' | 'new' | 'projects' | 'resources' | 'history' | 'scene' | 'reviews' | 'builds' | 'structural' | 'parametric' | 'thermal' | 'measurements' | null>(null), [newName, setNewName] = useState(''), [toast, setToast] = useState('');
  const [dock, setDock] = useState<'files' | 'source' | 'properties' | 'activity' | null>(null), [treeTab, setTreeTab] = useState<'model' | 'files'>('model');
  const [sourcePath, setSourcePath] = useState(''), [sourceText, setSourceText] = useState(''), [savedText, setSavedText] = useState(''), [sending, setSending] = useState(false);
  const view = useRef<ViewportHandle>(null), referenceView = useRef<ViewportHandle>(null), upload = useRef<HTMLInputElement>(null), chatEnd = useRef<HTMLDivElement>(null);
  const currentProject = useRef<string>(''), assetRef = useRef<Artifact | null>(null); assetRef.current = asset;
  const projectEpoch = useRef(0), fileRequest = useRef(0), appliedFileRequest = useRef(0);
  const notify = (text: string) => setToast(text);
  const parameterEdits = useRef({ dirty: false, working: false });
  const trackParameterEdits = useCallback((state: { dirty: boolean; working: boolean }) => { parameterEdits.current = state; }, []);
  const setDialog = (next: typeof dialog) => {
    if (dialog === 'builds' && next !== 'builds') {
      if (parameterEdits.current.working) { notify('正在保存或提交参数，请稍候。'); return; }
      if (parameterEdits.current.dirty && !window.confirm('参数有未保存修改，是否放弃修改并继续？')) return;
    }
    if (next === 'parametric' || next === 'structural' || next === 'thermal') { openWorkspace(next); updateDialog(null); return; }
    updateDialog(next);
  };
  useEffect(() => { if (dialog !== 'projects') return; let live = true; void api.projects().then(list => { if (live) setProjects(list); }).catch(e => { if (live) notify(e.message); }); return () => { live = false; }; }, [dialog]);
  const refreshGlobal = useCallback(async () => { const [s, p, list] = await Promise.all([api.status(), api.plugins(), api.projects()]); setStatus(s); setPlugins(p); setProjects(list); }, []);
  useEffect(() => { void (async () => { try { const list = await api.projects(); const first = list[0] || await api.createProject('我的第一个设计'); setProject(list.find(p=>p.id===(new URLSearchParams(location.search).get('project')||localStorage.getItem('pi-studio-project'))) || first); setProjects(list.length ? list : [first]); await refreshGlobal(); } catch (e) { notify((e as Error).message); } })(); }, [refreshGlobal]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 7000); return () => clearTimeout(timer); }, [toast]);
  const refreshFiles = useCallback(async (id: string) => {
    if (currentProject.current !== id) return;
    const epoch = projectEpoch.current, request = ++fileRequest.current;
    // Only resolve the published default while no model is selected. Recheck selection after both reads.
    const [incoming, cylinderState] = await Promise.all([
      api.files(id),
      !assetRef.current ? apiRequest<{ published?: { preview?: string; source?: string } | null }>(
        '/api/projects/' + encodeURIComponent(id) + '/cylinder-objects',
      ).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    if (currentProject.current !== id || epoch !== projectEpoch.current || request < appliedFileRequest.current) return;
    appliedFileRequest.current = request;
    setFiles(incoming);
    if (typeof cylinderState?.published?.source === 'string') setPublishedStructuralSource(cylinderState.published.source);
    const requested = requestedPreview.current;
    const exact = requested?.projectId === id ? incoming.find(f => f.path === requested.path && f.kind === 'model') : undefined;
    if (exact) { requestedPreview.current = null; assetRef.current = exact; setAsset(exact); return; }
    const current = assetRef.current;
    if (current) { const updated = incoming.find(f => f.path === current.path); if (!updated) setAsset(null); else if (updated.modified !== current.modified) setAsset(updated); }
    else { const preferred = cylinderState?.published?.preview; const preview = choosePreview(incoming, typeof preferred === 'string' ? preferred : undefined); if (preview) { assetRef.current = preview; setAsset(preview); } }
  }, []);

  const toggleCylinderObjects = (open: boolean) => {
    setCylinderObjectsOpen(open); if (open) setCylinderObjectsVisited(true);
    cylinderPanelPreference.current = open;
    if (project) { try { localStorage.setItem('castudio:cylinder-panel:' + project.id, open ? '1' : '0'); } catch { /* optional preference */ } }
  };
  useEffect(() => {
    if (cylinderPanelPreference.current === null && files.some(file => file.path.startsWith('cylinder-objects/'))) {
      setCylinderObjectsOpen(true); setCylinderObjectsVisited(true);
    }
  }, [files]);
  const rememberCylinderSelection = (id: string) => {
    cylinderSelectedRef.current = id; setCylinderSelectedId(id);
    if (project) { try { localStorage.setItem('castudio:cylinder-selection:' + project.id, id); } catch { /* optional preference */ } }
  };
  const receiveSelection = (next: Selection | null) => {
    setSelection(next);
    if (next?.cylinderObjectId) {
      rememberCylinderSelection(next.cylinderObjectId);
      setCylinderObjectsVisited(true);
    }
  };
  const receiveMeshes = (next: MeshInfo[]) => {
    setMeshes(next);
    const id = cylinderMeshId(next, cylinderSelectedRef.current);
    if (id) view.current?.select(id);
  };
  const selectCylinderObject = (id: string) => {
    rememberCylinderSelection(id);
    const meshId = cylinderMeshId(meshes, id);
    if (meshId) {
      view.current?.visible(meshId, true);
      setMeshes(old => old.map(mesh => mesh.id === meshId ? { ...mesh, visible: true } : mesh));
      view.current?.select(meshId);
    }
  };
  const showCylinderPreview = (id: string, path: string) => {
    if (currentProject.current !== id) return;
    requestedPreview.current = { projectId: id, path };
    // Refresh callbacks and artifact events can overlap; the exact requested path survives either response.
    void refreshFiles(id).catch(e => notify((e as Error).message));
  };
  useLayoutEffect(() => {
    if (!project) return;
    projectEpoch.current++;
    setFiles([]); setMeshes([]); setScenePackage(null); setStructuralSource(''); setPublishedStructuralSource(''); requestedPreview.current = null;
    let selectedObject = 'skin', panelPreference: string | null = null;
    try { selectedObject = localStorage.getItem('castudio:cylinder-selection:' + project.id) || 'skin'; panelPreference = localStorage.getItem('castudio:cylinder-panel:' + project.id); } catch { /* optional preferences */ }
    cylinderSelectedRef.current = selectedObject; setCylinderSelectedId(selectedObject);
    cylinderPanelPreference.current = panelPreference === null ? null : panelPreference === '1';
    setCylinderObjectsOpen(panelPreference === '1'); setCylinderObjectsVisited(panelPreference === '1');
    const id = project.id; localStorage.setItem('pi-studio-project',id); currentProject.current = id; setPendingReview(null); setPreview(null); setAsset(null); assetRef.current = null; setReference(null); setMessages([]); setSelection(null); setSourcePath(''); setSourceText(''); setSavedText(''); setBusy(false);
    let live = true;
    void api.messages(id).then(m => { if (live) setMessages(m); }).catch(e => notify(e.message));
    void refreshFiles(id).catch(e => notify(e.message));
    void api.status().then(s => { if (live) { setStatus(s); setBusy(s.busyProjects.includes(id)); } }).catch(() => {});
    const events = new EventSource(`/api/projects/${id}/events`);
    events.onmessage = event => {
      if (!live) return; const payload = JSON.parse(event.data) as StudioEvent, data = payload.data;
      if (['annotations_changed', 'artifacts_changed', 'history_changed'].includes(payload.type)) setReviewRevision(n => n + 1);
      if (payload.type === 'message') setMessages(old => { const m = data as unknown as Message, index = old.findIndex(v => v.id === m.id); return index < 0 ? [...old, m] : old.map(v => v.id === m.id ? m : v); });
      if (payload.type === 'delta') setMessages(old => { const id = String(data.id), existing = old.find(m => m.id === id); return existing ? old.map(m => m.id === id ? { ...m, text: m.text + String(data.text) } : m) : [...old, { id, role: 'assistant', text: String(data.text), timestamp: Date.now() }]; });
      if (payload.type === 'tool_start') setMessages(old => [...old.filter(m => m.id !== data.id), { id: String(data.id), role: 'tool', text: JSON.stringify(data.args, null, 2), toolName: String(data.toolName), timestamp: Date.now() }]);
      if (payload.type === 'tool_update') setMessages(old => old.map(m => m.id === data.id ? { ...m, text: String(data.text) } : m));
      if (payload.type === 'run_start') setBusy(true);
      if (payload.type === 'run_end') { setBusy(false); void refreshGlobal(); }
      if (payload.type === 'artifacts_changed' || payload.type === 'run_end') void refreshFiles(id);
    };
    events.onopen = () => { void api.status().then(s => { if (live) setBusy(s.busyProjects.includes(id)); }).catch(() => {}); };
    const timer = setInterval(() => void refreshFiles(id).catch(() => {}), 3500);
    return () => { live = false; projectEpoch.current++; currentProject.current = ''; clearInterval(timer); events.close(); };
  }, [project?.id, refreshFiles, refreshGlobal]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [messages.length, busy]);
  const doUpload = async (file: File) => {
    if (!project) return;
    try { notify('正在导入模型…'); const result = await api.upload(project.id, file); const list = await api.files(project.id); setFiles(list); const imported = list.find(f => f.path === result.path); if (imported?.kind === 'model') setAsset(imported); setDock('files'); notify(`已导入 ${file.name}`); } catch (e) { notify((e as Error).message); }
  };
  const send = async () => {
    if (!project || !draft.trim() || sending || busy) return;
    if (!status?.hasCredentials) { setDialog('settings'); return; }
    setSending(true);
    try { await api.prompt(project.id, draft.trim(), selection ? { ...selection, file: asset?.path || 'UI demonstration mesh', isDemo: !asset } : undefined); setDraft(''); setBusy(true); }
    catch (e) { notify((e as Error).message); } finally { setSending(false); }
  };
  const openSource = async (file: Artifact) => { if (!project) return; if (sourceText !== savedText && sourcePath !== file.path && !window.confirm('当前源码有未保存修改，是否切换文件？')) return; try { const text = await api.source(project.id, file.path); setSourcePath(file.path); setSourceText(text); setSavedText(text); setDock('source'); } catch (e) { notify((e as Error).message); } };
  const setOption = <K extends keyof ViewOptions>(key: K, value: ViewOptions[K]) => setOptions(old => ({ ...old, [key]: value }));
  const demo = !asset;
  const modelUrl = asset && project ? `${api.fileUrl(project.id, asset.path)}&v=${asset.modified}` : undefined;
  const locateReview = (note: ReviewNote) => {
    const file = files.find(f => f.path === note.anchor.file);
    if (!file) { notify('批注对应的模型文件已不存在，原批注仍保留'); return; }
    openWorkspace('model'); setPendingReview(note); setAsset(file); setDialog(null);
  };
  useEffect(() => {
    if (!pendingReview || !preview || asset?.path !== pendingReview.anchor.file || preview.url !== modelUrl || preview.status === 'loading') return;
    if (preview.status === 'error') { notify(preview.error || '模型读取失败'); setPendingReview(null); return; }
    const result = view.current?.locateReview(pendingReview.anchor);
    if (result?.error || !result?.meshId) notify(result?.error || '无法定位批注');
    else { setMeshes(old => old.map(m => m.id === result.meshId ? { ...m, visible: true } : m)); setDock('properties'); notify('已定位批注对应的几何'); }
    setPendingReview(null);
  }, [pendingReview, preview, modelUrl, asset?.path]);
  const reviewAnchor = asset && selection?.review && preview?.status === 'ready' && preview.url === modelUrl ? { ...selection.review, file: asset.path } : null;
  const activeModel = status?.settings.model || status?.models[0]?.name;
  const sourceDirty = sourceText !== savedText;
  const canLeaveSource = () => !sourceDirty || window.confirm('当前源码有未保存修改，是否放弃修改并继续？');
  const createSource = async () => {
    if (!project || !canLeaveSource()) return;
    try {
      const existing = await api.files(project.id);
      let path = 'model.py', suffix = 1;
      while (existing.some(file => file.path === path)) path = `model_${suffix++}.py`;
      const text = '# 在此编写 Python 建模程序\n';
      await api.saveSource(project.id, path, text, null);
      await refreshFiles(project.id); setSourcePath(path); setSourceText(text); setSavedText(text);
    } catch (e) { notify((e as Error).message); }
  };
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (sourceDirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [sourceDirty]);
  return <div className={`studio ${sidebarOpen ? "sidebar-open" : "sidebar-closed"} ${assistantOpen ? "assistant-open" : "assistant-closed"}`} onDragOver={e => { e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (e.dataTransfer.files[0]) void doUpload(e.dataTransfer.files[0]); }}>

    <header className="topbar">
      <div className="breadcrumb"><button className="icon-button" aria-label="切换项目导航" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><PanelLeft size={18}/></button><button className="project-breadcrumb" onClick={() => setDialog('projects')} title={project?.name}>{project?.name || '正在打开项目'}<ChevronDown size={13}/></button><span className="header-divider"/><span className="workspace-breadcrumb">{workspaceTitle}</span></div>
      <div className="top-actions"><span className="saved-indicator"><Check size={13}/>{sourceDirty ? '源码未保存' : '已保存'}</span><button className="button import-button" onClick={() => upload.current?.click()}><Upload size={14}/><span>导入</span></button><button className="button" onClick={() => { openWorkspace('model'); setDock('files'); }}><ArrowDownToLine size={14}/><span>文件</span></button><button className={`button assistant-toggle ${assistantOpen ? 'active' : ''}`} aria-label="切换设计助手" aria-expanded={assistantOpen} onClick={() => setAssistantOpen(!assistantOpen)}><PanelRight size={16}/><span>助手</span></button></div>
    </header>
    {sidebarOpen && <button className="navigation-scrim" aria-label="收起项目导航" onClick={() => setSidebarOpen(false)}/>}
    <aside className="navigator" aria-label="项目导航">
      <div className="sidebar-brand"><div className="brand-symbol"><Boxes size={22}/></div><strong>CAStudio</strong><span>Workspace</span></div>
      <button className="new-project" onClick={() => setDialog('new')}><Plus size={16}/>新建项目</button>
      <div className="sidebar-section-label">工作空间<button className="icon-button" aria-label="切换项目" onClick={() => setDialog('projects')}><FolderOpen size={15}/></button></div>
      <nav className="workspace-navigation" aria-label="工作区">
        <button className={workspaceMode === 'model' ? 'active' : ''} aria-current={workspaceMode === 'model' ? 'page' : undefined} onClick={() => openWorkspace('model')}><Box size={17}/><span>模型预览</span></button>
        <button className={workspaceMode === 'parametric' ? 'active' : ''} aria-current={workspaceMode === 'parametric' ? 'page' : undefined} onClick={() => setDialog('parametric')}><SlidersHorizontal size={17}/><span>参数化建模</span></button>
        <button className={workspaceMode === 'structural' ? 'active' : ''} aria-current={workspaceMode === 'structural' ? 'page' : undefined} onClick={() => setDialog('structural')}><FlaskConical size={17}/><span>结构仿真</span></button>
        <button className={workspaceMode === 'thermal' ? 'active' : ''} aria-current={workspaceMode === 'thermal' ? 'page' : undefined} onClick={() => setDialog('thermal')}><Thermometer size={17}/><span>热仿真</span></button>
        <button onClick={() => { if (sourceDirty) { notify('请先保存源码修改，再打开项目历史。'); openWorkspace('model'); setDock('source'); return; } setDialog('history'); }}><History size={17}/><span>项目历史</span></button>
      </nav>
      <div className="resource-section"><div className="tabs small"><button className={treeTab === 'model' ? 'active' : ''} onClick={() => setTreeTab('model')}>模型树 <span>{meshes.length}</span></button><button className={treeTab === 'files' ? 'active' : ''} onClick={() => setTreeTab('files')}>文件 <span>{files.length}</span></button></div>
            <div className="tree-scroll">{treeTab === 'model' ? <ModelTree key={asset?.path || 'demo'} meshes={meshes} selection={selection} name={asset?.name || '法兰装配'} demo={demo} select={id=>view.current?.select(id)} visibility={(ids, visible)=>{ const affected=new Set(ids); ids.forEach(id=>view.current?.visible(id,visible)); setMeshes(old=>old.map(mesh=>affected.has(mesh.id)?{...mesh,visible}:mesh)); }}/> : <>{files.length === 0 && <div className="small-empty">导入模型或让 Agent 创建文件</div>}{files.map(file => <button className="file-tree-row" key={file.path} onClick={() => (() => { openWorkspace('model'); if (file.kind === 'model') setAsset(file); else if (file.kind === 'source') void openSource(file); else setDock('files'); })()}>{file.kind === 'model' ? <Box size={14}/> : <FileCode2 size={14}/>}<span>{file.name}</span></button>)}</>}</div>
</div>
      <div className="navigator-bottom"><button onClick={() => setDialog('plugins')}><Package size={16}/>扩展</button><button onClick={() => setDialog('settings')}><Settings2 size={16}/>设置</button><span className="local-workspace"><span className="status-dot"/>本地工作空间</span></div>
    </aside>
    <main className="model-workspace">
      <div className="workspace-heading"><div><span className="workspace-kicker">{workspaceMode === 'model' ? 'DESIGN' : workspaceMode === 'parametric' ? 'MODELING' : 'ANALYSIS'}</span><h1>{workspaceTitle}</h1></div><div className="workspace-actions">{workspaceMode === 'model' && project && <button className={'cylinder-objects-toggle' + (cylinderObjectsOpen ? ' active' : '')} aria-label="圆柱对象" aria-pressed={cylinderObjectsOpen} aria-controls="cylinder-object-sidebar" onClick={() => toggleCylinderObjects(!cylinderObjectsOpen)}><SlidersHorizontal size={15}/><span>圆柱对象</span></button>}<button className="icon-button" aria-label="专注工作区" title="收起导航与助手" onClick={() => { setSidebarOpen(false); setAssistantOpen(false); }}><Maximize size={17}/></button><details className="workspace-menu"><summary aria-label="工程工具" title="工程工具"><MoreHorizontal size={20}/></summary><div className="workspace-menu-items">
       <button onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); setDialog('builds'); }}><Terminal size={16}/>构建与运行</button>
       <button onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); setDialog('measurements'); }}><ScanLine size={16}/>几何检查</button>
       <button onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); setDialog('reviews'); }}><MessageSquare size={16}/>批注与检查清单</button>
       <button disabled={!scenePackage} onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); setDialog('scene'); }}><Workflow size={16}/>场景与特征</button>
      </div></details></div></div>
      <section className="model-stage" hidden={workspaceMode !== 'model'} aria-label="模型工作区"><div className="viewport-heading"><div className="document-tab"><Box size={14}/><span>{asset?.name || '法兰装配 · 预览示例'}</span>{demo ? <span className="demo-dot"/> : <span className="status-dot"/>}</div><button className={`compare-button ${comparison ? 'active' : ''}`} onClick={() => setComparison(!comparison)}><Columns2 size={14}/>对比视图</button></div>
      <div className="viewport-toolbar"><div className="tool-group selection-mode-tools"><ToolButton label="选择部件" active={options.mode === 'component'} onClick={() => setOption('mode', 'component')}><MousePointer2 size={16}/><span>部件</span></ToolButton><ToolButton label="选择面（STEP 面或网格三角面）" active={options.mode === 'face'} onClick={() => setOption('mode', 'face')}><ScanLine size={16}/><span>{/\.(step|stp)$/i.test(asset?.name || '') ? '几何面' : '三角面'}</span></ToolButton><span className="toolbar-label">{options.mode === 'component' ? '部件选择' : '面选择'}</span></div><div className="tool-group"><ToolButton label="边线" active={options.edges} onClick={() => setOption('edges', !options.edges)}><Box size={16}/></ToolButton><ToolButton label="网格" active={options.grid} onClick={() => setOption('grid', !options.grid)}><Grid2X2 size={16}/></ToolButton><ToolButton label="正交投影" active={options.ortho} onClick={() => setOption('ortho', !options.ortho)}><Square size={15}/></ToolButton><ToolButton label="剖切" active={options.section < 100} onClick={() => setOption('section', options.section < 100 ? 100 : 60)}><Scissors size={16}/></ToolButton><ToolButton label="拆分显示" active={options.explode > 0} onClick={() => setOption('explode', options.explode > 0 ? 0 : 30)}><Layers3 size={16}/></ToolButton></div><div className="toolbar-spacer"/><ToolButton label="保存视口截图" onClick={() => view.current?.snapshot()}><Camera size={16}/></ToolButton><ToolButton label="适应视图" onClick={() => { view.current?.fit(); referenceView.current?.fit(); }}><Maximize size={16}/></ToolButton></div>
      <div className="model-canvas-layout"><div className={`viewports ${comparison ? 'compare' : ''}`}><Viewport key={`result-${project?.id || ''}`} ref={view} projectId={project?.id} url={modelUrl} name={asset?.name} demo={demo} options={options} onMeshes={receiveMeshes} onSelection={receiveSelection} onPackage={setScenePackage} onPreview={setPreview} label={comparison ? '当前设计' : undefined}/>{comparison && <Viewport key={`reference-${project?.id}-${reference?.revision || 'current'}-${reference?.path || ''}`} ref={referenceView} url={reference && project ? reference.revision ? api.revisionFileUrl(project.id, reference.revision, reference.path) : `${api.fileUrl(project.id, reference.path)}&v=${reference.modified}` : undefined} name={reference?.name} options={options} label={reference?.revisionLabel ? `历史 · ${reference.revisionLabel}` : '参考模型'}/>}<div className="canvas-meta"><span>{demo ? '交互示例 · 非 CAD 验证结果' : /\.(zip|scadpkg)$/i.test(asset.name) ? scenePackage ? '场景包 · mm · 装配与摘要已校验' : '归档模型预览' : /\.(step|stp)$/i.test(asset.name) ? 'STEP 预览 · mm · 面对应信息' : '本地模型预览'}</span><span>{meshes.length} 个网格 · {Math.round(meshes.reduce((sum, m) => sum + m.triangles, 0)).toLocaleString()} 三角面</span></div>{options.section < 100 && <div className="section-control"><Scissors size={14}/><span>Z 剖切</span><input aria-label="剖切位置" type="range" min="0" max="100" value={options.section} onChange={e => setOption('section', Number(e.target.value))}/><span>{options.section}%</span><button className="icon-button" aria-label="关闭剖切" onClick={() => setOption('section', 100)}><X size={13}/></button></div>}</div>
      {project && cylinderObjectsVisited && <aside id="cylinder-object-sidebar" className="cylinder-object-sidebar" hidden={!cylinderObjectsOpen}><CylinderObjectsPanel projectId={project.id} selectedId={cylinderSelectedId} onSelect={selectCylinderObject} onPreview={path => showCylinderPreview(project.id, path)} onSimulate={source => { setStructuralSource(source); setStructuralSourceRequest(n => n + 1); setDialog('structural'); }} onChanged={() => refreshFiles(project.id)}/></aside>}
      </div>
      <div className={`bottom-dock ${dock ? 'open' : ''}`}><div className="dock-tabs"><button className={dock === 'files' ? 'active' : ''} onClick={() => setDock(dock === 'files' ? null : 'files')}><FolderOpen size={13}/>文件 <span>{files.length}</span></button><button className={dock === 'source' ? 'active' : ''} onClick={() => setDock(dock === 'source' ? null : 'source')}><Braces size={14}/>源码{sourceDirty && <span className="demo-dot"/>}</button><button className={dock === 'properties' ? 'active' : ''} onClick={() => setDock(dock === 'properties' ? null : 'properties')}><SlidersIcon/>属性</button><button className={dock === 'activity' ? 'active' : ''} onClick={() => setDock(dock === 'activity' ? null : 'activity')}><Terminal size={13}/>运行记录</button><div className="toolbar-spacer"/><button className="icon-button" aria-label={dock ? '折叠底部面板' : '展开底部面板'} onClick={() => setDock(dock ? null : 'files')}>{dock ? <Minus size={14}/> : <PanelBottom size={14}/>}</button></div>
      {dock === 'files' && <div className="files-dock">{files.length === 0 ? <div className="files-empty"><div className="file-empty-icon"><FilePlus2 size={23}/></div><div><strong>让想法成为第一个文件</strong><p>导入 GLB、STL、OBJ 或 STEP，或向 Agent 描述你的设计。</p></div><button className="button" onClick={() => upload.current?.click()}><Plus size={13}/>导入文件</button></div> : <div className="file-list">{files.map(file => <div className={`artifact-row ${asset?.path === file.path ? 'active' : ''}`} key={file.path}><button className="artifact-name" onClick={() => file.kind === 'model' ? setAsset(file) : file.kind === 'source' ? void openSource(file) : undefined}>{file.kind === 'model' ? <Box size={15}/> : <FileText size={15}/>}<span title={file.path}><strong>{file.name}</strong><small>{file.path.startsWith('imports/') ? '导入文件' : file.path.includes('/') ? file.path.slice(0,file.path.lastIndexOf('/')) : '项目文件'}</small></span></button><span className="file-size">{sizeLabel(file.size)}</span>{file.kind === 'model' && <button className="text-button" onClick={() => { setReference(file); setComparison(true); }}>设为参考</button>}<a className="icon-button" aria-label={`下载 ${file.name}`} href={api.fileUrl(project!.id, file.path)} download={file.name}><Download size={14}/></a></div>)}</div>}</div>}
      {dock === 'source' && <div className="source-dock"><div className="source-bar"><select aria-label="选择源码文件" value={sourcePath} onChange={e => { const f = files.find(f => f.path === e.target.value); if (f) void openSource(f); }}><option value="">选择一个源文件</option>{files.filter(f => f.kind === 'source').map(f => <option key={f.path} value={f.path}>{f.name}</option>)}</select><button className="text-button" disabled={busy || !sourcePath || !sourceDirty} onClick={async () => { try { await api.saveSource(project!.id, sourcePath, sourceText, savedText); setSavedText(sourceText); notify('源码已保存'); } catch (e) { notify((e as Error).message); } }}><Save size={13}/>保存</button><button className="text-button" disabled={busy || !project} onClick={() => void createSource()}>新建 Python</button></div>{sourcePath ? <SourceEditor value={sourceText} onChange={setSourceText} readOnly={busy}/> : <div className="small-empty">打开 Agent 生成的 Python，或新建一个源文件开始编辑。</div>}</div>}
      {dock === 'properties' && <div className="properties-dock"><SelectionProperties selection={selection} selectFace={(id, face) => view.current?.selectFace(id, face) ?? false}/></div>}
      {dock === 'activity' && <div className="activity-dock">{messages.filter(m => m.role === 'tool' || m.role === 'system').length ? messages.filter(m => m.role === 'tool' || m.role === 'system').map(m => <details key={m.id}><summary><span className={m.error ? 'error-text' : 'positive'}>●</span>{m.toolName || '系统'}<time>{new Date(m.timestamp).toLocaleTimeString()}</time></summary><pre>{m.text}</pre></details>) : <div className="small-empty">Agent 运行后，这里会记录工具调用与错误信息。</div>}</div>}</div>
      </section>
      {project && visited.includes('parametric') && <section className="workspace-content parametric-workspace" hidden={workspaceMode !== 'parametric'} aria-label="参数化建模工作区"><ParametricPanel key={project.id} projectId={project.id} changed={() => refreshFiles(project.id)} simulate={source => { setStructuralSource(source); void refreshFiles(project.id); setDialog('structural'); }}/></section>}
      {project && visited.includes('structural') && <section className="workspace-content" hidden={workspaceMode !== 'structural'} aria-label="结构仿真工作区"><StructuralPanel key={project.id} projectId={project.id} initialSource={structuralSource} defaultSource={publishedStructuralSource} sourceRequest={structuralSourceRequest} files={files} changed={() => refreshFiles(project.id)}/></section>}
      {project && visited.includes('thermal') && <section className="workspace-content" hidden={workspaceMode !== 'thermal'} aria-label="热仿真工作区"><ThermalPanel key={project.id} projectId={project.id} files={files} initialSource={asset?.path} busy={busy} changed={() => refreshFiles(project.id)} feedback={text => { setDraft(old => old ? old + '\n\n' + text : text); setAssistantOpen(true); }}/></section>}
    </main>
    <aside className="agent-panel" aria-label="设计助手"><div className="agent-heading"><div className="agent-title"><div className="agent-spark"><MessageSquare size={18}/></div><h2>设计助手</h2><span className="pill">AI</span></div><button className="icon-button" aria-label="收起设计助手" onClick={() => setAssistantOpen(false)}><X size={17}/></button></div><button className="model-selector" onClick={() => setDialog('settings')}><span className={`status-dot ${status?.hasCredentials ? '' : 'neutral'}`}/><span>{activeModel || '连接一个模型，开始设计'}</span><ChevronDown size={13}/></button>
      <div className="conversation">{messages.length === 0 && <div className="welcome"><div className="welcome-mark"><BrandIcon size={40}/></div><span className="eyebrow">DESIGN WITH AI</span><h2>一起完成<br/><em>下一个设计。</em></h2><p>描述你的设计意图，或选中一个部件。在这里编写代码、检查结构与导出模型。</p><div className="suggestions">{['创建一块带 4 个安装孔的支架', '检查我导入的模型尺寸', '修改参数并导出 STEP 和 GLB'].map((text, i) => <button key={text} onClick={() => setDraft(text)}>{i === 0 ? <Box size={16}/> : i === 1 ? <Crosshair size={16}/> : <FileCode2 size={16}/>}<span>{text}</span><ChevronRight size={13}/></button>)}</div><div className="welcome-foot"><Box size={13}/>参数化建模 · 装配 · 几何检查</div></div>}
        <ConversationMessages messages={messages} busy={busy}/>
        {busy && <div className="agent-working"><LoaderCircle className="spin" size={13}/>Agent 正在处理<span className="thinking-dots">···</span></div>}<div ref={chatEnd}/></div>
      <div className="composer-area">{selection && <div className="selection-chip"><MousePointer2 size={12}/><span>{selection.name}{selection.cadFace ? ` · STEP 面 ${selection.cadFace.index}` : selection.triangle !== undefined ? ` · 网格面 ${selection.triangle}` : ''}</span><button title="清除选择上下文" onClick={() => setSelection(null)}><X size={12}/></button></div>}<div className="composer"><textarea aria-label="设计需求" value={draft} onChange={e => setDraft(e.target.value)} placeholder="描述你的设计，或选择模型后提问…" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/><div className="composer-actions"><button className="icon-button" title="添加模型" onClick={() => upload.current?.click()}><Plus size={18}/></button><span>Enter 发送 · Shift Enter 换行</span>{busy ? <button className="send-button stop" aria-label="停止 Agent" onClick={() => project && void api.stop(project.id).catch(e => notify(e.message))}><Square size={14} fill="currentColor"/></button> : <button className="send-button" aria-label="发送消息" disabled={!draft.trim() || sending} onClick={() => void send()}>{sending ? <LoaderCircle className="spin" size={17}/> : <ArrowUp size={19}/>}</button>}</div></div><div className="composer-footer"><span className="status-dot"/>CAStudio<span>本地工作空间</span></div></div>
    </aside>
    <footer className="statusbar"><span><span className="status-dot"/>{busy ? 'Agent 运行中' : '工作空间就绪'}</span><span>{demo ? '示例视图' : '模型文件'}<i/>旋转：左键拖动<i/>缩放：滚轮</span><span className="status-right">{status?.platform || 'LOCAL'}<i/>CAStudio</span></footer>
    <input ref={upload} type="file" hidden accept=".glb,.gltf,.stl,.obj,.step,.stp,.zip,.scadpkg,.py,.json,.png,.jpg,.jpeg,.webp" onChange={e => { if (e.target.files?.[0]) void doUpload(e.target.files[0]); e.target.value = ''; }}/>
    {dialog === 'resources' && <Dialog title="模型部件" subtitle={asset?.name || '法兰装配示例'} close={()=>setDialog(null)}><ModelTree meshes={meshes} selection={selection} name={asset?.name || '法兰装配'} demo={demo} select={id=>view.current?.select(id)} visibility={(ids, visible)=>{ const affected=new Set(ids); ids.forEach(id=>view.current?.visible(id,visible)); setMeshes(old=>old.map(mesh=>affected.has(mesh.id)?{...mesh,visible}:mesh)); }}/></Dialog>}
    {dialog === 'history' && project && <HistoryDialog key={project.id} projectId={project.id} busy={busy} close={() => setDialog(null)} restored={async () => {
      const id = project.id;
      setSelection(null);
      await refreshFiles(id);
      if (sourcePath) { try { const text = await api.source(id, sourcePath); setSourceText(text); setSavedText(text); } catch { setSourcePath(''); setSourceText(''); setSavedText(''); } }
      setMessages(await api.messages(id)); await refreshGlobal();
    }} preview={(revision, file) => { setReference({ ...file, name: file.path.split('/').pop() || file.path, kind: 'model', modified: Date.parse(revision.createdAt), revision: revision.id, revisionLabel: revision.label }); setComparison(true); openWorkspace('model'); setDialog(null); }}/>}
    {dialog === 'builds' && project && <Dialog title="构建与运行环境" subtitle="执行项目源码，检查日志，保留每次构建成果。" close={() => setDialog(null)}><BuildPanel key={project.id} filesChanged={() => refreshFiles(project.id)} editState={trackParameterEdits} projectId={project.id} files={files} initialSource={sourcePath} sourceDirty={sourceDirty} busy={busy} published={path => { void refreshFiles(project.id); openWorkspace('model'); setDock('files'); notify(`产物已另存到 ${path}`); }}/></Dialog>}
    {dialog === 'measurements' && project && <Dialog title="几何检查与对比" subtitle="检查显示网格，保存测量，比较不同版本。" close={() => setDialog(null)}><MeasurementPanel key={project.id} projectId={project.id} anchor={reviewAnchor} busy={busy} currentFile={asset?.path} currentHash={preview?.status === 'ready' && preview.url === modelUrl ? preview.identity?.sourceHash : undefined} measure={(anchor, signal) => view.current ? view.current.measure(anchor, signal) : Promise.reject(new Error('视口尚未就绪'))} context={text => { setDraft(old => old ? `${old}\n${text}` : text); setDialog(null); setAssistantOpen(true); notify('检查结果已加入对话草稿'); }}/></Dialog>}
    {dialog === 'reviews' && project && <Dialog title="批注与检查清单" subtitle="把设计意图绑定到几何，跟踪处理结果。" close={() => setDialog(null)}><ReviewPanel key={project.id} projectId={project.id} anchor={reviewAnchor} currentFile={asset?.path} currentHash={preview?.status === 'ready' && preview.url === modelUrl ? preview.identity?.sourceHash : undefined} revision={reviewRevision} busy={busy} locate={locateReview} context={text => { setDraft(old => old ? `${old}\n${text}` : text); setDialog(null); setAssistantOpen(true); notify('批注已加入对话草稿'); }}/></Dialog>}
    {dialog === 'scene' && <Dialog title="场景与特征" subtitle="查看装配、特征依赖与包内源码快照。" close={() => setDialog(null)}>{scenePackage ? <SceneInspector info={scenePackage} selectedNodeId={selection?.packageMesh?.nodeId} select={id => { view.current?.select(id); }} context={text => { setDraft(old => old ? `${old}\n${text}` : text); setDialog(null); setAssistantOpen(true); notify('特征信息已加入对话草稿'); }}/> : <div className="small-empty">当前没有已载入的场景包。</div>}</Dialog>}
    {dialog === 'plugins' && <PluginDialog plugins={plugins} refresh={refreshGlobal} close={() => setDialog(null)}/>}
    {dialog === 'settings' && <SettingsDialog status={status} refresh={refreshGlobal} close={() => setDialog(null)}/>}
    {dialog === 'new' && <Dialog title="新建设计项目" subtitle="每个项目保存独立的源码、模型和设计会话。" close={() => setDialog(null)}><form onSubmit={async e => { e.preventDefault(); if (!canLeaveSource()) return; try { const created = await api.createProject(newName || '新设计'); setProject(created); setNewName(''); await refreshGlobal(); setDialog(null); } catch (e) { notify((e as Error).message); } }}><label className="field">项目名称<input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="例如：减速器安装支架" maxLength={80}/></label><button className="button primary full" type="submit"><Plus size={16}/>创建项目</button></form></Dialog>}
    {dialog === 'projects' && <Dialog title="项目" subtitle="继续一个设计，或从新的想法开始。" close={() => setDialog(null)}><div className="project-list">{projects.map(p => <button key={p.id} onClick={() => { if (p.id !== project?.id && !canLeaveSource()) return; setProject(p); setDialog(null); }}><FolderOpen size={19}/><span><strong>{p.name}</strong><small>{new Date(p.updatedAt).toLocaleString()}</small></span>{project?.id === p.id && <Check size={16}/>}</button>)}</div><button className="button primary full" onClick={() => setDialog('new')}><Plus size={16}/>新建项目</button></Dialog>}
    {toast && <div className="toast" role="status"><Circle size={12}/><span>{toast}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}><X size={13}/></button></div>}
  </div>;
}
function SlidersIcon() { return <Settings2 size={13}/>; }
