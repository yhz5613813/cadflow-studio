import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { unzipSync, zipSync } from 'fflate';
import { validateArchive } from '../server/scene-package.js';
import { canonicalZipBytes, preflightZipBytes } from '../server/vendor/cadflow/zip.js';
import { loadScenePackage, type PackageInfo } from '../src/scene/package.js';
import { simpleFixture } from './scene-fixture.js';
const fixture = readFileSync(new URL('./fixtures/scene/cadflow-canonical.zip', import.meta.url));
const buffer = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;
const loadGlb = async (b: ArrayBuffer) => (await new GLTFLoader().parseAsync(b, '')).scene;
const load = (b: Uint8Array) => loadScenePackage(buffer(b), loadGlb, { validate: b => validateArchive(new Uint8Array(b)) });
const meshes = (g: THREE.Group) => { const list: THREE.Mesh[] = []; g.traverse(o => { if (o instanceof THREE.Mesh) list.push(o); }); return list; };
test('upstream CadFlow canonical scene: validate, render real GLB, preserve millimetres', async () => {
  const group = await load(fixture), info = group.userData.scenePackage as PackageInfo;
  assert.equal(info.format, 'cadflow-1.0'); assert.equal(info.nodes.length, 1);
  assert.equal(meshes(group).length, 1);
  const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  assert.deepEqual(size.toArray(), [1000, 1000, 1000]);
  assert.equal(meshes(group)[0].userData.packageMesh.nodeId, 'instance/root');
});
test('SimpleCADAPI projection: shared geometry instances compose parent rotation and mm translation; embedded feature/source', async () => {
  const group = await load(simpleFixture()), info = group.userData.scenePackage as PackageInfo, items = meshes(group);
  assert.equal(info.format, 'simplecadapi-3.0'); assert.equal(items.length, 2);
  assert.equal(items[0].geometry, items[1].geometry);
  const a = new THREE.Box3().setFromObject(items[0]).getCenter(new THREE.Vector3()), b = new THREE.Box3().setFromObject(items[1]).getCenter(new THREE.Vector3());
  assert.deepEqual(b.sub(a).toArray(), [0, 2000, 0]);
  assert.deepEqual(new THREE.Box3().setFromObject(items[0]).getSize(new THREE.Vector3()).toArray(), [1000, 1000, 1000]);
  assert.equal(info.sources[0].text.split('\n')[1], 'width = 1000'); assert.deepEqual(info.features[0].spans[0], { sourceId: info.sources[0].id, start: 2, end: 3 });
  assert.equal(new Set(info.nodes.flatMap(n => n.meshIds)).size, 2);
});
test('CadFlow embedded operation graph resolves validated source spans and selected definitions', async () => {
  const data = readFileSync(new URL('./fixtures/scene/cadflow-source.zip', import.meta.url));
  const group = await load(data), info = group.userData.scenePackage as PackageInfo;
  assert.equal(info.features.length, 1); assert.equal(info.features[0].id, 'body');
  assert.equal(info.features[0].definitionIds[0], info.nodes[0].definitionId);
  assert.deepEqual(info.features[0].spans[0], { sourceId: 'sources/model.py', start: 3, end: 3 });
  assert.equal(info.sources[0].text.split('\n')[2], 'body = make_tetrahedron(size)');
});
test('CadFlow packages reject changed geometry, extra members and noncanonical ZIP profiles', async () => {
  const files = new Map(preflightZipBytes(fixture).members), geometry = [...files.keys()].find(k => k.startsWith('geometry/'))!;
  const damaged = Buffer.from(files.get(geometry)!); damaged[damaged.length - 1] ^= 1; files.set(geometry, damaged);
  await assert.rejects(() => validateArchive(canonicalZipBytes(files)), /hash|digest/i);
  const extra = new Map(preflightZipBytes(fixture).members); extra.set('extra.txt', Buffer.from('x'));
  await assert.rejects(() => validateArchive(canonicalZipBytes(extra)), /member/i);
  await assert.rejects(() => validateArchive(zipSync(unzipSync(fixture))), /ZIP/);
});
test('SimpleCADAPI closure rejects blob tampering and loose members before rendering', async () => {
  const files = unzipSync(simpleFixture()), blob = Object.keys(files).find(p => p.startsWith('blobs/'))!;
  files[blob][0] ^= 1;
  await assert.rejects(() => load(zipSync(files)), /hash/i);
  const extra = unzipSync(simpleFixture()); extra['extra.txt'] = new Uint8Array([1]);
  await assert.rejects(() => load(zipSync(extra)), /members/i);
});
test('scene rendering rejects cycles, missing references, invalid frames and source spans even with recomputed hashes', async () => {
  await assert.rejects(() => load(simpleFixture(s => { s.nodes[1].parent_node_id = 'part.b'; s.nodes[2].parent_node_id = 'part.a'; })), /循环/);
  await assert.rejects(() => load(simpleFixture(s => { s.nodes[1].transform.x_axis = [2, 0, 0]; })), /正交/);
  await assert.rejects(() => load(simpleFixture(s => { s.feature_index[0].source_spans[0].end_line = 100; })), /源码位置/);
  await assert.rejects(() => load(simpleFixture(s => { s.feature_index[0].input_feature_ids = ['missing']; })), /依赖不存在/);
  await assert.rejects(() => load(simpleFixture(s => { s.feature_index[0].input_feature_ids = ['feature.body']; })), /循环/);
  await assert.rejects(() => load(simpleFixture(s => { s.nodes[1].geometry_asset_id = 'sha256:' + '0'.repeat(64); })), /几何资源不存在/);
});
test('cancelled package validation does not create any render geometry', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(() => loadScenePackage(buffer(fixture), async b => { calls++; return loadGlb(b); }, { signal: controller.signal, validate: b => validateArchive(new Uint8Array(b)) }), /abort/i);
  assert.equal(calls, 0);
});
