import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import { Store, jsonWrite } from '../server/storage.js';
import { History } from '../server/history.js';
import { cylinderObjectsRoutes } from '../server/cylinder-objects.js';
import type { runProcess } from '../server/process.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const model = () => ({ schema_version: 1, units: 'mm', diameter_mm: 1000, height_mm: 500, components: [
  { id: 'skin', kind: 'skin', thickness_mm: 2.5 },
  ...['bottom', 'top'].map(end => ({ id: 'frame.' + end, kind: 'flange', end, thickness_mm: 12 })),
  ...Array.from({ length: 12 }, (_, i) => ({ id: `longitudinal.${String(i + 1).padStart(3, '0')}`, kind: 'longitudinal', width_mm: 8, height_mm: 12 })),
  ...Array.from({ length: 5 }, (_, i) => ({ id: `ring.${String(i + 1).padStart(3, '0')}`, kind: 'ring', width_mm: 8, height_mm: 12 })),
] });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'castudio-cylinder-api-'));
  const store = new Store(root); await store.init();
  const project = await store.createProject('cylinder'), other = await store.createProject('other');
  await jsonWrite(path.join(root, 'parametric-runtime.json'), { python: process.execPath });
  const behavior = { build: 'success' as 'success' | 'wait' | 'fail' | 'bad-hash', render: 'success' as 'success' | 'fail' | 'bad-hash', entered: false };
  const processRunner: typeof runProcess = async (_executable, args, options) => {
    if (args[0] === '--background') {
      const output = args.at(-1)!;
      if (behavior.render === 'fail') return { code: 1, timedOut: false };
      const sourceHash = digest(await fs.readFile(path.join(output, 'cylinder.step'))), imageHash: Record<string, string> = {};
      for (const file of ['cad-full.png', 'cad-cutaway.png']) { await fs.writeFile(path.join(output, file), 'new CAD image'); imageHash[file] = digest('new CAD image'); }
      if (behavior.render === 'bad-hash') imageHash['cad-full.png'] = 'stale';
      await jsonWrite(path.join(output, 'render-manifest.json'), { source_sha256: sourceHash, full: 'cad-full.png', cutaway: 'cad-cutaway.png', image_sha256: imageHash });
      return { code: 0, timedOut: false };
    }
    if (args[2] === 'default-model') { options.output(JSON.stringify(model())); return { code: 0, timedOut: false }; }
    if (args[2] === 'validate-model') {
      const candidate = JSON.parse(await fs.readFile(args[3], 'utf8'));
      if (candidate.components[0].thickness_mm <= 0) { options.output('Invalid geometry parameter: thickness_mm'); return { code: 1, timedOut: false }; }
      options.output(JSON.stringify(candidate)); return { code: 0, timedOut: false };
    }
    assert.equal(args[2], 'build'); behavior.entered = true; options.output('building components\n');
    if (behavior.build === 'wait') await new Promise<void>((_ok, reject) => {
      const stop = () => reject(new Error('process aborted'));
      if (options.signal?.aborted) stop(); else options.signal?.addEventListener('abort', stop, { once: true });
    });
    if (behavior.build === 'fail') return { code: 7, timedOut: false };
    const input = JSON.parse(await fs.readFile(args[3], 'utf8')), output = args[4];
    const source = 'verified solid ' + JSON.stringify(input);
    await fs.writeFile(path.join(output, 'cylinder.step'), source);
    await fs.writeFile(path.join(output, 'assembly.step'), '20 named components');
    await jsonWrite(path.join(output, 'model.json'), input);
    await jsonWrite(path.join(output, 'cylinder.bindings.json'), {
      schema_version: 2, source_sha256: behavior.build === 'bad-hash' ? 'stale' : digest(source), geometry_model: input, equivalence: { approved: true },
      bindings: { 'interface.fixed_support': { shell_set: 'bottom', face_count: 1, area_mm2: 100 }, 'interface.axial_load': { shell_set: 'top', face_count: 1, area_mm2: 100 }, 'interface.external_pressure': { shell_set: 'skin', face_count: 1, area_mm2: 100 } },
    });
    return { code: 0, timedOut: false };
  };
  const app = express(); app.use(express.json());
  const manager = cylinderObjectsRoutes(app, store, new History(store), { process: processRunner });
  app.use((error: any, _q: any, r: any, _n: any) => r.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(ok => server.once('listening', ok));
  const host = `http://127.0.0.1:${(server.address() as any).port}`;
  const url = `${host}/api/projects/${project.id}/cylinder-objects`;
  const request = (suffix = '', method = 'GET', body?: unknown) => fetch(url + suffix, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const read = async () => (await request()).json();
  const wait = async () => {
    for (let n = 0; n < 100; n++) { const current = await read(); if (current.job?.state !== 'running') return current; await new Promise(ok => setTimeout(ok, 10)); }
    throw new Error('Job did not finish');
  };
  const close = async () => { await manager.dispose(); await new Promise<void>(ok => server.close(() => ok())); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); };
  return { root, store, project, other, behavior, manager, host, request, read, wait, close };
}

test('cylinder API initializes once, validates edits, and rejects stale revisions atomically', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.read(), { model: null, revision: 0, job: null, published: null });
    assert.equal((await f.request('/initialize', 'POST', {})).status, 201);
    const initial = await f.read(); assert.equal(initial.model.components.length, 20); assert.equal(initial.revision, 1);
    assert.equal((await f.request('/initialize', 'POST', {})).status, 409);
    const invalid = structuredClone(initial.model); invalid.components[0].thickness_mm = -2;
    const rejected = await f.request('/model', 'PATCH', { revision: 1, model: invalid }); assert.equal(rejected.status, 422); assert.match((await rejected.json()).error, /thickness_mm/);
    assert.deepEqual(await f.read(), initial);
    const edited = structuredClone(initial.model); edited.components[0].thickness_mm = 3;
    assert.equal((await f.request('/model', 'PATCH', { revision: 0, model: edited })).status, 409);
    assert.equal((await f.request('/model', 'PATCH', { revision: 1, model: edited })).status, 200);
    const saved = await f.read(); assert.equal(saved.revision, 2); assert.equal(saved.model.components[0].thickness_mm, 3);
    assert.equal((await f.request('/model', 'PATCH', { revision: 1, model: initial.model })).status, 409);
    assert.deepEqual(await f.read(), saved);
    assert.deepEqual(saved.model.components.map((p: any) => p.id), initial.model.components.map((p: any) => p.id));
    const other = await fetch(`${f.host}/api/projects/${f.other.id}/cylinder-objects`); assert.equal((await other.json()).model, null);
    assert.equal((await fetch(`${f.host}/api/projects/missing/cylinder-objects`)).status, 404);
  } finally { await f.close(); }
});

test('successful builds publish immutable revision-bound CAD; stale saves retain the prior publication', async () => {
  const f = await fixture();
  try {
    await f.request('/initialize', 'POST', {});
    assert.equal((await f.request('/build', 'POST', { revision: 0 })).status, 409);
    assert.equal((await f.request('/build', 'POST', { revision: 1 })).status, 202);
    const built = await f.wait(); assert.equal(built.job.state, 'succeeded'); assert.equal(built.published.revision, 1);
    assert.match(built.job.log, /没有新 CAD 渲染/); assert.match(built.published.preview, /assembly\.step$/);
    const original = await fs.readFile(path.join(f.store.workspace(f.project.id), built.published.source));
    const next = structuredClone(built.model); next.components[0].thickness_mm = 3;
    await f.request('/model', 'PATCH', { revision: 1, model: next });
    const saved = await f.read(); assert.equal(saved.revision, 2); assert.deepEqual(saved.published, built.published);
    assert.equal((await f.request('/build', 'POST', { revision: 2 })).status, 202); const rebuilt = await f.wait();
    assert.equal(rebuilt.job.state, 'succeeded', JSON.stringify(rebuilt.job));
    assert.equal(rebuilt.published.revision, 2); assert.notEqual(rebuilt.published.source, built.published.source);
    assert.deepEqual(await fs.readFile(path.join(f.store.workspace(f.project.id), built.published.source)), original);
    const release = f.store.acquire(f.project.id); release();
  } finally { await f.close(); }
});

test('failed CAD verification and failed rendering never replace the successful publication', async () => {
  const f = await fixture();
  try {
    await f.request('/initialize', 'POST', {}); await f.request('/build', 'POST', { revision: 1 });
    const good = await f.wait(); assert.equal(good.job.state, 'succeeded');
    for (const failure of ['fail', 'bad-hash'] as const) {
      f.behavior.build = failure; await f.request('/build', 'POST', { revision: 1 });
      const failed = await f.wait(); assert.equal(failed.job.state, 'failed'); assert.deepEqual(failed.published, good.published);
    }
    f.behavior.build = 'success'; await jsonWrite(path.join(f.root, 'cylinder-runtime.json'), { blender: process.execPath });
    for (const failure of ['fail', 'bad-hash'] as const) {
      f.behavior.render = failure; await f.request('/build', 'POST', { revision: 1 });
      const failed = await f.wait(); assert.equal(failed.job.state, 'failed'); assert.deepEqual(failed.published, good.published);
    }
    f.behavior.render = 'success'; await f.request('/build', 'POST', { revision: 1 });
    const rendered = await f.wait(); assert.equal(rendered.job.state, 'succeeded', JSON.stringify(rendered.job)); assert.match(rendered.job.log, /Blender CAD/);
  } finally { await f.close(); }
});

test('running builds reject saves and duplicate starts; cancellation terminates the process and unlocks the project', async () => {
  const f = await fixture();
  try {
    await f.request('/initialize', 'POST', {}); f.behavior.build = 'wait';
    await f.request('/build', 'POST', { revision: 1 });
    for (let n = 0; n < 100 && !f.behavior.entered; n++) await new Promise(ok => setTimeout(ok, 10));
    assert.equal(f.behavior.entered, true); assert.equal((await f.read()).job.state, 'running');
    assert.equal((await f.request('/build', 'POST', { revision: 1 })).status, 409);
    assert.equal((await f.request('/model', 'PATCH', { revision: 1, model: model() })).status, 409);
    assert.throws(() => f.store.acquire(f.project.id), /项目正在修改/);
    const cancelled = await (await f.request('/cancel', 'POST', {})).json(); assert.equal(cancelled.job.state, 'cancelled'); assert.equal(cancelled.published, null);
    const release = f.store.acquire(f.project.id); release();
    f.behavior.build = 'success'; await f.request('/build', 'POST', { revision: 1 }); assert.equal((await f.wait()).job.state, 'succeeded');
  } finally { await f.close(); }
});

test('shutdown aborts active builds and missing runtime releases all project locks', async () => {
  const f = await fixture();
  try {
    await fs.unlink(path.join(f.root, 'parametric-runtime.json'));
    assert.equal((await f.request('/initialize', 'POST', {})).status, 422);
    let release = f.store.acquire(f.project.id); release();
    await jsonWrite(path.join(f.root, 'parametric-runtime.json'), { python: process.execPath });
    await f.request('/initialize', 'POST', {}); f.behavior.build = 'wait'; await f.request('/build', 'POST', { revision: 1 });
    await f.manager.dispose(); assert.equal((await f.read()).job.state, 'cancelled');
    release = f.store.acquire(f.project.id); release();
    assert.equal((await f.request('/build', 'POST', { revision: 1 })).status, 503);
  } finally { await f.close(); }
});

test('external model changes and symlink escapes are rejected before running CAD', async () => {
  const f = await fixture();
  try {
    await f.request('/initialize', 'POST', {});
    await jsonWrite(path.join(f.store.workspace(f.project.id), 'cylinder-objects/model.json'), { ...model(), height_mm: 600 });
    assert.equal((await f.request('/build', 'POST', { revision: 1 })).status, 409); assert.equal(f.behavior.entered, false);
    const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(f.store.workspace(f.other.id), 'cylinder-objects'), process.platform === 'win32' ? 'junction' : 'dir');
    const escaped = await fetch(`${f.host}/api/projects/${f.other.id}/cylinder-objects`); assert.equal(escaped.status, 403);
    assert.deepEqual(await fs.readdir(outside), []);
    await fs.unlink(path.join(f.store.workspace(f.other.id), 'cylinder-objects'));
  } finally { await f.close(); }
});
