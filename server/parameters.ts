import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateParameters, withParameterValues, type ParameterState } from '../shared/parameters.js';
import { Store, HttpError, jsonWrite, safePath } from './storage.js';
import { History } from './history.js';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function parameterPath(source: unknown) {
  if (typeof source !== 'string' || !/\.py$/i.test(source) || source.includes('\\') || source.split('/').some(p => !p || p.startsWith('.') || ['venv', 'node_modules', '__pycache__'].includes(p))) throw new HttpError(400, '请选择项目中的 Python 源码');
  return source.replace(/\.py$/i, '.parameters.json');
}
export class Parameters {
  constructor(private store: Store, private history: History) {}
  async read(project: string, source: unknown): Promise<ParameterState> {
    await this.store.project(project);
    const relative = parameterPath(source), root = this.store.workspace(project);
    const script = await safePath(root, source as string);
    if (!(await fs.stat(script)).isFile()) throw new HttpError(400, '源码必须是文件');
    const file = await safePath(root, relative, false);
    let bytes: Buffer;
    try { const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 256000) throw new HttpError(413, '参数文件必须小于 256 KB'); bytes = await fs.readFile(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: relative, hash: null, document: null }; throw error; }
    try { return { path: relative, hash: hash(bytes), document: validateParameters(JSON.parse(bytes.toString('utf8'))) }; }
    catch (error) { throw new HttpError(422, `参数文件无效：${(error as Error).message}`); }
  }
  async save(project: string, source: unknown, expected: unknown, values: unknown) {
    const release = this.store.acquire(project);
    try {
      await this.history.recover(project);
      const state = await this.read(project, source);
      if (!state.document || typeof expected !== 'string' || expected !== state.hash) throw new HttpError(409, '参数定义或取值已变化，请重新载入参数后合并修改');
      let next; try { next = withParameterValues(state.document, values); } catch (error) { throw new HttpError(422, (error as Error).message); }
      const file = await safePath(this.store.workspace(project), state.path);
      await this.history.snapshot(project, `参数修改前 · ${source}`);
      await jsonWrite(file, next);
      await this.history.snapshot(project, `参数修改后 · ${source}`); await this.store.touch(project);
      return await this.read(project, source);
    } finally { release(); }
  }
  async template(project: string) {
    const release = this.store.acquire(project);
    try {
      await this.store.project(project); await this.history.recover(project);
      const relative = `models/plate-${randomUUID().slice(0, 8)}`, root = this.store.workspace(project);
      const target = await safePath(root, relative, false);
      const staging = path.join(this.store.projectRoot(project), `parameter-template-${randomUUID()}`);
      await fs.mkdir(staging);
      try {
        for (const file of ['plate.py', 'plate.parameters.json']) await fs.copyFile(fileURLToPath(new URL(`../resources/templates/${file}`, import.meta.url)), path.join(staging, file));
        validateParameters(JSON.parse(await fs.readFile(path.join(staging, 'plate.parameters.json'), 'utf8')));
        await this.history.snapshot(project, '新建参数化板件前');
        await fs.mkdir(path.dirname(target), { recursive: true }); await fs.rename(staging, target);
        await this.history.snapshot(project, '新建参数化板件'); await this.store.touch(project);
      } finally { for (const file of ['plate.py', 'plate.parameters.json']) await fs.unlink(path.join(staging, file)).catch(() => {}); await fs.rmdir(staging).catch(() => {}); }
      return { source: `${relative}/plate.py` };
    } finally { release(); }
  }
}
