import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const CADFLOW_PLUGIN_ID = 'zion-zion-zion-cadflow-skill';
export const CADFLOW_SKILL_DIR = fileURLToPath(new URL('../resources/cadflow/', import.meta.url));
export async function builtInSkillPaths() {
  await fs.access(path.join(CADFLOW_SKILL_DIR, 'SKILL.md'));
  return [CADFLOW_SKILL_DIR, fileURLToPath(new URL('../resources/thermal-sim/', import.meta.url))];
}
