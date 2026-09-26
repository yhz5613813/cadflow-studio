import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import type { ReviewAnchor, ReviewDocument, ReviewNote } from '../shared/types.js';
import { HttpError, Store, jsonWrite, safePath, supportedModels } from './storage.js';
import type { History } from './history.js';
export const REVIEW_FILE = 'studio/annotations.json';
const digest = (value: string | Buffer) => 'sha256:' + createHash('sha256').update(value).digest('hex');
const hashPattern = /^sha256:[a-f0-9]{64}$/;
function bad(message: string): never { throw new HttpError(400, message); }
const string = (value: unknown, max: number, field: string) => typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : bad(`${field}无效`);
const choice = <T extends string>(value: unknown, values: T[], field: string): T => values.includes(value as T) ? value as T : bad(`${field}无效`);
const index = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : bad('选择编号无效');
export function validateAnchor(value: unknown): ReviewAnchor {
  if (!value || typeof value !== 'object') bad('请选择模型中的几何');
  const a = value as ReviewAnchor;
  const file = string(a.file, 4096, '模型路径'); if (!supportedModels.test(file)) bad('批注必须关联模型文件');
  if (!hashPattern.test(a.sourceHash)) bad('模型摘要无效');
  if (!/^mesh\/\d+$/.test(a.meshKey)) bad('模型选择标识无效');
  if (!Array.isArray(a.bounds) || a.bounds.length !== 3 || a.bounds.some(n => !Number.isFinite(n) || n < 0)) bad('预览尺寸无效');
  const kind = choice(a.kind, ['component', 'step-face', 'triangle'], '几何类型');
  const result: ReviewAnchor = { file, sourceHash: a.sourceHash, profile: string(a.profile, 160, '预览版本'), meshKey: a.meshKey, name: string(a.name, 4096, '几何名称'), kind, bounds: a.bounds };
  if (kind === 'step-face') result.faceIndex = index(a.faceIndex);
  if (kind === 'triangle') result.triangleIndex = index(a.triangleIndex);
  if (a.nodeId !== undefined) result.nodeId = string(a.nodeId, 4096, '场景节点');
  if (a.definitionId !== undefined) result.definitionId = string(a.definitionId, 4096, '零件定义');
  if (a.units !== undefined) result.units = choice<'mm'>(a.units, ['mm'], '单位');
  return result;
}
export class Reviews {
  constructor(private store: Store, private history: History) {}
  async read(id: string): Promise<ReviewDocument> {
    await this.store.project(id);
    const file = await safePath(this.store.workspace(id), REVIEW_FILE, false);
    let raw: string;
    try { if ((await fs.stat(file)).size > 4 * 1024 * 1024) throw new HttpError(413, '批注文件超过 4 MB'); raw = await fs.readFile(file, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, notes: [], etag: digest('') }; throw e; }
    let doc: { schemaVersion: number; notes: ReviewNote[] };
    try {
      doc = JSON.parse(raw);
      if (doc.schemaVersion !== 1 || !Array.isArray(doc.notes) || doc.notes.length > 500 || new Set(doc.notes.map(n => n.id)).size !== doc.notes.length) throw new Error();
      for (const note of doc.notes) { string(note.id, 80, '批注 ID'); validateAnchor(note.anchor); this.fields(note); if (!Number.isFinite(Date.parse(note.createdAt)) || !Number.isFinite(Date.parse(note.updatedAt))) throw new Error(); }
    } catch { throw new HttpError(422, `${REVIEW_FILE} 格式无效；请从项目历史恢复或修复文件`); }
    return { schemaVersion: 1, notes: doc.notes, etag: digest(raw) };
  }
  private fields(value: unknown) {
    if (!value || typeof value !== 'object') bad('批注内容无效'); const v = value as ReviewNote;
    return { text: string(v.text, 4000, '批注').trim(), intent: choice(v.intent, ['inspect', 'dimension', 'hole', 'fillet', 'assembly'], '操作意图'), status: choice(v.status, ['open', 'resolved'], '处理状态'), priority: choice(v.priority, ['normal', 'important'], '优先级') };
  }
  async currentHash(id: string, file: string) {
    const target = await safePath(this.store.workspace(id), file), before = await fs.stat(target);
    if (!before.isFile() || before.size > 128 * 1024 * 1024) throw new HttpError(413, '模型文件无效或超过 128 MB');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(target)) hash.update(chunk);
    const after = await fs.stat(target); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new HttpError(409, '模型正在变化，请重新载入后添加批注');
    return 'sha256:' + hash.digest('hex');
  }
  async change(id: string, etag: string, action: { create: unknown } | { update: string; value: unknown } | { remove: string }): Promise<ReviewDocument> {
    const release = this.store.acquire(id);
    try {
      await this.history.recover(id); const doc = await this.read(id);
      if (!etag || etag !== doc.etag) throw new HttpError(409, '批注已更新，请刷新列表后重试');
      const now = new Date().toISOString(); let label: string;
      if ('create' in action) {
        if (doc.notes.length >= 500) throw new HttpError(413, '每个项目最多保存 500 条批注');
        const data = action.create as ReviewNote, fields = this.fields(data), anchor = validateAnchor(data.anchor);
        if (await this.currentHash(id, anchor.file) !== anchor.sourceHash) throw new HttpError(409, '模型内容已变化，请重新载入并选择几何');
        doc.notes.push({ id: randomUUID(), anchor, ...fields, createdAt: now, updatedAt: now }); label = '添加批注';
      } else {
        const noteId = 'update' in action ? action.update : action.remove, existing = doc.notes.findIndex(n => n.id === noteId);
        if (existing < 0) throw new HttpError(404, '批注不存在');
        if ('update' in action) { doc.notes[existing] = { ...doc.notes[existing], ...this.fields(action.value), updatedAt: now }; label = '更新批注'; }
        else { doc.notes.splice(existing, 1); label = '删除批注'; }
      }
      const value = { schemaVersion: 1, notes: doc.notes };
      if (Buffer.byteLength(JSON.stringify(value, null, 2)) > 4 * 1024 * 1024) throw new HttpError(413, '批注资料超过 4 MB');
      const file = await safePath(this.store.workspace(id), REVIEW_FILE, false);
      await this.history.snapshot(id, `${label}前`);
      await jsonWrite(file, value); await this.store.touch(id);
      await this.history.snapshot(id, label);
      return this.read(id);
    } finally { release(); }
  }
}
