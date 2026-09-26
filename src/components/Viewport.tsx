import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { AlertCircle, Box, LoaderCircle, RotateCcw, Play, Pause, Video, Maximize2, Minimize2, Download } from 'lucide-react';
import { CadRenderer, type MeshInfo, type Selection, type ViewOptions } from '../scene/renderer';
import { createDemo } from '../scene/demo';
import { loadModel } from '../scene/loaders';
import type { StepQuality } from '../scene/step';
import type { PackageInfo } from '../scene/package';
import type { ReviewAnchor } from '../../shared/types';
import type { PreviewState } from '../scene/review-selection';
import type { MeshMetrics } from '../../shared/measurements';
import type { MotorState } from '../scene/motor-motion';
import '../motor-motion.css';
export type ViewportHandle = { fit: (view?: 'iso' | 'top' | 'front' | 'right') => void; snapshot: () => void; select: (id: string) => void; selectFace: (id: string, face: number) => boolean; visible: (id: string, visible: boolean) => void; locateReview: (anchor: ReviewAnchor) => { meshId?: string; error?: string }; measure: (anchor: ReviewAnchor, signal: AbortSignal) => Promise<MeshMetrics> };
type Props = { url?: string; name?: string; demo?: boolean; projectId?: string; options: ViewOptions; onMeshes?: (meshes: MeshInfo[]) => void; onSelection?: (selection: Selection | null) => void; onPackage?: (info: PackageInfo | null) => void; onPreview?: (state: PreviewState) => void; label?: string };
export const Viewport = forwardRef<ViewportHandle, Props>(function Viewport({ url, name, demo, projectId, options, onMeshes, onSelection, onPackage, onPreview, label }, ref) {
  const host = useRef<HTMLDivElement>(null), engine = useRef<CadRenderer | null>(null);
  const callbacks = useRef({ onMeshes, onSelection, onPackage, onPreview }); callbacks.current = { onMeshes, onSelection, onPackage, onPreview };
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [ready, setReady] = useState(false);
  const [motor,setMotor]=useState<MotorState|null>(null),[cinema,setCinema]=useState(false),[saving,setSaving]=useState(false),[recordMessage,setRecordMessage]=useState(''),[recordUrl,setRecordUrl]=useState('');
  const [progress, setProgress] = useState('正在载入几何'), [quality, setQuality] = useState<StepQuality>('standard'), [retry, setRetry] = useState(0);
  const cancel = useRef<AbortController | null>(null), isStep = /\.(step|stp)$/i.test(name || '');
  useImperativeHandle(ref, () => ({ fit: view => engine.current?.fit(view), measure: (anchor, signal) => engine.current ? engine.current.measure(anchor, signal) : Promise.reject(new Error('视口尚未就绪')), snapshot: () => { const link = document.createElement('a'); link.download = 'cad-viewport.png'; link.href = engine.current?.snapshot() || ''; link.click(); }, select: id => engine.current?.select(id), selectFace: (id, face) => engine.current?.selectFace(id, face) ?? false, visible: (id, visible) => engine.current?.setVisible(id, visible), locateReview: anchor => engine.current?.locateReview(anchor) || { error: '视口尚未就绪' } }), []);
  useEffect(() => {
    try { engine.current = new CadRenderer(host.current!, s => callbacks.current.onSelection?.(s),setMotor); setReady(true); }
    catch (e) { setError(`无法创建三维视口：${(e as Error).message}`); }
    return () => { engine.current?.dispose(); engine.current = null; };
  }, []);
  useEffect(() => {
    if (!ready || !engine.current) return;
    const controller = new AbortController(); cancel.current = controller; let cancelled = false; setError(''); setProgress('正在读取模型文件…'); engine.current.clearModel(); callbacks.current.onMeshes?.([]); setLoading(false);
    async function load() {
      callbacks.current.onPreview?.({ url, status: 'loading' });
      callbacks.current.onPackage?.(null);
      if (!url && !demo) { callbacks.current.onMeshes?.([]); return; }
      setLoading(true);
      try {
        let group;
        if (demo && !url) group = createDemo();
        else { const response = await fetch(url!, { signal: controller.signal }); if (!response.ok) throw new Error('模型文件读取失败'); group = await loadModel(name || 'model.glb', await response.arrayBuffer(), { signal: controller.signal, quality, progress: text => { if (!cancelled) setProgress(text); } }); }
        if (cancelled || controller.signal.aborted) { group.traverse(o => { const object = o as { geometry?: { dispose(): void }; material?: { dispose(): void } | { dispose(): void }[] }; object.geometry?.dispose(); if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => m.dispose()); }); if (!cancelled) { setError('预览已取消，可点击重试'); callbacks.current.onPreview?.({ url, status: 'error', error: '预览已取消' }); } return; }
        const meshes = engine.current!.setModel(group);
        callbacks.current.onMeshes?.(meshes);
        callbacks.current.onPackage?.(group.userData.scenePackage || null);
        callbacks.current.onPreview?.({ url, status: 'ready', identity: group.userData.previewIdentity });
      } catch (e) { if (!cancelled) { const message = controller.signal.aborted ? '预览已取消，可点击重试' : (e as Error).message; setError(message); callbacks.current.onMeshes?.([]); engine.current?.clearModel(); callbacks.current.onPreview?.({ url, status: 'error', error: message }); } }
      finally { if (!cancelled) setLoading(false); }
    }
    void load(); return () => { cancelled = true; controller.abort(); };
  }, [url, name, demo, ready, quality, retry]);
  useEffect(() => { engine.current?.setOptions(options); }, [options, ready]);
  useEffect(()=>{setRecordMessage('');setRecordUrl('');setCinema(false);},[url]);
  async function record() {
    if(!engine.current||!projectId)return;
    setSaving(true);setRecordMessage('正在录制 Studio 视口…');setRecordUrl('');
    try {
      const video=await engine.current.recordMotor();setRecordMessage('正在保存到项目…');
      const response=await fetch(`/api/projects/${encodeURIComponent(projectId)}/motor-recordings`,{method:'POST',headers:{'Content-Type':'video/webm'},body:video});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'保存失败');
      setRecordUrl(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(result.path)}`);setRecordMessage('视频已保存到项目文件');
    } catch(e){setRecordMessage((e as Error).message);}finally{setSaving(false);}
  }
  return <div className={`viewport ${cinema&&motor?'motor-cinema':''}`}><div className="canvas-host" ref={host}/>{label && <span className="viewport-label">{label}</span>}
    {motor&&!loading&&<>
      <div className="motor-transport" role="toolbar" aria-label="电机动画控制">
        <button className="icon-button" title="组合并启动" aria-label="组合并启动" disabled={saving} onClick={()=>engine.current?.motorRestart()}><RotateCcw size={16}/></button>
        <button className="icon-button" title={motor.playing?'暂停':'继续'} aria-label={motor.playing?'暂停':'继续'} disabled={saving} onClick={()=>motor.playing?engine.current?.motorPause():engine.current?.motorPlay()}>{motor.playing?<Pause size={16}/>:<Play size={16}/>}</button>
        <input aria-label="电机演示进度" type="range" min="0" max="40" step=".1" value={motor.time} disabled={saving} onChange={e=>engine.current?.motorSeek(Number(e.target.value))}/>
        <button className={`icon-button ${saving?'motor-recording':''}`} title="录制视频" aria-label="录制视频" disabled={saving||!projectId} onClick={()=>void record()}>{saving?<LoaderCircle size={16} className="spin"/>:<Video size={16}/>}</button>
        <button className="icon-button" title={cinema?'退出演示':'放大演示'} aria-label={cinema?'退出演示':'放大演示'} onClick={()=>setCinema(!cinema)}>{cinema?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</button>
        {recordUrl&&<a className="icon-button" title="下载视频" aria-label="下载视频" href={recordUrl} download="异步电机_Studio无字幕.webm"><Download size={16}/></a>}
      </div>
      {recordMessage&&<span role="status" className={saving||recordUrl?'motor-sr-only':'motor-record-error'}>{recordMessage}</span>}
    </>}
    {!url && !demo && <div className="viewport-empty"><Box size={32}/><strong>选择参考模型</strong><span>在文件面板中将模型设为参考</span></div>}
    {isStep && <div className="step-preview-tools"><span>STEP · mm</span><select aria-label={`${label || '当前'} STEP 预览精度`} value={quality} onChange={e => setQuality(e.target.value as StepQuality)}><option value="draft">快速</option><option value="standard">标准</option><option value="fine">精细</option></select></div>}
    {loading && <div className="viewport-notice"><LoaderCircle className="spin" size={17}/>{progress}<button className="text-button" onClick={() => cancel.current?.abort()}>取消预览</button></div>}
    {error && <div className="viewport-error"><AlertCircle size={22}/><strong>预览暂不可用</strong><p>{error}</p><button className="button" onClick={() => setRetry(n => n + 1)}>重试预览</button></div>}
    <div className="axis-widget"><button title="俯视图" onClick={() => engine.current?.fit('top')} className="axis-z">Z</button><button title="右视图" onClick={() => engine.current?.fit('right')} className="axis-x">X</button><button title="前视图" onClick={() => engine.current?.fit('front')} className="axis-y">Y</button><i/></div>
  </div>;
});
