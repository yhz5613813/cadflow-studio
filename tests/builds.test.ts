import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store, inside, jsonWrite } from '../server/storage.js';
import { History } from '../server/history.js';
import { Builds } from '../server/builds.js';
import { Events } from '../server/events.js';
import { Runtime } from '../server/runtime.js';
import { createApp } from '../server/app.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runProcess } from '../server/process.js';
const python = process.env.STUDIO_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
async function fixture() {
  const base = path.resolve('.studio/test-runs'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'builds-')), store = new Store(root); await store.init(); const project = await store.createProject('构建验收');
  await jsonWrite(path.join(root, 'runtime.json'), { executable: python });
  const history = new History(store), builds = new Builds(store, history, new Events()), workspace = store.workspace(project.id);
  return { root, store, history, builds, workspace, id: project.id, cleanup: async () => { await builds.dispose(); assert(inside(base, root)); await fs.rm(root, { recursive: true, force: true }); } };
}
async function finish(builds: Builds, id: string, run: string) {
  const until = Date.now() + 30000;
  while (Date.now() < until) { const value = await builds.read(id, run); if (!['preparing', 'running'].includes(value.state)) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('build did not finish');
}
test('runtime probes a real Python interpreter and rejects command strings without executing a shell', async () => {
  const f = await fixture();
  try { const runtime = new Runtime(f.root), probe = await runtime.save(python); assert.equal(probe.python, true); assert.equal(typeof probe.cadflow, 'boolean'); assert(probe.version); assert.deepEqual(await runtime.config(), { executable: python }); await assert.rejects(() => runtime.probe('python -c print(1)'), /绝对路径/); assert.equal((await runtime.probe(path.join(f.root, 'missing-python.exe'))).python, false); }
  finally { await f.cleanup(); }
});
test('real Python builds a snapshot, preserves original files and publishes verified outputs to a new project directory', async () => {
  const f = await fixture();
  try {
    const script = 'from pathlib import Path\nprint("中文构建日志",flush=True)\nPath("artifacts/result.txt").write_text("new result",encoding="utf-8")\n';
    await fs.writeFile(path.join(f.workspace, 'model.py'), script); await fs.writeFile(path.join(f.workspace, 'artifacts/result.txt'), 'original');
    const started = await f.builds.start(f.id, 'model.py', script), run = await finish(f.builds, f.id, started.id);
    assert.equal(run.state, 'succeeded', run.error + '\n' + run.log); assert.match(run.log, /中文构建日志/); assert.equal(run.exitCode, 0);
    assert.equal(run.sourceHash, createHash('sha256').update(script).digest('hex')); assert.deepEqual(run.artifacts.map(a => a.path), ['artifacts/result.txt']);
    assert.equal(await fs.readFile(path.join(f.workspace, 'artifacts/result.txt'), 'utf8'), 'original');
    const saved = await f.builds.publish(f.id, run.id); assert.equal(await fs.readFile(path.join(f.workspace, saved.path, 'artifacts/result.txt'), 'utf8'), 'new result');
    assert.deepEqual(await f.builds.publish(f.id, run.id), saved); assert.equal(await fs.readFile(path.join(f.workspace, 'artifacts/result.txt'), 'utf8'), 'original');
    assert((await f.history.list(f.id)).length >= 3);
    assert.equal((await new Builds(f.store, f.history, new Events()).list(f.id))[0].published, saved.path);
    await fs.writeFile(path.join(f.root, 'build-work', run.id, 'artifacts/result.txt'), 'tampered');
    await assert.rejects(() => f.builds.file(f.id, run.id, 'artifacts/result.txt'), /已变化/);
  } finally { await f.cleanup(); }
});
test('failed and cancelled processes cannot replace project outputs; project locks and stale source are enforced', async () => {
  const f = await fixture();
  try {
    const failure = 'from pathlib import Path\nPath("artifacts/result.txt").write_text("broken")\nraise RuntimeError("deliberate failure")\n';
    await fs.writeFile(path.join(f.workspace, 'fail.py'), failure); await fs.writeFile(path.join(f.workspace, 'artifacts/result.txt'), 'original');
    await assert.rejects(() => f.builds.start(f.id, '../fail.py', failure)); await assert.rejects(() => f.builds.start(f.id, 'fail.py', 'stale'), /源码已变化/);
    const bad = await f.builds.start(f.id, 'fail.py', failure), failed = await finish(f.builds, f.id, bad.id);
    assert.equal(failed.state, 'failed'); assert.match(failed.log, /deliberate failure/); await assert.rejects(() => f.builds.publish(f.id, bad.id), /成功产物/);
    const slow = 'import time\nprint("started",flush=True)\ntime.sleep(60)\n'; await fs.writeFile(path.join(f.workspace, 'slow.py'), slow);
    const running = await f.builds.start(f.id, 'slow.py', slow);
    await assert.rejects(() => f.builds.start(f.id, 'fail.py', failure), /项目正在修改/);
    const until = Date.now() + 20000;
    while (!(await f.builds.read(f.id, running.id)).log.includes('started') && Date.now() < until) await new Promise(r => setTimeout(r, 100));
    assert.match((await f.builds.read(f.id, running.id)).log, /started/);
    const cancelled = await f.builds.cancel(f.id, running.id); assert.equal(cancelled.state, 'cancelled');
    assert.equal(await fs.readFile(path.join(f.workspace, 'artifacts/result.txt'), 'utf8'), 'original');
    const release = f.store.acquire(f.id); release();
    const other = await f.store.createProject('另一个项目'); await assert.rejects(() => f.builds.read(other.id, running.id), /不存在/);
  } finally { await f.cleanup(); }
});
test('interrupted records are recovered without publishing partial workspace files', async () => {
  const f = await fixture();
  try {
    const id = '12345678-1234-1234-1234-123456789abc';
    await fs.mkdir(path.join(f.root, 'projects', f.id, 'builds', id), { recursive: true });
    assert.deepEqual(await f.builds.list(f.id), [], 'a newly created run directory is not visible until its initial record is committed');
    await jsonWrite(path.join(f.root, 'projects', f.id, 'builds', id, 'run.json'), { id, source: 'model.py', sourceHash: '', executable: python, createdAt: new Date().toISOString(), state: 'running', log: 'partial', truncated: false, artifacts: [] });
    await f.builds.recover(); assert.equal((await f.builds.read(f.id, id)).state, 'interrupted'); await assert.rejects(() => f.builds.publish(f.id, id), /成功产物/);
  } finally { await f.cleanup(); }
});
test('HTTP runtime, build, verified download and publish endpoints form a complete workflow', async () => {
  const f = await fixture(), { app, builds } = await createApp(f.root), server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`, url = `${base}/projects/${f.id}/builds`;
  const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const probe = await post(`${base}/runtime/probe`, { executable: python }); assert.equal(probe.status, 200); assert.equal((await probe.json()).python, true);
    const script = 'from pathlib import Path\nPath("result.json").write_text("{\\"executed\\":true}")\n';
    await fs.writeFile(path.join(f.workspace, 'model.py'), script);
    const response = await post(url, { source: 'model.py', expectedSource: script }); assert.equal(response.status, 202);
    const { id } = await response.json(), run = await finish(builds, f.id, id); assert.equal(run.state, 'succeeded', run.log);
    const download = await fetch(`${url}/${id}/file?path=result.json`); assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition') || '', /attachment/); assert.deepEqual(await download.json(), { executed: true });
    assert.equal((await fetch(`${url}/${id}/file?path=../runtime.json`)).status, 404);
    const published = await post(`${url}/${id}/publish`, {}); assert.equal(published.status, 200); assert((await published.json()).path.startsWith('builds/'));
    assert.equal((await fetch(url).then(r => r.json()))[0].state, 'succeeded');
  } finally { await builds.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});
test('publish resumes metadata and history after files were committed but project touch failed', async t => {
  const f = await fixture();
  try {
    const script = 'from pathlib import Path\nPath("result.txt").write_text("complete")\n';
    await fs.writeFile(path.join(f.workspace, 'model.py'), script);
    const started = await f.builds.start(f.id, 'model.py', script), run = await finish(f.builds, f.id, started.id);
    const touch = t.mock.method(f.store, 'touch', async () => { throw new Error('transient metadata failure'); });
    await assert.rejects(() => f.builds.publish(f.id, run.id), /metadata failure/); touch.mock.restore();
    const partial = await f.builds.read(f.id, run.id); assert(partial.published); assert.equal(partial.publishedRevision, undefined);
    const repaired = await f.builds.publish(f.id, run.id); assert.equal(repaired.path, partial.published);
    assert((await f.builds.read(f.id, run.id)).publishedRevision);
    assert.equal(await fs.readFile(path.join(f.workspace, repaired.path, 'result.txt'), 'utf8'), 'complete');
  } finally { await f.cleanup(); }
});
test('Windows atomic JSON replacement retries transient sharing failures without deleting the target', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture();
  try {
    const file = path.join(f.root, 'atomic.json'); await jsonWrite(file, { version: 1 });
    const rename = fs.rename.bind(fs); let failures = 0;
    t.mock.method(fs, 'rename', async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
      if (to === file && failures++ < 2) { assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1 }); throw Object.assign(new Error('sharing violation'), { code: 'EPERM' }); }
      return rename(from, to);
    });
    await jsonWrite(file, { version: 2 }); assert.equal(failures, 3); assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 2 });
  } finally { await f.cleanup(); }
});
test('cancel terminates a Python process tree before a background child can write its artifact', async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    const child = 'import time;from pathlib import Path;time.sleep(5);Path("late.txt").write_text("should not exist")';
    const parent = `import subprocess,sys,time\nsubprocess.Popen([sys.executable,"-c",${JSON.stringify(child)}])\nprint("child-started",flush=True)\ntime.sleep(60)\n`;
    const result = await runProcess(python, ['-u', '-c', parent], { cwd: f.root, signal: controller.signal, timeout: 12000, output: text => { if (text.includes('child-started')) controller.abort(); } });
    assert(controller.signal.aborted); assert.equal(result.timedOut, false); assert.notEqual(result.code, 0);
    await assert.rejects(fs.access(path.join(f.root, 'late.txt')));
    const probe = await f.builds.runtime.probe(python); assert(!probe.message.includes('\uFFFD')); assert.match(probe.message, /CadFlow/);
  } finally { await f.cleanup(); }
});
