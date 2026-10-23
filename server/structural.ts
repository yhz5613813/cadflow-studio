import { checkParametricBindings } from './semantic-bindings.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Store, HttpError, jsonRead, jsonWrite, safePath } from './storage.js';
import { runProcess } from './process.js';
import type { Express, Request, Response } from 'express';
type Run = { id:string; state:string; createdAt:string; source:string; sourceHash:string; log:string; output?:string; error?:string; summary?:any; progress?:any };
export function structuralRoutes(app:Express,store:Store,validateGeometry:typeof checkParametricBindings=checkParametricBindings) {
  const active=new Map<string,{abort:AbortController;done:Promise<void>}>();
  let preparing=false;
  const root=(id:string)=>path.join(store.workspace(id),'structural');
  const valid=(id:string)=>{if(!/^[a-f0-9-]{36}$/.test(id))throw new HttpError(400,'无效任务编号');return id;};
  const config=()=>jsonRead<any>(path.join(store.root,'structural-runtime.json'),null);
  const read=async(id:string,rid:string)=> {
    await store.project(id);
    const folder=path.join(root(id),valid(rid));let r=await jsonRead<Run|null>(path.join(folder,'run.json'),null);
    if(!r)throw new HttpError(404,'任务不存在');
    if(['queued','running'].includes(r.state)&&!active.has(rid)){
      // A worker can finish between the first disk read and the active-map check.
      const latest=await jsonRead<Run|null>(path.join(folder,'run.json'),null);
      if(latest)r=latest;
      if(['queued','running'].includes(r.state)&&!active.has(rid)){r.state='interrupted';await jsonWrite(path.join(folder,'run.json'),r);}
    }
    r.progress=await jsonRead(path.join(r.output||path.join(folder,'result'),'status.json'),null);
    return r;
  };
  app.get('/api/structural/runtime',async(_req,res)=>{const c=await config();res.json({configured:!!c,analyses:['cylinder_shell_static','cylinder_shell_buckling','cylinder_shell_nonlinear_mesh_study'],version:'0.2.0'});});
  app.get('/api/projects/:id/structural',async(req,res)=>{
    await store.project(req.params.id);const names=await fs.readdir(root(req.params.id)).catch(()=>[]);
    const rows=await Promise.all(names.filter(n=>/^[a-f0-9-]{36}$/.test(n)).map(n=>read(req.params.id,n)));
    res.json(rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
  });
  app.get('/api/projects/:id/structural/:run',async(req,res)=>res.json(await read(req.params.id,req.params.run)));
  const start=async(req:Request,res:Response,allowQueue=false)=>{
    const id=String(req.params.id);await store.project(id);
    if(active.size||preparing)throw new HttpError(409,'已有结构分析正在运行或校验 CAD');
    preparing=true;
    try {
    const runtime=await config();if(!runtime)throw new HttpError(422,'尚未配置结构求解环境');
    const source=String(req.body.source||'');const src=await safePath(store.workspace(id),source);
    if(!/\.(step|stp)$/i.test(src))throw new HttpError(400,'请选择 STEP 文件');
    let release:undefined|(()=>void)=allowQueue?undefined:store.acquire(id);const rid=randomUUID(),folder=path.join(root(id),rid);
    const r:Run={id:rid,state:allowQueue?'queued':'running',createdAt:new Date().toISOString(),source,sourceHash:'',log:''};
    let handedOff=false;
    try {
      const bytes=await fs.readFile(src);
      r.output=path.join(runtime.workRoot||path.join(store.root,'structural-work'),rid);
      r.sourceHash=createHash('sha256').update(bytes).digest('hex');
      const previous=req.body.resume_run?await read(id,String(req.body.resume_run)):null;
      if(previous&&previous.sourceHash!==r.sourceHash)throw new HttpError(400,'复用记录与当前 CAD 不同');
      if(req.body.reprocess_only===true&&(!previous||!['succeeded','failed'].includes(previous.state)||req.body.mesh_study!==true))throw new HttpError(400,'重新整理需要一份已结束的网格验证记录');
      await fs.mkdir(folder,{recursive:true});
      const snapshot=path.join(folder,'source.step');await fs.writeFile(snapshot,bytes);
      const request={geometry_model:undefined as any,presentation_images:undefined as any,semantic_bindings:null as any,reprocess_only:req.body.reprocess_only===true,diagnostics_fill_missing:req.body.diagnostics_fill_missing===true,resume_output:previous?.output,diagnostics:true,analysis:'cylinder_shell',geometry:snapshot,geometry_sha256:r.sourceHash,
        mesh_size_mm:req.body.mesh_size_mm??24,axial_force_N:req.body.axial_force_N??2451662.5,
        external_pressure_MPa:req.body.external_pressure_MPa??.2,E_MPa:req.body.E_MPa??70000,
        nu:req.body.nu??.33,mesh_study:req.body.mesh_study===true,mesh_levels_mm:req.body.mesh_levels_mm??[32,24,18],buckling:req.body.buckling!==false,report_python:runtime.reportPython};
      await jsonWrite(path.join(folder,'request.json'),request);await jsonWrite(path.join(folder,'run.json'),r);
      const abort=new AbortController();
      const done=Promise.resolve().then(async()=>{
        try {
          const deadline=Date.now()+10*60*1000;
          while(!release){
            abort.signal.throwIfAborted();
            try{release=store.acquire(id);}catch(e){
              if(!(e instanceof HttpError)||e.status!==409||Date.now()>deadline)throw e;
              await new Promise(ok=>setTimeout(ok,300));
            }
          }
          abort.signal.throwIfAborted();
          if(createHash('sha256').update(await fs.readFile(src)).digest('hex')!==r.sourceHash)throw Error('排队后源模型已改变，请重新提交');
          r.state='running';await jsonWrite(path.join(folder,'run.json'),r);
          r.log+='正在独立复核 CAD 实体与语义边界\n';
          request.semantic_bindings=await validateGeometry(store.root,src,folder,r.sourceHash,abort.signal,t=>{r.log=(r.log+t).slice(-64000);});
          request.geometry_model=request.semantic_bindings?.geometry_model;
          request.presentation_images=request.semantic_bindings?.presentation_images;
          abort.signal.throwIfAborted();
          await jsonWrite(path.join(folder,'request.json'),request);
          const result=await runProcess(runtime.python,['-u','-m','structural_sim','run',path.join(folder,'request.json'),'--output',r.output!,'--solver',runtime.solver],
            {cwd:runtime.packageRoot,signal:abort.signal,timeout:12*60*60*1000,output:t=>{r.log=(r.log+t).slice(-64000);}});
          if(result.code!==0||result.timedOut)throw Error(result.timedOut?'求解超时':r.log.slice(-2500));
          const manifest=await jsonRead<any>(path.join(r.output!,'manifest.json'),null);
          if(!manifest||manifest.source_sha256!==r.sourceHash)throw Error('结果与源模型不匹配');
          r.summary=manifest.summary;r.state='succeeded';
        }catch(e){r.state=abort.signal.aborted?'cancelled':'failed';r.error=(e as Error).message;}
        finally{await jsonWrite(path.join(folder,'run.json'),r);active.delete(rid);release?.();}
      });
      active.set(rid,{abort,done});handedOff=true;res.status(202).json(r);
    }finally{if(!handedOff)release?.();}
    }finally{preparing=false;}
  };
  app.post('/api/projects/:id/structural',async(req,res)=>start(req,res));
  app.post('/api/projects/:id/structural/queue',async(req,res)=>start(req,res,true));
  app.post('/api/projects/:id/structural/:run/cancel',async(req,res)=>{
    await read(req.params.id,req.params.run);const a=active.get(req.params.run);if(a){a.abort.abort();await a.done;}res.json(await read(req.params.id,req.params.run));
  });
  app.get('/api/projects/:id/structural/:run/file',async(req,res)=>{
    const r=await read(req.params.id,req.params.run);
    if(r.state!=='succeeded')throw new HttpError(409,'计算尚未成功');
    const file=await safePath(r.output||path.join(root(req.params.id),r.id,'result'),String(req.query.path||''));
    if(req.query.download==='1')res.download(file);else res.sendFile(file);
  });
  return {dispose:async()=>{for(const a of active.values())a.abort.abort();await Promise.allSettled([...active.values()].map(a=>a.done));}};
}
