import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileChange, Revision, RevisionComparison, RevisionFileDiff, RevisionKind } from '../shared/types.js';
import { HttpError, jsonRead, jsonWrite, safePath, Store } from './storage.js';

type Entry = { path: string; hash: string; size: number };
type Snapshot = Revision & { entries: Entry[] };
const ignored = new Set(['node_modules', '__pycache__', 'venv']);
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const fingerprint = (entries: Entry[]) => digest(JSON.stringify(entries));
const metadata = ({ entries, ...revision }: Snapshot): Revision => revision;

// Revision data lives outside the Agent workspace. Blobs are immutable and deduplicated.
export class History {
  constructor(readonly store: Store) {}
  private root(id: string) { return path.join(this.store.projectRoot(id), 'history'); }
  private blob(id: string, hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new HttpError(400, '无效历史摘要');
    return path.join(this.root(id), 'blobs', hash);
  }
  private async scan(id: string, save: boolean): Promise<Entry[]> {
    await this.store.project(id);
    const root = this.store.workspace(id), entries: Entry[] = []; let total = 0;
    if (save) await fs.mkdir(path.join(this.root(id), 'blobs'), { recursive: true });
    const visit = async (dir: string, depth: number) => {
      if (depth > 32) throw new HttpError(413, '项目目录过深，无法完整记录历史');
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new HttpError(409, '请移除项目中的符号链接后再记录历史');
        if (entry.isDirectory()) { await visit(file, depth + 1); continue; }
        if (!entry.isFile()) throw new HttpError(409, '项目包含无法记录的特殊文件');
        const stat = await fs.stat(file);
        total += stat.size;
        if (stat.size > 128 * 1024 * 1024 || total > 2 * 1024 ** 3 || entries.length >= 10000) throw new HttpError(413, '历史容量限制：单文件 128 MB、项目 2 GB、10000 个文件');
        const bytes = await fs.readFile(file), after = await fs.stat(file);
        if (stat.size !== bytes.length || stat.mtimeMs !== after.mtimeMs) throw new HttpError(409, '文件在记录期间发生变化，请重试');
        const hash = digest(bytes);
        entries.push({ path: path.relative(root, file).split(path.sep).join('/'), hash, size: bytes.length });
        if (save) {
          const target = this.blob(id, hash);
          try { await fs.access(target); }
          catch { const temporary = `${target}.${randomUUID()}.tmp`; await fs.writeFile(temporary, bytes); await fs.rename(temporary, target); }
        }
      }
    };
    await visit(root, 0);
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  async list(id: string): Promise<Revision[]> {
    await this.store.project(id);
    return jsonRead(path.join(this.root(id), 'index.json'), []);
  }
  async snapshot(id: string, label: string, kind: RevisionKind = 'manual'): Promise<Revision> {
    const entries = await this.scan(id, true);
    const value: Snapshot = { id: randomUUID(), label: label.trim().slice(0, 160) || '保存版本', kind, createdAt: new Date().toISOString(), files: entries.length, bytes: entries.reduce((sum, e) => sum + e.size, 0), fingerprint: fingerprint(entries), entries };
    await jsonWrite(path.join(this.root(id), `${value.id}.json`), value);
    await jsonWrite(path.join(this.root(id), 'index.json'), [metadata(value), ...await this.list(id)]);
    return metadata(value);
  }
  private async read(id: string, revision: string): Promise<Snapshot> {
    await this.store.project(id);
    if (!/^[a-f0-9-]{36}$/.test(revision)) throw new HttpError(400, '无效版本编号');
    const value = await jsonRead<Snapshot | null>(path.join(this.root(id), `${revision}.json`), null);
    if (!value) throw new HttpError(404, '版本不存在');
    if (value.fingerprint !== fingerprint(value.entries)) throw new HttpError(409, '版本记录损坏');
    return value;
  }
  private async bytes(id: string, entry: Entry) {
    const bytes = await fs.readFile(this.blob(id, entry.hash));
    if (digest(bytes) !== entry.hash || bytes.length !== entry.size) throw new HttpError(409, `历史文件校验失败：${entry.path}`);
    return bytes;
  }
  async file(id: string, revision: string, relative: string): Promise<Buffer> {
    const value = await this.read(id, revision), entry = value.entries.find(e => e.path === relative);
    if (!entry) throw new HttpError(404, '该版本没有此文件');
    return this.bytes(id, entry);
  }
  async materialize(id: string, revision: string, target: string, signal: AbortSignal) {
    const value = await this.read(id, revision);
    await fs.mkdir(target, { recursive: true });
    for (const entry of value.entries) {
      signal.throwIfAborted();
      const file = await safePath(target, entry.path, false);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, await this.bytes(id, entry));
    }
    return value.entries;
  }
  async compare(id: string, revision: string): Promise<RevisionComparison> {
    const value = await this.read(id, revision), current = await this.scan(id, false);
    const before = new Map(value.entries.map(e => [e.path, e])), after = new Map(current.map(e => [e.path, e]));
    const changes: FileChange[] = [];
    for (const relative of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const a = before.get(relative), b = after.get(relative);
      if (a?.hash !== b?.hash) changes.push({ path: relative, status: !a ? 'added' : !b ? 'deleted' : 'modified', beforeSize: a?.size ?? 0, afterSize: b?.size ?? 0 });
    }
    return { revision: metadata(value), fingerprint: fingerprint(current), changes, models: value.entries.filter(e => /\.(glb|gltf|stl|obj|step|stp|scadpkg)$/i.test(e.path)).map(({ path, size }) => ({ path, size })) };
  }
  async diff(id: string, revision: string, relative: string): Promise<RevisionFileDiff> {
    const value = await this.read(id, revision), entry = value.entries.find(e => e.path === relative);
    const file = await safePath(this.store.workspace(id), relative, false);
    const stat = await fs.stat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    const text = /\.(py|json|md|txt|ts|js|yaml|yml|toml|csv|svg|dxf)$/i.test(relative);
    const truncated = (entry?.size ?? 0) > 200000 || (stat?.size ?? 0) > 200000;
    if (!text || truncated) return { path: relative, before: null, after: null, binary: !text, truncated };
    return { path: relative, before: entry ? (await this.bytes(id, entry)).toString('utf8') : null, after: stat ? await fs.readFile(file, 'utf8') : null, binary: false, truncated: false };
  }
  private async apply(id: string, snapshot: Snapshot) {
    const root = this.store.workspace(id), current = await this.scan(id, false);
    const targets = new Set(snapshot.entries.map(e => e.path));
    // Validate every destination and blob before changing any project file.
    for (const entry of snapshot.entries) {
      const file = await safePath(root, entry.path, false);
      const stat = await fs.stat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (stat && !stat.isFile()) throw new HttpError(409, `文件与目录冲突：${entry.path}`);
      await this.bytes(id, entry);
    }
    for (const entry of snapshot.entries) {
      if (current.some(e => e.path === entry.path && e.hash === entry.hash)) continue;
      const file = await safePath(root, entry.path, false);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = path.join(path.dirname(file), `.studio-restore-${randomUUID()}.tmp`);
      await fs.writeFile(temporary, await this.bytes(id, entry));
      try { await fs.rename(temporary, file); } finally { await fs.unlink(temporary).catch(() => {}); }
    }
    for (const entry of current) if (!targets.has(entry.path)) await fs.unlink(await safePath(root, entry.path));
  }
  async recover(id: string) {
    const journal = path.join(this.root(id), 'pending.json');
    const pending = await jsonRead<{ backup: string } | null>(journal, null);
    if (!pending) return;
    await this.apply(id, await this.read(id, pending.backup));
    await fs.unlink(journal);
  }
  async restore(id: string, revision: string, expectedFingerprint: string) {
    await this.recover(id);
    const target = await this.read(id, revision), comparison = await this.compare(id, revision);
    if (comparison.fingerprint !== expectedFingerprint) throw new HttpError(409, '项目已发生变化，请刷新差异后再恢复');
    const backup = await this.snapshot(id, `恢复前 · ${target.label}`, 'before-restore');
    if (backup.fingerprint !== expectedFingerprint) throw new HttpError(409, '项目在备份期间发生变化，请刷新差异后再恢复');
    const journal = path.join(this.root(id), 'pending.json');
    await jsonWrite(journal, { backup: backup.id });
    try {
      await this.apply(id, target);
      await this.snapshot(id, `已恢复 · ${target.label}`, 'after-restore');
      await fs.unlink(journal);
      return { backup, restored: metadata(target) };
    } catch (error) {
      try { await this.recover(id); }
      catch { throw new HttpError(500, '恢复中断，原项目已保存在恢复前版本中；请检查磁盘后重启以恢复原文件'); }
      throw error;
    }
  }
}
