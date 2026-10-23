import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {snapshotPresentation,validateBindings} from '../server/semantic-bindings.js';

test('object bindings require all 20 components and the exact CAD hash',()=>{
 const value={schema_version:2,source_sha256:'hash',equivalence:{approved:true},geometry_model:{schema_version:1,components:Array.from({length:20},(_,i)=>({id:i}))},
  bindings:Object.fromEntries([['interface.fixed_support','bottom'],['interface.axial_load','top'],['interface.external_pressure','skin']].map(([name,shell_set])=>[name,{shell_set,face_count:1,area_mm2:100}]))};
 assert.equal(validateBindings(value,'hash'),value);
 assert.throws(()=>validateBindings(value,'different'),/改变/);
 assert.throws(()=>validateBindings({...value,geometry_model:{...value.geometry_model,components:[]}},'hash'),/不完整/);
});

test('report snapshots reject stale or changed renders and freeze both current images',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'castudio-renders-'));
 try{
  const folder=path.join(root,'analysis');await fs.mkdir(folder);const source=path.join(root,'cylinder.step');
  assert.equal(await snapshotPresentation(source,folder,'cad-hash'),undefined);
  const pixels=Buffer.from('fixture PNG bytes'),hash=createHash('sha256').update(pixels).digest('hex');
  for(const file of ['cad-full.png','cad-cutaway.png'])await fs.writeFile(path.join(root,file),pixels);
  const manifest={source_sha256:'cad-hash',renderer:'Blender Cycles',full:'cad-full.png',cutaway:'cad-cutaway.png',image_sha256:{'cad-full.png':hash,'cad-cutaway.png':hash}};
  await fs.writeFile(path.join(root,'render-manifest.json'),JSON.stringify(manifest));
  const images=await snapshotPresentation(source,folder,'cad-hash');
  assert.deepEqual(await fs.readFile(images.full),pixels);
  assert.deepEqual(await fs.readFile(images.cutaway),pixels);
  await assert.rejects(snapshotPresentation(source,folder,'other-cad'),/不匹配/);
  await fs.writeFile(path.join(root,'cad-full.png'),'tampered');
  await assert.rejects(snapshotPresentation(source,folder,'cad-hash'),/已改变/);
 }finally{
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
  await fs.rm(root,{recursive:true,force:true});
 }
});
