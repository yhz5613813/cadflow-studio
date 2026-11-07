import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Express } from 'express';
import type { CadInspectionJob, CadInspectionResult, CadInspectionSource } from '../shared/cad-inspections.js';
import { History } from './history.js';
import { HttpError, jsonRead, jsonWrite, safePath, Store } from './storage.js';
import { runProcess } from './process.js';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../resources/parametric/cad_inspect.py');
const maxBytes = 128 * 1024 * 1024;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const pending = (job: CadInspectionJob) => ['queued', 'running'].includes(job.state);
type Options = { process?: typeof runProcess; changed?: (id: string) => void };
type Active = { job: CadInspectionJob; abort: AbortController; done: Promise<void> };

function reference(value: unknown): CadInspectionSource {
  const ref = value as CadInspectionSource | null;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || typeof ref.path !== 'string' || ref.path.length > 2000) throw new HttpError(400, '需要 STEP 文件引用');
  const relative = ref.path.replace(/\\/g, '/');
  if (!relative || relative.includes('\0') || relative.startsWith('/') || /^[a-z]:/i.test(relative) || /(^|\/)\.\.?($|\/)/.test(relative) || !/\.(step|stp)$/i.test(relative)) throw new HttpError(400, '仅支持项目内的 STEP/STP 文件');
  if (ref.revision !== undefined && (typeof ref.revision !== 'string' || !uuid.test(ref.revision))) throw new HttpError(400, '无效历史版本编号');
  return { path: relative, ...(ref.revision ? { revision: ref.revision } : {}) };
}

function checkedResult(raw: unknown, source: string, baseline?: string): CadInspectionResult {
  const value = raw as any;
  const fail = () => { throw new Error('CAD 检查输出格式或来源校验失败'); };
  const number = (v: unknown, positive = false) => v === null || (typeof v === 'number' && Number.isFinite(v) && (!positive || v >= 0));
  const vector = (v: any) => v === null || (Array.isArray(v) && v.length === 3 && v.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)));
  const box = (v: any) => v === null || (v && vector(v.min) && v.min !== null && vector(v.max) && v.max !== null && vector(v.size) && v.size !== null && v.size.every((n: number) => n >= 0));
  const warnings = (v: unknown) => Array.isArray(v) && v.every(t => typeof t === 'string');
  const summary = (v: any) => {
    if (!v || typeof v.valid_brep !== 'boolean' || typeof v.material_valid !== 'boolean' || !Number.isSafeInteger(v.solid_count) || v.solid_count < 0 || !Array.isArray(v.bodies) || !warnings(v.warnings) || !['input-brep', 'material-union'].includes(v.surface_area_basis)) return false;
    if (!['raw_solid_volume_sum_mm3', 'material_volume_mm3', 'overlap_volume_mm3', 'surface_area_mm2'].every(k => number(v[k], true)) || !vector(v.centroid_mm) || !box(v.bbox_mm)) return false;
    if (v.material_valid && (!v.valid_brep || !(v.material_volume_mm3 > 0) || v.centroid_mm === null)) return false;
    if (!v.material_valid && v.material_volume_mm3 !== null) return false;
    return v.bodies.every((b: any) => b && /^body:\d+$/.test(b.id) && b.id_scope === 'source-file' && typeof b.valid === 'boolean' && typeof b.closed === 'boolean' && number(b.volume_mm3, true) && number(b.surface_area_mm2, true) && vector(b.centroid_mm) && box(b.bbox_mm));
  };
  const input = (v: any, expected: string) => v && v.sha256 === expected && typeof v.name === 'string' && path.basename(v.name) === v.name && !/[\\/]/.test(v.name) && Array.isArray(v.input_units) && v.input_units.every((unit: unknown) => typeof unit === 'string');
  if (!value || value.schema_version !== 1 || value.method !== 'occt-brep-v1' || value.units?.length !== 'mm' || value.units?.area !== 'mm2' || value.units?.volume !== 'mm3' || !input(value.source, source) || !summary(value.summary)) fail();
  if (baseline) {
    const c = value.comparison;
    if (!input(value.baseline, baseline) || !summary(value.baseline.summary) || !c || !['succeeded', 'unavailable', 'failed'].includes(c.status) || typeof c.boolean_valid !== 'boolean' || typeof c.volume_balance_valid !== 'boolean' || !warnings(c.warnings)) fail();
    if (!number(c.missing_volume_mm3, true) || !number(c.excess_volume_mm3, true) || !number(c.volume_delta_mm3) || !number(c.centroid_distance_mm, true)) fail();
    if (!c.exported_files || typeof c.exported_files !== 'object' || Array.isArray(c.exported_files)) fail();
    for (const [key, file] of Object.entries(c.exported_files)) if (!['missing_material', 'excess_material'].includes(key) || file !== key + '.step') fail();
    if (!c.artifact_sha256 || typeof c.artifact_sha256 !== 'object' || Array.isArray(c.artifact_sha256) || Object.keys(c.artifact_sha256).length !== Object.keys(c.exported_files).length) fail();
    for (const file of Object.values(c.exported_files) as string[]) if (!isHash(c.artifact_sha256[file])) fail();
    if (c.status === 'succeeded' && (!c.boolean_valid || !c.volume_balance_valid || c.missing_volume_mm3 === null || c.excess_volume_mm3 === null)) fail();
  } else if (value.baseline !== undefined || value.comparison !== undefined) fail();
  return value as CadInspectionResult;
}

export function cadInspectionRoutes(app: Express, store: Store, history: History, options: Options = {}) {
  const execute = options.process ?? runProcess;
  const active = new Map<string, Active>();
  const starts = new Set<{ abort: AbortController; done: Promise<void> }>();
  const artifactHashes = new Map<string, { signature: string; hash: string }>();
  const base = '/api/projects/:id/cad-inspections';
  let disposed = false;
  const checkOpen = () => { if (disposed) throw new HttpError(503, 'CAD 检查服务正在关闭'); };
  const key = (project: string, run: string) => project + '/' + run;
  const relativeOutput = (run: string) => 'studio/cad-inspections/' + run;
  const location = async (project: string, run: string, file = '', exists = true) => {
    if (!uuid.test(run)) throw new HttpError(400, '无效检查编号');
    return safePath(store.workspace(project), relativeOutput(run) + (file ? '/' + file : ''), exists);
  };
  const sanitize = (project: string, output: string, text: string) => {
    let clean = text;
    for (const prefix of [output, store.workspace(project)]) for (const form of [path.toNamespacedPath(prefix), prefix, prefix.replace(/\\/g, '/')]) clean = clean.split(form).join('[project]');
    return clean;
  };
  async function input(project: string, ref: CadInspectionSource): Promise<Buffer> {
    let bytes: Buffer;
    if (ref.revision) bytes = await history.file(project, ref.revision, ref.path);
    else {
      const file = await safePath(store.workspace(project), ref.path);
      const before = await fs.stat(file);
      if (!before.isFile()) throw new HttpError(400, 'STEP 来源必须是普通文件');
      if (before.size > maxBytes) throw new HttpError(413, 'STEP 文件不能超过 128 MB');
      bytes = await fs.readFile(file);
      const after = await fs.stat(file);
      if (before.size !== bytes.length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new HttpError(409, 'STEP 文件在读取期间发生变化，请重试');
    }
    if (!bytes.length) throw new HttpError(400, 'STEP 文件为空');
    if (bytes.length > maxBytes) throw new HttpError(413, 'STEP 文件不能超过 128 MB');
    return bytes;
  }
  async function freshness(project: string, job: CadInspectionJob, cache = new Map<string, Promise<string | null>>()) {
    const staleInputs: Array<'source' | 'baseline'> = [];
    for (const name of ['source', 'baseline'] as const) {
      const ref = job[name]; if (!ref) continue;
      const cacheKey = JSON.stringify([ref.path, ref.revision]);
      let current = cache.get(cacheKey);
      if (!current) { current = input(project, ref).then(sha).catch(() => null); cache.set(cacheKey, current); }
      if (await current !== ref.sha256) staleInputs.push(name);
    }
    return { ...job, stale: staleInputs.length > 0, staleInputs };
  }
  async function frozenHash(project: string, run: string, name: string) {
    const file = await location(project, run, name);
    const signature = (stat: Awaited<ReturnType<typeof fs.stat>>) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs].join(':');
    const before = await fs.stat(file);
    if (!before.isFile() || !before.size || before.size > maxBytes) throw new Error('无效检查文件');
    const stamp = signature(before), cached = artifactHashes.get(file);
    if (cached?.signature === stamp) return cached.hash;
    const bytes = await fs.readFile(file), after = await fs.stat(file);
    if (!after.isFile() || bytes.length !== before.size || signature(after) !== stamp) throw new Error('检查文件在校验期间发生变化');
    const hash = sha(bytes);
    artifactHashes.set(file, { signature: stamp, hash });
    if (artifactHashes.size > 512) artifactHashes.delete(artifactHashes.keys().next().value!);
    return hash;
  }
  async function verified(project: string, job: CadInspectionJob): Promise<CadInspectionJob> {
    if (job.state !== 'succeeded') return job;
    try {
      const result = checkedResult(job.result, job.source.sha256, job.baseline?.sha256);
      const files = [{ name: 'source.step', hash: job.source.sha256 }, ...(job.baseline ? [{ name: 'baseline.step', hash: job.baseline.sha256 }] : [])];
      for (const name of Object.values(result.comparison?.exported_files ?? {})) files.push({ name, hash: result.comparison!.artifact_sha256[name] });
      for (const file of files) if (await frozenHash(project, job.id, file.name) !== file.hash) throw new Error('检查文件摘要不匹配');
      return job;
    } catch {
      const invalid: CadInspectionJob = { ...job, state: 'failed', error: '检查文件完整性校验失败：冻结输入或材料差异文件缺失、发生变化或与记录不符。请重新运行检查。' };
      delete invalid.result;
      return invalid;
    }
  }
  async function persisted(project: string, run: string): Promise<CadInspectionJob> {
    const file = await location(project, run, 'job.json');
    const job = await jsonRead<CadInspectionJob | null>(file, null);
    if (!job) throw new HttpError(404, '检查记录不存在');
    if (job.id !== run || job.outputPath !== relativeOutput(run) || !isHash(job.source?.sha256) || (job.baseline && !isHash(job.baseline.sha256))) throw new HttpError(409, '检查记录损坏');
    reference(job.source); if (job.baseline) reference(job.baseline);
    return job;
  }
  async function read(project: string, run: string, cache?: Map<string, Promise<string | null>>) {
    await store.project(project);
    let job = active.get(key(project, run))?.job ?? await persisted(project, run);
    if (pending(job) && !active.has(key(project, run))) {
      job = active.get(key(project, run))?.job ?? await persisted(project, run);
      if (pending(job) && !active.has(key(project, run))) {
        job = { ...job, state: 'failed', finishedAt: new Date().toISOString(), error: '服务已重启，CAD 检查中断；请重新运行检查' };
        delete job.result;
        await jsonWrite(await location(project, run, 'job.json'), job);
      }
    }
    return freshness(project, await verified(project, job), cache);
  }

  app.get(base, async (q, r) => {
    const project = String(q.params.id); await store.project(project);
    const root = await safePath(store.workspace(project), 'studio/cad-inspections', false);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const records: CadInspectionJob[] = [], cache = new Map<string, Promise<string | null>>();
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && uuid.test(entry.name)) {
      try { records.push(active.get(key(project, entry.name))?.job ?? await persisted(project, entry.name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const result: CadInspectionJob[] = [];
    for (const job of records.slice(0, 50)) result.push(await read(project, job.id, cache));
    r.json(result);
  });
  app.get(base + '/:run', async (q, r) => r.json(await read(String(q.params.id), String(q.params.run))));
  app.post(base, async (q, r) => {
    checkOpen(); const project = String(q.params.id); await store.project(project);
    const source = reference(q.body?.source), baseline = q.body?.baseline === undefined ? undefined : reference(q.body.baseline);
    const density = q.body?.density_kg_m3, suppliedHash = q.body?.expected_source_hash;
    const expected = typeof suppliedHash === 'string' && /^sha256:[a-f0-9]{64}$/.test(suppliedHash) ? suppliedHash.slice(7) : suppliedHash;
    if (density !== undefined && (typeof density !== 'number' || !Number.isFinite(density) || density <= 0 || density > 100000)) throw new HttpError(400, '密度必须为 0–100000 kg/m³ 之间的正数');
    if (expected !== undefined && !isHash(expected)) throw new HttpError(400, '无效源文件摘要');
    const release = store.acquire(project), abort = new AbortController();
    let done!: () => void; const preparation = { abort, done: new Promise<void>(resolve => { done = resolve; }) };
    starts.add(preparation); let launched = false;
    try {
      const runtime = await jsonRead<{ python?: string } | null>(path.join(store.root, 'parametric-runtime.json'), null);
      if (!runtime || typeof runtime.python !== 'string' || !path.isAbsolute(runtime.python)) throw new HttpError(422, '未配置参数化建模 Python 环境');
      const sourceBytes = await input(project, source), baselineBytes = baseline ? await input(project, baseline) : undefined;
      abort.signal.throwIfAborted(); checkOpen();
      const sourceHash = sha(sourceBytes), baselineHash = baselineBytes ? sha(baselineBytes) : undefined;
      if (expected !== undefined && expected !== sourceHash) throw new HttpError(409, 'STEP 模型已更新，请刷新后重新检查');
      const run = randomUUID(), output = await location(project, run, '', false);
      await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 }); await fs.mkdir(output, { mode: 0o700 });
      const sourceFile = await location(project, run, 'source.step', false);
      await fs.writeFile(sourceFile, sourceBytes, { flag: 'wx', mode: 0o600 });
      let baselineFile: string | undefined;
      if (baselineBytes) { baselineFile = await location(project, run, 'baseline.step', false); await fs.writeFile(baselineFile, baselineBytes, { flag: 'wx', mode: 0o600 }); }
      const job: CadInspectionJob = { id: run, state: 'queued', createdAt: new Date().toISOString(), source: { ...source, sha256: sourceHash }, ...(baseline && baselineHash ? { baseline: { ...baseline, sha256: baselineHash } } : {}), outputPath: relativeOutput(run), ...(density !== undefined ? { density_kg_m3: density } : {}), log: '' };
      const save = (value = job) => jsonWrite(path.join(output, 'job.json'), value);
      await save(); abort.signal.throwIfAborted(); checkOpen();
      const task: Active = { job, abort, done: Promise.resolve() };
      active.set(key(project, run), task);
      task.done = (async () => {
        const append = (text: string) => { job.log = (job.log + sanitize(project, output, text)).slice(-64000); };
        try {
          abort.signal.throwIfAborted(); job.state = 'running'; await save();
          const args = ['-u', script, sourceFile, '--output', output, ...(baselineFile ? ['--baseline', baselineFile] : [])];
          const result = await execute(runtime.python!, args, { cwd: output, signal: abort.signal, timeout: 30 * 60 * 1000, output: append });
          abort.signal.throwIfAborted();
          if (result.timedOut || result.code !== 0) throw new Error(result.timedOut ? 'CAD 检查超时' : `CAD 检查进程退出码 ${result.code}`);
          if (sha(await fs.readFile(sourceFile)) !== sourceHash || (baselineFile && sha(await fs.readFile(baselineFile)) !== baselineHash)) throw new Error('检查输入快照发生变化，结果未发布');
          const report = await location(project, run, 'inspection.json');
          if ((await fs.stat(report)).size > 16 * 1024 * 1024) throw new Error('检查结果超过 16 MB');
          const inspected = checkedResult(await jsonRead(report, null), sourceHash, baselineHash);
          for (const file of Object.values(inspected.comparison?.exported_files ?? {})) {
            const artifact = await location(project, run, file);
            const stat = await fs.stat(artifact);
            if (!stat.isFile() || !stat.size || stat.size > maxBytes) throw new Error('几何差异 STEP 输出无效');
            if (sha(await fs.readFile(artifact)) !== inspected.comparison!.artifact_sha256[file]) throw new Error('几何差异 STEP 摘要不匹配，结果未发布');
          }
          const refreshed = await freshness(project, job); abort.signal.throwIfAborted();
          const complete: CadInspectionJob = { ...job, result: inspected, stale: refreshed.stale, staleInputs: refreshed.staleInputs, state: 'succeeded', finishedAt: new Date().toISOString() };
          await save(complete); await store.touch(project); abort.signal.throwIfAborted();
          Object.assign(job, complete); options.changed?.(project);
        } catch (error) {
          const failure: CadInspectionJob = { ...job, state: abort.signal.aborted ? 'cancelled' : 'failed', finishedAt: new Date().toISOString(), error: sanitize(project, output, abort.signal.aborted ? '已取消 CAD 检查' : (error as Error).message) };
          delete failure.result;
          append('\n' + failure.error + '\n'); failure.log = job.log;
          await save(failure).catch(error => append('无法保存检查状态：' + (error as Error).message));
          Object.assign(job, failure); delete job.result;
        } finally { active.delete(key(project, run)); release(); }
      })();
      launched = true; r.status(202).json(job);
    } finally { starts.delete(preparation); done(); if (!launched) release(); }
  });
  app.post(base + '/:run/cancel', async (q, r) => {
    const project = String(q.params.id), run = String(q.params.run); await store.project(project);
    const task = active.get(key(project, run));
    if (task) { task.abort.abort(); await task.done; }
    r.json(await read(project, run));
  });
  return { dispose: async () => {
    disposed = true;
    for (const start of starts) start.abort.abort();
    for (const task of active.values()) task.abort.abort();
    await Promise.allSettled([...starts].map(start => start.done));
    await Promise.allSettled([...active.values()].map(task => task.done));
  } };
}
