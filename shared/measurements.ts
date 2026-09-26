import type { ReviewAnchor } from './types';
export type MeshMetrics = {
  method: 'triangle-mesh-v1'; triangles: number; vertices: number; components: number;
  min: number[]; max: number[]; size: number[]; surfaceArea: number; signedVolume: number | null;
  boundaryEdges: number; nonManifoldEdges: number; orientationConflicts: number;
  nonManifoldVertices: number; degenerateTriangles: number; duplicateTriangles: number;
};
export type Measurement = { id: string; createdAt: string; anchor: ReviewAnchor; metrics: MeshMetrics };
export type MeasurementDocument = { version: 1; etag: string; measurements: Measurement[] };
export function validateMetrics(raw: unknown): MeshMetrics {
  if (!raw || typeof raw !== 'object') throw new Error('缺少网格检查结果');
  const m = raw as MeshMetrics;
  if (m.method !== 'triangle-mesh-v1') throw new Error('不支持的测量方法');
  const counts = ['triangles', 'vertices', 'components', 'boundaryEdges', 'nonManifoldEdges', 'orientationConflicts', 'nonManifoldVertices', 'degenerateTriangles', 'duplicateTriangles'] as const;
  for (const k of counts) if (!Number.isSafeInteger(m[k]) || m[k] < 0 || m[k] > 1500000) throw new Error('网格计数无效');
  if (!m.triangles || !m.vertices || m.triangles > 250000 || m.components > m.triangles || m.degenerateTriangles > m.triangles || m.duplicateTriangles > m.triangles || m.nonManifoldVertices > m.vertices) throw new Error('网格检查计数不一致');
  for (const v of [m.min, m.max, m.size]) if (!Array.isArray(v) || v.length !== 3 || v.some(n => !Number.isFinite(n))) throw new Error('网格尺寸无效');
  for (let i = 0; i < 3; i++) if (m.max[i] < m.min[i] || m.size[i] < 0 || Math.abs(m.max[i] - m.min[i] - m.size[i]) > Math.max(1e-10, Math.abs(m.size[i]) * 1e-10)) throw new Error('包围盒范围不一致');
  if (!Number.isFinite(m.surfaceArea) || m.surfaceArea < 0 || (m.signedVolume !== null && !Number.isFinite(m.signedVolume))) throw new Error('网格面积或体积无效');
  if (m.signedVolume !== null && [m.boundaryEdges, m.nonManifoldEdges, m.orientationConflicts, m.nonManifoldVertices, m.degenerateTriangles, m.duplicateTriangles].some(n => n !== 0)) throw new Error('缺陷网格不能提供封闭体积');
  return { method: m.method, ...Object.fromEntries(counts.map(k => [k, m[k]])), min: [...m.min], max: [...m.max], size: [...m.size], surfaceArea: m.surfaceArea, signedVolume: m.signedVolume } as MeshMetrics;
}
export function measurementDifference(before: Measurement, after: Measurement) {
  if (before.anchor.units !== 'mm' || after.anchor.units !== 'mm') return null;
  const delta = (a: number, b: number) => ({ before: a, after: b, delta: b - a, percent: a === 0 ? null : (b - a) / Math.abs(a) * 100 });
  return {
    size: before.metrics.size.map((n, i) => delta(n, after.metrics.size[i])),
    surfaceArea: delta(before.metrics.surfaceArea, after.metrics.surfaceArea),
    signedVolume: before.metrics.signedVolume === null || after.metrics.signedVolume === null ? null : delta(before.metrics.signedVolume, after.metrics.signedVolume),
  };
}
