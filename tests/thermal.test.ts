import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, jsonWrite } from '../server/storage.js';
import { History } from '../server/history.js';
import { Thermal } from '../server/thermal.js';
import { Events } from '../server/events.js';
const python=process.env.STUDIO_THERMAL_TEST_PYTHON;
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'thermal-test-'));const store=new Store(root);await store.init();const project=await store.createProject('test');const thermal=new Thermal(store,new History(store),new Events());return {root,store,project,thermal};}
test('thermal adapter rejects traversal, cross-project runs and invalid interpreters',async()=>{
  const f=await fixture();try{
    await assert.rejects(()=>f.thermal.probe('python --evil'),/绝对路径/);
    await assert.rejects(()=>f.thermal.start(f.project.id,{source:'../secret.step',units:'mm',config:{}}),/路径/);
    await assert.rejects(()=>f.thermal.read(f.project.id,'../escape'),/编号/);
    await assert.rejects(()=>f.thermal.read(f.project.id,'00000000-0000-0000-0000-000000000000'),/不存在/);
  }finally{await f.thermal.dispose();await fs.rm(f.root,{recursive:true,force:true});}
});
test('thermal adapter cancels, recovers and does not publish failed output',{skip:!python},async()=>{
  const f=await fixture();try{
    await jsonWrite(path.join(f.root,'thermal-runtime.json'),{executable:python});
    await fs.writeFile(path.join(f.store.workspace(f.project.id),'bad.stl'),'invalid solid');
    const run=await f.thermal.start(f.project.id,{source:'bad.stl',units:'mm',config:{environment_only:true}});
    const cancelled=await f.thermal.cancel(f.project.id,run.id);assert.equal(cancelled.state,'cancelled');
    await assert.rejects(()=>f.thermal.publish(f.project.id,run.id),/已完成/);
    await assert.rejects(()=>f.thermal.file(f.project.id,run.id,'manifest.json'),/没有/);
    const other=await f.store.createProject('other');await assert.rejects(()=>f.thermal.read(other.id,run.id),/不存在/);
    const record=path.join(f.store.projectRoot(f.project.id),'thermal',run.id,'run.json');
    await jsonWrite(record,{...cancelled,state:'running'});await f.thermal.recover();assert.equal((await f.thermal.read(f.project.id,run.id)).state,'interrupted');
    const release=f.store.acquire(f.project.id);release();
  }finally{await f.thermal.dispose();await fs.rm(f.root,{recursive:true,force:true});}
});
