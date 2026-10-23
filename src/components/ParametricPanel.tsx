import {useEffect,useState,useRef} from 'react';
import {request} from '../api';
import './ParametricPanel.css';

export function ParametricPanel({projectId,changed,simulate}:{projectId:string;changed:()=>Promise<void>;simulate:(source:string)=>void}){
 const base=`/api/projects/${projectId}/parametric`;
 const [state,setState]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[url,setUrl]=useState('');
 const frame=useRef<HTMLIFrameElement>(null);
 const prepareEditor=()=>new Promise<any>((resolve,reject)=>{
  if(!url){resolve(undefined);return;}
  const requestId=crypto.randomUUID();
  const cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',receive);};
  const receive=(e:MessageEvent)=>{if(e.source===frame.current?.contentWindow&&e.origin===new URL(url).origin&&e.data?.type==='castudio.prepared'&&e.data.requestId===requestId){cleanup();resolve(e.data.editor);}};
  const timer=setTimeout(()=>{cleanup();reject(Error('编辑器尚未就绪，无法确认保存状态'));},5000);
  window.addEventListener('message',receive);frame.current?.contentWindow?.postMessage({type:'castudio.prepare',requestId},new URL(url).origin);
 });
 const post=(action:string,body:any={})=>request<any>(base+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const refresh=async()=>{const next=await request<any>(base);setState(next);if(next.url)setUrl(next.url);else setUrl('');return next;};
 useEffect(()=>{let live=true;const update=()=>request<any>(base).then(s=>{if(live){setState(s);setUrl(s.url||'');}}).catch(e=>live&&setError(e.message));void update();const t=setInterval(update,2000);return()=>{live=false;clearInterval(t);};},[base]);
 useEffect(()=>{if(state?.job?.state==='succeeded')void changed();},[state?.job?.id,state?.job?.state]);
 const act=async(action:string)=>{setBusy(true);setError('');try{const editor=action==='publish'?await prepareEditor():undefined;await post(action,{editor});await refresh();await changed();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const published=state?.published,manifest=published?.manifest,running=state?.job?.state==='running';
 return <div className="parametric-panel">
  <div className="parametric-toolbar"><strong>参数化建模</strong><span>SimpleCADAPI · 步骤缓存 · CAD 实体选择</span>
   {!state?.exists?<button disabled={busy} onClick={()=>void act('template')}>创建参数化圆柱</button>:<>
    {!url&&<button disabled={busy||running} onClick={()=>void act('start')}>打开建模编辑器</button>}
    {url&&<span className="editor-connected"><i/>编辑器已连接</span>}
    <button disabled={busy||running} onClick={()=>void act('publish')}>导出 CAD 并校验仿真边界</button>
    {running&&<button onClick={()=>void act('cancel')}>取消构建</button>}
    <button disabled={busy||running||!manifest?.equivalence?.approved} onClick={()=>simulate(published.source)}>送入现有结构仿真</button>
   </>}
  </div>
  <details className="parametric-session" open={error || running ? true : undefined}><summary>会话与发布信息</summary>{url&&<button disabled={busy||running||!state?.running} onClick={()=>void act('stop')}>关闭编辑器</button>}<p>修改参数会更新相关建模步骤；点击面、边或顶点会把选择表达式写入模型。发布时会保存源码、STEP、场景包与边界检查结果。</p>
  {error&&<p role="alert" className="form-error">{error}</p>}
  {running&&<p role="status">正在导出并检查实体等价性。完成后可重新打开编辑器或进入结构仿真。</p>}
  {state?.job?.log&&<details><summary>构建日志</summary><pre>{state.job.log}</pre></details>}
  {state?.job?.error&&<details open><summary>构建问题</summary><pre>{state.job.error}</pre></details>}
  {manifest&&<details className="parametric-validation" open={!url}><summary>最近发布 · {manifest.equivalence.approved?'已通过圆柱壳模型适配检查':'几何已变化，暂不可套用现有圆柱壳模型'}</summary>
    <p>实体体积：{manifest.equivalence.volume_mm3.toFixed(3)} mm³；双向实体差体积：{manifest.equivalence.difference_volumes_mm3.join(' / ')||'体积不匹配'} mm³。</p>
    <table><thead><tr><th>仿真边界</th><th>CAD 面数</th><th>面积 mm²</th><th>壳模型区域</th></tr></thead><tbody>{Object.entries(manifest.bindings).map(([key,b]:[string,any])=><tr key={key}><td>{key}</td><td>{b.face_count}</td><td>{b.area_mm2.toFixed(3)}</td><td>{b.shell_set}</td></tr>)}</tbody></table>
    <p>筒体外表面映射到筒皮中面；两端面映射到端框中面。沿用原薄壳理想化和材料假设。</p>
    <p>构建步骤：{manifest.cells.filter((c:any)=>c.status==='cached').length} 个缓存命中，{manifest.cells.filter((c:any)=>c.status==='ran').length} 个实际运行。{manifest.timings&&` 总耗时 ${manifest.timings.total_seconds.toFixed(1)} 秒。`}</p>
  </details>}
  </details>
  {url?<iframe ref={frame} title="CAStudio 参数化建模编辑器" src={url} className="parametric-frame"/>:<div className="parametric-empty">{state?.exists?'点击“打开建模编辑器”，编辑参数、建模步骤与几何选择。':'创建后将使用已确认的圆柱尺寸和连接方式。原 CadFlow 源码和已有分析记录继续可用。'}</div>}
 </div>;
}
