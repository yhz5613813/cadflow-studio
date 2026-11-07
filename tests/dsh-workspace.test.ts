import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/storage.js';
import { prepareDshWorkspace } from '../server/dsh-workspace.js';

test('DSH gets the real project, engineering skills and preserved local instructions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'castudio-dsh-'));
  try {
    const store = new Store(root); await store.init();
    const project = await store.createProject('Native CAD');
    const instructions = path.join(store.workspace(project.id), 'AGENTS.md');
    await fs.writeFile(instructions, '# Project rules\nPreserve these instructions.\n');
    const prepared = await prepareDshWorkspace(store, project.id);
    assert.equal(prepared.workspacePath, store.workspace(project.id));
    const text = await fs.readFile(instructions, 'utf8');
    assert.match(text, /Preserve these instructions/);
    assert.match(text, /DSH is the sole conversation/);
    for (const skill of ['castudio', 'cadflow', 'thermal-sim', 'structural-sim'])
      assert.ok((await fs.stat(path.join(prepared.workspacePath, '.agents', 'skills', skill, 'SKILL.md'))).isFile());
    const structural = await fs.readFile(path.join(prepared.workspacePath, '.agents/skills/structural-sim/SKILL.md'), 'utf8');
    assert.doesNotMatch(structural, /\/structural\/queue|current agent turn holds the project editing lock/);
    await prepareDshWorkspace(store, project.id);
    assert.equal(await fs.readFile(instructions, 'utf8'), text);
    assert.deepEqual(await store.messages(project.id), []);
    await assert.rejects(prepareDshWorkspace(store, '../outside'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
