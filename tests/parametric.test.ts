import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {Store} from '../server/storage.js';
import {History} from '../server/history.js';
import {parametricRoutes} from '../server/parametric.js';
import {validateBindings} from '../server/semantic-bindings.js';

test('semantic bindings reject stale CAD, missing groups and swapped pressure surfaces',()=>{
 const value={schema_version:1,source_sha256:'abc',equivalence:{approved:true},bindings:{
  'interface.fixed_support':{shell_set:'bottom',face_count:1,area_mm2:1},
  'interface.axial_load':{shell_set:'top',face_count:1,area_mm2:1},
  'interface.external_pressure':{shell_set:'skin',face_count:1,area_mm2:1}}};
 assert.equal(validateBindings(value,'abc'),value);
 assert.throws(()=>validateBindings(value,'changed'),/改变/);
 const swapped=structuredClone(value);swapped.bindings['interface.external_pressure'].shell_set='top';
 assert.throws(()=>validateBindings(swapped,'abc'),/映射/);
 assert.throws(()=>validateBindings({...value,bindings:{}},'abc'),/完整/);
 assert.throws(()=>validateBindings({...value,equivalence:{approved:false}},'abc'),/改变/);
});

test('parametric templates preserve existing source and project boundaries; runtime errors remain actionable',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'castudio-parametric-'));const store=new Store(dir);await store.init();
 const project=await store.createProject('test'),other=await store.createProject('other');
 const app=express();app.use(express.json());const manager=parametricRoutes(app,store,new History(store));
 app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(ok=>server.once('listening',ok));
 const url=`http://127.0.0.1:${(server.address() as any).port}/api/projects/${project.id}/parametric`;
 const post=(suffix:string)=>fetch(url+suffix,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 try{
  assert.equal((await post('/template')).status,201);
  const source=path.join(store.workspace(project.id),'parametric/cylinder.py');const bytes=await fs.readFile(source);
  assert.equal((await post('/template')).status,409);assert.deepEqual(await fs.readFile(source),bytes);
  assert.equal(await fs.access(path.join(store.workspace(other.id),'parametric/cylinder.py')).then(()=>true,()=>false),false);
  assert.equal((await post('/start')).status,422);
  assert.equal((await post('/agent/cells/edit')).status,409);
  assert.equal((await post('/agent/arbitrary')).status,400);
  assert.equal((await post('/publish')).status,422);
  const release=store.acquire(project.id);release(); // failed publication releases project lock
 }finally{await manager.dispose();await new Promise<void>(ok=>server.close(()=>ok()));assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});}
});
