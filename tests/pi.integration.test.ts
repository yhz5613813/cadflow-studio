import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createApp } from '../server/app.js';
import { inside } from '../server/storage.js';
import type { AddressInfo } from 'node:net';

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('real pi SDK: model stream → write tool → artifact → answer, session resume, plugin activation, cancel and HTTP boundaries', { timeout: 90000 }, async () => {
  const base = path.resolve('.studio/test-runs'); await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'integration-'));
  const oldAgentDir = process.env.PI_AGENT_DIR; process.env.PI_AGENT_DIR = path.join(root, 'pi');
  let calls = 0, lastRequest: Record<string, any> = {}, slowResponse: import('node:http').ServerResponse | undefined;
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || '{}'); lastRequest = parsed; calls++;
    assert(req.url?.endsWith('/chat/completions'));
    const latestUser = [...(parsed.messages || [])].reverse().find((m: any) => m.role === 'user');
    if (JSON.stringify(latestUser).includes('SLOW_TEST')) { slowResponse = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'studio-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const wrote = parsed.messages?.some((m: any) => m.role === 'tool');
    chunk({ role: 'assistant' });
    if (!wrote) {
      chunk({ tool_calls: [{ index: 0, id: 'write-test-1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'artifacts/pi-verified.txt', content: 'Written by the real pi SDK tool.' }) } }] });
      chunk({}, 'tool_calls');
    } else { chunk({ content: '文件已通过 pi 的 write 工具创建。' }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  const providerUrl = await listen(provider);
  const { app, store, harness, plugins, history } = await createApp(root); const server = createServer(app); const url = await listen(server);
  const post = (route: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const waitIdle = async (id: string) => { for (let i = 0; i < 180 && harness.isBusy(id); i++) await sleep(100); assert.equal(harness.isBusy(id), false, JSON.stringify(await store.messages(id))); };
  try {
    const pluginDir = path.join(root, 'plugins', 'fixture-skill'); await fs.mkdir(path.join(pluginDir, 'skills', 'fixture'), { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture-cad\ndescription: UNIQUE_PLUGIN_MARKER geometry workflows\n---\nThis skill exists to verify loading.');
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({ id: 'fixture-skill', name: 'Fixture', enabled: true, skills: [{ name: 'fixture-cad', description: 'UNIQUE_PLUGIN_MARKER geometry workflows', path: 'skills/fixture' }] }));
    const config = await post('/api/provider', { baseUrl: `${providerUrl}/v1`, model: 'studio-fixture', apiKey: 'test-only-key' }); assert.equal(config.status, 200, await config.text());
    const status = await fetch(`${url}/api/status`).then(r => r.json()); assert.equal(status.hasCredentials, true); assert(!JSON.stringify(status).includes('test-only-key'));
    const project = await post('/api/projects', { name: 'SDK integration' }).then(r => r.json());
    const controller = new AbortController(); const eventResponse = await fetch(`${url}/api/projects/${project.id}/events`, { signal: controller.signal }); let eventText = '';
    const eventReader = (async () => { try { for await (const chunk of eventResponse.body!) eventText += new TextDecoder().decode(chunk); } catch { /* aborted intentionally */ } })();
    const response = await post(`/api/projects/${project.id}/prompt`, { text: 'Create a small text file using the write tool.' }); assert.equal(response.status, 202, await response.text());
    await waitIdle(project.id); controller.abort(); await eventReader;
    assert.equal(await fs.readFile(path.join(store.workspace(project.id), 'artifacts', 'pi-verified.txt'), 'utf8'), 'Written by the real pi SDK tool.');
    assert(calls >= 2); assert(JSON.stringify(lastRequest.messages).includes('UNIQUE_PLUGIN_MARKER'));
    assert.match(JSON.stringify(lastRequest.messages.find((m: any) => m.role === 'system')), /resources.*cadflow/i, 'bundled CadFlow skill is provided without installing a plugin');
    assert(eventText.includes('tool_start')); assert(eventText.includes('run_end')); assert(eventText.includes('delta'));
    const revisions = await history.list(project.id);
    assert.equal(revisions[0].kind, 'after-agent'); assert.equal(revisions[1].kind, 'before-agent');
    assert.equal(revisions[1].files, 0);
    assert.equal((await history.file(project.id, revisions[0].id, 'artifacts/pi-verified.txt')).toString(), 'Written by the real pi SDK tool.');
    const messages = await store.messages(project.id); assert(messages.some(m => m.role === 'tool' && m.toolName === 'write')); assert(messages.some(m => m.role === 'assistant' && m.text.includes('文件已')));
    assert((await fs.readdir(path.join(store.projectRoot(project.id), 'sessions'))).some(f => f.endsWith('.jsonl')));
    await harness.invalidate(); await plugins.enable('fixture-skill', false);
    assert.equal((await post(`/api/projects/${project.id}/prompt`, { text: 'Confirm the previous file.' })).status, 202); await waitIdle(project.id);
    assert(!JSON.stringify(lastRequest.messages.find((m: any) => m.role === 'system')).includes('UNIQUE_PLUGIN_MARKER'));
    assert.match(JSON.stringify(lastRequest.messages.find((m: any) => m.role === 'system')), /resources.*cadflow/i, 'CadFlow remains available when optional extensions are disabled');
    assert(lastRequest.messages.some((m: any) => m.role === 'tool'), 'pi conversation persisted after session recreation');
    assert.equal((await post(`/api/projects/${project.id}/prompt`, { text: 'SLOW_TEST' })).status, 202);
    for (let i = 0; !slowResponse && i < 100; i++) await sleep(30);
    assert.equal((await post(`/api/projects/${project.id}/prompt`, { text: 'second' })).status, 409);
    assert.equal((await post(`/api/projects/${project.id}/history`, { label: 'busy' })).status, 409);
    assert.equal((await post(`/api/projects/${project.id}/stop`, {})).status, 200); await waitIdle(project.id);
    assert.equal((await fetch(`${url}/api/projects/${project.id}/file?path=..%2Fproject.json`)).status, 400);
    assert.equal((await post('/api/projects', { name: 'blocked' }, { Origin: 'https://evil.example' })).status, 403);
    const form = new FormData(); form.set('file', new Blob(['solid fixture\nendsolid fixture']), 'fixture.stl');
    const uploaded = await fetch(`${url}/api/projects/${project.id}/upload`, { method: 'POST', body: form }); assert.equal(uploaded.status, 200);
    const artifact = await uploaded.json();
    const download = await fetch(`${url}/api/projects/${project.id}/file?path=${encodeURIComponent(artifact.path)}`);
    assert.equal(download.status, 200, 'files inside the hidden .studio data root must be downloadable');
    assert.equal(await download.text(), 'solid fixture\nendsolid fixture');
    const files = await fetch(`${url}/api/projects/${project.id}/files`).then(r => r.json()); assert(files.some((f: any) => f.name.endsWith('fixture.stl')));
  } finally {
    slowResponse?.end(); for (const p of await store.projects()) await harness.stop(p.id); await harness.invalidate();
    await close(server); await close(provider); if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = oldAgentDir;
    assert(inside(base, root)); await fs.rm(root, { recursive: true, force: true });
  }
});
