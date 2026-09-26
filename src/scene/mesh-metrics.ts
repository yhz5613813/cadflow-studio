import type { MeshMetrics } from '../../shared/measurements';
export type MetricInput = { positions: Float64Array; indices: Uint32Array; matrix: number[] };
// The worker owns copies of geometry buffers. Exact coordinate welding merges
// duplicated seam vertices, without rounding away small real holes or gaps.
export function measureMesh(input: MetricInput): MeshMetrics {
  const { positions, indices, matrix: m } = input, triangles = indices.length / 3;
  if (!Number.isSafeInteger(triangles) || !triangles || triangles > 250000 || positions.length % 3 || positions.length > 4500000) throw new Error('请选择不超过 25 万个三角面的单个部件或面');
  if (m.length !== 16 || m.some(n => !Number.isFinite(n)) || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) throw new Error('测量变换无效');
  const coordinates: number[][] = [], weld = new Map<string, number>(), remap = new Map<number, number>();
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const vertex = (index: number) => {
    if (index >= positions.length / 3) throw new Error('三角面引用越界');
    if (remap.has(index)) return remap.get(index)!;
    const x = positions[index * 3], y = positions[index * 3 + 1], z = positions[index * 3 + 2];
    const p = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    if (p.some(n => !Number.isFinite(n) || Math.abs(n) > 1e12)) throw new Error('模型包含无效或过大的坐标');
    const key = p.join(','), existing = weld.get(key);
    if (existing !== undefined) { remap.set(index, existing); return existing; }
    const id = coordinates.length; coordinates.push(p); weld.set(key, id); remap.set(index, id);
    p.forEach((n, i) => { min[i] = Math.min(min[i], n); max[i] = Math.max(max[i], n); }); return id;
  };
  const faces = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) faces[i] = vertex(indices[i]);
  const count = coordinates.length, center = min.map((n, i) => n + (max[i] - n) / 2);
  type Edge = { faces: number[]; balance: number };
  const edges = new Map<number, Edge>(), incident: number[][] = Array.from({ length: count }, () => []), uniqueFaces = new Set<string>();
  const parent = Int32Array.from({ length: triangles }, (_, i) => i);
  const find = (i: number): number => { let p = i; while (parent[p] !== p) { parent[p] = parent[parent[p]]; p = parent[p]; } return p; };
  const key = (a: number, b: number) => Math.min(a, b) * count + Math.max(a, b);
  let surfaceArea = 0, volume = 0, areaError = 0, volumeError = 0, degenerateTriangles = 0, duplicateTriangles = 0;
  for (let t = 0; t < triangles; t++) {
    const ids = [faces[t * 3], faces[t * 3 + 1], faces[t * 3 + 2]], [a, b, c] = ids.map(id => coordinates[id]);
    const u = b.map((n, i) => n - a[i]), v = c.map((n, i) => n - a[i]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const area = Math.hypot(...cross) / 2;
    if (area === 0 || new Set(ids).size !== 3) degenerateTriangles++;
    const faceKey = [...ids].sort((a, b) => a - b).join(','); if (uniqueFaces.has(faceKey)) duplicateTriangles++; uniqueFaces.add(faceKey);
    const adjustedArea = area - areaError, nextArea = surfaceArea + adjustedArea; areaError = (nextArea - surfaceArea) - adjustedArea; surfaceArea = nextArea;
    const translated = a.map((n, i) => n - center[i]);
    const signed = translated.reduce((sum, n, i) => sum + n * cross[i], 0) / 6;
    const adjustedVolume = signed - volumeError, nextVolume = volume + adjustedVolume; volumeError = (nextVolume - volume) - adjustedVolume; volume = nextVolume;
    ids.forEach(id => incident[id].push(t));
    for (let i = 0; i < 3; i++) {
      const a = ids[i], b = ids[(i + 1) % 3], k = key(a, b); let edge = edges.get(k);
      if (!edge) { edge = { faces: [], balance: 0 }; edges.set(k, edge); }
      if (edge.faces.length) parent[find(t)] = find(edge.faces[0]);
      edge.faces.push(t); edge.balance += a < b ? 1 : -1;
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0, orientationConflicts = 0, nonManifoldVertices = 0;
  for (const edge of edges.values()) {
    if (edge.faces.length === 1) boundaryEdges++;
    if (edge.faces.length > 2) nonManifoldEdges++;
    if (edge.faces.length === 2 && edge.balance !== 0) orientationConflicts++;
  }
  // A closed edge-manifold can still have a pinched vertex: check each local fan.
  for (let v = 0; v < count; v++) {
    const fan = incident[v]; if (!fan.length) continue;
    if (fan.some(t => [0, 1, 2].some(i => { const other = faces[t * 3 + i]; return other !== v && edges.get(key(v, other))!.faces.length > 2; }))) { nonManifoldVertices++; continue; }
    const visited = new Set<number>(), pending = [fan[0]];
    while (pending.length) {
      const t = pending.pop()!; if (visited.has(t)) continue; visited.add(t);
      for (let i = 0; i < 3; i++) { const other = faces[t * 3 + i]; if (other !== v) for (const next of edges.get(key(v, other))!.faces) if (!visited.has(next)) pending.push(next); }
    }
    if (visited.size !== new Set(fan).size) nonManifoldVertices++;
  }
  const closed = ![boundaryEdges, nonManifoldEdges, orientationConflicts, nonManifoldVertices, degenerateTriangles, duplicateTriangles].some(Boolean);
  if (![surfaceArea, volume].every(Number.isFinite)) throw new Error('模型数值超出测量范围');
  return { method: 'triangle-mesh-v1', triangles, vertices: count, components: new Set(Array.from(parent, (_, i) => find(i))).size, min, max, size: max.map((n, i) => n - min[i]), surfaceArea, signedVolume: closed ? volume : null, boundaryEdges, nonManifoldEdges, orientationConflicts, nonManifoldVertices, degenerateTriangles, duplicateTriangles };
}
