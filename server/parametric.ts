import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import type { Express } from 'express';
import { Store, HttpError, jsonRead, jsonWrite, safePath } from './storage.js';
import { History } from './history.js';
import { runProcess } from './process.js';

const resource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../resources/parametric');
const delay = (n:number) => new Promise(ok=>setTimeout(ok,n));
async function pythonSources(root:string,relative=''):Promise<string[]>{
  const result:string[]=[];
  for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
    const name=path.join(relative,entry.name);
    if(entry.isDirectory()&&!['exports','__marimo__','__pycache__','.sca-editor'].includes(entry.name))result.push(...await pythonSources(root,name));
    else if(entry.isFile()&&entry.name.endsWith('.py'))result.push(name);
  }
  return result.sort();
}
type Worker = { port:number; abort:AbortController; done:Promise<unknown>; log:string; ended:boolean; ready:boolean };
export function parametricRoutes(app:Express, store:Store, history:History) {
  const workers=new Map<string,Worker>(), starting=new Map<string,Promise<Worker>>();
  const builds=new Map<string,AbortController>();
  const jobStates=new Map<string,any>();
  const workspace=(id:string)=>path.join(store.workspace(id),'parametric');
  const config=()=>jsonRead<any>(path.join(store.root,'parametric-runtime.json'),null);
  const endpoint=(id:string)=>`/api/projects/${id}/parametric`;
  async function stop(id:string) {
    workers.get(id)?.abort.abort();
    const pending=starting.get(id);if(pending)await pending.catch(()=>{});
    const worker=workers.get(id);if(worker){worker.abort.abort();await worker.done;workers.delete(id);}
  }
  async function ensure(id:string,parent:string):Promise<Worker> {
    await store.project(id);
    const present=workers.get(id);if(present&&!present.ended&&present.ready)return present;
    const pending=starting.get(id);if(pending)return pending;
    const task=(async()=>{
      const runtime=await config();if(!runtime)throw new HttpError(422,'未配置参数化建模环境');
      await fs.access(path.join(workspace(id),'cylinder.py')).catch(()=>{throw new HttpError(422,'请先创建参数化圆柱');});
      const socket=net.createServer();await new Promise<void>(ok=>socket.listen(0,'127.0.0.1',ok));
      const port=(socket.address() as net.AddressInfo).port;await new Promise<void>(ok=>socket.close(()=>ok()));
      const worker:Worker={port,abort:new AbortController(),done:Promise.resolve(),log:'',ended:false,ready:false};
      workers.set(id,worker);
      worker.done=runProcess(runtime.python,['-u',path.join(resource,'bridge.py'),'serve',workspace(id),String(port),parent],
        {cwd:workspace(id),signal:worker.abort.signal,timeout:24*60*60*1000,output:t=>{worker.log=(worker.log+t).slice(-24000);}})
        .catch(e=>{worker.log+='\n'+e.message;}).finally(()=>{worker.ended=true;});
      for(let n=0;n<600;n++){
        if(worker.ended)throw new HttpError(422,worker.log);
        try{const r=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(1000)});if(r.ok){worker.ready=true;return worker;}}catch{}
        await delay(500);
      }
      worker.abort.abort();await worker.done;throw new HttpError(504,'参数化建模服务启动超时：'+worker.log);
    })();
    starting.set(id,task);try{return await task;}finally{starting.delete(id);}
  }
  const base='/api/projects/:id/parametric';
  app.get('/api/parametric/runtime',async(_q,r)=>r.json({configured:!!await config(),upstream:'SimpleCADAPI 2.2.6.post2',commit:'9e749ed706aa3e40cbf78b2dcfff5717737a0c2f'}));
  app.get(base,async(q,r)=>{
    await store.project(String(q.params.id));const w=workers.get(String(q.params.id));
    const published=await jsonRead<any>(path.join(workspace(String(q.params.id)),'published.json'),null);
    const job=jobStates.get(String(q.params.id))||await jsonRead<any>(path.join(workspace(String(q.params.id)),'job.json'),null);
    if(job?.state==='running'&&!builds.has(String(q.params.id))){job.state='interrupted';await jsonWrite(path.join(workspace(String(q.params.id)),'job.json'),job);}
    r.json({exists:await fs.access(path.join(workspace(String(q.params.id)),'cylinder.py')).then(()=>true,()=>false),
      running:!!w&&!w.ended,url:w&&!w.ended&&w.ready?`http://127.0.0.1:${w.port}/`:null,published,job,log:w?.log});
  });
  app.post(base+'/template',async(q,r)=>{
    const id=String(q.params.id);await store.project(id);const release=store.acquire(id);
    try{
      const root=workspace(id);await fs.mkdir(root,{recursive:true});
      if(await fs.access(path.join(root,'cylinder.py')).then(()=>true,()=>false))throw new HttpError(409,'参数化圆柱已存在');
      await history.snapshot(id,'创建参数化建模工作区前');
      for(const file of ['cylinder.py','parametric_common.py'])await fs.copyFile(path.join(resource,'templates',file),path.join(root,file));
      await history.snapshot(id,'创建参数化圆柱与语义边界');r.status(201).json({source:'parametric/cylinder.py'});
    }finally{release();}
  });
  app.post(base+'/start',async(q,r)=>{
    if(builds.has(String(q.params.id)))throw new HttpError(409,'正在发布 CAD，请稍候');
    const w=await ensure(String(q.params.id),`http://${q.get('host')}`);r.json({url:`http://127.0.0.1:${w.port}/`,agentApi:endpoint(String(q.params.id))});
  });
  app.post(base+'/stop',async(q,r)=>{await store.project(String(q.params.id));await stop(String(q.params.id));r.json({ok:true});});
  // A constrained proxy for the built-in agent: no arbitrary upstream URL or path.
  const operations=new Set(['snapshot','cells','sdk','workspace','studio/selected']);
  const commands=new Set(['cells/edit','cells/insert','cells/delete','cells/run','workspace/open','studio/select']);
  app.all(base+'/agent/{*operation}',async(q,r)=>{
    await store.project(String(q.params.id));const operation=Array.isArray(q.params.operation)?q.params.operation.join('/'):String(q.params.operation);
    if(!(q.method==='GET'?operations:commands).has(operation)||!['GET','POST'].includes(q.method))throw new HttpError(400,'不支持的建模操作');
    if(builds.has(String(q.params.id)))throw new HttpError(409,'正在发布 CAD，请稍候');
    const w=workers.get(String(q.params.id));if(!w||w.ended)throw new HttpError(409,'请先打开参数化建模');
    const response=await fetch(`http://127.0.0.1:${w.port}/api/${operation}`,{method:q.method,headers:{'Content-Type':'application/json'},body:q.method==='POST'?JSON.stringify(q.body):undefined,signal:AbortSignal.timeout(q.method==='POST'?60*60*1000:120000)});
    r.status(response.status).type(response.headers.get('content-type')||'application/json').send(Buffer.from(await response.arrayBuffer()));
  });
  app.post(base+'/publish',async(q,r)=>{
    const id=String(q.params.id);await store.project(id);if(builds.has(id))throw new HttpError(409,'已有参数化构建正在进行');
    const release=store.acquire(id);const runtime=await config();if(!runtime){release();throw new HttpError(422,'未配置参数化建模环境');}
    const abort=new AbortController();builds.set(id,abort);
    try{
      const w=workers.get(id);
      if(w&&!w.ended){
        if(!q.body?.editor)throw new HttpError(409,'请通过建模面板发布，以确认编辑内容已保存');
        let settled=false;
        for(let n=0;n<240;n++){
          if(abort.signal.aborted)throw new HttpError(409,'已取消发布');
          const response=await fetch(`http://127.0.0.1:${w.port}/api/castudio/settled`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(q.body.editor),signal:AbortSignal.timeout(5000)});
          const ready=await response.json() as any;
          if(!response.ok)throw new HttpError(response.status,ready.error||'无法确认编辑状态');
          if(ready.ready){settled=true;break;}await delay(500);
        }
        if(!settled)throw new HttpError(409,'编辑保存或建模尚未完成，请等待后重新发布');
      }
      await stop(id);await history.snapshot(id,'参数化 CAD 发布前');
      const rid=randomUUID(),root=workspace(id),output=path.join(root,'exports',rid);
      const source=await safePath(root,'cylinder.py');
      const snapshot=path.join(output,'source');await fs.mkdir(snapshot,{recursive:true});
      // Freeze all local Python modules; exports must describe exactly the snapshot.
      for(const name of await pythonSources(root)){await fs.mkdir(path.dirname(path.join(snapshot,name)),{recursive:true});await fs.copyFile(await safePath(root,name),path.join(snapshot,name));}
      const job:any={id:rid,state:'running',createdAt:new Date().toISOString(),log:'',sourceHash:createHash('sha256').update(await fs.readFile(source)).digest('hex')};
      jobStates.set(id,job);
      await jsonWrite(path.join(root,'job.json'),job);
      const task=async()=>{
        try{
          // Run in the original workspace to reuse per-cell caches. Editor is stopped.
          const result=await runProcess(runtime.python,['-u',path.join(resource,'bridge.py'),'build',source,output,path.join(resource,'reference-cylinder.step')],
            {cwd:root,signal:abort.signal,timeout:60*60*1000,output:t=>{job.log=(job.log+t).slice(-32000);}});
          job.exitCode=result.code;job.timedOut=result.timedOut;
          if(result.code!==0||result.timedOut||abort.signal.aborted)throw Error('CAD 进程退出码 '+result.code+(result.timedOut?'（超时）':'')+'\n'+job.log.slice(-5000));
          const names=await pythonSources(root);
          if(JSON.stringify(names)!==JSON.stringify(await pythonSources(snapshot)))throw Error('构建期间共享模块列表发生变化，产物未发布');
          for(const name of names)if(!Buffer.from(await fs.readFile(path.join(snapshot,name))).equals(await fs.readFile(await safePath(root,name))))throw Error('构建期间源码发生变化，产物未发布');
          const manifest=await jsonRead<any>(path.join(output,'cylinder.bindings.json'),null);
          if(!manifest||manifest.source_sha256!==createHash('sha256').update(await fs.readFile(path.join(output,'cylinder.step'))).digest('hex'))throw Error('CAD 与边界记录不匹配');
          const published={source:`parametric/exports/${rid}/cylinder.step`,manifest,createdAt:new Date().toISOString()};
          await jsonWrite(path.join(root,'published.json'),published);job.state='succeeded';job.published=published;
          await history.snapshot(id,'发布参数化 CAD 与仿真边界');
        }catch(e){job.state=abort.signal.aborted?'cancelled':'failed';job.error=(e as Error).message;}
        finally{await jsonWrite(path.join(root,'job.json'),job);builds.delete(id);release();}
      };
      void task();r.status(202).json(job);
    }catch(e){builds.delete(id);release();throw e;}
  });
  app.post(base+'/cancel',async(q,r)=>{await store.project(String(q.params.id));builds.get(String(q.params.id))?.abort();r.json({ok:true});});
  return {dispose:async()=>{for(const abort of builds.values())abort.abort();await Promise.allSettled([...workers.keys()].map(stop));}};
}
