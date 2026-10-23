import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { Store, HttpError, jsonRead, jsonWrite, safePath } from './storage.js';
import { History } from './history.js';
import { runProcess } from './process.js';

const resource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../resources/parametric');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Model = Record<string, unknown> & { components: Array<{ id: string }> };
type Job = { id: string; state: 'running' | 'succeeded' | 'failed' | 'cancelled'; revision: number; stage: string; log: string; error?: string; createdAt: string; finishedAt?: string };
type Published = { source: string; preview: string; revision: number; manifest: any; createdAt: string };
type State = { revision: number; modelHash: string; job: Job | null; published: Published | null };
type Build = { abort: AbortController; done: Promise<void>; state: State };
type Options = { process?: typeof runProcess; changed?: (id: string) => void };

export function cylinderObjectsRoutes(app: Express, store: Store, history: History, options: Options = {}) {
  const execute = options.process ?? runProcess;
  const active = new Map<string, Build>();
  const controllers = new Set<AbortController>(), processes = new Set<Promise<unknown>>();
  let disposed = false;
  const base = '/api/projects/:id/cylinder-objects';
  const checkOpen = () => { if (disposed) throw new HttpError(503, '圆柱建模服务正在关闭'); };
  const location = (id: string, name: string, exists = false) => safePath(store.workspace(id), `cylinder-objects/${name}`, exists);
  const stateFile = (id: string) => location(id, 'state.json');
  const modelFile = (id: string) => location(id, 'model.json');
  const persist = async (id: string, state: State) => jsonWrite(await stateFile(id), state);
  async function runtime() {
    const config = await jsonRead<any>(path.join(store.root, 'parametric-runtime.json'), null);
    if (!config || typeof config.python !== 'string' || !path.isAbsolute(config.python)) throw new HttpError(422, '未配置参数化建模 Python 环境');
    return config.python as string;
  }
  async function command(executable: string, args: string[], cwd: string, abort: AbortController, output: (text: string) => void, timeout = 60 * 60 * 1000) {
    checkOpen(); controllers.add(abort);
    const task = Promise.resolve().then(() => execute(executable, args, { cwd, signal: abort.signal, timeout, output }));
    processes.add(task);
    try {
      const result = await task;
      if (abort.signal.aborted) throw new Error('已取消圆柱建模');
      if (result.timedOut || result.code !== 0) throw new Error(result.timedOut ? '圆柱建模进程超时' : `圆柱建模进程退出码 ${result.code}`);
    } finally { controllers.delete(abort); processes.delete(task); }
  }
  async function jsonCommand(id: string, args: string[]) {
    const python = await runtime(), abort = new AbortController(); let log = '';
    try {
      await command(python, ['-u', path.join(resource, 'objects.py'), ...args], store.workspace(id), abort, text => { log = (log + text).slice(-1_000_000); }, 120000);
      const model = JSON.parse(log) as Model;
      if (!model || typeof model !== 'object' || !Array.isArray(model.components) || model.components.length !== 20) throw new Error('模型必须包含 20 个圆柱对象');
      return model;
    } catch (error) { throw new HttpError(422, `${(error as Error).message}${log ? '\n' + log.slice(-6000) : ''}`); }
  }
  async function read(id: string) {
    await store.project(id);
    let state = active.get(id)?.state ?? await jsonRead<State | null>(await stateFile(id), null);
    const model = await jsonRead<Model | null>(await modelFile(id), null);
    // A job can finish during an awaited disk read. Refresh before diagnosing a restart.
    if (active.has(id)) state = active.get(id)!.state;
    else if (state?.job?.state === 'running') {
      state = await jsonRead<State | null>(await stateFile(id), null);
      if (active.has(id)) state = active.get(id)!.state;
      else if (state?.job?.state === 'running') state = { ...state, job: { ...state.job, state: 'failed', stage: 'interrupted', error: '服务已重启，构建中断；上一次成功发布仍保留' } };
    }
    if (!!state !== !!model || (state && (!Number.isSafeInteger(state.revision) || state.revision < 1 || hash(JSON.stringify(model)) !== state.modelHash))) {
      throw new HttpError(409, '圆柱模型与版本记录不一致，请从项目历史恢复完整版本');
    }
    return { state, model };
  }
  function snapshot(state: State | null, model: Model | null) {
    return { model, revision: state?.revision ?? 0, job: state?.job ?? null, published: state?.published ?? null };
  }
  const expectRevision = (state: State | null, revision: unknown) => {
    if (!state) throw new HttpError(409, '请先创建可编辑圆柱');
    if (!Number.isSafeInteger(revision) || revision !== state.revision) throw new HttpError(409, '圆柱模型已更新，请刷新参数后重试');
  };
  const changed = (id: string) => options.changed?.(id);

  app.get(base, async (q, r) => { const { state, model } = await read(String(q.params.id)); r.json(snapshot(state, model)); });
  app.post(base + '/initialize', async (q, r) => {
    checkOpen(); const id = String(q.params.id); await store.project(id); const release = store.acquire(id);
    try {
      const current = await read(id); if (current.model) throw new HttpError(409, '可编辑圆柱已存在，初始化不会覆盖现有参数');
      const model = await jsonCommand(id, ['default-model']);
      await history.snapshot(id, '创建圆柱对象前');
      const state: State = { revision: 1, modelHash: hash(JSON.stringify(model)), job: null, published: null };
      await jsonWrite(await modelFile(id), model); await persist(id, state); await store.touch(id);
      await history.snapshot(id, '创建 20 个可编辑圆柱对象'); changed(id); r.status(201).json(snapshot(state, model));
    } finally { release(); }
  });
  app.patch(base + '/model', async (q, r) => {
    checkOpen(); const id = String(q.params.id); await store.project(id); const release = store.acquire(id);
    let candidate: string | undefined;
    try {
      const { state, model: previous } = await read(id); expectRevision(state, q.body?.revision);
      if (!q.body?.model || typeof q.body.model !== 'object' || Array.isArray(q.body.model)) throw new HttpError(400, '需要完整圆柱对象模型');
      candidate = await location(id, `.validate-${randomUUID()}.json`); await jsonWrite(candidate, q.body.model);
      const model = await jsonCommand(id, ['validate-model', candidate]);
      if (JSON.stringify(model) === JSON.stringify(previous)) { r.json(snapshot(state, previous)); return; }
      await history.snapshot(id, '修改圆柱对象前');
      const next: State = { ...state!, revision: state!.revision + 1, modelHash: hash(JSON.stringify(model)) };
      await jsonWrite(await modelFile(id), model);
      try { await persist(id, next); } catch (error) { await jsonWrite(await modelFile(id), previous); throw error; }
      await store.touch(id); await history.snapshot(id, '保存圆柱对象参数'); changed(id); r.json(snapshot(next, model));
    } finally { if (candidate) await fs.unlink(candidate).catch(() => {}); release(); }
  });
  app.post(base + '/build', async (q, r) => {
    checkOpen(); const id = String(q.params.id); await store.project(id); const release = store.acquire(id);
    let started = false;
    try {
      const { state, model } = await read(id); expectRevision(state, q.body?.revision);
      const python = await runtime();
      const renderConfig = await jsonRead<any>(path.join(store.root, 'cylinder-runtime.json'), null);
      const blender = renderConfig?.blender;
      if (blender !== undefined && (typeof blender !== 'string' || !path.isAbsolute(blender))) throw new HttpError(422, 'Blender 路径必须为绝对路径');
      const rid = randomUUID();
      const job: Job = { id: rid, state: 'running', revision: state!.revision, stage: 'preparing', log: '', createdAt: new Date().toISOString() };
      const next: State = { ...state!, job };
      const build: Build = { abort: new AbortController(), done: Promise.resolve(), state: next };
      active.set(id, build);
      const append = (text: string) => { job.log = (job.log + text).slice(-64000); };
      const stage = async (value: string) => { build.abort.signal.throwIfAborted(); job.stage = value; await persist(id, next); };
      build.done = (async () => {
        try {
          await persist(id, next);
          await history.snapshot(id, '重建圆柱 CAD 前');
          const output = await location(id, `exports/${rid}`);
          await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(output);
          const input = await location(id, `exports/${rid}/input-model.json`); await jsonWrite(input, model);
          await stage('building'); append(`正在构建圆柱对象 · 版本 ${next.revision}\n`);
          await command(python, ['-u', path.join(resource, 'objects.py'), 'build', input, output], output, build.abort, append);
          await stage('validating');
          const source = await location(id, `exports/${rid}/cylinder.step`, true);
          const preview = await location(id, `exports/${rid}/assembly.step`, true);
          const sourceHash = hash(await fs.readFile(source));
          if (!(await fs.stat(source)).size || !(await fs.stat(preview)).size) throw new Error('CAD 输出为空');
          const manifest = await jsonRead<any>(await location(id, `exports/${rid}/cylinder.bindings.json`, true), null);
          const builtModel = await jsonRead<any>(await location(id, `exports/${rid}/model.json`, true), null);
          if (manifest?.schema_version !== 2 || manifest.source_sha256 !== sourceHash || manifest.equivalence?.approved !== true ||
              JSON.stringify(manifest.geometry_model) !== JSON.stringify(model) || JSON.stringify(builtModel) !== JSON.stringify(model)) throw new Error('CAD、对象参数和边界记录不匹配，产物未发布');
          for (const [key, group] of [['interface.fixed_support', 'bottom'], ['interface.axial_load', 'top'], ['interface.external_pressure', 'skin']]) {
            const binding = manifest.bindings?.[key];
            if (binding?.shell_set !== group || !(binding.face_count > 0) || !(binding.area_mm2 > 0)) throw new Error('CAD 缺少有效仿真边界：' + key);
          }
          if (blender) {
            await stage('rendering'); append('\n正在生成 Blender CAD 渲染…\n');
            await command(blender, ['--background', '--factory-startup', '--python', path.join(resource, 'render_objects.py'), '--', output], output, build.abort, append);
            const render = await jsonRead<any>(await location(id, `exports/${rid}/render-manifest.json`, true), null);
            if (render?.source_sha256 !== sourceHash || render.full !== 'cad-full.png' || render.cutaway !== 'cad-cutaway.png') throw new Error('Blender 图像与本次 CAD 不匹配');
            for (const file of ['cad-full.png', 'cad-cutaway.png']) if (render.image_sha256?.[file] !== hash(await fs.readFile(await location(id, `exports/${rid}/${file}`, true)))) throw new Error('Blender 图像校验失败：' + file);
          } else append('\n未配置 Blender，本次没有新 CAD 渲染；不会复用旧模型图片。\n');
          await stage('publishing');
          if (hash(JSON.stringify(await jsonRead(await modelFile(id), null))) !== next.modelHash || hash(await fs.readFile(source)) !== sourceHash) throw new Error('构建期间模型发生变化，产物未发布');
          await history.snapshot(id, '圆柱 CAD 构建与校验完成');
          build.abort.signal.throwIfAborted();
          const published: Published = { source: `cylinder-objects/exports/${rid}/cylinder.step`, preview: `cylinder-objects/exports/${rid}/assembly.step`, revision: next.revision, manifest, createdAt: new Date().toISOString() };
          // Publish the pointer only after every required output and optional render passes.
          await store.touch(id);
          build.abort.signal.throwIfAborted();
          const complete: State = { ...next, published, job: { ...job, state: 'succeeded', stage: 'complete', finishedAt: new Date().toISOString() } };
          await persist(id, complete); build.state = complete; changed(id);
        } catch (error) {
          job.state = build.abort.signal.aborted ? 'cancelled' : 'failed'; job.stage = job.state; job.error = (error as Error).message; job.finishedAt = new Date().toISOString();
          append('\n' + job.error + '\n');
          try { await persist(id, next); } catch (writeError) { append('无法保存任务状态：' + (writeError as Error).message); }
        } finally { active.delete(id); release(); }
      })();
      started = true;
      r.status(202).json(job);
    } finally { if (!started) release(); }
  });
  app.post(base + '/cancel', async (q, r) => {
    const id = String(q.params.id); await store.project(id);
    const build = active.get(id);
    if (build) { build.abort.abort(); await build.done; }
    const { state, model } = await read(id); r.json(snapshot(state, model));
  });
  return { dispose: async () => {
    disposed = true;
    for (const build of active.values()) build.abort.abort();
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...active.values()].map(build => build.done));
    await Promise.allSettled([...processes]);
  } };
}
