import type { Artifact } from '../../shared/types';

// Follow the newest artifact as before, but use its same-export CAD companion
// when the default is a flattened STL. Never substitute geometry from an older run.
export function choosePreview(files: Artifact[]): Artifact | undefined {
  const first = files.find(file => file.kind === 'model' && /\.(glb|gltf|stl|obj|step|stp|scadpkg|zip)$/i.test(file.name));
  if (!first || !/\.stl$/i.test(first.path)) return first;
  const stem = first.path.slice(0, -4).toLowerCase();
  return files.find(file => file.kind === 'model' && /\.(step|stp)$/i.test(file.path) && file.path.replace(/\.(step|stp)$/i, '').toLowerCase() === stem) || first;
}
