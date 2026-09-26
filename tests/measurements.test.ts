import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { metricInput } from '../src/scene/metric-input.js';
import { measureMesh } from '../src/scene/mesh-metrics.js';
import { measurementDifference, validateMetrics, type Measurement } from '../shared/measurements.js';
import { stepScene, type StepResult } from '../src/scene/step.js';
import { Store, inside } from '../server/storage.js';
import { History } from '../server/history.js';
import { Measurements, MEASUREMENT_FILE } from '../server/measurements.js';
import { createApp } from '../server/app.js';
import { measureInWorker } from '../src/scene/measure.js';
const close = (actual: number, expected: number) => assert(Math.abs(actual - expected) <= Math.max(1e-7, Math.abs(expected) * 1e-9), `${actual} != ${expected}`);
function cube(x = 10, y = 20, z = 30) { return new THREE.Mesh(new THREE.BoxGeometry(x, y, z)); }
test('mesh area, signed volume, bounds and topology use baked world frames, not exploded display positions', () => {
  const mesh = cube(), matrix = new THREE.Matrix4().makeScale(2, 3, 4).setPosition(1e7, -2e7, 3e7);
  const input = metricInput(mesh, matrix); mesh.position.set(100000, 20000, -10000); mesh.updateMatrixWorld();
  const m = measureMesh(input); close(m.surfaceArea, 2 * (20 * 60 + 60 * 120 + 20 * 120)); close(m.signedVolume!, 20 * 60 * 120);
  assert.deepEqual(m.size, [20, 60, 120]); assert.equal(m.vertices, 8); assert.equal(m.components, 1); assert.equal(m.boundaryEdges, 0); assert.equal(m.nonManifoldVertices, 0); validateMetrics(m);
  const reflected = measureMesh(metricInput(mesh, new THREE.Matrix4().makeScale(-1, 1, 1))); close(reflected.signedVolume!, -6000);
  mesh.geometry.dispose();
});
test('an open face, reversed triangle, duplicates and pinched vertices cannot claim an enclosed volume', () => {
  const mesh = cube(), original = metricInput(mesh, new THREE.Matrix4());
  const face = measureMesh(metricInput(mesh, new THREE.Matrix4(), 0, 1)); close(face.surfaceArea, 600); assert.equal(face.boundaryEdges, 4); assert.equal(face.signedVolume, null);
  const reversed = structuredClone(original); [reversed.indices[0], reversed.indices[1]] = [reversed.indices[1], reversed.indices[0]];
  const orientation = measureMesh(reversed); assert(orientation.orientationConflicts > 0); assert.equal(orientation.signedVolume, null);
  const duplicate = { ...original, indices: Uint32Array.from([...original.indices, ...original.indices.slice(0, 3)]) };
  const duplicated = measureMesh(duplicate); assert.equal(duplicated.duplicateTriangles, 1); assert(duplicated.nonManifoldEdges > 0); assert.equal(duplicated.signedVolume, null);
  const second = metricInput(mesh, new THREE.Matrix4()), offset = original.positions.length / 3;
  for (let i = 0; i < second.positions.length; i++) second.positions[i] += [10, 20, 30][i % 3];
  const pinched = measureMesh({ positions: Float64Array.from([...original.positions, ...second.positions]), indices: Uint32Array.from([...original.indices, ...second.indices.map(n => n + offset)]), matrix: original.matrix });
  assert.equal(pinched.boundaryEdges, 0); assert.equal(pinched.nonManifoldEdges, 0); assert.equal(pinched.nonManifoldVertices, 1); assert.equal(pinched.components, 2); assert.equal(pinched.signedVolume, null);
  mesh.geometry.dispose();
});
test('exact welding retains small real gaps and rejects malformed or oversized input', () => {
  const mesh = cube(), input = metricInput(mesh, new THREE.Matrix4());
  input.positions[0] += 1e-8; const m = measureMesh(input); assert(m.boundaryEdges > 0); assert.equal(m.signedVolume, null);
  const bad = metricInput(mesh, new THREE.Matrix4()); bad.positions[0] = NaN; assert.throws(() => measureMesh(bad), /坐标/);
  assert.throws(() => metricInput(mesh, new THREE.Matrix4(), 0, 999), /25 万/);
  assert.throws(() => measureMesh({ ...input, indices: new Uint32Array(750003) }), /25 万/);
  assert.throws(() => validateMetrics({ ...m, signedVolume: 6000 }), /缺陷网格/); mesh.geometry.dispose();
});
test('real OCCT STEP cube measurements match its geometry and source faces, without using a CAD-kernel certificate', async () => {
  const require = createRequire(import.meta.url), factory = require('occt-import-js');
  const bytes = await fs.readFile(path.join(path.dirname(require.resolve('occt-import-js')), '..', 'test/testfiles/simple-basic-cube/cube.stp'));
  const runtime = await factory({ print: () => {}, printErr: () => {} });
  const result: StepResult = runtime.ReadStepFile(bytes, { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.35 });
  const group = stepScene(result, createHash('sha256').update(bytes).digest('hex')); group.updateMatrixWorld(true);
  let mesh: THREE.Mesh | undefined; group.traverse(o => { if (o instanceof THREE.Mesh) mesh = o; });
  assert(mesh); const metrics = measureMesh(metricInput(mesh, mesh.matrixWorld));
  assert.deepEqual(metrics.size, [300, 300, 300]); close(metrics.surfaceArea, 540000); close(Math.abs(metrics.signedVolume!), 27000000);
  const face = mesh.userData.step.faces[2], faceMetrics = measureMesh(metricInput(mesh, mesh.matrixWorld, face.first, face.last));
  close(faceMetrics.surfaceArea, 90000); assert.equal(faceMetrics.triangles, 2); assert.equal(faceMetrics.signedVolume, null); mesh.geometry.dispose();
});
test('measurement comparisons require explicit units and keep zero baselines meaningful', () => {
  const mesh = cube(), metrics = measureMesh(metricInput(mesh, new THREE.Matrix4()));
  const a = { metrics, anchor: { units: 'mm' } } as Measurement;
  const b = { ...a, metrics: { ...metrics, size: [20, 20, 30], surfaceArea: 3000 } };
  const result = measurementDifference(a, b)!; assert.equal(result.size[0].delta, 10); assert.equal(result.size[0].percent, 100);
  assert.equal(measurementDifference({ ...a, anchor: { ...a.anchor, units: undefined } }, b), null);
  const zero = { ...a, metrics: { ...metrics, size: [0, 20, 30] } }; assert.equal(measurementDifference(zero, b)!.size[0].percent, null); mesh.geometry.dispose();
});
test('measurement worker transfers only copied buffers and cancellation terminates pending work', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker'); let held = false, terminated = 0;
  class LocalWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    postMessage(input: ReturnType<typeof metricInput>, transfer: ArrayBuffer[]) {
      const received = structuredClone(input, { transfer });
      if (!held) queueMicrotask(() => this.onmessage?.({ data: { result: measureMesh(received) } }));
    }
    terminate() { terminated++; }
  }
  Object.defineProperty(globalThis, 'Worker', { value: LocalWorker, configurable: true });
  const mesh = cube();
  try {
    const input = metricInput(mesh, new THREE.Matrix4()), originalCount = mesh.geometry.getAttribute('position').count;
    const result = await measureInWorker(input, new AbortController().signal); close(result.signedVolume!, 6000);
    assert.equal(input.positions.byteLength, 0); assert.equal(input.indices.byteLength, 0);
    assert.equal(mesh.geometry.getAttribute('position').count, originalCount); assert.equal(mesh.geometry.getAttribute('position').getX(0), 5);
    held = true; const controller = new AbortController(), pending = measureInWorker(metricInput(mesh, new THREE.Matrix4()), controller.signal);
    controller.abort(); await assert.rejects(pending, /已取消/); assert.equal(terminated, 2);
  } finally { mesh.geometry.dispose(); if (previous) Object.defineProperty(globalThis, 'Worker', previous); else Reflect.deleteProperty(globalThis, 'Worker'); }
});
async function fixture() {
  const base = path.resolve('.studio/test-runs'); await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'metrics-'));
  const store = new Store(root); await store.init(); const project = await store.createProject('Measurements'), history = new History(store), measurements = new Measurements(store, history);
  const mesh = cube(), metrics = measureMesh(metricInput(mesh, new THREE.Matrix4())); mesh.geometry.dispose();
  const bytes = Buffer.from('test model identity'); await fs.writeFile(path.join(store.workspace(project.id), 'test.glb'), bytes);
  const anchor = { file: 'test.glb', sourceHash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), profile: 'test', meshKey: 'mesh/0', name: 'Test', kind: 'component' as const, bounds: metrics.size, units: 'mm' as const };
  return { id: project.id, root, store, history, measurements, record: { anchor, metrics }, cleanup: async () => { assert(inside(base, root)); await fs.rm(root, { recursive: true, force: true }); } };
}
test('saved mesh evidence is versioned, rejects stale files/clients and survives deletion recovery', async () => {
  const f = await fixture();
  try {
    const initial = await f.measurements.read(f.id), saved = await f.measurements.change(f.id, initial.etag, { add: f.record });
    const checkpoint = await f.history.snapshot(f.id, 'Measurement baseline');
    assert.equal((await new Measurements(f.store, f.history).read(f.id)).measurements[0].metrics.signedVolume, 6000);
    await assert.rejects(() => f.measurements.change(f.id, initial.etag, { add: f.record }), /已变化/);
    const release = f.store.acquire(f.id); await assert.rejects(() => f.measurements.change(f.id, saved.etag, { add: f.record }), /项目正在修改/); release();
    const empty = await f.measurements.change(f.id, saved.etag, { remove: saved.measurements[0].id }); assert.equal(empty.measurements.length, 0);
    const comparison = await f.history.compare(f.id, checkpoint.id); await f.history.restore(f.id, checkpoint.id, comparison.fingerprint);
    const restored = await f.measurements.read(f.id); assert.equal(restored.measurements.length, 1);
    await fs.writeFile(path.join(f.store.workspace(f.id), 'test.glb'), 'changed'); await assert.rejects(() => f.measurements.change(f.id, restored.etag, { add: f.record }), /模型已变化/);
    await fs.writeFile(path.join(f.store.workspace(f.id), MEASUREMENT_FILE), '{broken'); await assert.rejects(() => f.measurements.change(f.id, restored.etag, { add: f.record }), /损坏/);
  } finally { await f.cleanup(); }
});
test('HTTP measurement routes preserve geometry provenance and isolate projects', async () => {
  const f = await fixture(), { app, builds } = await createApp(f.root), server = createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`, url = `${base}/${f.id}/measurements`;
  try {
    const initial = await fetch(url).then(r => r.json());
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ etag: initial.etag, measurement: f.record }) });
    assert.equal(response.status, 201); const saved = await response.json(); assert.deepEqual(saved.measurements[0].anchor, f.record.anchor);
    const other = await f.store.createProject('Other'), otherDoc = await fetch(`${base}/${other.id}/measurements`).then(r => r.json());
    assert.equal(otherDoc.measurements.length, 0);
    assert.equal((await fetch(`${base}/${other.id}/measurements/${saved.measurements[0].id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ etag: otherDoc.etag }) })).status, 404);
  } finally { await builds.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await f.cleanup(); }
});
