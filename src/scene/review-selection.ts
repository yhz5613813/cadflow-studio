import * as THREE from 'three';
import type { ReviewAnchor } from '../../shared/types';
import type { StepEvidence } from './step';
export type PreviewIdentity = { sourceHash: string; profile: string };
export type PreviewState = { url?: string; status: 'loading' | 'ready' | 'error'; identity?: PreviewIdentity; error?: string };
export function resolveReview(meshes: THREE.Mesh[], identity: PreviewIdentity | undefined, anchor: ReviewAnchor) {
  if (!identity || identity.sourceHash !== anchor.sourceHash) throw new Error('模型内容已变化；保留原批注，请重新选择后创建新的批注');
  if (identity.profile !== anchor.profile) throw new Error('预览版本或 STEP 精度不同，请恢复原预览设置后定位');
  const mesh = meshes.find(m => m.userData.reviewKey === anchor.meshKey);
  if (!mesh || (anchor.nodeId && mesh.userData.packageMesh?.nodeId !== anchor.nodeId) || (anchor.definitionId && mesh.userData.packageMesh?.definitionId !== anchor.definitionId)) throw new Error('原几何选择已无法匹配');
  if (mesh.userData.packageMesh?.selectable === false) throw new Error('此场景节点不允许选择');
  let triangle: number | undefined;
  if (anchor.kind === 'triangle') {
    triangle = anchor.triangleIndex;
    const count = (mesh.geometry.index?.count || mesh.geometry.attributes.position?.count || 0) / 3;
    if (!Number.isSafeInteger(triangle) || triangle! < 0 || triangle! >= count) throw new Error('原三角面已无法匹配');
  }
  if (anchor.kind === 'step-face') {
    const evidence = mesh.userData.step as StepEvidence | undefined, face = evidence?.faces[anchor.faceIndex!];
    if (!Number.isSafeInteger(anchor.faceIndex) || !face || face.last < face.first || `sha256:${evidence?.sourceHash}` !== anchor.sourceHash) throw new Error('原 STEP 面已无法匹配');
    triangle = face.first;
  }
  return { mesh, triangle };
}
