import * as THREE from 'three';
import type { MetricInput } from './mesh-metrics';
export function metricInput(mesh: THREE.Mesh, matrix: THREE.Matrix4, first = 0, last?: number): MetricInput {
  if (mesh instanceof THREE.SkinnedMesh || mesh instanceof THREE.InstancedMesh || mesh.morphTargetInfluences?.some(n => n !== 0)) throw new Error('当前不支持变形或 GPU 实例网格测量，请导出静态几何');
  const pos = mesh.geometry.getAttribute('position'), index = mesh.geometry.index;
  if (!pos || pos.itemSize !== 3) throw new Error('网格没有有效坐标');
  const count = (index?.count ?? pos.count) / 3; last ??= count - 1;
  if (![count, first, last].every(Number.isSafeInteger) || first < 0 || last < first || last >= count || last - first + 1 > 250000) throw new Error('请选择不超过 25 万个三角面的部件或面');
  const positions: number[] = [], indices = new Uint32Array((last - first + 1) * 3), remap = new Map<number, number>();
  for (let i = first * 3; i < (last + 1) * 3; i++) {
    const old = index ? index.getX(i) : i;
    if (!Number.isSafeInteger(old) || old < 0 || old >= pos.count) throw new Error('三角面引用越界');
    let id = remap.get(old);
    if (id === undefined) { id = positions.length / 3; remap.set(old, id); positions.push(pos.getX(old), pos.getY(old), pos.getZ(old)); }
    indices[i - first * 3] = id;
  }
  return { positions: Float64Array.from(positions), indices, matrix: matrix.toArray() };
}
