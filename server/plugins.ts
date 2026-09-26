import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Plugin } from '../shared/types.js';
import { HttpError, inside, jsonRead, jsonWrite } from './storage.js';
import { CADFLOW_PLUGIN_ID } from './builtin.js';

const exec = promisify(execFile);
export const CADFLOW_SOURCE = 'https://github.com/zion-zion-zion/CadFlow-Skill';
export function parseSource(input: string) {
  const match = input.trim().match(/^(?:https:\/\/github\.com\/)?([\w-]+)\/([\w.-]+?)(?:\.git)?(?:#([\w./-]+))?\/?$/);
  if (!match || match[2].includes('..') || match[3]?.startsWith('-')) throw new HttpError(400, '请输入 GitHub 仓库地址，可在末尾用 # 指定分支或提交');
  return { url: `https://github.com/${match[1]}/${match[2]}.git`, id: `${match[1]}-${match[2]}`.toLowerCase(), ref: match[3] };
}
export async function discoverSkills(root: string): Promise<Plugin['skills']> {
  const found: Plugin['skills'] = [];
  async function visit(dir: string, depth: number) {
    if (depth > 5) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.name === 'SKILL.md') {
        const source = await fs.readFile(file, 'utf8');
        const name = source.match(/^name:\s*["']?([^\r\n"']+)/m)?.[1]?.trim();
        const description = source.match(/^description:\s*["']?([^\r\n"']+)/m)?.[1]?.trim();
        if (name && description) found.push({ name, description, path: path.relative(root, path.dirname(file)).split(path.sep).join('/') });
      }
    }
  }
  await visit(root, 0);
  if (found.length > 100) throw new HttpError(400, '插件包含过多 Skill');
  return found;
}
export class Plugins {
  private installing = false;
  readonly root: string;
  constructor(dataRoot: string) { this.root = path.join(dataRoot, 'plugins'); }
  async list(): Promise<Plugin[]> {
    await fs.mkdir(this.root, { recursive: true });
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const plugins = await Promise.all(entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => jsonRead<Plugin | null>(path.join(this.root, e.name, 'plugin.json'), null)));
    return plugins.filter((p): p is Plugin => !!p && p.id !== CADFLOW_PLUGIN_ID);
  }
  async install(source: string): Promise<Plugin> {
    if (this.installing) throw new HttpError(409, '另一个插件正在安装');
    const { url, id, ref } = parseSource(source);
    if (id === CADFLOW_PLUGIN_ID) throw new HttpError(409, 'CadFlow 建模能力已内置于 Studio，无需另行安装');
    if ((await this.list()).some(p => p.id === id)) throw new HttpError(409, '这个插件已经安装');
    this.installing = true;
    const stage = path.resolve(this.root, `.install-${randomUUID()}`);
    try {
      await exec('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', url, stage], { timeout: 180_000, windowsHide: true, maxBuffer: 2_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      if (ref) {
        await exec('git', ['fetch', '--depth', '1', 'origin', ref], { cwd: stage, timeout: 120_000, windowsHide: true });
        await exec('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: stage, timeout: 120_000, windowsHide: true });
      }
      await exec('git', ['sparse-checkout', 'set', 'skills'], { cwd: stage, timeout: 120_000, windowsHide: true });
      const skills = await discoverSkills(stage);
      if (!skills.length) throw new HttpError(400, '仓库没有符合 Agent Skills 格式的 SKILL.md');
      const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: stage, windowsHide: true });
      const plugin: Plugin = { id, name: id.endsWith('cadflow-skill') ? 'CadFlow' : skills[0].name, description: skills[0].description, source: url.replace(/\.git$/, ''), revision: stdout.trim(), installedAt: new Date().toISOString(), enabled: true, skills };
      // On Windows git/antivirus can briefly hold the checkout open. Publish only
      // skill resources, never the .git directory or executable package hooks.
      // The manifest is the commit point; list() ignores incomplete directories.
      const destination = path.resolve(this.root, id);
      if (!inside(this.root, destination) || destination === path.resolve(this.root)) throw new HttpError(400, '无效插件目录');
      await fs.mkdir(destination);
      try {
        for (const skill of skills) {
          const from = path.join(stage, skill.path), to = path.join(destination, skill.path);
          await fs.cp(from, to, { recursive: true, force: false, errorOnExist: true, filter: async file => !(await fs.lstat(file)).isSymbolicLink() && path.basename(file) !== '.git' });
        }
        const license = path.join(stage, 'LICENSE');
        if (await fs.stat(license).then(s => s.isFile()).catch(() => false)) await fs.copyFile(license, path.join(destination, 'LICENSE'));
        await jsonWrite(path.join(destination, 'plugin.json'), plugin);
      } catch (error) {
        await fs.rm(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); throw error;
      }
      return plugin;
    } finally {
      this.installing = false;
      if (inside(this.root, stage) && path.basename(stage).startsWith('.install-')) await fs.rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  }
  async enable(id: string, enabled: boolean) {
    if (id === CADFLOW_PLUGIN_ID) throw new HttpError(409, '内置建模能力不能停用');
    const plugin = (await this.list()).find(p => p.id === id);
    if (!plugin) throw new HttpError(404, '插件不存在');
    plugin.enabled = enabled; await jsonWrite(path.join(this.root, plugin.id, 'plugin.json'), plugin); return plugin;
  }
  async remove(id: string) {
    if (id === CADFLOW_PLUGIN_ID) throw new HttpError(409, '内置建模能力不能卸载');
    const plugin = (await this.list()).find(p => p.id === id);
    if (!plugin) throw new HttpError(404, '插件不存在');
    const target = path.resolve(this.root, plugin.id);
    if (!inside(this.root, target) || target === path.resolve(this.root)) throw new HttpError(400, '无效插件路径');
    await fs.rm(target, { recursive: true, force: true });
  }
  async skillPaths() {
    return (await this.list()).filter(p => p.enabled).flatMap(p => p.skills.map(s => path.join(this.root, p.id, s.path)));
  }
}
