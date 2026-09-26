import express from 'express';
import { Thermal } from './thermal.js';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { Store, safePath, scanArtifacts, HttpError, jsonRead, jsonWrite } from './storage.js';
import { Plugins } from './plugins.js';
import { Events } from './events.js';
import { PiHarness } from './harness.js';
import { History } from './history.js';
import { validateArchive } from './scene-package.js';
import { Reviews } from './reviews.js';
import { Builds } from './builds.js';
import { Parameters } from './parameters.js';
import { Measurements } from './measurements.js';

export async function createApp(dataRoot: string) {
  const store = new Store(dataRoot); await store.init();
  const history = new History(store);
  const reviews = new Reviews(store, history);
  const parameters = new Parameters(store, history);
  const measurements = new Measurements(store, history);
  for (const project of await store.projects()) await history.recover(project.id);
  const plugins = new Plugins(dataRoot), events = new Events(), harness = new PiHarness(store, plugins, events, history);
  const builds = new Builds(store, history, events); await builds.recover();
  const thermal = new Thermal(store, history, events); await thermal.recover();
  const modify = async <T>(id: string, action: () => Promise<T>) => {
    const release = store.acquire(id);
    try { await history.recover(id); return await action(); } finally { release(); }
  };
  const app = express(); app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    const host = req.hostname;
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return res.status(403).json({ error: '仅允许本机访问' });
    const origin = req.get('origin');
    if (origin) { try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: '跨站请求被拒绝' }); } catch { return res.status(403).json({ error: '无效请求来源' }); } }
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  app.use(express.json({ limit: '8mb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/projects/:id/measurements', async (req, res) => res.json(await measurements.read(req.params.id)));
  app.post('/api/projects/:id/measurements', async (req, res) => {
    const value = await measurements.change(req.params.id, req.body.etag, { add: req.body.measurement });
    events.emit(req.params.id, 'artifacts_changed', {}); res.status(201).json(value);
  });
  app.delete('/api/projects/:id/measurements/:measurement', async (req, res) => {
    const value = await measurements.change(req.params.id, req.body.etag, { remove: req.params.measurement });
    events.emit(req.params.id, 'artifacts_changed', {}); res.json(value);
  });
  app.get('/api/runtime', async (_req, res) => res.json(await builds.runtime.config()));
  app.post('/api/runtime/probe', async (req, res) => res.json(await builds.runtime.probe(req.body.executable)));
  app.put('/api/runtime', async (req, res) => res.json(await builds.runtime.save(req.body.executable)));
  app.get('/api/projects/:id/builds', async (req, res) => res.json(await builds.list(req.params.id)));
  app.post('/api/projects/:id/builds', async (req, res) => res.status(202).json(await builds.start(req.params.id, req.body.source, req.body.expectedSource, req.body.expectedParameters)));
  app.get('/api/projects/:id/parameters', async (req, res) => res.json(await parameters.read(req.params.id, req.query.source)));
  app.put('/api/projects/:id/parameters', async (req, res) => {
    const value = await parameters.save(req.params.id, req.body.source, req.body.hash, req.body.values);
    events.emit(req.params.id, 'artifacts_changed', {}); events.emit(req.params.id, 'history_changed', {}); res.json(value);
  });
  app.post('/api/projects/:id/templates/plate', async (req, res) => {
    const value = await parameters.template(req.params.id);
    events.emit(req.params.id, 'artifacts_changed', {}); events.emit(req.params.id, 'history_changed', {}); res.status(201).json(value);
  });
  app.get('/api/projects/:id/builds/:run', async (req, res) => res.json(await builds.read(req.params.id, req.params.run)));
  app.post('/api/projects/:id/builds/:run/cancel', async (req, res) => res.json(await builds.cancel(req.params.id, req.params.run)));
  app.post('/api/projects/:id/builds/:run/publish', async (req, res) => res.json(await builds.publish(req.params.id, req.params.run)));
  app.get('/api/projects/:id/builds/:run/file', async (req, res) => {
    const file = String(req.query.path || '');
    res.set('X-Content-Type-Options', 'nosniff').attachment(path.basename(file)).send(await builds.file(req.params.id, req.params.run, file));
  });
  app.post('/api/scene-package/validate', express.raw({ type: 'application/octet-stream', limit: '128mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, '需要场景包二进制文件');
    try { res.json(await validateArchive(req.body)); }
    catch (error) { throw new HttpError(422, (error as Error).message); }
  });
  app.get('/api/thermal/runtime', async (_req,res) => res.json(await thermal.config()));
  app.post('/api/thermal/runtime/probe', async (req,res) => res.json(await thermal.probe(req.body.executable)));
  app.put('/api/thermal/runtime', async (req,res) => res.json(await thermal.saveRuntime(req.body.executable)));
  app.get('/api/projects/:id/thermal/case', async (req,res) => {
    await store.project(req.params.id);
    const file=await safePath(store.workspace(req.params.id),'thermal-case.json',false);
    res.json(await jsonRead(file,{}));
  });
  app.put('/api/projects/:id/thermal/case', async (req,res) => {
    const {source,units,config}=req.body;
    if(typeof source!=='string'||!['mm','cm','m'].includes(units)||!config||typeof config!=='object'||Array.isArray(config))throw new HttpError(400,'无效工况');
    await modify(req.params.id,async()=>{
      await store.project(req.params.id);
      await safePath(store.workspace(req.params.id),source);
      const file=await safePath(store.workspace(req.params.id),'thermal-case.json',false);
      await history.snapshot(req.params.id,'保存热仿真工况前');
      await jsonWrite(file,{source,units,config});await store.touch(req.params.id);
      await history.snapshot(req.params.id,'保存热仿真工况');
    });
    events.emit(req.params.id,'artifacts_changed',{});res.json({ok:true});
  });
  app.get('/api/projects/:id/thermal',async(req,res)=>res.json(await thermal.list(req.params.id)));
  app.post('/api/projects/:id/thermal',async(req,res)=>res.status(202).json(await thermal.start(req.params.id,req.body)));
  app.get('/api/projects/:id/thermal/:run',async(req,res)=>res.json(await thermal.read(req.params.id,req.params.run)));
  app.post('/api/projects/:id/thermal/:run/cancel',async(req,res)=>res.json(await thermal.cancel(req.params.id,req.params.run)));
  app.post('/api/projects/:id/thermal/:run/publish',async(req,res)=>res.json(await thermal.publish(req.params.id,req.params.run)));
  app.get('/api/projects/:id/thermal/:run/file',async(req,res)=>{
    const file=String(req.query.path||'');res.set('X-Content-Type-Options','nosniff').attachment(path.basename(file)).send(await thermal.file(req.params.id,req.params.run,file));
  });
  app.get('/api/status', async (_req, res) => res.json(await harness.status()));
  app.get('/api/auth/chatgpt', (_req, res) => res.json(harness.chatGPT.status()));
  app.post('/api/auth/chatgpt', async (_req, res) => {
    if (!harness.chatGPT.active) await harness.invalidate();
    res.json(harness.chatGPT.start());
  });
  app.delete('/api/auth/chatgpt/:id', async (req, res) => res.json(await harness.chatGPT.cancel(String(req.params.id))));
  app.post('/api/auth/chatgpt/:id/callback', (req, res) => {
    if (typeof req.body.callbackUrl !== 'string' || req.body.callbackUrl.length > 10000) throw new HttpError(400, '无效回跳地址');
    res.json(harness.chatGPT.submitCallback(String(req.params.id), req.body.callbackUrl.trim()));
  });
  app.post('/api/provider/openai', async (req, res) => {
    if (typeof req.body.apiKey !== 'string' || !req.body.apiKey.trim()) throw new HttpError(400, '请填写 OpenAI API Key');
    await harness.connectOpenAI(req.body.apiKey.trim()); res.json({ ok: true, model: 'gpt-6-astra' });
  });
  app.post('/api/provider', async (req, res) => {
    const { baseUrl, model, apiKey } = req.body;
    if (typeof baseUrl !== 'string' || typeof model !== 'string' || !model.trim() || typeof apiKey !== 'string' || !apiKey.trim()) throw new HttpError(400, '请填写服务地址、模型名称和 API Key');
    let url: URL; try { url = new URL(baseUrl); } catch { throw new HttpError(400, '服务地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HttpError(400, '服务地址必须是 HTTP(S) URL');
    await harness.connectProvider(url.toString().replace(/\/$/, ''), model.trim(), apiKey.trim()); res.json({ ok: true });
  });
  app.put('/api/settings', async (req, res) => {
    const { provider, model, thinking } = req.body;
    if (typeof provider !== 'string' || typeof model !== 'string' || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new HttpError(400, '无效模型设置');
    if (model === 'gpt-6-astra' && ['off', 'minimal'].includes(thinking)) throw new HttpError(400, 'GPT-6 的思考级别请选择 low 或更高');
    await harness.invalidate(); await store.saveSettings({ provider, model, thinking }); res.json({ ok: true });
  });
  app.get('/api/projects', async (_req, res) => res.json(await store.projects()));
  app.post('/api/projects', async (req, res) => res.status(201).json(await store.createProject(String(req.body.name || '新设计'))));
  app.get('/api/projects/:id', async (req, res) => res.json(await store.project(req.params.id)));
  app.get('/api/projects/:id/messages', async (req, res) => res.json(await store.messages(req.params.id)));
  app.get('/api/projects/:id/events', async (req, res) => { await store.project(req.params.id); events.connect(req.params.id, res, Number(req.get('last-event-id') || 0)); });
  app.post('/api/projects/:id/prompt', async (req, res) => {
    if (typeof req.body.text !== 'string' || !req.body.text.trim() || req.body.text.length > 40000) throw new HttpError(400, '请输入 1–40000 字符的消息');
    res.status(202).json(await harness.prompt(req.params.id, req.body.text, req.body.selection));
  });
  app.post('/api/projects/:id/stop', async (req, res) => { await store.project(req.params.id); await harness.stop(req.params.id); res.json({ ok: true }); });
  app.get('/api/projects/:id/files', async (req, res) => { await store.project(req.params.id); res.json(await scanArtifacts(store.workspace(req.params.id))); });
  app.get('/api/projects/:id/annotations', async (req, res) => res.json(await reviews.read(req.params.id)));
  app.post('/api/projects/:id/annotations', async (req, res) => {
    const doc = await reviews.change(req.params.id, req.body.etag, { create: req.body.note });
    events.emit(req.params.id, 'annotations_changed', {}); events.emit(req.params.id, 'artifacts_changed', {}); res.status(201).json(doc);
  });
  app.patch('/api/projects/:id/annotations/:note', async (req, res) => {
    const doc = await reviews.change(req.params.id, req.body.etag, { update: req.params.note, value: req.body.note });
    events.emit(req.params.id, 'annotations_changed', {}); events.emit(req.params.id, 'artifacts_changed', {}); res.json(doc);
  });
  app.delete('/api/projects/:id/annotations/:note', async (req, res) => {
    const doc = await reviews.change(req.params.id, req.body.etag, { remove: req.params.note });
    events.emit(req.params.id, 'annotations_changed', {}); events.emit(req.params.id, 'artifacts_changed', {}); res.json(doc);
  });
  app.get('/api/projects/:id/history', async (req, res) => res.json(await history.list(req.params.id)));
  app.post('/api/projects/:id/history', async (req, res) => {
    const id = req.params.id;
    res.status(201).json(await modify(id, () => history.snapshot(id, String(req.body.label || '手动保存版本'))));
    events.emit(id, 'history_changed', {});
  });
  app.get('/api/projects/:id/history/:revision/compare', async (req, res) => res.json(await history.compare(req.params.id, req.params.revision)));
  app.get('/api/projects/:id/history/:revision/diff', async (req, res) => res.json(await history.diff(req.params.id, req.params.revision, String(req.query.path || ''))));
  app.get('/api/projects/:id/history/:revision/file', async (req, res) => {
    const bytes = await history.file(req.params.id, req.params.revision, String(req.query.path || ''));
    res.set('X-Content-Type-Options', 'nosniff').type('application/octet-stream').send(bytes);
  });
  app.post('/api/projects/:id/history/:revision/restore', async (req, res) => {
    const id = req.params.id;
    if (typeof req.body.fingerprint !== 'string') throw new HttpError(400, '请先查看版本差异');
    const result = await modify(id, async () => {
      const value = await history.restore(id, req.params.revision, req.body.fingerprint);
      await store.touch(id);
      await store.addMessage(id, { id: randomUUID(), role: 'system', text: `项目文件已恢复到「${value.restored.label}」。恢复前版本「${value.backup.label}」已保留。对话记录不回退。`, timestamp: Date.now() });
      return value;
    });
    events.emit(id, 'artifacts_changed', {}); events.emit(id, 'history_changed', {});
    res.json(result);
  });
  app.get('/api/projects/:id/file', async (req, res) => {
    await store.project(req.params.id);
    const file = await safePath(store.workspace(req.params.id), String(req.query.path || ''));
    if (String(req.query.text) === '1') {
      if (!/\.(py|ts|js|json|md|txt|yaml|toml)$/i.test(file)) throw new HttpError(400, '这个文件不是可编辑文本');
      if ((await fs.stat(file)).size > 2_000_000) throw new HttpError(413, '源文件超过 2 MB');
      res.type('text/plain').send(await fs.readFile(file, 'utf8'));
    } else { res.set('X-Content-Type-Options', 'nosniff'); res.type('application/octet-stream'); res.sendFile(file, { dotfiles: 'allow' }); }
  });
  app.put('/api/projects/:id/file', async (req, res) => {
    await store.project(req.params.id);
    if (harness.isBusy(req.params.id)) throw new HttpError(409, 'Agent 正在修改项目，请先停止任务');
    const relative = String(req.body.path || '');
    if (!/\.(py|json|md|txt|yaml|toml)$/i.test(relative) || typeof req.body.text !== 'string') throw new HttpError(400, '只支持保存 Python 和文本文件');
    await modify(req.params.id, async () => {
      const file = await safePath(store.workspace(req.params.id), relative, false);
      if ('baseText' in req.body) {
        const actual = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (actual !== req.body.baseText) throw new HttpError(409, '源码已被其他操作修改。请重新打开文件并合并修改后保存。');
      }
      await history.snapshot(req.params.id, `保存前 · ${relative}`, 'before-save');
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = path.join(path.dirname(file), `.studio-save-${randomUUID()}.tmp`);
      await fs.writeFile(temporary, req.body.text, 'utf8');
      try { await fs.rename(temporary, file); } finally { await fs.unlink(temporary).catch(() => {}); }
      await history.snapshot(req.params.id, `保存后 · ${relative}`, 'after-save');
      await store.touch(req.params.id);
    });
    events.emit(req.params.id, 'artifacts_changed', {}); res.json({ ok: true });
  });
  app.post('/api/projects/:id/motor-recordings', express.raw({ type: 'video/webm', limit: '128mb' }), async (req,res) => {
    const bytes=req.body;
    if(!Buffer.isBuffer(bytes)||bytes.length<32||bytes.readUInt32BE(0)!==0x1a45dfa3||!bytes.subarray(0,256).includes(Buffer.from('webm')))throw new HttpError(400,'需要有效的 WebM 视口录制');
    const id=String(req.params.id), name='induction-motor-studio.webm', relative=`recordings/${randomUUID()}/${name}`;
    await modify(id,async()=>{
      await store.project(id);
      const target=await safePath(store.workspace(id),relative,false);
      await history.snapshot(id,'保存电机视口录制前','before-import');
      await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);
      await history.snapshot(id,'电机装配与启动 · Studio 视口录制','after-import');await store.touch(id);
    });
    events.emit(id,'artifacts_changed',{});events.emit(id,'history_changed',{});res.status(201).json({path:relative,name});
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 128 * 1024 * 1024, files: 1 } });
  app.post('/api/projects/:id/upload', upload.single('file'), async (req, res) => {
    const id = String(req.params.id);
    await store.project(id);
    if (!req.file) throw new HttpError(400, '请选择一个文件');
    const name = path.basename(Buffer.from(req.file.originalname, 'latin1').toString('utf8')).replace(/[^\p{L}\p{N}._ -]/gu, '_');
    if (!/\.(glb|gltf|stl|obj|step|stp|scadpkg|zip|py|json|png|jpg|jpeg|webp)$/i.test(name)) throw new HttpError(400, '不支持这个文件类型');
    const relative = `imports/${randomUUID()}/${name}`;
    const bytes = req.file.buffer;
    await modify(id, async () => {
      const target = await safePath(store.workspace(id), relative, false);
      await history.snapshot(id, `导入前 · ${name}`, 'before-import');
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
      await history.snapshot(id, `导入后 · ${name}`, 'after-import');
      await store.touch(id);
    });
    events.emit(id, 'artifacts_changed', {}); res.json({ path: relative, name });
  });
  app.get('/api/plugins', async (_req, res) => res.json(await plugins.list()));
  app.post('/api/plugins', async (req, res) => { await harness.invalidate(); res.status(201).json(await plugins.install(String(req.body.source || ''))); });
  app.patch('/api/plugins/:id', async (req, res) => { if (typeof req.body.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值'); await harness.invalidate(); res.json(await plugins.enable(req.params.id, req.body.enabled)); });
  app.delete('/api/plugins/:id', async (req, res) => { await harness.invalidate(); await plugins.remove(req.params.id); res.json({ ok: true }); });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const error = err as Error & { status?: number; code?: string };
    const status = error.code === 'ENOENT' ? 404 : error.code === 'LIMIT_FILE_SIZE' ? 413 : error.status || 500;
    res.status(status).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '文件不能超过 128 MB' : error.message || '请求失败' });
  });
  return { app, store, plugins, harness, events, history, builds, thermal };
}
