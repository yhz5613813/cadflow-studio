import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createApp } from '../server/app.js';
import { inside } from '../server/storage.js';

const listen = (s: Server) => new Promise<string>(resolve => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const close = (s: Server) => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); });
test('GPT-6 Responses: verify before activating, reject bad key, execute pi tool', { timeout: 90000 }, async () => {
  const base = path.resolve('.studio/test-runs'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'openai-'));
  const previousAgent = process.env.PI_AGENT_DIR; process.env.PI_AGENT_DIR = path.join(root, 'pi');
  const requests: any[] = [];
  const fixture = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    if (req.headers.authorization !== 'Bearer fixture-good') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Invalid fixture-bad key', type: 'invalid_request_error' } })); return; }
    assert.equal(req.url, '/v1/responses'); assert.equal(body.model, 'gpt-6-astra');
    assert(['low', 'medium'].includes(body.reasoning.effort));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const probe = JSON.stringify(body.input).includes('Reply with OK only.');
    const wrote = body.input.some((item: any) => item.type === 'function_call_output');
    const item = probe || wrote
      ? { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: probe ? 'OK' : 'Created the file.', annotations: [] }] }
      : { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'write', arguments: JSON.stringify({ path: 'artifacts/gpt6.txt', content: 'Real pi tool via Responses fixture.' }), status: 'completed' };
    event('response.created', { response: { id: 'resp_fixture' } });
    event('response.output_item.added', { output_index: 0, item: { ...item, ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } });
    if (item.type === 'message') event('response.output_text.delta', { output_index: 0, delta: item.content![0].text });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
    res.end();
  });
  const fixtureUrl = await listen(fixture);
  const { app, harness, store } = await createApp(root); const server = createServer(app); const url = await listen(server);
  const post = (route: string, body: unknown) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const runtime = await harness.runtime();
    const gpt6 = runtime.getModel('openai', 'gpt-6-astra')!;
    assert.equal(gpt6.api, 'openai-responses');
    runtime.registerProvider('openai', { baseUrl: `${fixtureUrl}/v1`, models: [{ ...gpt6, baseUrl: `${fixtureUrl}/v1` }] });
    const before = await store.settings();
    const rejected = await post('/api/provider/openai', { apiKey: 'fixture-bad' });
    assert.equal(rejected.status, 400); assert(!(await rejected.text()).includes('fixture-bad'));
    assert.deepEqual(await store.settings(), before);
    const accepted = await post('/api/provider/openai', { apiKey: 'fixture-good' });
    assert.equal(accepted.status, 200, await accepted.text());
    assert.deepEqual(await store.settings(), { provider: 'openai', model: 'gpt-6-astra', thinking: 'medium' });
    const status = await fetch(url + '/api/status').then(r => r.json()); assert(status.hasCredentials); assert(!JSON.stringify(status).includes('fixture-good'));
    const invalid = await fetch(url + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'openai', model: 'gpt-6-astra', thinking: 'off' }) }); assert.equal(invalid.status, 400);
    const project = await store.createProject('Responses integration');
    assert.equal((await post(`/api/projects/${project.id}/prompt`, { text: 'Create a file using the write tool.' })).status, 202);
    for (let i = 0; i < 200 && harness.isBusy(project.id); i++) await new Promise(r => setTimeout(r, 100));
    assert(!harness.isBusy(project.id), JSON.stringify(await store.messages(project.id)));
    assert.equal(await fs.readFile(path.join(store.workspace(project.id), 'artifacts/gpt6.txt'), 'utf8'), 'Real pi tool via Responses fixture.');
    assert(requests.some(body => body.input.some((item: any) => item.type === 'function_call_output')));
    assert((await store.messages(project.id)).some(m => m.role === 'assistant' && m.text === 'Created the file.'));
    assert(!(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).includes('fixture-good'));
  } finally {
    for (const p of await store.projects()) await harness.stop(p.id); await harness.invalidate();
    await close(server); await close(fixture);
    if (previousAgent === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = previousAgent;
    assert(inside(base, root)); await fs.rm(root, { recursive: true, force: true });
  }
});
