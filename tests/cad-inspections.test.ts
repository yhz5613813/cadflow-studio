import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { Store, jsonWrite } from '../server/storage.js';
import { History } from '../server/history.js';
import { cadInspectionRoutes } from '../server/cad-inspections.js';
import type { CadInspectionJob, CadInspectionResult, CadInspectionSummary } from '../shared/cad-inspections.js';
import type { runProcess } from '../server/process.js';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const summary = (): CadInspectionSummary => ({
  valid_brep: true, solid_count: 1, material_valid: true,
  raw_solid_volume_sum_mm3: 1000, material_volume_mm3: 1000, overlap_volume_mm3: 0,
  surface_area_mm2: 600, surface_area_basis: 'material-union', centroid_mm: [5, 5, 5], bbox_mm: { min: [0, 0, 0], max: [10, 10, 10], size: [10, 10, 10] },
  bodies: [{ id: 'body:1', id_scope: 'source-file', valid: true, closed: true, volume_mm3: 1000, surface_area_mm2: 600, centroid_mm: [5, 5, 5], bbox_mm: { min: [0, 0, 0], max: [10, 10, 10], size: [10, 10, 10] } }], warnings: [],
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'castudio-inspect-'));
  const store = new Store(root); await store.init();
  const project = await store.createProject('Inspection'), other = await store.createProject('Other');
  const history = new History(store);
  await fs.writeFile(path.join(store.workspace(project.id), 'part.step'), 'original source');
  await fs.writeFile(path.join(store.workspace(project.id), 'reference.stp'), 'original baseline');
  await jsonWrite(path.join(root, 'parametric-runtime.json'), { python: process.execPath });
  const behavior = { mode: 'success', calls: 0, entered: false, release: () => {}, snapshotSource: '', snapshotBaseline: '', changed: 0, signal: undefined as AbortSignal | undefined };
  const runner: typeof runProcess = async (executable, args, options) => {
    assert.equal(executable, process.execPath); assert.equal(args[0], '-u'); assert.match(args[1], /cad_inspect\.py$/);
    behavior.calls++; behavior.entered = true; behavior.signal = options.signal;
    const source = args[2], output = args[args.indexOf('--output') + 1], baseline = args.includes('--baseline') ? args[args.indexOf('--baseline') + 1] : undefined;
    behavior.snapshotSource = await fs.readFile(source, 'utf8');
    if (baseline) behavior.snapshotBaseline = await fs.readFile(baseline, 'utf8');
    options.output('Inspecting ' + source + '\n');
    if (['wait', 'pause'].includes(behavior.mode)) await new Promise<void>((resolve, reject) => {
      behavior.release = resolve;
      const stop = () => reject(new Error('aborted ' + output));
      if (options.signal?.aborted) stop(); else options.signal?.addEventListener('abort', stop, { once: true });
    });
    if (behavior.mode === 'fail') return { code: 2, timedOut: false };
    if (behavior.mode === 'timeout') return { code: null, timedOut: true };
    const result: CadInspectionResult = { schema_version: 1, method: 'occt-brep-v1', units: { length: 'mm', area: 'mm2', volume: 'mm3' }, source: { name: 'source.step', sha256: hash(behavior.snapshotSource), input_units: ['millimetre'] }, summary: summary() };
    if (baseline) {
      result.baseline = { name: 'baseline.step', sha256: hash(behavior.snapshotBaseline), input_units: ['millimetre'], summary: summary() };
      result.comparison = { status: 'succeeded', missing_volume_mm3: 20, excess_volume_mm3: 20, volume_delta_mm3: 0, centroid_distance_mm: 0, boolean_valid: true, volume_balance_valid: true, exported_files: { missing_material: 'missing_material.step', excess_material: 'excess_material.step' }, artifact_sha256: { 'missing_material.step': hash('difference A'), 'excess_material.step': hash('difference B') }, warnings: [] };
      await fs.writeFile(path.join(output, 'missing_material.step'), 'difference A'); await fs.writeFile(path.join(output, 'excess_material.step'), 'difference B');
    }
    if (behavior.mode === 'bad-hash') result.source.sha256 = '0'.repeat(64);
    if (behavior.mode === 'snapshot-change') await fs.writeFile(source, 'tampered snapshot');
    if (behavior.mode === 'invalid-material') { result.summary.material_valid = false; result.summary.material_volume_mm3 = null; result.summary.warnings = ['open surface']; }
    if (behavior.mode === 'inconsistent-material') { result.summary.material_valid = false; result.summary.material_volume_mm3 = 1000; }
    if (behavior.mode === 'path-escape') result.comparison!.exported_files.missing_material = '../outside.step';
    if (behavior.mode === 'missing-output') await fs.unlink(path.join(output, 'excess_material.step'));
    if (behavior.mode === 'difference-change') await fs.writeFile(path.join(output, 'excess_material.step'), 'different output');
    await jsonWrite(path.join(output, 'inspection.json'), result);
    return { code: 0, timedOut: false };
  };
  const app = express(); app.use(express.json());
  const manager = cadInspectionRoutes(app, store, history, { process: runner, changed: () => { behavior.changed++; } });
  app.use((error: any, _q: any, r: any, _n: any) => r.status(error.code === 'ENOENT' ? 404 : error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const host = `http://127.0.0.1:${(server.address() as any).port}`, url = host + '/api/projects/' + project.id + '/cad-inspections';
  const request = (suffix = '', method = 'GET', body?: unknown) => fetch(url + suffix, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const start = (extra = {}) => request('', 'POST', { source: { path: 'part.step' }, ...extra });
  const read = async (id: string): Promise<CadInspectionJob> => (await request('/' + id)).json();
  const wait = async (id: string) => {
    for (let i = 0; i < 200; i++) { const job = await read(id); if (!['queued', 'running'].includes(job.state)) return job; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error('Inspection did not finish');
  };
  const entered = async () => { for (let i = 0; i < 200 && !behavior.entered; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(behavior.entered, true); };
  const close = async () => { await manager.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); };
  return { root, store, project, other, history, behavior, manager, request, start, read, wait, entered, close, host };
}

test('CAD inspection freezes current and historical STEP inputs, publishes results and detects later edits', async () => {
  const f = await fixture();
  try {
    const revision = await f.history.snapshot(f.project.id, 'baseline');
    await fs.writeFile(path.join(f.store.workspace(f.project.id), 'reference.stp'), 'edited baseline');
    const response = await f.start({ baseline: { path: 'reference.stp', revision: revision.id }, density_kg_m3: 2700, expected_source_hash: hash('original source') });
    assert.equal(response.status, 202); const started = await response.json();
    const job = await f.wait(started.id);
    assert.equal(job.state, 'succeeded', job.error); assert.equal(job.density_kg_m3, 2700); assert.equal(job.stale, false);
    assert.equal(job.source.sha256, hash('original source')); assert.equal(job.baseline?.sha256, hash('original baseline'));
    assert.equal(f.behavior.snapshotSource, 'original source'); assert.equal(f.behavior.snapshotBaseline, 'original baseline');
    assert.equal(job.outputPath, 'studio/cad-inspections/' + job.id); assert.equal(f.behavior.changed, 1);
    assert.equal(JSON.stringify(job).includes(f.store.workspace(f.project.id)), false);
    assert.equal(await fs.readFile(path.join(f.store.workspace(f.project.id), 'part.step'), 'utf8'), 'original source');
    const listed = await (await f.request()).json(); assert.equal(listed[0].id, job.id); assert.equal(listed[0].result.summary.material_volume_mm3, 1000);
    await fs.writeFile(path.join(f.store.workspace(f.project.id), 'part.step'), 'new model');
    const stale = await f.read(job.id); assert.equal(stale.stale, true); assert.deepEqual(stale.staleInputs, ['source']); assert.deepEqual(stale.result, job.result);
    assert.equal((await f.start({ expected_source_hash: hash('original source') })).status, 409);
    assert.equal(f.behavior.calls, 1);
  } finally { await f.close(); }
});

test('CAD inspection validates paths, extension, density, history ownership and input size before execution', async () => {
  const f = await fixture();
  try {
    for (const source of [{ path: '../part.step' }, { path: 'C:/part.step' }, { path: 'part.stl' }, { path: 'part.step', revision: '../../x' }, { path: '' }, null]) assert.equal((await f.start({ source })).status, 400);
    for (const density of [0, -1, 100001, '2700', null]) assert.equal((await f.start({ density_kg_m3: density })).status, 400);
    assert.equal((await f.start({ expected_source_hash: 'bad' })).status, 400);
    const otherRevision = await f.history.snapshot(f.other.id, 'other');
    assert.equal((await f.start({ source: { path: 'part.step', revision: otherRevision.id } })).status, 404);
    await fs.writeFile(path.join(f.store.workspace(f.project.id), 'empty.step'), '');
    assert.equal((await f.start({ source: { path: 'empty.step' } })).status, 400);
    const large = path.join(f.store.workspace(f.project.id), 'large.step'); await fs.writeFile(large, ''); await fs.truncate(large, 128 * 1024 * 1024 + 1);
    assert.equal((await f.start({ source: { path: 'large.step' } })).status, 413);
    assert.equal(f.behavior.calls, 0); const release = f.store.acquire(f.project.id); release();
  } finally { await f.close(); }
});

test('completed inspections hide results when frozen inputs or difference artifacts change after publication', async () => {
  const f = await fixture();
  try {
    const response = await f.start({ baseline: { path: 'reference.stp' } });
    assert.equal(response.status, 202);
    const started = await response.json(), initial = await f.wait(started.id);
    assert.equal(initial.state, 'succeeded', initial.error);
    const root = path.join(f.store.workspace(f.project.id), initial.outputPath);
    // Editing the live model only makes the intact frozen result historical.
    await fs.writeFile(path.join(f.store.workspace(f.project.id), 'part.step'), 'edited live model');
    const historical = await f.read(initial.id);
    assert.equal(historical.state, 'succeeded'); assert.equal(historical.stale, true); assert.ok(historical.result);
    for (const name of ['source.step', 'baseline.step', 'missing_material.step', 'excess_material.step']) {
      const file = path.join(root, name), original = await fs.readFile(file), before = await fs.stat(file);
      assert.equal((await f.read(initial.id)).state, 'succeeded');
      // Equal size and restored mtime must still invalidate the cached digest through ctime.
      const changed = Buffer.from(original); changed[0] ^= 1;
      await fs.writeFile(file, changed); await fs.utimes(file, before.atime, before.mtime);
      const invalid = await f.read(initial.id);
      assert.equal(invalid.state, 'failed', name); assert.equal(invalid.result, undefined, name);
      assert.match(invalid.error!, /完整性校验失败/); assert.equal(invalid.stale, true);
      const listed: CadInspectionJob[] = await (await f.request()).json();
      assert.equal(listed[0].state, 'failed'); assert.equal(listed[0].result, undefined);
      await fs.writeFile(file, original);
      const restored = await f.read(initial.id);
      assert.equal(restored.state, 'succeeded', restored.error); assert.ok(restored.result); assert.equal(restored.stale, true);
      await fs.unlink(file);
      const missing = await f.read(initial.id);
      assert.equal(missing.state, 'failed', name); assert.equal(missing.result, undefined); assert.match(missing.error!, /完整性校验失败/);
      await fs.writeFile(file, original);
    }
    const persisted = JSON.parse(await fs.readFile(path.join(root, 'job.json'), 'utf8'));
    assert.equal(persisted.state, 'succeeded'); assert.ok(persisted.result);
    assert.equal(await fs.readFile(path.join(f.store.workspace(f.project.id), 'part.step'), 'utf8'), 'edited live model');
    assert.equal(f.behavior.calls, 1); assert.equal(f.behavior.changed, 1);
  } finally { await f.close(); }
});

test('viewport sha256-prefixed source identities are accepted but stored and checked as bare digests', async () => {
  const f = await fixture();
  try {
    const digest = hash('original source');
    const response = await f.start({ expected_source_hash: 'sha256:' + digest });
    assert.equal(response.status, 202); const job = await f.wait((await response.json()).id);
    assert.equal(job.state, 'succeeded', job.error); assert.equal(job.source.sha256, digest); assert.equal(job.result?.source.sha256, digest);
    for (const invalid of ['sha256:bad', 'sha256:sha256:' + digest, 'SHA256:' + digest, 'sha256:' + digest + '0', 'sha256:' + 'g'.repeat(64)]) {
      assert.equal((await f.start({ expected_source_hash: invalid })).status, 400, invalid);
    }
    assert.equal((await f.start({ expected_source_hash: 'sha256:' + '0'.repeat(64) })).status, 409);
    assert.equal(f.behavior.calls, 1);
  } finally { await f.close(); }
});

test('CAD inspections reject concurrent mutation; cancellation and shutdown terminate work and release locks', async () => {
  const f = await fixture();
  try {
    f.behavior.mode = 'wait'; const job = await (await f.start()).json(); await f.entered();
    assert.equal((await f.start()).status, 409); assert.throws(() => f.store.acquire(f.project.id), /项目正在修改/);
    const cancelled = await (await f.request('/' + job.id + '/cancel', 'POST', {})).json();
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.result, undefined); let release = f.store.acquire(f.project.id); release();
    f.behavior.entered = false; const second = await (await f.start()).json(); await f.entered(); await f.manager.dispose();
    assert.equal((await f.read(second.id)).state, 'cancelled'); release = f.store.acquire(f.project.id); release();
    assert.equal((await f.start()).status, 503);
  } finally { await f.close(); }
});

test('kernel failures, source mismatch and unsafe difference outputs never publish a result', async () => {
  const f = await fixture();
  try {
    for (const mode of ['fail', 'timeout', 'bad-hash', 'snapshot-change', 'inconsistent-material', 'path-escape', 'missing-output', 'difference-change']) {
      f.behavior.mode = mode;
      const job = await (await f.start({ baseline: { path: 'reference.stp' } })).json(); const result = await f.wait(job.id);
      assert.equal(result.state, 'failed', mode); assert.equal(result.result, undefined, mode); assert.ok(result.error);
      assert.equal(JSON.stringify(result).includes(f.store.workspace(f.project.id)), false);
      const release = f.store.acquire(f.project.id); release();
    }
    assert.equal(f.behavior.changed, 0);
    f.behavior.mode = 'invalid-material'; const invalid = await f.wait((await (await f.start()).json()).id);
    assert.equal(invalid.state, 'succeeded'); assert.equal(invalid.result?.summary.material_valid, false); assert.equal(invalid.result?.summary.material_volume_mm3, null);
  } finally { await f.close(); }
});

test('external edits during calculation mark a frozen result stale without replacing source geometry', async () => {
  const f = await fixture();
  try {
    f.behavior.mode = 'pause'; const started = await (await f.start()).json(); await f.entered();
    await fs.writeFile(path.join(f.store.workspace(f.project.id), 'part.step'), 'external edit');
    f.behavior.release(); const job = await f.wait(started.id);
    assert.equal(job.state, 'succeeded'); assert.equal(job.stale, true); assert.deepEqual(job.staleInputs, ['source']); assert.equal(job.source.sha256, hash('original source'));
    assert.equal(await fs.readFile(path.join(f.store.workspace(f.project.id), 'part.step'), 'utf8'), 'external edit');
  } finally { await f.close(); }
});

test('cancellation during final persistence cannot publish a successful result or retain the project lock', async () => {
  const f = await fixture(); let releaseTouch!: () => void;
  try {
    let touchEntered!: () => void;
    const entering = new Promise<void>(resolve => { touchEntered = resolve; });
    const holding = new Promise<void>(resolve => { releaseTouch = resolve; });
    f.store.touch = async () => { touchEntered(); await holding; };
    const started = await (await f.start()).json(); await entering;
    assert.equal((await f.read(started.id)).state, 'running');
    const cancelling = f.request('/' + started.id + '/cancel', 'POST', {});
    for (let i = 0; i < 200 && !f.behavior.signal?.aborted; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.behavior.signal?.aborted, true); releaseTouch();
    const cancelled = await (await cancelling).json();
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.result, undefined);
    assert.equal(f.behavior.changed, 0); const release = f.store.acquire(f.project.id); release();
  } finally { releaseTouch?.(); await f.close(); }
});

test('restart marks orphaned tasks interrupted, and source or output symlinks cannot escape the workspace', async () => {
  const f = await fixture();
  try {
    const run = randomUUID(), relative = 'studio/cad-inspections/' + run;
    const orphan: CadInspectionJob = { id: run, state: 'running', createdAt: new Date().toISOString(), outputPath: relative, source: { path: 'part.step', sha256: hash('original source') }, log: '' };
    await jsonWrite(path.join(f.store.workspace(f.project.id), relative, 'job.json'), orphan);
    const recovered = await f.read(run); assert.equal(recovered.state, 'failed'); assert.match(recovered.error!, /重启.*中断/); assert.ok(recovered.finishedAt);
    const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'part.step'), 'outside private');
    const junction = path.join(f.store.workspace(f.project.id), 'external'); await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await f.start({ source: { path: 'external/part.step' } })).status, 403); await fs.unlink(junction);
    const otherStudio = path.join(f.store.workspace(f.other.id), 'studio'); await fs.symlink(outside, otherStudio, process.platform === 'win32' ? 'junction' : 'dir');
    const response = await fetch(f.host + '/api/projects/' + f.other.id + '/cad-inspections'); assert.equal(response.status, 403);
    await fs.unlink(otherStudio); assert.deepEqual(await fs.readdir(outside), ['part.step']);
  } finally { await f.close(); }
});

test('missing runtime releases the project, and list results are newest first with a 50 record cap', async () => {
  const f = await fixture();
  try {
    await fs.unlink(path.join(f.root, 'parametric-runtime.json')); assert.equal((await f.start()).status, 422);
    const release = f.store.acquire(f.project.id); release();
    await fs.mkdir(path.join(f.store.workspace(f.project.id), 'studio/cad-inspections', randomUUID()), { recursive: true });
    for (let i = 0; i < 51; i++) {
      const run = randomUUID(), outputPath = 'studio/cad-inspections/' + run;
      await jsonWrite(path.join(f.store.workspace(f.project.id), outputPath, 'job.json'), { id: run, state: 'failed', createdAt: new Date(1700000000000 + i * 1000).toISOString(), outputPath, source: { path: 'part.step', sha256: hash('original source') }, log: '' });
    }
    const list = await (await f.request()).json(); assert.equal(list.length, 50); assert.ok(list[0].createdAt > list[49].createdAt);
  } finally { await f.close(); }
});
