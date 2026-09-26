import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Store, HttpError, jsonRead, jsonWrite, safePath } from './storage.js';
import { History } from './history.js';
import { Events } from './events.js';
import { runProcess } from './process.js';
import type { ThermalConfig, ThermalRun, ThermalManifest, ThermalProbe } from '../shared/thermal.js';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// Host adapter only. All geometry, meshing, material validation and FEM live in
// the separately installed thermal-sim distribution and its versioned CLI.
export class Thermal {
  private active = new Map<string, { run: ThermalRun; abort: AbortController; done: Promise<void> }>();
  private pending = 0;
  constructor(private store: Store, private history: History, private events: Events) {}
  async config() { return jsonRead(path.join(this.store.root, 'thermal-runtime.json'), { executable: process.env.STUDIO_THERMAL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }); }
  async probe(value?: unknown): Promise<ThermalProbe> {
    const executable = value ?? (await this.config()).executable;
    if (typeof executable !== 'string' || executable.length > 2048 || /[\0\r\n]/.test(executable) || (!path.isAbsolute(executable) && !['python','python3'].includes(executable))) throw new HttpError(400, '请填写 Python 解释器绝对路径');
    let log = '';
    try {
      const result = await runProcess(executable, ['-I','-X','utf8','-m','thermal_sim','doctor'], { cwd: os.tmpdir(), timeout: 60000, output: s => { log = (log + s).slice(-16000); } });
      const line = log.split(/\r?\n/).find(l => l.startsWith('THERMAL_RESULT='));
      const body = line ? JSON.parse(line.slice(15)) : null;
      if (result.code !== 0 || result.timedOut || body?.schema_version !== 1 || body?.ok !== true) throw new Error(log || '检测超时或缺少 thermal-sim');
      return { ok: true, executable, version: body.version, message: '热仿真包与 CPU 依赖可用' };
    } catch (e) { return { ok: false, executable, message: (e as Error).message.slice(-3000) }; }
  }
  async saveRuntime(value: unknown) { const probe = await this.probe(value); if (!probe.ok) throw new HttpError(422, probe.message); await jsonWrite(path.join(this.store.root, 'thermal-runtime.json'), { executable: probe.executable }); return probe; }
  private directory(project: string, run?: string) {
    if (run !== undefined && !/^[a-f0-9-]{36}$/.test(run)) throw new HttpError(400, '无效仿真编号');
    return path.join(this.store.projectRoot(project), 'thermal', run || '');
  }
  private work(project: string, run: string) { this.directory(project,run); return path.join(this.store.root, 'thermal-work',run); }
  private async persist(project: string, run: ThermalRun) { await jsonWrite(path.join(this.directory(project,run.id),'run.json'), run); this.events.emit(project,'thermal_changed',{ id: run.id }); }
  async list(project: string) {
    await this.store.project(project);
    const ids = await fs.readdir(this.directory(project)).catch(e => { if(e.code==='ENOENT') return []; throw e; });
    return (await Promise.all(ids.filter(id => /^[a-f0-9-]{36}$/.test(id)).map(id => this.read(project,id)))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async read(project: string, id: string): Promise<ThermalRun> {
    await this.store.project(project); this.directory(project,id);
    const active = this.active.get(project);
    if (active?.run.id === id && active.run.state !== 'running') await active.done;
    const run = active?.run.id === id ? structuredClone(active.run) : await jsonRead<ThermalRun | null>(path.join(this.directory(project,id),'run.json'),null);
    if (!run) throw new HttpError(404,'仿真不存在');
    if (run.state === 'running') run.progress = await jsonRead(path.join(this.work(project,id),'output/job/status.json'), run.progress);
    try { const file=await safePath(this.store.workspace(project),run.source); run.stale=hash(await fs.readFile(file))!==run.sourceHash; } catch { run.stale=true; }
    return run;
  }
  async recover() { for(const project of await this.store.projects()) for(const run of await this.list(project.id)) if(run.state==='running') { run.state='interrupted';run.error='服务中断，请重新运行';run.finishedAt=new Date().toISOString(); await this.persist(project.id,run); } }
  async start(project: string, input: { source?: unknown; units?: unknown; config?: unknown; expectedHash?: unknown }) {
    if(this.active.size + this.pending >= 1) throw new HttpError(409,'已有热仿真正在运行，请等待或取消');
    const release=this.store.acquire(project); let dispatched=false; this.pending++;
    try {
      await this.store.project(project); await this.history.recover(project);
      if(typeof input.source!=='string' || !/\.(step|stp|stl)$/i.test(input.source)) throw new HttpError(400,'请选择项目中的 STEP/STL 实体');
      if(!['mm','cm','m'].includes(String(input.units))) throw new HttpError(400,'请选择模型单位');
      if(!input.config || typeof input.config!=='object' || Array.isArray(input.config) || JSON.stringify(input.config).length>400000) throw new HttpError(400,'无效仿真工况');
      const file=await safePath(this.store.workspace(project),input.source), stat=await fs.stat(file);
      if(!stat.isFile() || stat.size>100*1024*1024 || !stat.size) throw new HttpError(413,'模型必须为 100 MB 以内的非空文件');
      const bytes=await fs.readFile(file), sourceHash=hash(bytes);
      if(input.expectedHash && input.expectedHash!==sourceHash) throw new HttpError(409,'模型已变化，请重新选择');
      const {executable}=await this.config();
      const run: ThermalRun={id:randomUUID(),source:input.source,sourceHash,units:input.units as ThermalRun['units'],config:structuredClone(input.config) as ThermalConfig,executable,createdAt:new Date().toISOString(),state:'running',log:'',files:[]};
      const work=this.work(project,run.id);await fs.mkdir(work,{recursive:true});
      const source=path.join(work,'source'+path.extname(input.source));await fs.writeFile(source,bytes);
      await jsonWrite(path.join(work,'request.json'),{schema_version:1,geometry:{path:source,units:run.units,sha256:sourceHash},simulation:run.config,device:'cpu'});
      run.revision=(await this.history.snapshot(project,`热仿真 ${run.source} 前`)).id;
      await this.persist(project,run);
      const abort=new AbortController();
      const done=Promise.resolve().then(()=>this.execute(project,run,abort.signal)).finally(()=>{this.active.delete(project);release();});
      this.active.set(project,{run,abort,done});dispatched=true;
      void done.catch(e=>console.error('保存仿真记录失败',e));return structuredClone(run);
    } finally { this.pending--; if(!dispatched) release(); }
  }
  private async execute(project: string, run: ThermalRun, signal: AbortSignal) {
    try {
      const work=this.work(project,run.id), output=path.join(work,'output');
      const result=await runProcess(run.executable,['-I','-X','utf8','-u','-m','thermal_sim','run',path.join(work,'request.json'),'--output',output],{cwd:work,signal,timeout:30*60*1000,output:text=>{run.log=(run.log+text).slice(-128000);}});
      if(signal.aborted) throw new Error('仿真已取消');
      if(result.timedOut) throw new Error('仿真超过 30 分钟，已停止');
      if(result.code!==0) throw new Error(`热仿真退出码 ${result.code}，请查看日志`);
      const manifest=await jsonRead<ThermalManifest|null>(path.join(output,'manifest.json'),null);
      if(manifest?.schema_version!==1 || manifest.source_sha256!==run.sourceHash || !Number.isFinite(manifest.result?.maximum_C)) throw new Error('仿真结果协议或模型摘要不匹配');
      let total=0;
      const scan=async(dir:string,depth=0)=>{if(depth>10)throw new Error('结果目录过深');for(const entry of await fs.readdir(dir,{withFileTypes:true})){
        const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('结果含符号链接');if(entry.isDirectory()){await scan(file,depth+1);continue;}if(!entry.isFile())throw new Error('结果不是普通文件');
        const stat=await fs.stat(file);total+=stat.size;if(stat.size>128*1024*1024||total>512*1024*1024||run.files.length>=2000)throw new Error('结果超过保存上限，请降低网格或帧数');
        run.files.push({path:path.relative(output,file).split(path.sep).join('/'),size:stat.size,hash:hash(await fs.readFile(file))});
      }};await scan(output);run.result=manifest;run.state='succeeded';
    } catch(e){run.state=signal.aborted?'cancelled':'failed';run.error=(e as Error).message;run.files=[];delete run.result;}
    finally{run.finishedAt=new Date().toISOString();await this.persist(project,run);}
  }
  async cancel(project:string,id:string){await this.read(project,id);const active=this.active.get(project);if(active?.run.id===id){active.abort.abort();await active.done;}return this.read(project,id);}
  async file(project:string,id:string,relative:string){
    const run=await this.read(project,id),item=run.files.find(f=>f.path===relative);
    if(run.state!=='succeeded'||!item)throw new HttpError(404,'没有可用结果文件');
    const file=await safePath(path.join(this.work(project,id),'output'),relative),stat=await fs.stat(file);
    if(!stat.isFile()||stat.size!==item.size)throw new HttpError(409,'结果文件已变化');
    const bytes=await fs.readFile(file);if(hash(bytes)!==item.hash)throw new HttpError(409,'结果文件摘要已变化');return bytes;
  }
  async publish(project:string,id:string){
    const release=this.store.acquire(project);
    try{
      await this.history.recover(project);const run=await this.read(project,id);
      if(run.state!=='succeeded')throw new HttpError(409,'只能保存已完成仿真');
      if(run.publishedRevision)return {path:run.published!};
      const prefix=`simulations/${id}`,target=await safePath(this.store.workspace(project),prefix,false);
      if(!run.published){
        try{await fs.access(target);throw new HttpError(409,'保存目录已存在');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        const staging=path.join(this.directory(project,id),'publish');await fs.mkdir(staging,{recursive:true});
        for(const item of run.files){const bytes=await this.file(project,id,item.path),file=await safePath(staging,item.path,false);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
        await jsonWrite(path.join(staging,'studio-simulation.json'),{id,source:run.source,sourceHash:run.sourceHash,revision:run.revision,config:run.config,engine:run.result?.engine_version});
        await this.history.snapshot(project,'保存仿真结果前');await fs.mkdir(path.dirname(target),{recursive:true});await fs.rename(staging,target);run.published=prefix;await this.persist(project,run);
      }
      await this.store.touch(project);run.publishedRevision=(await this.history.snapshot(project,'热仿真结果与建模来源')).id;await this.persist(project,run);this.events.emit(project,'artifacts_changed',{});return {path:prefix};
    }finally{release();}
  }
  async dispose(){for(const item of this.active.values())item.abort.abort();await Promise.allSettled([...this.active.values()].map(a=>a.done));}
}
