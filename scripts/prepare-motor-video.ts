import {Store} from '../server/storage.js';
import {promises as fs} from 'node:fs';
import path from 'node:path';
const store=new Store(path.resolve('.studio'));await store.init();const p=await store.createProject('三相异步电机 · 建模与热分析');const w=store.workspace(p.id);for(const f of ['build_motor.py','thermal_geometry.py'])await fs.copyFile('C:/Users/hongzhuyi/Documents/Codex/2026-09-21/ben-d/work/motor-video/'+f,path.join(w,f));await fs.writeFile('C:/Users/hongzhuyi/Documents/Codex/2026-09-21/ben-d/work/motor-video/project.json',JSON.stringify({id:p.id,workspace:w}));console.log(p.id);
