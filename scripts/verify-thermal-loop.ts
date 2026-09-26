/** Real CAD -> STEP -> FEM -> design change -> FEM acceptance example.
 * Creates one new named project; existing projects are not edited.
 * Uses only the configured CAD and thermal interpreters and public adapters.
 */
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Store,jsonWrite} from '../server/storage.js';
import {History} from '../server/history.js';
import {Events} from '../server/events.js';
import {Builds} from '../server/builds.js';
import {Thermal} from '../server/thermal.js';
import {Parameters} from '../server/parameters.js';
const root=path.resolve(process.env.STUDIO_DATA_DIR||'.studio');
const store=new Store(root);await store.init();const history=new History(store),events=new Events();
const builds=new Builds(store,history,events),thermal=new Thermal(store,history,events),parameters=new Parameters(store,history);
const project=await store.createProject('建模与热仿真联调 · 铝板 8mm / 12mm');
console.log('DEMO_PROJECT='+project.id);
const {source}=await parameters.template(project.id);
const config={name:'顶部 5W · 60秒 · 铝板示例',base_material:{name:'Aluminum example',k:205,rho:2700,cp:900},analysis_mode:'transient',initial_C:25,ambient_C:25,default_h:10,duration_s:60,dt_s:2,save_s:10,mesh_size_m:.006,air_gap_enabled:false,heat_sources:[{name:'Top heater',power_W:5,start_s:0,end_s:60,selector:'+z'}]};
const rows:unknown[]=[];
try{
  for(const thickness of [8,12]){
    let state=await parameters.read(project.id,source);
    if(thickness!==8){const values=Object.fromEntries(state.document!.parameters.map(p=>[p.name,p.name==='thickness'?thickness:p.value]));state=await parameters.save(project.id,source,state.hash,values);}
    const script=await fs.readFile(path.join(store.workspace(project.id),source),'utf8');
    let build=await builds.start(project.id,source,script,state.hash);
    const until=Date.now()+600000;
    while(['preparing','running'].includes(build.state)&&Date.now()<until){await new Promise(r=>setTimeout(r,1000));build=await builds.read(project.id,build.id);}
    assert.equal(build.state,'succeeded',build.error+'\n'+build.log);
    const saved=await builds.publish(project.id,build.id);
    const step=build.artifacts.find(a=>a.path.endsWith('plate.step'))!;assert(step);
    const geometry=`${saved.path}/${step.path}`;
    const validation=JSON.parse((await builds.file(project.id,build.id,'artifacts/plate/validation.json')).toString());
    assert.equal(validation.cad_geometry_validated,true);
    console.log(`CAD ${thickness} mm built and STEP roundtrip verified`);
    let run=await thermal.start(project.id,{source:geometry,units:'mm',config});
    const deadline=Date.now()+600000;
    while(run.state==='running'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,1500));run=await thermal.read(project.id,run.id);}
    assert.equal(run.state,'succeeded',run.error+'\n'+run.log);
    assert(run.result!.result.maximum_C>25);assert.equal(run.result!.result.frames,7);
    const result=await thermal.publish(project.id,run.id);
    assert.equal((await thermal.publish(project.id,run.id)).path,result.path);
    const archive=await thermal.file(project.id,run.id,'job/result.zip');assert(archive.length>1000);
    const other=await store.project(project.id);assert(other);
    rows.push({thickness_mm:thickness,build:build.id,source:geometry,sourceHash:run.sourceHash,simulation:run.id,resultPath:result.path,maximum_C:run.result!.result.maximum_C,cadVolume_mm3:validation.volume,warnings:run.result!.result.summary.warnings});
    await jsonWrite(path.join(store.workspace(project.id),'thermal-case.json'),{source:geometry,units:'mm',config});
    console.log(`THERMAL ${thickness} mm: ${run.result!.result.maximum_C} C`);
  }
  const report={status:'PASS',project:project.id,source,rows,scope:'Two real CadFlow builds with STEP roundtrip and two CPU FEM solves. Illustrative aluminum/top 5W/60s conditions; not an engineering design recommendation.'};
  const output=path.resolve(process.env.THERMAL_ACCEPTANCE_REPORT||'thermal-acceptance.json');await jsonWrite(output,report);
  console.log(JSON.stringify(report,null,2));
}finally{await builds.dispose();await thermal.dispose();}
