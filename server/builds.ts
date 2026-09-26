import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BuildRun } from '../shared/types.js';
import { Store, HttpError, jsonRead, jsonWrite, safePath } from './storage.js';
import { History } from './history.js';
import { Runtime } from './runtime.js';
import { Parameters, parameterPath } from './parameters.js';
import { runProcess } from './process.js';
import type { Events } from './events.js';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const activeState = (run: BuildRun) => ['preparing', 'running'].includes(run.state);
export class Builds {
  private active = new Map<string, { run: BuildRun; controller: AbortController; done: Promise<void> }>();
  readonly runtime: Runtime;
  constructor(private store: Store, private history: History, private events: Events) { this.runtime = new Runtime(store.root); }
  private root(project: string, run?: string) {
    if (run !== undefined && !/^[a-f0-9-]{36}$/.test(run)) throw new HttpError(400, '构建编号无效');
    return path.join(this.store.projectRoot(project), 'builds', run || '');
  }
  private workspace(project: string, run: string) {
    this.root(project, run);
    // Keep Python working directories short: relative file APIs on Windows can
    // still hit MAX_PATH even when Node accepts a namespaced long path.
    return path.join(this.store.root, 'build-work', run);
  }
  private async persist(project: string, run: BuildRun) { await jsonWrite(path.join(this.root(project, run.id), 'run.json'), run); this.events.emit(project, 'build_changed', { id: run.id }); }
  async list(project: string) {
    await this.store.project(project);
    const dirs = await fs.readdir(this.root(project)).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    const runs = await Promise.all(dirs.filter(id => /^[a-f0-9-]{36}$/.test(id)).map(async id => {
      try { return await this.read(project, id); }
      catch (error) { if (error instanceof HttpError && error.status === 404) return null; throw error; }
    }));
    return runs.filter((run): run is BuildRun => run !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async read(project: string, id: string): Promise<BuildRun> {
    await this.store.project(project);
    const active = this.active.get(project);
    if (active?.run.id === id) {
      // Expose a terminal state only after its record is durable and its lock is released.
      if (!activeState(active.run)) await active.done;
      return structuredClone(active.run);
    }
    const run = await jsonRead<BuildRun | null>(path.join(this.root(project, id), 'run.json'), null);
    if (!run) throw new HttpError(404, '构建不存在'); return run;
  }
  async recover() {
    for (const project of await this.store.projects()) for (const run of await this.list(project.id)) if (activeState(run)) {
      run.state = 'interrupted'; run.error = '服务在构建期间中断；原项目未被构建产物覆盖，请重新构建'; run.finishedAt = new Date().toISOString(); await this.persist(project.id, run);
    }
  }
  async start(project: string, source: unknown, expectedSource: unknown, expectedParameters?: unknown) {
    const release = this.store.acquire(project);
    let dispatched = false;
    try {
      await this.store.project(project); await this.history.recover(project);
      if (typeof source !== 'string' || !/\.py$/i.test(source) || typeof expectedSource !== 'string') throw new HttpError(400, '请选择已保存的 Python 源码');
      const file = await safePath(this.store.workspace(project), source), stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new HttpError(413, '源码文件超过 2 MB');
      const bytes = await fs.readFile(file);
      if (bytes.toString('utf8') !== expectedSource) throw new HttpError(409, '源码已变化，请刷新并保存后构建');
      const parameters = await new Parameters(this.store, this.history).read(project, source);
      if ((expectedParameters ?? null) !== parameters.hash) throw new HttpError(409, '参数已变化，请重新载入参数后构建');
      const { executable } = await this.runtime.config();
      const run: BuildRun = { id: randomUUID(), source, sourceHash: digest(bytes), executable, createdAt: new Date().toISOString(), state: 'preparing', log: '', truncated: false, artifacts: [] };
      if (parameters.document && parameters.hash) run.parameters = { path: parameters.path, hash: parameters.hash, values: parameters.document.parameters.map(({ name, value, unit }) => ({ name, value, unit })) };
      await this.persist(project, run);
      const controller = new AbortController();
      const done = Promise.resolve().then(() => this.execute(project, run, controller.signal)).finally(() => { this.active.delete(project); release(); this.events.emit(project, 'build_changed', { id: run.id }); });
      this.active.set(project, { run, controller, done }); dispatched = true;
      void done.catch(error => console.error('构建记录保存失败：', (error as Error).message));
      return structuredClone(run);
    } finally { if (!dispatched) release(); }
  }
  private async execute(project: string, run: BuildRun, signal: AbortSignal) {
    try {
      const before = await this.history.snapshot(project, `构建 ${run.source} 前`); run.revision = before.id;
      const workspace = this.workspace(project, run.id);
      const originals = new Map((await this.history.materialize(project, before.id, workspace, signal)).map(e => [e.path, e.hash]));
      if (originals.get(run.source) !== run.sourceHash) throw new Error('源码在构建准备期间发生变化，请重试');
      if ((originals.get(parameterPath(run.source)) ?? null) !== (run.parameters?.hash ?? null)) throw new Error('参数在构建准备期间发生变化，请重新载入后重试');
      signal.throwIfAborted(); run.state = 'running'; await this.persist(project, run);
      const entry = await safePath(workspace, run.source);
      const result = await runProcess(run.executable, ['-u', entry], { cwd: workspace, signal, timeout: 10 * 60 * 1000, output: text => {
        if (!text) return; run.log += text;
        if (run.log.length > 512000) { run.log = run.log.slice(-512000); run.truncated = true; }
      } });
      run.exitCode = result.code;
      if (signal.aborted) throw new Error('构建已取消');
      if (result.timedOut) throw new Error('构建超过 10 分钟，已终止');
      if (result.code !== 0) throw new Error(`脚本退出码 ${result.code}；请查看日志`);
      let total = 0, files = 0;
      const scan = async (dir: string, depth: number) => {
        signal.throwIfAborted(); if (depth > 32) throw new Error('构建产物目录过深');
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || ['node_modules', 'venv', '__pycache__'].includes(entry.name)) continue;
          if (entry.isSymbolicLink()) throw new Error('构建产物包含符号链接，拒绝发布');
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) { await scan(file, depth + 1); continue; }
          if (!entry.isFile()) throw new Error('构建产物包含特殊文件');
          const stat = await fs.stat(file); total += stat.size;
          if (++files > 10000 || stat.size > 128 * 1024 * 1024 || total > 2 * 1024 ** 3) throw new Error('构建目录超过容量限制');
          const hash = digest(await fs.readFile(file)), relative = path.relative(workspace, file).split(path.sep).join('/');
          if (originals.get(relative) !== hash) run.artifacts.push({ path: relative, size: stat.size, hash });
        }
      };
      await scan(workspace, 0); signal.throwIfAborted(); run.state = 'succeeded';
    } catch (error) { run.state = signal.aborted ? 'cancelled' : 'failed'; run.error = (error as Error).message; run.artifacts = []; }
    finally { run.finishedAt = new Date().toISOString(); await this.persist(project, run); }
  }
  async cancel(project: string, id: string) {
    const run = await this.read(project, id), active = this.active.get(project);
    if (active?.run.id === id) { active.controller.abort(); await active.done; }
    return this.read(project, run.id);
  }
  async file(project: string, id: string, relative: string) {
    const run = await this.read(project, id), artifact = run.artifacts.find(a => a.path === relative);
    if (run.state !== 'succeeded' || !artifact) throw new HttpError(404, '没有可下载的成功产物');
    const file = await safePath(this.workspace(project, id), relative), stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== artifact.size || stat.size > 128 * 1024 * 1024) throw new HttpError(409, '构建产物已变化');
    const bytes = await fs.readFile(file); if (digest(bytes) !== artifact.hash) throw new HttpError(409, '构建产物已变化'); return bytes;
  }
  async publish(project: string, id: string) {
    const release = this.store.acquire(project);
    const staging = path.join(this.root(project, id), 'publish');
    try {
      await this.history.recover(project); const run = await this.read(project, id);
      if (run.state !== 'succeeded' || !run.artifacts.length) throw new HttpError(409, '构建没有可保存的成功产物');
      const prefix = `builds/${id}`, target = await safePath(this.store.workspace(project), prefix, false);
      if (run.artifacts.some(a => a.path === 'studio-build-manifest.json')) throw new HttpError(409, '构建产物使用了保留的 studio-build-manifest.json 文件名');
      const finalize = async () => {
        await this.store.touch(project);
        run.publishedRevision = (await this.history.snapshot(project, `构建产物 ${run.source}`)).id;
        await this.persist(project, run); this.events.emit(project, 'artifacts_changed', {});
        return { path: prefix };
      };
      if (run.published) { if (run.publishedRevision) return { path: run.published }; return await finalize(); }
      try { await fs.access(target); throw new HttpError(409, '目标目录已存在，保留已有成果'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await fs.mkdir(staging, { recursive: true });
      for (const artifact of run.artifacts) {
        const bytes = await this.file(project, id, artifact.path), file = await safePath(staging, artifact.path, false);
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
      }
      await jsonWrite(path.join(staging, 'studio-build-manifest.json'), { id, source: run.source, sourceHash: run.sourceHash, parameters: run.parameters, executable: run.executable, revision: run.revision, createdAt: run.createdAt, artifacts: run.artifacts });
      await this.history.snapshot(project, '保存构建产物前');
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.rename(staging, target);
      run.published = prefix; await this.persist(project, run);
      return await finalize();
    } finally { release(); }
  }
  async dispose() { for (const active of this.active.values()) active.controller.abort(); await Promise.allSettled([...this.active.values()].map(a => a.done)); }
}
