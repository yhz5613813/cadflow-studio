import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Store,jsonWrite} from '../server/storage.js';
import {structuralRoutes} from '../server/structural.js';

test('agent queue waits for editing lock, rejects changed geometry, and cancels safely',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-structural-test-'));
 const store=new Store(root);await store.init();const project=await store.createProject('queue test');
 await fs.writeFile(path.join(store.workspace(project.id),'case.step'),'fixture original');
 await jsonWrite(path.join(root,'structural-runtime.json'),{python:process.execPath,packageRoot:root,solver:'must-not-run',workRoot:path.join(root,'work')});
 const app=express();app.use(express.json());const structural=structuralRoutes(app,store);
 app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server.once('listening',ok));
 const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}/api/projects/${project.id}/structural`;
 const post=(suffix:string,body:any={})=>fetch(base+suffix,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 let release:(()=>void)|undefined;
 try{
  release=store.acquire(project.id);
  assert.equal((await post('',{source:'case.step'})).status,409);
  const queued=await post('/queue',{source:'case.step'});assert.equal(queued.status,202);const run=await queued.json();
  assert.equal((await (await fetch(base+'/'+run.id)).json()).state,'queued');
  await fs.writeFile(path.join(store.workspace(project.id),'case.step'),'fixture changed');release();release=undefined;
  let state:any;
  for(let i=0;i<30;i++){state=await (await fetch(base+'/'+run.id)).json();if(state.state==='failed')break;await new Promise(ok=>setTimeout(ok,100));}
  assert.equal(state.state,'failed');assert.match(state.error,/源模型已改变/);
  assert.equal((await fetch(base+'/'+run.id+'/file?path=report.docx')).status,409);
  release=store.acquire(project.id);
  const run2=await (await post('/queue',{source:'case.step'})).json();
  const cancelled=await (await post('/'+run2.id+'/cancel')).json();assert.equal(cancelled.state,'cancelled');
  assert.throws(()=>store.acquire(project.id),/项目/);release();release=undefined;
  assert.equal((await post('/queue',{source:'../outside.step'})).status,400);
 }finally{
  release?.();await structural.dispose();await new Promise<void>(ok=>server.close(()=>ok()));
  const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(resolved,{recursive:true,force:true});
 }
});


test('slow CAD verification is recorded immediately and remains cancellable',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-cad-check-'));
 const store=new Store(root);await store.init();const project=await store.createProject('CAD validation');
 await fs.writeFile(path.join(store.workspace(project.id),'case.step'),'fixture');
 await jsonWrite(path.join(root,'structural-runtime.json'),{python:process.execPath,packageRoot:root,solver:'must-not-run',workRoot:path.join(root,'work')});
 const app=express();app.use(express.json());let entered=false;
 const manager=structuralRoutes(app,store,async(_root,_source,_folder,_hash,signal)=>{
  entered=true;
  return new Promise((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(new Error('cancelled verification')),{once:true});});
 });
 app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server.once('listening',ok));
 const url=`http://127.0.0.1:${(server.address() as any).port}/api/projects/${project.id}/structural`;
 try{
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'case.step'})});
  assert.equal(response.status,202);const run=await response.json();
  for(let i=0;i<50&&!entered;i++)await new Promise(ok=>setTimeout(ok,20));
  assert.equal(entered,true);
  const listing=await fetch(url);assert.equal(listing.status,200);
  assert.equal((await listing.json())[0].state,'running');
  const cancel=await fetch(url+'/'+run.id+'/cancel',{method:'POST'});
  assert.equal((await cancel.json()).state,'cancelled');
  assert.equal(await fs.readFile(path.join(store.workspace(project.id),'case.step'),'utf8'),'fixture');
 }finally{await manager.dispose();await new Promise<void>(ok=>server.close(()=>ok()));assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});}
});
