import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { validateMetrics, type Measurement, type MeasurementDocument } from '../shared/measurements.js';
import { Store, safePath, jsonWrite, HttpError } from './storage.js';
import { Reviews, validateAnchor } from './reviews.js';
import type { History } from './history.js';
export const MEASUREMENT_FILE = 'studio/measurements.json';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export class Measurements {
  constructor(private store: Store, private history: History) {}
  async read(project: string): Promise<MeasurementDocument> {
    await this.store.project(project); const file = await safePath(this.store.workspace(project), MEASUREMENT_FILE, false);
    let raw: string;
    try { const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new HttpError(413, '测量记录超过 2 MB'); raw = await fs.readFile(file, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, etag: digest(''), measurements: [] }; throw e; }
    try {
      const doc = JSON.parse(raw);
      if (doc.version !== 1 || !Array.isArray(doc.measurements) || doc.measurements.length > 200 || new Set(doc.measurements.map((r: Measurement) => r.id)).size !== doc.measurements.length) throw new Error('记录列表无效');
      const measurements = doc.measurements.map((r: Measurement) => {
        if (typeof r.id !== 'string' || !/^[a-f0-9-]{36}$/.test(r.id) || !Number.isFinite(Date.parse(r.createdAt))) throw new Error('记录编号或时间无效');
        return { id: r.id, createdAt: r.createdAt, anchor: validateAnchor(r.anchor), metrics: validateMetrics(r.metrics) };
      });
      return { version: 1, etag: digest(raw), measurements };
    } catch { throw new HttpError(422, '测量记录损坏，请从项目历史恢复或修复 studio/measurements.json'); }
  }
  async change(project: string, etag: unknown, action: { add: unknown } | { remove: string }) {
    const release = this.store.acquire(project);
    try {
      await this.history.recover(project); const doc = await this.read(project);
      if (etag !== doc.etag) throw new HttpError(409, '测量列表已变化，请刷新后重试');
      if ('add' in action) {
        if (doc.measurements.length >= 200) throw new HttpError(413, '每个项目最多保存 200 条测量');
        const input = action.add as Measurement;
        const anchor = validateAnchor(input?.anchor);
        let metrics; try { metrics = validateMetrics(input?.metrics); } catch (e) { throw new HttpError(422, (e as Error).message); }
        if (await new Reviews(this.store, this.history).currentHash(project, anchor.file) !== anchor.sourceHash) throw new HttpError(409, '模型已变化，请重新载入后测量');
        // This records the browser's mesh calculation, never a CAD-kernel certificate.
        doc.measurements.push({ id: randomUUID(), createdAt: new Date().toISOString(), anchor, metrics });
      } else {
        const index = doc.measurements.findIndex(r => r.id === action.remove); if (index < 0) throw new HttpError(404, '测量记录不存在'); doc.measurements.splice(index, 1);
      }
      const value = { version: 1, measurements: doc.measurements }, file = await safePath(this.store.workspace(project), MEASUREMENT_FILE, false);
      if (Buffer.byteLength(JSON.stringify(value, null, 2)) > 2 * 1024 * 1024) throw new HttpError(413, '测量记录超过 2 MB');
      await this.history.snapshot(project, '测量记录修改前'); await jsonWrite(file, value); await this.store.touch(project); await this.history.snapshot(project, '测量记录更新');
      return await this.read(project);
    } finally { release(); }
  }
}
