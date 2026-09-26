import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Artifact, Message, Project, Settings } from '../shared/types.js';

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const jsonRead = async <T>(file: string, fallback: T): Promise<T> => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
};
export async function jsonWrite(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '') || attempt >= 8) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}
export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function safePath(root: string, relative: string, mustExist = true): Promise<string> {
  if (!relative || relative.includes('\0') || /(^|[/\\])\.\.?([/\\]|$)/.test(relative) || path.isAbsolute(relative)) throw new HttpError(400, '无效文件路径');
  const candidate = path.resolve(root, relative);
  if (!inside(root, candidate)) throw new HttpError(403, '文件必须位于当前项目中');
  const rootReal = await fs.realpath(root);
  let current = root;
  for (const part of path.relative(root, candidate).split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new HttpError(403, '不允许通过符号链接访问项目外文件');
      if (!inside(rootReal, await fs.realpath(current))) throw new HttpError(403, '路径超出项目范围');
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !mustExist) break; throw e; }
  }
  return candidate;
}
export const supportedModels = /\.(glb|gltf|stl|obj|step|stp|scadpkg|zip)$/i;
const excluded = new Set(['.git', '.pi', '.studio', '.venv', 'venv', 'node_modules', '__pycache__']);
export async function scanArtifacts(root: string): Promise<Artifact[]> {
  const found: Artifact[] = [];
  async function visit(dir: string, depth: number) {
    if (depth > 6 || found.length > 1000) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || excluded.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await visit(file, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(file);
      const kind = supportedModels.test(entry.name) ? 'model' : /\.(py|ts|js|json|md|txt|yaml|toml)$/i.test(entry.name) ? 'source' : /\.(png|jpg|jpeg|webp)$/i.test(entry.name) ? 'image' : 'file';
      found.push({ path: path.relative(root, file).split(path.sep).join('/'), name: entry.name, size: stat.size, modified: stat.mtimeMs, kind });
    }
  }
  await visit(root, 0);
  return found.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
}
export class Store {
  constructor(readonly root: string) {}
  private mutations = new Set<string>();
  acquire(id: string): () => void {
    this.projectRoot(id);
    if (this.mutations.has(id)) throw new HttpError(409, '项目正在修改，请稍后重试或停止 Agent');
    this.mutations.add(id);
    return () => { this.mutations.delete(id); };
  }
  async init() { await fs.mkdir(path.join(this.root, 'projects'), { recursive: true }); }
  projectRoot(id: string) {
    if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new HttpError(400, '无效项目编号');
    return path.join(this.root, 'projects', id);
  }
  workspace(id: string) { return path.join(this.projectRoot(id), 'workspace'); }
  async project(id: string): Promise<Project> {
    const project = await jsonRead<Project | null>(path.join(this.projectRoot(id), 'project.json'), null);
    if (!project) throw new HttpError(404, '项目不存在');
    return project;
  }
  async projects(): Promise<Project[]> {
    const ids = await fs.readdir(path.join(this.root, 'projects'));
    const projects = await Promise.all(ids.map(id => jsonRead<Project | null>(path.join(this.projectRoot(id), 'project.json'), null)));
    return projects.filter((p): p is Project => !!p).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async createProject(name: string): Promise<Project> {
    const project = { id: randomUUID(), name: name.trim().slice(0, 80) || '未命名设计', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await fs.mkdir(path.join(this.workspace(project.id), 'artifacts'), { recursive: true });
    await jsonWrite(path.join(this.projectRoot(project.id), 'project.json'), project);
    return project;
  }
  async touch(id: string) { const p = await this.project(id); p.updatedAt = new Date().toISOString(); await jsonWrite(path.join(this.projectRoot(id), 'project.json'), p); }
  async messages(id: string): Promise<Message[]> { await this.project(id); return jsonRead(path.join(this.projectRoot(id), 'messages.json'), []); }
  private messageWrites = new Map<string, Promise<unknown>>();
  async addMessage(id: string, message: Message) {
    const previous = this.messageWrites.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const messages = await this.messages(id);
      const index = messages.findIndex(m => m.id === message.id);
      if (index >= 0) messages[index] = message; else messages.push(message);
      await jsonWrite(path.join(this.projectRoot(id), 'messages.json'), messages.slice(-500));
    });
    this.messageWrites.set(id, next); await next;
  }
  async settings(): Promise<Settings> {
    const settings = await jsonRead<Settings>(path.join(this.root, 'settings.json'), { provider: process.env.PI_PROVIDER || '', model: process.env.PI_MODEL || '', thinking: 'off' });
    if (settings.model === 'gpt-6-astra' && ['off', 'minimal'].includes(settings.thinking)) settings.thinking = 'medium';
    return settings;
  }
  async saveSettings(settings: Settings) { await jsonWrite(path.join(this.root, 'settings.json'), settings); }
}
