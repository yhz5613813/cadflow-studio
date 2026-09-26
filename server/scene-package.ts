import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { preflightZipBytes } from './vendor/cadflow/zip.js';
import { parseStrictJson, sha256 } from './vendor/cadflow/canonical.js';
import { validateScenePackage } from './vendor/cadflow/validation.js';
import { extractArchive, openCadPackage } from '../src/scene/vendor/product-package.js';

const simpleSchema = new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(new URL('../resources/contracts/simplecadapi/scene-2.0.schema.json', import.meta.url), 'utf8')));
export async function validateArchive(bytes: Uint8Array) {
  if (bytes.byteLength > 128 * 1024 * 1024) throw new Error('场景包超过 128 MB');
  const detected = extractArchive(bytes, ['package.json', 'scene.json']);
  if (detected['package.json']) {
    // Reject ambiguous JSON before the upstream reader's JSON.parse sees it.
    for (const [name, value] of Object.entries(detected)) if (name.endsWith('.json')) parseStrictJson(value);
    const opened = await openCadPackage(bytes);
    const scene = parseStrictJson(opened.files['scene.json']);
    if (!simpleSchema(scene)) throw new Error(`SimpleCADAPI 场景结构无效：${simpleSchema.errors?.[0]?.instancePath} ${simpleSchema.errors?.[0]?.message}`);
    return { format: 'simplecadapi-3.0' as const, archiveHash: sha256(bytes), sceneRevision: (scene as { revision: string }).revision };
  }
  const archive = preflightZipBytes(bytes);
  const scene = archive.members.get('scene.json')!;
  const blobs = new Map(archive.members); blobs.delete('scene.json');
  const validation = validateScenePackage(scene, blobs);
  if (!validation.valid) {
    const first = validation.firstError!;
    throw new Error(`CadFlow 场景校验失败：${first.path || '/'} · ${first.code} · ${first.message}`);
  }
  return { format: 'cadflow-1.0' as const, archiveHash: sha256(bytes), sceneRevision: (parseStrictJson(scene) as { revision: string }).revision };
}
