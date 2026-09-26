import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Store, inside, safePath, scanArtifacts } from '../server/storage.js';
import { discoverSkills, parseSource, Plugins } from '../server/plugins.js';
import { zipSync, strToU8 } from 'fflate';
import { unpackPreview } from '../src/scene/loaders.js';
import { builtInSkillPaths, CADFLOW_PLUGIN_ID } from '../server/builtin.js';

test('CadFlow is bundled and cannot be installed, disabled or removed as an extension', async () => {
  const { root, cleanup } = await fixture();
  try {
    const paths = await builtInSkillPaths(); assert.equal(paths.length, 2);
    assert.match(await fs.readFile(path.join(paths[0], 'SKILL.md'), 'utf8'), /name: cadflow/);
    const manager = new Plugins(root);
    const oldInstall = path.join(manager.root, CADFLOW_PLUGIN_ID);
    await fs.mkdir(oldInstall, { recursive: true });
    await fs.writeFile(path.join(oldInstall, 'plugin.json'), JSON.stringify({id: CADFLOW_PLUGIN_ID, enabled: false, skills: []}));
    assert.deepEqual(await manager.list(), []);
    await assert.rejects(manager.install('zion-zion-zion/CadFlow-Skill'), /已内置/);
    await assert.rejects(manager.enable(CADFLOW_PLUGIN_ID, false), /不能停用/);
    await assert.rejects(manager.remove(CADFLOW_PLUGIN_ID), /不能卸载/);
    assert.equal((await builtInSkillPaths()).length, 2);
  } finally { await cleanup(); }
});

async function fixture() { const base = path.resolve('.studio/test-runs'); await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'unit-')); return { root, cleanup: async () => { assert(inside(base, root)); await fs.rm(root, { recursive: true, force: true }); } }; }
test('project file boundaries reject traversal and links while allowing new nested source', async () => {
  const { root, cleanup } = await fixture();
  try {
    const store = new Store(root); await store.init(); const project = await store.createProject('模型'); const cwd = store.workspace(project.id);
    for (const file of ['../private', '..\\private', '/etc/passwd', 'code/../../private', 'a\0.py']) await assert.rejects(safePath(cwd, file, false));
    const file = await safePath(cwd, 'code/model.py', false); assert.equal(file, path.join(cwd, 'code', 'model.py'));
    await fs.mkdir(path.join(root, 'external')); await fs.writeFile(path.join(root, 'external', 'secret.txt'), 'private');
    await fs.symlink(path.join(root, 'external'), path.join(cwd, 'escape'), 'junction');
    await assert.rejects(safePath(cwd, 'escape/secret.txt'));
    assert.deepEqual(await scanArtifacts(cwd), []);
  } finally { await cleanup(); }
});
test('concurrent message writes are serialized and sessions survive reopening', async () => {
  const { root, cleanup } = await fixture();
  try {
    const store = new Store(root); await store.init(); const p = await store.createProject('Persistent');
    await Promise.all(Array.from({ length: 15 }, (_, i) => store.addMessage(p.id, { id: String(i), role: 'assistant', text: `message ${i}`, timestamp: i })));
    assert.equal((await new Store(root).messages(p.id)).length, 15);
    await store.addMessage(p.id, { id: '1', role: 'assistant', text: 'updated', timestamp: 20 });
    assert.equal((await store.messages(p.id)).length, 15); assert.equal((await store.messages(p.id))[1].text, 'updated');
  } finally { await cleanup(); }
});
test('plugin sources are GitHub-only and optional refs cannot become git flags', () => {
  assert.deepEqual(parseSource('https://github.com/zion-zion-zion/CadFlow-Skill'), { url: 'https://github.com/zion-zion-zion/CadFlow-Skill.git', id: 'zion-zion-zion-cadflow-skill', ref: undefined });
  assert.equal(parseSource('owner/repo.git#main').ref, 'main');
  for (const source of ['file:///etc', 'https://evil.test/a/b', 'owner/repo#--upload-pack=x', 'owner/../a', 'owner/repo;rm -rf /']) assert.throws(() => parseSource(source));
});
test('only installed and enabled skills are exposed, preserving their reference directories', async () => {
  const { root, cleanup } = await fixture();
  try {
    const pluginRoot = path.join(root, 'plugins', 'example-cad');
    await fs.mkdir(path.join(pluginRoot, 'skills', 'cad', 'references'), { recursive: true });
    await fs.writeFile(path.join(pluginRoot, 'skills', 'cad', 'SKILL.md'), '---\nname: cad\ndescription: CAD geometry tools.\n---\nRead references/api.md');
    await fs.writeFile(path.join(pluginRoot, 'skills', 'cad', 'references', 'api.md'), 'API details');
    const skills = await discoverSkills(pluginRoot); assert.equal(skills[0].path, 'skills/cad');
    await fs.writeFile(path.join(pluginRoot, 'plugin.json'), JSON.stringify({ id: 'example-cad', name: 'CAD', enabled: true, skills }));
    const manager = new Plugins(root); assert.equal((await manager.skillPaths()).length, 1);
    await manager.enable('example-cad', false); assert.equal((await manager.skillPaths()).length, 0);
    await manager.enable('example-cad', true); assert.equal((await manager.skillPaths()).length, 1);
    await manager.remove('example-cad'); assert.deepEqual(await manager.list(), []);
  } finally { await cleanup(); }
});
test('preview archive reader rejects unsafe paths and keeps render assets only', () => {
  const files = unpackPreview(zipSync({ 'assets/part.glb': new Uint8Array([1, 2]), 'scene.json': strToU8('{}'), 'sources/model.py': strToU8('print(1)') }));
  assert.deepEqual(Object.keys(files).sort(), ['assets/part.glb', 'scene.json']);
  assert.throws(() => unpackPreview(zipSync({ '../outside.glb': new Uint8Array([1]) })));
});
