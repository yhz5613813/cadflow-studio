import type { Express } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, jsonRead } from './storage.js';

const resources = fileURLToPath(new URL('../resources/', import.meta.url));
const marker = '<!-- coserve-dsh-workspace -->';

/** Prepare CAD project instructions for DSH's existing filesystem and skill tools. */
export async function prepareDshWorkspace(store: Store, id: string) {
  const project = await store.project(id);
  const workspacePath = store.workspace(id);
  const skillRoot = path.join(workspacePath, '.agents', 'skills');
  await fs.mkdir(skillRoot, { recursive: true });
  for (const name of ['cadflow', 'thermal-sim', 'structural-sim']) {
    const destination = path.join(skillRoot, name);
    try { await fs.access(destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.cp(path.join(resources, name), destination, { recursive: true, filter: source => !source.split(path.sep).some(part => ['__pycache__', 'data', '.venv'].includes(part)) });
    }
  }
  // The original skill assumes Pi holds an editing lock throughout each turn.
  // Adapt that exact bundled instruction for DSH without changing either harness.
  const structuralSkill = path.join(skillRoot, 'structural-sim', 'SKILL.md');
  const structuralText = await fs.readFile(structuralSkill, 'utf8');
  const nativeStructuralText = structuralText.replaceAll("'/structural/queue'", "'/structural'")
    .replace('The current agent turn holds the project editing lock. Queueing returns promptly; **finish the turn after reporting the queued job ID** so execution can acquire that lock. Do not wait in this same turn for the queued job or call the immediate `/structural` POST. A later turn can GET `/structural` or `/structural/<id>`. Source changes after queueing reject the job. Queueing alone is not successful analysis.', 'DSH does not hold the legacy Pi editing lock. POST `/structural` starts the calculation through the existing project service. Poll GET `/structural` or `/structural/<id>` until a terminal state; starting a job alone is not successful analysis. Do not change source geometry while its calculation is running.')
    .replace('submit the existing queue route', 'submit the existing `/structural` route');
  if (nativeStructuralText !== structuralText) await fs.writeFile(structuralSkill, nativeStructuralText);
  const runtime = await jsonRead<{ executable?: string }>(path.join(store.root, 'runtime.json'), {});
  const thermal = await jsonRead<{ executable?: string }>(path.join(store.root, 'thermal-runtime.json'), {});
  const api = `http://127.0.0.1:${Number(process.env.STUDIO_PORT || 4317)}/api/projects/${id}`;
  const skill = `---\nname: castudio\ndescription: Use the integrated CAD project, parametric editor, model files, build and simulation services when designing, editing or inspecting engineering models.\n---\n\n# CAD workspace\n\nThis directory is the current CAD project's source of truth. DSH owns conversation, model requests and tool execution. Use its normal file and PowerShell tools. The local CAD service supplies geometry editing, previews, builds, history and simulation; do not call its /prompt endpoint or use its legacy Pi agent.\n\nProject API: ${api}\nConfigured CAD Python: ${runtime.executable || 'not configured; inspect /api/runtime'}\nConfigured thermal Python: ${thermal.executable || 'not configured; inspect /api/thermal/runtime'}\n\nRead the cadflow skill for modeling, structural-sim for structural calculations, and thermal-sim for thermal analysis. Probe the configured interpreter before installing anything; the host may already have a Windows CadFlow runtime. Keep generated files in this project. Export STEP plus GLB or STL for preview. Never report a model or solver result before checking the actual files and output.\n\nThe parametric editor uses SimpleCADAPI. Use POST /parametric/start, GET /parametric/agent/cells, POST /parametric/agent/cells/edit, /parametric/agent/cells/insert, /parametric/agent/cells/run, and GET /parametric/agent/snapshot under the project API instead of overwriting a live notebook. POST /parametric/publish publishes the saved geometry and bindings. Read current cells before editing.\n\nUse the existing project API for model files, history, measurements, builds and simulation. For structural work, read the structural-sim skill and inspect GET /structural. DSH does not hold the legacy Pi project lock, so use the ordinary calculation endpoint instead of the legacy /structural/queue route. Respect geometry fingerprints and published CAD checks.\n\nViewport selections inserted in the conversation are preview context. Only cadFace explicitly identifies an imported STEP face; a triangle index is a mesh index, not BREP topology. A selection marked isDemo is a UI sample. Verify the actual source and geometry before editing or analysis.\n`;
  await fs.mkdir(path.join(skillRoot, 'castudio'), { recursive: true });
  await fs.writeFile(path.join(skillRoot, 'castudio', 'SKILL.md'), skill);
  const instructions = path.join(workspacePath, 'AGENTS.md');
  let existing = '';
  try { existing = await fs.readFile(instructions, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!existing.includes(marker)) await fs.writeFile(instructions, `${existing.trimEnd()}\n\n${marker}\nThis is a CoServe AI CAD project. Before CAD, parametric editing, build or simulation tasks, read .agents/skills/castudio/SKILL.md and the relevant bundled engineering skill. Use the configured runtime and existing project services. DSH is the sole conversation and tool-execution harness.\n`);
  return { ...project, workspacePath };
}

/** Loopback-only routes used by the native DSH CAD tab; these never start Pi. */
export function dshWorkspaceRoutes(app: Express, store: Store): void {
  app.get('/api/dsh/projects', async (_req, res) => res.json((await store.projects()).map(project => ({ ...project, workspacePath: store.workspace(project.id) }))));
  app.post('/api/dsh/projects/:id/prepare', async (req, res) => res.json(await prepareDshWorkspace(store, String(req.params.id))));
}
