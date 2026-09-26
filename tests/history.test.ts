import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { History } from '../server/history.js';
import { Store, inside, jsonRead, jsonWrite } from '../server/storage.js';
import { createApp } from '../server/app.js';

async function fixture() {
  const base = path.resolve('.studio/test-runs'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'history-'));
  const store = new Store(root); await store.init(); const project = await store.createProject('历史测试');
  const workspace = store.workspace(project.id), history = new History(store), id = project.id;
  return { root, store, history, id, workspace, cleanup: async () => { assert(inside(base, root)); await fs.rm(root, { recursive: true, force: true }); } };
}
test('snapshots persist, deduplicate binary geometry, diff sources and restore all files with a recoverable backup', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.workspace, 'part.py'), 'diameter = 6\n');
    const geometry = Buffer.from([0, 1, 2, 255]); await fs.writeFile(path.join(f.workspace, 'artifacts', 'part.glb'), geometry);
    await fs.writeFile(path.join(f.workspace, '.env'), 'PRIVATE');
    await fs.mkdir(path.join(f.workspace, '.venv')); await fs.writeFile(path.join(f.workspace, '.venv', 'dependency'), 'preserve');
    const baseline = await f.history.snapshot(f.id, '初版'); assert.equal(baseline.files, 2);
    await f.history.snapshot(f.id, '相同几何');
    assert.equal((await fs.readdir(path.join(f.store.projectRoot(f.id), 'history', 'blobs'))).length, 2);
    await fs.writeFile(path.join(f.workspace, 'part.py'), 'diameter = 8\n');
    await fs.unlink(path.join(f.workspace, 'artifacts', 'part.glb'));
    await fs.writeFile(path.join(f.workspace, 'new.txt'), 'later result');
    const reopened = new History(new Store(f.root)); assert.equal((await reopened.list(f.id)).length, 2);
    const comparison = await reopened.compare(f.id, baseline.id);
    assert.deepEqual(comparison.changes.map(c => [c.path, c.status]), [['artifacts/part.glb', 'deleted'], ['new.txt', 'added'], ['part.py', 'modified']]);
    assert.deepEqual(await reopened.file(f.id, baseline.id, 'artifacts/part.glb'), geometry);
    assert.deepEqual(await reopened.diff(f.id, baseline.id, 'part.py'), { path: 'part.py', before: 'diameter = 6\n', after: 'diameter = 8\n', binary: false, truncated: false });
    const restored = await reopened.restore(f.id, baseline.id, comparison.fingerprint);
    assert.equal(await fs.readFile(path.join(f.workspace, 'part.py'), 'utf8'), 'diameter = 6\n');
    assert.deepEqual(await fs.readFile(path.join(f.workspace, 'artifacts', 'part.glb')), geometry);
    await assert.rejects(fs.access(path.join(f.workspace, 'new.txt')));
    assert.equal(await fs.readFile(path.join(f.workspace, '.env'), 'utf8'), 'PRIVATE');
    assert.equal(await fs.readFile(path.join(f.workspace, '.venv', 'dependency'), 'utf8'), 'preserve');
    // Undo a restore using its automatic backup, including formerly removed files.
    await reopened.restore(f.id, restored.backup.id, (await reopened.compare(f.id, restored.backup.id)).fingerprint);
    assert.equal(await fs.readFile(path.join(f.workspace, 'new.txt'), 'utf8'), 'later result');
    assert.equal(await fs.readFile(path.join(f.workspace, 'part.py'), 'utf8'), 'diameter = 8\n');
    assert.deepEqual((await reopened.compare(f.id, restored.backup.id)).changes, []);
  } finally { await f.cleanup(); }
});
test('stale comparisons, traversal, corrupt blobs and cross-project revisions cannot overwrite current results', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.workspace, 'part.py'), 'a = 1'); const baseline = await f.history.snapshot(f.id, 'v1');
    const stale = await f.history.compare(f.id, baseline.id);
    await fs.writeFile(path.join(f.workspace, 'part.py'), 'a = 2');
    await assert.rejects(f.history.restore(f.id, baseline.id, stale.fingerprint), /发生变化/);
    await assert.rejects(f.history.diff(f.id, baseline.id, '../project.json'), /无效/);
    const other = await f.store.createProject('other'); await assert.rejects(f.history.file(other.id, baseline.id, 'part.py'), /不存在/);
    const manifest = await jsonRead<any>(path.join(f.store.projectRoot(f.id), 'history', `${baseline.id}.json`), null);
    await fs.writeFile(path.join(f.store.projectRoot(f.id), 'history', 'blobs', manifest.entries[0].hash), 'corrupt');
    await assert.rejects(f.history.file(f.id, baseline.id, 'part.py'), /校验失败/);
    await assert.rejects(f.history.restore(f.id, baseline.id, (await f.history.compare(f.id, baseline.id)).fingerprint), /校验失败/);
    assert.equal(await fs.readFile(path.join(f.workspace, 'part.py'), 'utf8'), 'a = 2');
  } finally { await f.cleanup(); }
});
test('an interrupted restore is recovered from the durable journal when the application restarts', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.workspace, 'part.py'), 'original'); const backup = await f.history.snapshot(f.id, '恢复前', 'before-restore');
    await jsonWrite(path.join(f.store.projectRoot(f.id), 'history', 'pending.json'), { backup: backup.id });
    await fs.writeFile(path.join(f.workspace, 'part.py'), 'partial restore');
    await fs.writeFile(path.join(f.workspace, 'partial.txt'), 'partial output');
    await createApp(f.root);
    assert.equal(await fs.readFile(path.join(f.workspace, 'part.py'), 'utf8'), 'original');
    await assert.rejects(fs.access(path.join(f.workspace, 'partial.txt')));
    await assert.rejects(fs.access(path.join(f.store.projectRoot(f.id), 'history', 'pending.json')));
  } finally { await f.cleanup(); }
});
test('HTTP saves checkpoint both states, reject stale editor text, and respect the project mutation lock', async () => {
  const f = await fixture(); const { app, store } = await createApp(f.root); const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${f.id}`;
  const save = (text: string, baseText: string | null) => fetch(`${url}/file`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'part.py', text, baseText }) });
  try {
    assert.equal((await save('radius = 3', null)).status, 200);
    assert.equal((await save('radius = 5', null)).status, 409);
    assert.equal((await save('radius = 5', 'radius = 3')).status, 200);
    const revisions = await fetch(`${url}/history`).then(r => r.json()); assert.equal(revisions.length, 4);
    assert.equal(revisions[0].kind, 'after-save'); assert.equal(revisions[1].kind, 'before-save');
    assert.equal(await fetch(`${url}/history/${revisions[1].id}/file?path=part.py`).then(r => r.text()), 'radius = 3');
    const release = store.acquire(f.id);
    try {
      assert.equal((await save('radius = 9', 'radius = 5')).status, 409);
      assert.equal((await fetch(`${url}/history`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 409);
      const form = new FormData(); form.set('file', new Blob(['test']), 'part.stl');
      assert.equal((await fetch(`${url}/upload`, { method: 'POST', body: form })).status, 409);
    } finally { release(); }
    assert.equal(await fs.readFile(path.join(f.workspace, 'part.py'), 'utf8'), 'radius = 5');
    const diff = await fetch(`${url}/history/${revisions[1].id}/compare`).then(r => r.json());
    const response = await fetch(`${url}/history/${revisions[1].id}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprint: diff.fingerprint }) });
    assert.equal(response.status, 200, await response.text());
    assert.equal(await fs.readFile(path.join(f.workspace, 'part.py'), 'utf8'), 'radius = 3');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});
