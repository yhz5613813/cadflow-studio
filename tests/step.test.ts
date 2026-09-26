import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { stepScene, faceForTriangle, importStep, type StepResult, type StepEvidence } from '../src/scene/step.js';
import { explodeMeshes } from '../src/scene/explode.js';
import { loadModel } from '../src/scene/loaders.js';

const require = createRequire(import.meta.url);
const factory = require('occt-import-js');
const root = path.join(path.dirname(require.resolve('occt-import-js')), '..', 'test', 'testfiles');
const runtime = factory({ print: () => {}, printErr: () => {} });
const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.35 };
async function load(file: string) { const buffer = await readFile(path.join(root, file)); const result: StepResult = (await runtime).ReadStepFile(buffer, params); const hash = createHash('sha256').update(buffer).digest('hex'); return { result, hash, scene: stepScene(result, hash) }; }
function meshes(scene: THREE.Group) { const found: THREE.Mesh[] = []; scene.traverse(o => { if (o instanceof THREE.Mesh) found.push(o); }); return found; }
function dispose(scene: THREE.Group) { meshes(scene).forEach(mesh => { mesh.geometry.dispose(); (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(mat => mat.dispose()); }); }

test('STEP preview identity matches original file after worker transfer detaches its input buffer', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  let terminated = false;
  class TransferWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    postMessage(message: { buffer: ArrayBuffer; quality: string }, transfer: ArrayBuffer[]) {
      // Exercise actual ArrayBuffer ownership transfer; the geometry still comes from real OCCT.
      const received = structuredClone(message, { transfer });
      void runtime.then((occt: { ReadStepFile: (buffer: Uint8Array, options: typeof params) => StepResult }) => {
        const hash = createHash('sha256').update(new Uint8Array(received.buffer)).digest('hex');
        const result = occt.ReadStepFile(new Uint8Array(received.buffer), params);
        this.onmessage?.({ data: { type: 'result', result, hash, quality: received.quality } });
      }).catch(() => this.onerror?.());
    }
    terminate() { terminated = true; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: TransferWorker });
  let scene: THREE.Group | undefined;
  try {
    const bytes = await readFile(path.join(root, 'simple-basic-cube/cube.stp'));
    const expected = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    const input = Uint8Array.from(bytes).buffer;
    scene = await loadModel('cube.step', input);
    assert.equal(input.byteLength, 0, 'the input was transferred, not copied');
    assert.equal(scene.userData.previewIdentity.sourceHash, expected);
    assert.equal('sha256:' + meshes(scene)[0].userData.step.sourceHash, expected);
    assert.equal(scene.userData.previewIdentity.profile, 'studio-1/three-0.178.0/step/occt-0.0.23/standard');
    assert(terminated);
  } finally {
    if (scene) dispose(scene);
    if (previous) Object.defineProperty(globalThis, 'Worker', previous);
    else Reflect.deleteProperty(globalThis, 'Worker');
  }
});

test('real OCCT WASM imports a STEP cube and preserves six BREP faces with full triangle mappings', { timeout: 30000 }, async () => {
  const { result, hash, scene } = await load('simple-basic-cube/cube.stp');
  try {
    const [mesh] = meshes(scene), evidence = mesh.userData.step as StepEvidence;
    assert.equal(meshes(scene).length, 1); assert.equal(evidence.faces.length, 6); assert.equal(evidence.units, 'mm'); assert.equal(evidence.sourceHash, hash);
    assert.equal(mesh.geometry.index!.count, 36);
    for (const [index, face] of evidence.faces.entries()) {
      const selection = faceForTriangle(evidence, face.first)!;
      assert.equal(selection.index, index); assert.equal(selection.lastTriangle - selection.firstTriangle + 1, 2);
      assert.equal(faceForTriangle(evidence, face.last)?.id, selection.id);
      assert.equal(selection.id, `step:${hash}:mesh:0:face:${index}`);
    }
    assert.equal(faceForTriangle(evidence, 12), undefined); assert.equal(faceForTriangle(undefined, 0), undefined);
    assert.deepEqual(result.root.children.map(c => c.name), ['cube']);
    assert.equal(mesh.geometry.groups.reduce((n, g) => n + g.count, 0), mesh.geometry.index!.count);
  } finally { dispose(scene); }
});

test('STEP source units in mm, metres and inches all yield the same millimetre geometry', { timeout: 30000 }, async () => {
  const bounds: number[][] = [];
  for (const name of ['cube-mm.step', 'cube-m.step', 'cube-in.step']) {
    const { scene } = await load(`cube-units/${name}`);
    try { bounds.push(new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3()).toArray()); } finally { dispose(scene); }
  }
  for (const dimensions of bounds) dimensions.forEach((value, i) => assert(Math.abs(value - bounds[0][i]) < 0.001, JSON.stringify(bounds)));
  assert(bounds[0].every(n => Math.abs(n - 1000) < 0.001), 'the fixture is a 1 m cube; output must be 1000 mm');
});

test('STEP assembly retains all 18 placed parts, hierarchy, colours and separated occurrences', { timeout: 45000 }, async () => {
  const { scene } = await load('cax-if/as1_pe_203.stp');
  try {
    const parts = meshes(scene); assert.equal(parts.length, 18);
    assert(parts.some(p => p.userData.assembly_group.includes('L_BRACKET')));
    assert(parts.every(p => p.userData.step.faces.length > 0));
    const centers = parts.map(p => new THREE.Box3().setFromObject(p).getCenter(new THREE.Vector3()).toArray());
    assert.notDeepEqual(centers[1], centers[8], 'two bracket occurrences must not collapse onto one position');
    assert(parts.every(p => (Array.isArray(p.material) ? p.material : [p.material]).every(m => m instanceof THREE.MeshStandardMaterial)));
  } finally { dispose(scene); }
});

test('bad STEP, corrupt topology references, overlapping face ranges and aborted imports fail explicitly', async () => {
  const occt = await runtime; assert.equal(occt.ReadStepFile(new Uint8Array([1,2,3]), params).success, false);
  const { result, hash, scene } = await load('simple-basic-cube/cube.stp'); dispose(scene);
  const missing = structuredClone(result); missing.root.children[0].meshes = [999]; assert.throws(() => stepScene(missing, hash), /不存在/);
  const malformed = structuredClone(result); malformed.meshes[0].brep_faces[1].first = 0; assert.throws(() => stepScene(malformed, hash), /对应关系/);
  const invalid = structuredClone(result); invalid.meshes[0].index.array[0] = -1; assert.throws(() => stepScene(invalid, hash), /索引/);
  const abandoned = structuredClone(result); abandoned.root.children = []; assert.throws(() => stepScene(abandoned, hash), /遗漏/);
  await assert.rejects(importStep(new ArrayBuffer(1), { signal: AbortSignal.abort() }), /取消/);
  const degenerate = structuredClone(result); degenerate.meshes[0].brep_faces.unshift({ first: 0, last: -1, color: null });
  const withEmptyFace = stepScene(degenerate, hash);
  assert.equal(faceForTriangle(meshes(withEmptyFace)[0].userData.step, 0)?.index, 1, 'a face without tessellation must not renumber following source faces'); dispose(withEmptyFace);
});

test('explode separates baked STEP geometry in transformed groups and resets exactly without changing geometry', () => {
  const group = new THREE.Group(); group.rotation.z = Math.PI / 2; group.scale.setScalar(2);
  const a = new THREE.Mesh(new THREE.BoxGeometry(2,2,2).translate(-10,0,0));
  const b = new THREE.Mesh(new THREE.BoxGeometry(2,2,2).translate(10,0,0)); group.add(a,b); group.updateMatrixWorld(true);
  const original = new Map([a,b].map(m => [m.uuid,m.position.clone()]));
  const positions = [a,b].map(m => Array.from(m.geometry.attributes.position.array));
  explodeMeshes([a,b],original,new THREE.Vector3(),5); group.updateMatrixWorld(true);
  const ca = new THREE.Box3().setFromObject(a).getCenter(new THREE.Vector3());
  const cb = new THREE.Box3().setFromObject(b).getCenter(new THREE.Vector3());
  assert(Math.abs(ca.y + 25) < 1e-5); assert(Math.abs(cb.y - 25) < 1e-5);
  explodeMeshes([a,b],original,new THREE.Vector3(),0);
  assert.deepEqual(a.position.toArray(),[0,0,0]); assert.deepEqual(b.position.toArray(),[0,0,0]);
  [a,b].forEach((m,i)=>assert.deepEqual(Array.from(m.geometry.attributes.position.array),positions[i])); dispose(group);
});
