import {useEffect,useState,useRef} from 'react';
import './StructuralPanel.css';
import { chooseStructuralSource } from '../scene/structural-source';
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import type {Artifact} from '../../shared/types';
async function request(url:string,method='GET',body?:unknown){const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error||r.statusText);return j;}
function FieldView({url,field,factor,section}:{url:string;field:string;factor:number;section:boolean}){
 const host=useRef<HTMLDivElement>(null);
 useEffect(()=>{let disposed=false,renderer:THREE.WebGLRenderer|undefined,controls:OrbitControls|undefined,ro:ResizeObserver|undefined;let frame=0;const objects:THREE.Object3D[]=[];
  void request(url).then(d=>{if(disposed||!host.current)return;const el=host.current,scene=new THREE.Scene();scene.background=new THREE.Color('#f2f4ee');
   renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));el.appendChild(renderer.domElement);
   const camera=new THREE.PerspectiveCamera(38,1,1,10000);camera.up.set(0,0,1);camera.position.set(1350,-1650,1200);
   controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,0,250);controls.update();
   const positions:number[]=[],colors:number[]=[];const color=new THREE.Color();
   d.triangles.forEach((tri:number[],i:number)=>{const center=tri.reduce((a,n)=>a+d.points[n][1],0)/3;if(section&&center<0)return;
    tri.forEach(n=>{const p=d.points[n],u=d.displacements[n];positions.push(...p.map((v:number,a:number)=>v+factor*u[a]));
      const value=field==='mises'?d.element_mises[i]/d.maximum_mises:Math.hypot(...u)/d.maximum_displacement;color.setHSL((1-Math.min(1,Math.max(0,value)))*.67,1,.52);colors.push(color.r,color.g,color.b);});});
   const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.computeVertexNormals();
   const material=new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide});const mesh=new THREE.Mesh(geometry,material);scene.add(mesh);objects.push(mesh);
   const resize=()=>{if(!renderer)return;const w=el.clientWidth,h=el.clientHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();};ro=new ResizeObserver(resize);ro.observe(el);resize();
   const draw=()=>{if(disposed||!renderer)return;controls?.update();renderer.render(scene,camera);frame=requestAnimationFrame(draw);};draw();
  }).catch(console.error);
  return()=>{disposed=true;cancelAnimationFrame(frame);ro?.disconnect();controls?.dispose();objects.forEach(o=>{const m=o as THREE.Mesh;m.geometry?.dispose();(m.material as THREE.Material)?.dispose();});renderer?.dispose();host.current?.replaceChildren();};
 },[url,field,factor,section]);
 return <div ref={host} className="field-view"/>;
}
export function StructuralPanel({projectId,files,changed,initialSource,defaultSource,sourceRequest}:{projectId:string;files:Artifact[];changed:()=>Promise<void>;initialSource?:string;defaultSource?:string;sourceRequest?:number}){
 const controlsRef=useRef<HTMLDetailsElement>(null);
 const sourceSelected=useRef(!!initialSource);
 const base='/api/projects/'+projectId;const [runs,setRuns]=useState<any[]>([]),[chosen,setChosen]=useState(''),[source,setSource]=useState(initialSource||defaultSource||''),[mesh,setMesh]=useState(24),[study,setStudy]=useState(true),[sizes,setSizes]=useState('32,24,18'),[resume,setResume]=useState(''),[reprocess,setReprocess]=useState(false),[fillDiagnostics,setFillDiagnostics]=useState(false),[force,setForce]=useState(2451662.5),[pressure,setPressure]=useState(.2),[error,setError]=useState(''),[working,setWorking]=useState(false),[build,setBuild]=useState(''),[field,setField]=useState('mises'),[resultSize,setResultSize]=useState(''),[resultMode,setResultMode]=useState('nonlinear'),[factor,setFactor]=useState(0),[section,setSection]=useState(false);
 const run=runs.find(r=>r.id===chosen)||runs[0],steps=files.filter(f=>/\.step$/i.test(f.name)&&!f.path.startsWith('structural/')&&!f.path.startsWith('studio/cad-inspections/'));
 useEffect(()=>{setSource(current=>chooseStructuralSource(files,current,defaultSource,sourceSelected.current));},[files,defaultSource]);
 useEffect(()=>{let live=true;const refresh=()=>request(base+'/structural').then(r=>{if(live)setRuns(r);}).catch(e=>{if(live)setError(e.message);});void refresh();const t=setInterval(refresh,2000);return()=>{live=false;clearInterval(t);};},[base]);
 useEffect(()=>{if(initialSource){sourceSelected.current=true;setSource(initialSource);if(controlsRef.current)controlsRef.current.open=true;}},[initialSource,sourceRequest]);
 useEffect(()=>{setResume('');setReprocess(false);setFillDiagnostics(false);},[source,sourceRequest]);
 const levels=run?.summary?.mesh_study?.levels;const selectedLevel=levels?.find((r:any)=>String(r.size_mm)===resultSize)||levels?.[levels.length-1];
 const result=selectedLevel?.[resultMode]||run?.summary;const resultPath=selectedLevel?`mesh-${selectedLevel.size_mm}/${resultMode}`:'static';
 const file=(p:string,download=false)=>base+'/structural/'+run.id+'/file?path='+encodeURIComponent(p)+(download?'&download=1':'');
 const construct=async()=>{setWorking(true);setError('');try{const src=await fetch(base+'/file?path=build_model.py&text=1');if(!src.ok)throw Error('无法读取建模源码');const expectedSource=await src.text();const parameters=await request(base+'/parameters?source=build_model.py');let r=await request(base+'/builds','POST',{source:'build_model.py',expectedSource,expectedParameters:parameters.hash});setBuild('正在通过 CadFlow 构建筒体、翻边、孔与筋条');
   while(['preparing','running'].includes(r.state)){await new Promise(ok=>setTimeout(ok,1500));r=await request(base+'/builds/'+r.id);}
   if(r.state!=='succeeded')throw Error(r.error||r.log||'CAD 构建失败');const pub=await request(base+'/builds/'+r.id+'/publish','POST');sourceSelected.current=true;setSource(pub.path+'/cylinder.step');setBuild('CAD 已构建并保存：'+pub.path);await changed();
  }catch(e){setError((e as Error).message);}finally{setWorking(false);}};
 const solve=async()=>{setWorking(true);setError('');try{const r=await request(base+'/structural','POST',{source,mesh_size_mm:mesh,axial_force_N:force,external_pressure_MPa:pressure,buckling:!study,mesh_study:study,reprocess_only:study&&reprocess,diagnostics_fill_missing:study&&reprocess&&fillDiagnostics,resume_run:resume||undefined,mesh_levels_mm:sizes.split(',').map(Number)});setChosen(r.id);setRuns(v=>[r,...v]);}catch(e){setError((e as Error).message);}finally{setWorking(false);}};
 return <div className="structural-panel">
 <p className="structural-intro">构建几何 · 设置载荷 · 检查收敛 · 生成报告</p>
 <div className="structural-layout">
 <details ref={controlsRef} className="structural-controls"><summary>分析设置与计算记录</summary><div className="structural-controls-body"><h3>几何与工况</h3><p>使用选中的圆柱模型；对象修改后需先重建并发布。</p>
 <button disabled={working||runs.some(r=>['queued','running'].includes(r.state))} onClick={()=>void construct()}>在 Studio 中构建 CAD</button><p>{build}</p>
 <h3>分析设置</h3><p><label><input type="checkbox" checked={study} onChange={e=>setStudy(e.target.checked)}/>几何非线性与网格收敛验证</label></p>{study&&<p><label>网格序列 mm<input value={sizes} onChange={e=>setSizes(e.target.value)}/></label></p>}<label>STEP 模型<select value={source} onChange={e=>{sourceSelected.current=true;setSource(e.target.value);}} style={{width:'100%'}}>{steps.map(f=><option key={f.path} value={f.path}>{f.path}</option>)}</select></label>
 <p><label>网格目标尺寸 mm <input type="number" min={12} max={60} value={mesh} onChange={e=>setMesh(+e.target.value)}/></label></p>
 <p><label>轴向总压力 N <input type="number" value={force} onChange={e=>setForce(+e.target.value)}/></label></p>
 <p><label>外压 MPa <input type="number" step={.01} value={pressure} onChange={e=>setPressure(+e.target.value)}/></label></p>
 <p>固定下端框；上端面均布轴向总力。假设铝材 E＝70 GPa，ν＝0.33；一体连接，不作屈服合格判定。</p>
 <button disabled={working||!source||runs.some(r=>['queued','running'].includes(r.state))} onClick={()=>void solve()}>{study?(reprocess?(fillDiagnostics?'整理结果并补齐诊断':'重新生成云图与报告'):'运行非线性与网格验证'):'运行静力与屈曲分析'}</button>
 {run&&['queued','running'].includes(run.state)&&<button onClick={()=>void request(base+'/structural/'+run.id+'/cancel','POST')}>取消计算</button>}
 <p><label>复用已完成网格<select value={resume} onChange={e=>setResume(e.target.value)} style={{width:'100%'}}><option value="">不复用</option>{runs.filter(r=>!['queued','running'].includes(r.state)).map(r=><option key={r.id} value={r.id}>{r.id.slice(0,8)} · {r.state}</option>)}</select></label></p>{study&&<p><label><input type="checkbox" checked={reprocess} onChange={e=>setReprocess(e.target.checked)}/>仅重新生成云图与报告（保留原收敛状态）</label></p>}{study&&reprocess&&<p><label><input type="checkbox" checked={fillDiagnostics} onChange={e=>setFillDiagnostics(e.target.checked)}/>补算缺失的载荷诊断（主分析不重算）</label></p>}
 <p role="status">{run?.state==='queued'?'等待设计助手完成当前编辑后自动计算':run?.progress?.detail}</p>{error&&<p role="alert" style={{color:'#f48771'}}>{error}</p>}{run?.error&&<pre style={{whiteSpace:'pre-wrap'}}>{run.error}</pre>}
 </div></details><div className="structural-results"><div className="result-heading"><h3>结果与报告</h3><label>计算记录 <select aria-label="计算记录" value={run?.id||''} onChange={e=>setChosen(e.target.value)}>{runs.map(r=><option value={r.id} key={r.id}>{r.createdAt.slice(0,19)} · {r.state}</option>)}</select></label></div>{run && source && run.source !== source && <p className="assessment" role="status">当前显示的是其他几何版本的计算记录。运行分析后可查看新版本的结果。</p>}{run?.state==='succeeded'&&run.summary?<>{levels&&<p><label>结果网格 mm <select value={String(selectedLevel.size_mm)} onChange={e=>setResultSize(e.target.value)}>{levels.map((r:any)=><option key={r.size_mm} value={r.size_mm}>{r.size_mm}</option>)}</select></label>　<label>分析结果 <select value={resultMode} onChange={e=>setResultMode(e.target.value)}><option value="nonlinear">几何非线性</option><option value="linear">线性参考</option></select></label></p>}<div className="result-context"><span>{levels ? (resultMode === 'nonlinear' ? '几何非线性' : '线性参考') : '线性参考'}</span>{levels&&<span>载荷比例 {result.load_factor.toFixed(5)} · {result.full_load_reached ? '达到全载荷' : '最后收敛增量'}</span>}</div><div className="structural-metrics"><div><span>最大 Mises 应力</span><strong>{result.maximum_von_mises_MPa.toFixed(2)}<small>MPa</small></strong></div><div><span>最大总位移</span><strong>{result.maximum_displacement_mm.toFixed(3)}<small>mm</small></strong></div></div>
 <p>首阶正屈曲系数：{run.summary.buckling?.first_positive_factor?.toFixed(4)??'未计算'}　{run.summary.mesh_study&&result.assembled_balance_relative==null?'中面近似平衡残差':'力平衡残差'}：{result.balance_relative.toExponential(2)}</p>
 {run.summary.diagnosis&&<details><summary>高应力来源分析</summary>{run.summary.diagnosis.paragraphs.map((p:string,i:number)=><p key={i}>{p}</p>)}</details>}{run.summary.mesh_study&&<details className="convergence-details"><summary>网格收敛验证与载荷曲线</summary><h4>几何非线性网格验证</h4><p>当前云图载荷比例：{result.load_factor.toFixed(5)} · {result.full_load_reached?'达到全载荷':'仅最后收敛增量'}；轴压力 {(result.load.axial_force_N*result.load_factor/9806.65).toFixed(3)} 公吨力，外压 {(result.load.external_pressure_MPa*result.load_factor).toFixed(5)} MPa</p><table><thead><tr><th>网格 mm</th><th>载荷比例</th><th>位移 mm</th><th>Mises MPa</th><th>筒皮远场 MPa</th></tr></thead><tbody>{run.summary.mesh_study.levels.map((r:any)=><tr key={r.size_mm}><td>{r.size_mm}</td><td>{r.nonlinear.load_factor.toFixed(5)}</td><td>{r.nonlinear.maximum_displacement_mm.toFixed(3)}</td><td>{r.nonlinear.maximum_von_mises_MPa.toFixed(1)}</td><td>{r.nonlinear.bulk_skin_max_mises_MPa.toFixed(1)}</td></tr>)}</tbody></table><MeshChanges study={run.summary.mesh_study}/><CommonLoad study={run.summary.mesh_study}/><img alt="载荷位移与网格验证曲线" src={file('study.png')} style={{width:'100%'}}/></details>}<p className="assessment">{run.summary.assessment||'线弹性参考场；屈曲系数、应力适用性与收敛结果请查看报告。'}</p>
 <div className="field-controls"><select aria-label="云图变量" value={field} onChange={e=>setField(e.target.value)}><option value="mises">Mises 应力 MPa</option><option value="displacement">总位移 mm</option></select><label>变形倍率 <input type="number" min={0} max={30} value={factor} onChange={e=>setFactor(+e.target.value)} style={{width:58}}/></label><label><input type="checkbox" checked={section} onChange={e=>setSection(e.target.checked)}/>剖切查看内筋</label></div>
 <FieldView url={file(resultPath+'/display.json')} field={field} factor={factor} section={section}/>
 <div style={{height:10,background:'linear-gradient(to right,blue,cyan,lime,yellow,red)',marginTop:8}}/><p>0　—　{field==='mises'?result.maximum_von_mises_MPa.toFixed(2)+' MPa':result.maximum_displacement_mm.toFixed(3)+' mm'}{field==='mises'?'（各单元厚度方向积分点最大值）':'（节点总位移）'}</p>
 <div className="result-downloads"><a href={file('report.docx',true)}>下载 Word 报告</a><a href={file(resultPath+'/mises.png',true)}>应力云图</a><a href={file(resultPath+'/displacement.png',true)}>位移云图</a><a href={file(resultPath+'/analysis.inp',true)}>求解输入文件</a></div>
 </>:<p>构建模型后点击求解。计算完成后可旋转云图、剖切查看筋条，并下载报告。</p>}</div></div></div>;
}


function MeshChanges({study}:{study:any}) {
 const metrics=['maximum_displacement_mm','maximum_von_mises_MPa','bulk_skin_max_mises_MPa'];
 return <div><h4>相邻网格变化（非线性，同载荷）</h4>
 <p>判据：最后两级的三项变化均小于 {100*study.tolerance}%。载荷不同的结果不作收敛比较。</p>
 <table className="mesh-comparisons"><thead><tr><th>网格 mm</th><th>位移变化</th><th>峰值变化</th><th>远场变化</th></tr></thead>
 <tbody>{study.comparisons.map((c:any)=><tr key={c.to_mm}><td>{c.from_mm} → {c.to_mm}</td>
 {metrics.map(k=>{const v=c.nonlinear[k+'_relative_change'];return <td key={k}>{v==null?'载荷不同':(100*v).toFixed(2)+'%'}</td>;})}</tr>)}</tbody></table></div>;
}

function CommonLoad({study}:{study:any}) {
 if(study.common_load_factor==null||study.common_load_factor>=.99999)return null;
 const rows=study.common_load_levels,a=rows[rows.length-2],b=rows[rows.length-1];
 const change=(k:string)=>(100*Math.abs(a[k]-b[k])/Math.abs(b[k])).toFixed(2);
 return <div><h4>实际共同收敛载荷比较</h4><p>载荷比例 {study.common_load_factor.toFixed(5)}，仅使用实际收敛输出，不作插值。</p>
 <table className="common-load"><thead><tr><th>网格 mm</th><th>位移 mm</th><th>Mises MPa</th></tr></thead><tbody>
 {rows.map((r:any)=><tr key={r.size_mm}><td>{r.size_mm}</td><td>{r.maximum_displacement_mm.toFixed(3)}</td><td>{r.maximum_von_mises_MPa.toFixed(1)}</td></tr>)}</tbody></table>
 <p>最后两级位移变化 {change('maximum_displacement_mm')}%，峰值变化 {change('maximum_von_mises_MPa')}%。这不代表目标全载荷下全部指标已收敛。</p></div>;
}
