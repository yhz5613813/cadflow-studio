import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store, inside, jsonWrite } from '../server/storage.js';
import { History } from '../server/history.js';
import { Builds } from '../server/builds.js';
import { Parameters as ParameterStore } from '../server/parameters.js';
import { Events } from '../server/events.js';
import { createApp } from '../server/app.js';
import { validateParameters, withParameterValues, type ParameterDocument } from '../shared/parameters.js';
const document: ParameterDocument = {
  version: 1, title: 'Plate', parameters: [
    { name: 'width', label: '宽度', value: 80, min: 5, max: 1000, unit: 'mm', type: 'number' },
    { name: 'hole', label: '孔径', value: 12, min: 1, max: 900, unit: 'mm', type: 'number' },
    { name: 'count', label: '数量', value: 4, min: 1, max: 20, unit: 'unitless', type: 'integer' },
  ], constraints: [{ terms: { width: 1, hole: -1 }, min: 2, message: '孔壁不足 1 mm' }],
};
const script = 'import json\nfrom pathlib import Path\np=json.loads(Path(__file__).with_suffix(".parameters.json").read_text(encoding="utf-8"))\nvalues={v["name"]:v["value"] for v in p["parameters"]}\nPath("result.json").write_text(json.dumps({"values":values,"cad_geometry_validated":False}),encoding="utf-8")\nprint(values,flush=True)\n';
async function fixture() {
  const base = path.resolve('.studio/test-runs'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'params-')), store = new Store(root); await store.init();
  const p = await store.createProject('参数验收'), history = new History(store), parameters = new ParameterStore(store, history), builds = new Builds(store, history, new Events());
  const workspace = store.workspace(p.id);
  await jsonWrite(path.join(root, 'runtime.json'), { executable: process.env.STUDIO_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') });
  await fs.writeFile(path.join(workspace, 'model.py'), script); await jsonWrite(path.join(workspace, 'model.parameters.json'), document);
  return { id: p.id, store, root, workspace, history, parameters, builds, cleanup: async () => { await builds.dispose(); assert(inside(base, root)); await fs.rm(root, { recursive: true, force: true }); } };
}
async function finish(builds: Builds, id: string, run: string) {
  const until = Date.now() + 30000;
  while (Date.now() < until) { const record = await builds.read(id, run); if (!['preparing', 'running'].includes(record.state)) return record; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Parameter build timed out');
}
test('parameter bounds, integers, units and relational guards reject invalid designs without evaluation', () => {
  assert.equal(validateParameters(document).parameters[0].value, 80);
  for (const values of [{ width: 0, hole: 12, count: 4 }, { width: 80, hole: 12, count: 1.5 }, { width: 80, hole: 79, count: 4 }, { width: NaN, hole: 12, count: 4 }, { width: 80, hole: 12 }, { width: 80, hole: 12, count: 4, extra: 1 }]) assert.throws(() => withParameterValues(document, values));
  const mixed = structuredClone(document); mixed.parameters[1].unit = 'cm'; assert.throws(() => validateParameters(mixed), /单位必须一致/);
  const unknown = structuredClone(document); unknown.constraints[0].terms.unknown = 1; assert.throws(() => validateParameters(unknown), /未知参数/);
  assert.throws(() => validateParameters({ ...document, formula: 'process.exit()' }), /不支持/);
});
test('parameter saves preserve history, reject stale schemas and locks, and survive restore', async () => {
  const f = await fixture();
  try {
    const original = await f.parameters.read(f.id, 'model.py'), baseline = await f.history.snapshot(f.id, 'baseline');
    await assert.rejects(() => f.parameters.save(f.id, 'model.py', original.hash, { width: 80, hole: 79, count: 4 }), /孔壁/);
    assert.equal((await f.parameters.read(f.id, 'model.py')).hash, original.hash);
    const saved = await f.parameters.save(f.id, 'model.py', original.hash, { width: 100, hole: 20, count: 8 });
    assert.notEqual(saved.hash, original.hash); assert.equal(saved.document!.parameters[0].value, 100);
    await assert.rejects(() => f.parameters.save(f.id, 'model.py', original.hash, { width: 90, hole: 20, count: 8 }), /已变化/);
    const release = f.store.acquire(f.id); await assert.rejects(() => f.parameters.save(f.id, 'model.py', saved.hash, { width: 90, hole: 20, count: 8 }), /项目正在修改/); release();
    const comparison = await f.history.compare(f.id, baseline.id); await f.history.restore(f.id, baseline.id, comparison.fingerprint);
    assert.equal((await f.parameters.read(f.id, 'model.py')).hash, original.hash);
    await fs.writeFile(path.join(f.workspace, 'model.parameters.json'), '{broken');
    await assert.rejects(() => f.parameters.save(f.id, 'model.py', saved.hash, {}), /参数文件无效/);
    assert.equal(await fs.readFile(path.join(f.workspace, 'model.parameters.json'), 'utf8'), '{broken');
    await assert.rejects(() => f.parameters.read(f.id, '../model.py'));
  } finally { await f.cleanup(); }
});
test('two real Python builds consume distinct saved values and publish exact parameter provenance', async () => {
  const f = await fixture();
  try {
    const a = await f.parameters.read(f.id, 'model.py');
    await assert.rejects(() => f.builds.start(f.id, 'model.py', script), /参数已变化/);
    const first = await finish(f.builds, f.id, (await f.builds.start(f.id, 'model.py', script, a.hash)).id);
    assert.equal(first.state, 'succeeded', first.error + first.log);
    assert.equal(first.parameters?.hash, a.hash);
    assert.deepEqual(JSON.parse((await f.builds.file(f.id, first.id, 'result.json')).toString()).values, { width: 80, hole: 12, count: 4 });
    const b = await f.parameters.save(f.id, 'model.py', a.hash, { width: 100, hole: 20, count: 8 });
    await assert.rejects(() => f.builds.start(f.id, 'model.py', script, a.hash), /参数已变化/);
    const second = await finish(f.builds, f.id, (await f.builds.start(f.id, 'model.py', script, b.hash)).id);
    assert.equal(second.state, 'succeeded', second.error + second.log);
    assert.deepEqual(JSON.parse((await f.builds.file(f.id, second.id, 'result.json')).toString()).values, { width: 100, hole: 20, count: 8 });
    assert.equal(first.sourceHash, second.sourceHash); assert.notEqual(first.parameters?.hash, second.parameters?.hash);
    const published = await f.builds.publish(f.id, second.id);
    const manifest = JSON.parse(await fs.readFile(path.join(f.workspace, published.path, 'studio-build-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.parameters, second.parameters);
    assert.equal((await f.builds.read(f.id, first.id)).parameters?.values[0].value, 80);
    assert.equal(await fs.readFile(path.join(f.workspace, 'model.py'), 'utf8'), script);
  } finally { await f.cleanup(); }
});
test('parameter changes during snapshot preparation abort before executing a script', async t => {
  const f = await fixture();
  try {
    const current = await f.parameters.read(f.id, 'model.py'), snapshot = f.history.snapshot.bind(f.history);
    t.mock.method(f.history, 'snapshot', async (...args: Parameters<History['snapshot']>) => {
      await jsonWrite(path.join(f.workspace, 'model.parameters.json'), withParameterValues(document, { width: 90, hole: 10, count: 4 }));
      return snapshot(...args);
    });
    const run = await finish(f.builds, f.id, (await f.builds.start(f.id, 'model.py', script, current.hash)).id);
    assert.equal(run.state, 'failed'); assert.match(run.error || '', /参数在构建准备/); assert.equal(run.log, '');
    await assert.rejects(() => fs.access(path.join(f.root, 'build-work', run.id, 'result.json')));
  } finally { await f.cleanup(); }
});
test('HTTP template and parameter editing are connected and new templates never overwrite existing files', async () => {
  const f = await fixture(), { app, builds } = await createApp(f.root), server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${f.id}`;
  const send = (url: string, method: string, body: unknown) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const first = await send(`${base}/templates/plate`, 'POST', {}); assert.equal(first.status, 201);
    const { source } = await first.json();
    const params = await fetch(`${base}/parameters?source=${encodeURIComponent(source)}`).then(r => r.json());
    const changed = await send(`${base}/parameters`, 'PUT', { source, hash: params.hash, values: { width: 100, height: 60, thickness: 6, hole_diameter: 20 } }); assert.equal(changed.status, 200);
    assert.equal((await changed.json()).document.parameters[0].value, 100);
    assert.equal((await send(`${base}/parameters`, 'PUT', { source, hash: params.hash, values: {} })).status, 409);
    const second = await send(`${base}/templates/plate`, 'POST', {}); assert.notEqual((await second.json()).source, source);
    assert.equal((await f.parameters.read(f.id, source)).document?.parameters[0].value, 100);
    assert.match(await fs.readFile(path.join(f.workspace, source), 'utf8'), /with_suffix\('\.parameters.json'\)/);
    const other = await f.store.createProject('Other'); assert.equal((await fetch(base.replace(f.id, other.id) + `/parameters?source=${encodeURIComponent(source)}`)).status, 404);
  } finally { await builds.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await f.cleanup(); }
});
