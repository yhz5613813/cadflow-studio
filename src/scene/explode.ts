import * as THREE from 'three';

// Imported STEP placements may be baked into vertices, while glTF placements are
// usually transforms. Use each part's geometry centre in world space for both.
export function explodeMeshes(meshes: THREE.Mesh[], originals: Map<string, THREE.Vector3>, center: THREE.Vector3, distance: number) {
  for (const mesh of meshes) mesh.position.copy(originals.get(mesh.uuid) ?? mesh.position);
  for (const mesh of meshes) mesh.updateWorldMatrix(true, false);
  const offsets = meshes.map((mesh, index) => {
    mesh.geometry.computeBoundingBox();
    const origin = mesh.geometry.boundingBox!.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
    const direction = origin.clone().sub(center);
    if (direction.lengthSq() < 1e-12) direction.set(0, 0, index % 2 ? -1 : 1);
    const target = origin.clone().addScaledVector(direction.normalize(), distance);
    if (mesh.parent) { mesh.parent.worldToLocal(target); mesh.parent.worldToLocal(origin); }
    return target.sub(origin);
  });
  meshes.forEach((mesh, index) => { mesh.position.add(offsets[index]); mesh.updateMatrix(); });
}
