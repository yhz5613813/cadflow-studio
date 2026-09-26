import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, loadSkillsFromDir, type AgentSession } from '@earendil-works/pi-coding-agent';
import type { Message, Status } from '../shared/types.js';
import { Store, HttpError } from './storage.js';
import { Plugins } from './plugins.js';
import { Events } from './events.js';
import { Runtime } from './runtime.js';
import { Thermal } from './thermal.js';
import { builtInSkillPaths } from './builtin.js';
import { ChatGPTAuth } from './login.js';
import { History } from './history.js';

const contentText = (content: unknown): string => Array.isArray(content) ? content.filter(c => c && c.type === 'text').map(c => c.text).join('\n') : typeof content === 'string' ? content : '';
export class PiHarness {
  private sessions = new Map<string, AgentSession>();
  private running = new Set<string>();
  private runtimePromise?: Promise<ModelRuntime>;
  readonly agentDir: string;
  readonly chatGPT = new ChatGPTAuth(() => this.runtime(), async () => {
    await this.store.saveSettings({ provider: 'openai-codex', model: 'gpt-6-astra', thinking: 'medium' });
  });
  constructor(readonly store: Store, readonly plugins: Plugins, readonly events: Events, readonly history = new History(store)) {
    this.agentDir = process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  }
  runtime() {
    return this.runtimePromise ??= this.createRuntime().catch(e => { this.runtimePromise = undefined; throw e; });
  }
  private async createRuntime() {
    const runtime = await ModelRuntime.create({ authPath: path.join(this.agentDir, 'auth.json'), modelsPath: path.join(this.agentDir, 'models.json'), modelsStorePath: path.join(this.store.root, 'model-catalog.json'), allowModelNetwork: false, signal: AbortSignal.timeout(20000) });
    if (process.env.STUDIO_MODEL_BASE_URL && process.env.STUDIO_MODEL_ID) {
      runtime.registerProvider('studio', {
        baseUrl: process.env.STUDIO_MODEL_BASE_URL, api: 'openai-completions',
        apiKey: process.env.STUDIO_MODEL_API_KEY || process.env.OPENAI_API_KEY || 'local',
        models: [{ id: process.env.STUDIO_MODEL_ID, name: process.env.STUDIO_MODEL_ID, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
      });
    }
    return runtime;
  }
  isBusy(id: string) { return this.running.has(id); }
  async connectOpenAI(apiKey: string) {
    await this.invalidate();
    const runtime = await this.runtime();
    const model = runtime.getModel('openai', 'gpt-6-astra');
    if (!model) throw new HttpError(400, 'pi 模型目录中没有 GPT-6 Astra');
    // Test with a per-request key before changing the active credentials/model.
    const result = await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Reply with OK only.', timestamp: Date.now() }] }, { apiKey, reasoning: 'low', maxTokens: 1024, signal: AbortSignal.timeout(45000) }).catch(error => {
      throw new HttpError(400, `GPT-6 连接测试失败：${String((error as Error).message).split(apiKey).join('[redacted]')}`);
    });
    if (result.stopReason === 'error' || result.stopReason === 'aborted' || !contentText(result.content).trim()) {
      const message = (result.errorMessage || '模型没有返回文本，请重试').split(apiKey).join('[redacted]');
      throw new HttpError(400, `GPT-6 连接测试失败：${message}`);
    }
    await this.invalidate();
    await runtime.setRuntimeApiKey('openai', apiKey, { signal: AbortSignal.timeout(15000) });
    await this.store.saveSettings({ provider: 'openai', model: model.id, thinking: 'medium' });
  }
  async connectProvider(baseUrl: string, model: string, apiKey: string) {
    await this.invalidate();
    const runtime = await this.runtime();
    runtime.registerProvider('studio', { baseUrl, api: 'openai-completions', apiKey,
      models: [{ id: model, name: model, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }] });
    await runtime.setRuntimeApiKey('studio', apiKey, { signal: AbortSignal.timeout(15000) });
    await this.store.saveSettings({ provider: 'studio', model, thinking: 'off' });
  }
  async status(): Promise<Status> {
    const runtime = await this.runtime();
    const available = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(15000) });
    const settings = await this.store.settings();
    return { pi: '0.85.1', platform: `${process.platform}/${process.arch}`, models: available.map(m => ({ provider: m.provider, id: m.id, name: m.name })), settings, hasCredentials: available.length > 0, cadPlatformSupported: (process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && process.arch === 'arm64'), busyProjects: [...this.running] };
  }
  async invalidate() {
    if (this.chatGPT.active) throw new HttpError(409, '请先完成或取消 ChatGPT 登录');
    if (this.running.size) throw new HttpError(409, '请先停止正在运行的任务，再修改模型或插件');
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
  private async session(id: string) {
    const existing = this.sessions.get(id); if (existing) return existing;
    const runtime = await this.runtime();
    const settings = await this.store.settings();
    const cadRuntime = await new Runtime(this.store.root).config();
    const thermalRuntime = await new Thermal(this.store, this.history, this.events).config();
    const available = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(15000) });
    const model = settings.provider && settings.model ? available.find(m => m.provider === settings.provider && m.id === settings.model) : available[0];
    if (!model) throw new HttpError(400, '尚未配置可用模型。请在设置中选择已登录 pi 的模型，或在 .env 配置 API Key 后重启。');
    const cwd = this.store.workspace(id);
    const builtIn = (await builtInSkillPaths()).flatMap(dir => loadSkillsFromDir({ dir, source: 'studio-builtin' }).skills);
    const extensions = (await this.plugins.skillPaths()).flatMap(dir => loadSkillsFromDir({ dir, source: 'studio-plugin' }).skills);
    const skills = [...builtIn, ...extensions.filter(skill => !builtIn.some(core => core.name === skill.name))];
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 }, enableSkillCommands: true });
    const loader = new DefaultResourceLoader({
      cwd, agentDir: path.join(this.store.root, 'pi-config'), settingsManager,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      skillsOverride: () => ({ skills, diagnostics: [] }),
      appendSystemPrompt: [
        'Studio supports numeric parameter forms through a sidecar next to each Python entry: model.py reads model.parameters.json via Path(__file__).with_suffix(".parameters.json"). Format: {version:1,title:"Part",parameters:[{name:"width",label:"Width",type:"number",unit:"mm",value:80,min:5,max:1000,step:1}],constraints:[]}. type is number or integer; units are mm,cm,m,in,deg,unitless. Optional linear constraints use {terms:{width:1,hole_diameter:-1},min:2,message:"Leave 1 mm per side"}; all terms must use the same unit. The script must actually consume the values and validate geometry after building; declaring a sidecar alone does not establish parameter binding. The build UI validates and snapshots the sidecar, preserves hashes/values per run, and keeps failed outputs separate. Maintain the script and its schema together. Do not claim JSON changes prove a geometric change.',
        'You are the coding agent inside CadFlow Studio, a local CAD workspace. Respond in the user\'s language. Read the installed skill relevant to the task before using its API. Keep project code and generated files inside the current working directory. Never modify an installed plugin, another project, global configuration, or credentials. CadFlow is an integral, bundled modeling capability of this application. Always read its built-in skill for CadFlow tasks. Additional extensions are optional; explain when a task requires a missing extension.',
        'Ordinary Python files are the editable source of truth. Use the terminal to run programs, inspect errors, and verify geometry. The browser can preview STEP files directly using a local OCCT WebAssembly importer, including file-specific face mapping. This is independent of the Python CadFlow runtime: browser STEP import does not mean CadFlow modeling is installed. For portable preview, also export a binary GLB or STL alongside the STEP deliverable, preferably under artifacts/. GLB should embed its buffers. You may also write a JSON measurement report. The UI auto-discovers these files; never claim that a file exists or that geometry was validated before checking it. Geometry face selection in this UI is mesh-triangle selection unless explicit topology metadata exists; do not interpret triangle indices as BREP face IDs.',
        `The host platform is ${process.platform}/${process.arch}. ${process.platform === 'win32' ? 'Use PowerShell for terminal operations. Probe the configured CadFlow interpreter before modeling; a local Windows build may be installed.' : 'Use an isolated project-local Python environment when required by a skill.'}`,
        `Configured CadFlow Python: ${cadRuntime.executable}. Configured thermal-sim Python: ${thermalRuntime.executable}. Use absolute interpreter paths. Read the bundled thermal-sim skill before thermal work. thermal-case.json is the editable Studio case {source,units,config}; update it when changing simulation conditions, then the user can reopen Thermal Simulation to load it. Results saved under simulations/<run>/ contain a source hash, source geometry, config and report. Never pass Studio preview face indices as thermal mesh indices; use semantic selectors or inspect the thermal mesh. Export STEP/STL from the same modeling source and rerun simulation after geometry changes.`,
      ],
    });
    await loader.reload();
    const thinkingLevel = model.id === 'gpt-6-astra' && ['off', 'minimal'].includes(settings.thinking) ? 'medium' : settings.thinking;
    const created = await createAgentSession({ cwd, agentDir: path.join(this.store.root, 'pi-config'), modelRuntime: runtime, model, thinkingLevel, resourceLoader: loader, settingsManager, sessionManager: SessionManager.continueRecent(cwd, path.join(this.store.projectRoot(id), 'sessions')), tools: ['read', 'write', 'edit', 'grep', 'find', 'ls', process.platform === 'win32' ? 'powershell' : 'bash'] });
    this.sessions.set(id, created.session); return created.session;
  }
  async prompt(id: string, text: string, selection?: unknown) {
    if (this.chatGPT.active) throw new HttpError(409, '请先完成或取消 ChatGPT 登录');
    await this.store.project(id);
    if (this.running.has(id)) throw new HttpError(409, 'Agent 正在运行，请停止后再发送');
    const release = this.store.acquire(id);
    this.running.add(id);
    let session: AgentSession;
    try {
      await this.history.recover(id);
      session = await this.session(id);
      await this.history.snapshot(id, `Agent 修改前 · ${text.slice(0, 70)}`, 'before-agent');
    } catch (e) { this.running.delete(id); release(); throw e; }
    const user: Message = { id: randomUUID(), role: 'user', text, timestamp: Date.now() };
    try { await this.store.addMessage(id, user); }
    catch (e) { this.running.delete(id); release(); throw e; }
    this.events.emit(id, 'message', user as unknown as Record<string, unknown>);
    this.events.emit(id, 'run_start', {});
    void this.execute(id, session, text, selection, release);
    return { accepted: true };
  }
  private async execute(id: string, session: AgentSession, text: string, selection: unknown, release: () => void) {
    let assistantId = randomUUID();
    const writeQueue: Promise<unknown>[] = [];
    const save = (m: Message) => { writeQueue.push(this.store.addMessage(id, m)); this.events.emit(id, 'message', m as unknown as Record<string, unknown>); };
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'message_start' && event.message.role === 'assistant') assistantId = randomUUID();
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') this.events.emit(id, 'delta', { id: assistantId, text: event.assistantMessageEvent.delta });
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const message = event.message;
        const result = contentText(message.content);
        if (result || message.errorMessage) save({ id: assistantId, role: 'assistant', text: result || message.errorMessage || '模型返回错误', timestamp: Date.now(), error: message.stopReason === 'error' });
      }
      if (event.type === 'tool_execution_start') this.events.emit(id, 'tool_start', { id: event.toolCallId, toolName: event.toolName, args: event.args });
      if (event.type === 'tool_execution_update') this.events.emit(id, 'tool_update', { id: event.toolCallId, text: contentText(event.partialResult?.content).slice(-16000) });
      if (event.type === 'tool_execution_end') save({ id: event.toolCallId, role: 'tool', text: contentText(event.result?.content).slice(0, 64000), toolName: event.toolName, error: event.isError, timestamp: Date.now() });
    });
    const timer = setTimeout(() => void session.abort(), 20 * 60 * 1000);
    try {
      const lastRestore = (await this.history.list(id)).find(revision => revision.kind === 'after-restore');
      const restoreContext = lastRestore ? `\n\nWorkspace state notice: project files were restored at ${lastRestore.createdAt} to revision "${lastRestore.label}". Conversation history was retained and may describe newer files that no longer exist. Read current files before editing; disk contents are authoritative.` : '';
      const prompt = (selection ? `${text}\n\nUser-selected viewport context: bounds and points are preview mesh measurements. If cadFace is present, it maps triangles to a source STEP face through the named importer, keyed by the file SHA-256 and mesh/face indices; it is NOT a CadFlow native face ID or recovered feature history. Verify the file hash and inspect its geometry before using this selection for CAD edits. Without cadFace, triangle is only a display mesh triangle index.\n${JSON.stringify(selection).slice(0, 6000)}` : text) + restoreContext;
      await session.prompt(prompt);
    } catch (e) { save({ id: randomUUID(), role: 'system', text: (e as Error).message, timestamp: Date.now(), error: true }); }
    finally {
      clearTimeout(timer); unsubscribe();
      await Promise.allSettled(writeQueue); await this.store.touch(id).catch(() => {});
      try { await this.history.snapshot(id, `Agent 运行后 · ${text.slice(0, 70)}`, 'after-agent'); }
      catch (e) { const warning: Message = { id: randomUUID(), role: 'system', text: `运行后版本保存失败：${(e as Error).message}。修改前版本仍保留。`, timestamp: Date.now(), error: true }; await this.store.addMessage(id, warning).catch(() => {}); this.events.emit(id, 'message', warning as unknown as Record<string, unknown>); }
      release();
      this.running.delete(id); this.events.emit(id, 'run_end', {});
      this.events.emit(id, 'artifacts_changed', {});
    }
  }
  async stop(id: string) { await this.sessions.get(id)?.abort(); }
}
