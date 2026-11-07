import type { Artifact } from '../../shared/types';

// A published assembly is authoritative. Analysis snapshots are solver inputs,
// so they must not replace the editable design when reopening the project.
export function choosePreview(files: Artifact[], preferredPath?: string): Artifact | undefined {
  const models = files.filter(file => file.kind === 'model'
    && !file.path.startsWith('structural/') && !file.path.startsWith('studio/cad-inspections/')
    && /\.(glb|gltf|stl|obj|step|stp|scadpkg|zip)$/i.test(file.name));
  const preferred = preferredPath ? models.find(file => file.path === preferredPath) : undefined;
  if (preferred) return preferred;
  const first = models[0];
  if (!first || !/\.stl$/i.test(first.path)) return first;
  // Prefer CAD faces only from the same export, never from an older design.
  const stem = first.path.slice(0, -4).toLowerCase();
  return models.find(file => /\.(step|stp)$/i.test(file.path) && file.path.replace(/\.(step|stp)$/i, '').toLowerCase() === stem) || first;
}
