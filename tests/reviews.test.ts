import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { Store, inside } from '../server/storage.js';
import { History } from '../server/history.js';
import { Reviews, REVIEW_FILE } from '../server/reviews.js';
import { loadModel } from '../src/scene/loaders.js';
import { resolveReview } from '../src/scene/review-selection.js';
import type { ReviewAnchor, ReviewNote } from '../shared/types.js';
const hash = (v: string) => 'sha256:' + createHash('sha256').update(v).digest('hex');
const anchor: ReviewAnchor = { file: 'part.glb', sourceHash: hash('model-v1'), profile: 'studio-1/three-0.178.0/glb', meshKey: 'mesh/0', name: '外壳', kind: 'component', bounds: [10, 20, 30], units: 'mm' };
const fields = { text: '检查安装孔位置', intent: 'hole', status: 'open', priority: 'important' } as const;
async function fixture() {
  const base = path.resolve('.studio/test-runs'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'reviews-')), store = new Store(root); await store.init(); const project = await store.createProject('批注验收');
  const history = new History(store), reviews = new Reviews(store, history), workspace = store.workspace(project.id);
  await fs.writeFile(path.join(workspace, anchor.file), 'model-v1');
  return { root, store, history, reviews, workspace, id: project.id, cleanup: async () => { assert(inside(base, root)); await fs.rm(root, { recursive: true, force: true }); } };
}
test('annotations persist across reopening, immutable anchors survive edits, and project history restores deleted notes', async () => {
  const f = await fixture();
  try {
    const empty = await f.reviews.read(f.id);
    const added = await f.reviews.change(f.id, empty.etag, { create: { ...fields, anchor } });
    assert.equal(added.notes.length, 1); assert.notEqual(added.etag, empty.etag);
    assert.deepEqual((await new Reviews(f.store, f.history).read(f.id)).notes, added.notes);
    const updated = await f.reviews.change(f.id, added.etag, { update: added.notes[0].id, value: { ...fields, text: '改为 4 个安装孔', status: 'resolved', anchor: { ...anchor, file: 'wrong.glb' } } });
    assert.deepEqual(updated.notes[0].anchor, anchor); assert.equal(updated.notes[0].status, 'resolved');
    const saved = await f.history.snapshot(f.id, '批注已解决');
    const removed = await f.reviews.change(f.id, updated.etag, { remove: added.notes[0].id }); assert.equal(removed.notes.length, 0);
    const comparison = await f.history.compare(f.id, saved.id); assert(comparison.changes.some(c => c.path === REVIEW_FILE));
    await f.history.restore(f.id, saved.id, comparison.fingerprint);
    assert.equal((await f.reviews.read(f.id)).notes[0].text, '改为 4 个安装孔');
  } finally { await f.cleanup(); }
});
test('stale files, stale clients, concurrent edits, project lock and cross-project IDs cannot overwrite annotations', async () => {
  const f = await fixture();
  try {
    const empty = await f.reviews.read(f.id);
    await fs.writeFile(path.join(f.workspace, anchor.file), 'model-v2');
    await assert.rejects(() => f.reviews.change(f.id, empty.etag, { create: { ...fields, anchor } }), /内容已变化/);
    await fs.writeFile(path.join(f.workspace, anchor.file), 'model-v1');
    const results = await Promise.allSettled([1, 2].map(() => f.reviews.change(f.id, empty.etag, { create: { ...fields, anchor } })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const current = await f.reviews.read(f.id); assert.equal(current.notes.length, 1);
    await assert.rejects(() => f.reviews.change(f.id, empty.etag, { remove: current.notes[0].id }), /批注已更新/);
    const other = await f.store.createProject('另一个项目'), otherDoc = await f.reviews.read(other.id);
    await assert.rejects(() => f.reviews.change(other.id, otherDoc.etag, { remove: current.notes[0].id }), /不存在/);
    const release = f.store.acquire(f.id);
    await assert.rejects(() => f.reviews.change(f.id, current.etag, { remove: current.notes[0].id }), /项目正在修改/); release();
    assert.equal((await f.reviews.read(f.id)).notes.length, 1);
  } finally { await f.cleanup(); }
});
test('invalid anchors, traversal and damaged review documents fail without silently replacing project data', async () => {
  const f = await fixture();
  try {
    const empty = await f.reviews.read(f.id);
    for (const override of [{ file: '../outside.glb' }, { sourceHash: 'wrong' }, { bounds: [NaN, 2, 3] }, { kind: 'step-face', faceIndex: -1 }, { kind: 'triangle', triangleIndex: 1.5 }]) {
      await assert.rejects(() => f.reviews.change(f.id, empty.etag, { create: { ...fields, anchor: { ...anchor, ...override } } }));
    }
    await assert.rejects(() => f.reviews.change(f.id, empty.etag, { create: { ...fields, text: ' ', anchor } }));
    await fs.mkdir(path.join(f.workspace, 'studio'));
    await fs.writeFile(path.join(f.workspace, REVIEW_FILE), '{broken');
    await assert.rejects(() => f.reviews.read(f.id), /格式无效/);
    await assert.rejects(() => f.reviews.change(f.id, empty.etag, { create: { ...fields, anchor } }), /格式无效/);
    assert.equal(await fs.readFile(path.join(f.workspace, REVIEW_FILE), 'utf8'), '{broken');
  } finally { await f.cleanup(); }
});
test('preview anchors resolve after reload with new UUIDs and reject changed geometry/version/node identity', async () => {
  const obj = 'o body\nv 0 0 0\nv 10 0 0\nv 0 20 0\nf 1 2 3\n', bytes = new TextEncoder().encode(obj);
  const first = await loadModel('body.obj', bytes.buffer), second = await loadModel('body.obj', bytes.buffer);
  const getMesh = (group: THREE.Group) => { const meshes: THREE.Mesh[] = []; group.traverse(o => { if (o instanceof THREE.Mesh) { o.userData.reviewKey = `mesh/${meshes.length}`; meshes.push(o); } }); return meshes; };
  const initial = getMesh(first), reloaded = getMesh(second); assert.notEqual(initial[0].uuid, reloaded[0].uuid);
  const saved = { ...anchor, ...first.userData.previewIdentity, file: 'body.obj', kind: 'triangle' as const, triangleIndex: 0 };
  assert.equal(resolveReview(reloaded, second.userData.previewIdentity, saved).mesh.uuid, reloaded[0].uuid);
  assert.throws(() => resolveReview(reloaded, { ...second.userData.previewIdentity, sourceHash: hash('changed') }, saved), /模型内容已变化/);
  assert.throws(() => resolveReview(reloaded, { ...second.userData.previewIdentity, profile: 'new-version' }, saved), /预览版本/);
  assert.throws(() => resolveReview(reloaded, second.userData.previewIdentity, { ...saved, nodeId: 'missing' }), /无法匹配/);
  assert.throws(() => resolveReview(reloaded, second.userData.previewIdentity, { ...saved, triangleIndex: 50 }), /三角面/);
});
test('STEP review anchors restore a complete face and refuse mismatched precision or empty faces', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry()); mesh.userData.reviewKey = 'mesh/0';
  mesh.userData.step = { sourceHash: anchor.sourceHash.slice(7), faces: [{ first: 0, last: 1 }, { first: 2, last: 3 }, { first: 4, last: 3 }] };
  const identity = { sourceHash: anchor.sourceHash, profile: 'step/standard' };
  const selected = { ...anchor, profile: identity.profile, kind: 'step-face' as const, faceIndex: 1 };
  assert.equal(resolveReview([mesh], identity, selected).triangle, 2);
  assert.throws(() => resolveReview([mesh], { ...identity, profile: 'step/fine' }, selected), /精度/);
  assert.throws(() => resolveReview([mesh], identity, { ...selected, faceIndex: 2 }), /无法匹配/);
});
