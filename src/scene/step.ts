import * as THREE from 'three';

export type StepQuality = 'draft' | 'standard' | 'fine';
export type StepFace = { first: number; last: number; color?: number[] | null };
type StepNode = { name: string; meshes: number[]; children: StepNode[] };
export type StepResult = { success: boolean; root: StepNode; meshes: { name: string; color?: number[]; brep_faces: StepFace[]; attributes: { position: { array: number[] | Float32Array }; normal?: { array: number[] | Float32Array } }; index: { array: number[] | Uint32Array } }[] };
export type StepEvidence = { sourceHash: string; importer: 'occt-import-js@0.0.23'; meshIndex: number; faces: StepFace[]; units: 'mm'; quality: StepQuality };
export type CadFaceSelection = { id: string; index: number; meshIndex: number; firstTriangle: number; lastTriangle: number; sourceHash: string; importer: string };
export type ImportOptions = { signal?: AbortSignal; progress?: (text: string) => void; quality?: StepQuality };

export function faceForTriangle(evidence: StepEvidence | undefined, triangle: number | undefined): CadFaceSelection | undefined {
  if (!evidence || triangle === undefined || !Number.isSafeInteger(triangle) || triangle < 0) return;
  const index = evidence.faces.findIndex(face => triangle >= face.first && triangle <= face.last);
  if (index < 0) return;
  const face = evidence.faces[index];
  return { id: `step:${evidence.sourceHash}:mesh:${evidence.meshIndex}:face:${index}`, index, meshIndex: evidence.meshIndex, firstTriangle: face.first, lastTriangle: face.last, sourceHash: evidence.sourceHash, importer: evidence.importer };
}

export function stepScene(result: StepResult, sourceHash: string, quality: StepQuality = 'standard'): THREE.Group {
  if (!result.success || !result.meshes?.length || !result.root || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('STEP 解析结果无效');
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const material = (color?: number[] | null) => {
    const rgb = color?.length === 3 && color.every(n => Number.isFinite(n) && n >= 0 && n <= 1) ? color : [0.68, 0.73, 0.79];
    const key = rgb.join(','); let mat = materials.get(key);
    if (!mat) { mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace), metalness: 0.15, roughness: 0.45, side: THREE.DoubleSide }); materials.set(key, mat); }
    return mat;
  };
  const geometries: THREE.BufferGeometry[] = [];
  const meshTemplates: THREE.Mesh[] = [];
  const root = new THREE.Group(); let triangles = 0, nodes = 0;
  try {
    if (result.meshes.length > 20000) throw new Error('STEP 零件数量超过预览限制');
    for (const [meshIndex, part] of result.meshes.entries()) {
      const positions = part.attributes?.position?.array, indices = part.index?.array;
      if (!positions?.length || positions.length % 3 || !indices?.length || indices.length % 3 || !positions.every(Number.isFinite)) throw new Error('STEP 网格坐标无效');
      const count = positions.length / 3; triangles += indices.length / 3;
      if (triangles > 3000000 || !indices.every(i => Number.isSafeInteger(i) && i >= 0 && i < count)) throw new Error('STEP 网格索引无效或超过预览限制');
      const geometry = new THREE.BufferGeometry(); geometries.push(geometry);
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
      const normals = part.attributes.normal?.array;
      if (normals?.length === positions.length && normals.every(Number.isFinite)) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3)); else geometry.computeVertexNormals();
      const faces = part.brep_faces ?? []; let last = -1;
      for (const face of faces) {
        if (!Number.isSafeInteger(face.first) || !Number.isSafeInteger(face.last) || face.first < 0 || face.first <= last || face.last < face.first - 1 || face.last >= indices.length / 3 || face.first > indices.length / 3) throw new Error('STEP 面与三角网格的对应关系无效');
        last = face.last;
      }
      const mats = [material(part.color)]; let start = 0;
      for (const face of faces) {
        if (face.last < face.first) continue; // Keep the original face index even when a source face has no tessellation.
        if (face.first * 3 > start) geometry.addGroup(start, face.first * 3 - start, 0);
        const mat = material(face.color ?? part.color); let slot = mats.indexOf(mat); if (slot < 0) { slot = mats.length; mats.push(mat); }
        geometry.addGroup(face.first * 3, (face.last - face.first + 1) * 3, slot); start = (face.last + 1) * 3;
      }
      if (start < indices.length) geometry.addGroup(start, indices.length - start, 0);
      const mesh = new THREE.Mesh(geometry, mats); mesh.name = part.name || `STEP 部件 ${meshIndex + 1}`;
      mesh.userData.step = { sourceHash, importer: 'occt-import-js@0.0.23', meshIndex, faces, units: 'mm', quality } satisfies StepEvidence;
      meshTemplates.push(mesh);
    }
    const used = new Set<number>();
    const visit = (node: StepNode, parent: THREE.Group, depth: number, groupPath: string) => {
      if (++nodes > 50000 || depth > 100 || !Array.isArray(node.meshes) || !Array.isArray(node.children)) throw new Error('STEP 装配层级无效或过深');
      const group = new THREE.Group(); group.name = node.name || 'STEP'; parent.add(group);
      const label = node.name ? [groupPath, node.name].filter(Boolean).join(' / ') : groupPath;
      for (const index of node.meshes) {
        if (!Number.isSafeInteger(index) || !meshTemplates[index]) throw new Error('STEP 装配引用了不存在的零件');
        // OCCT's importer already bakes placements into vertex coordinates; do not apply them twice.
        const mesh = meshTemplates[index].clone(); mesh.userData.assembly_group = node.meshes.length > 1 ? label : groupPath || node.name || 'STEP 部件';
        group.add(mesh); used.add(index);
      }
      for (const child of node.children) visit(child, group, depth + 1, label);
    };
    visit(result.root, root, 0, '');
    if (used.size !== meshTemplates.length) throw new Error('STEP 装配遗漏了零件，拒绝显示不完整模型');
    root.userData.step = { sourceHash, importer: 'occt-import-js@0.0.23', quality, units: 'mm', meshes: meshTemplates.length, faces: result.meshes.reduce((sum, mesh) => sum + mesh.brep_faces.length, 0) };
    return root;
  } catch (error) { geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); throw error; }
}

export async function importStep(buffer: ArrayBuffer, options: ImportOptions = {}): Promise<THREE.Group> {
  if (options.signal?.aborted) throw new DOMException('已取消 STEP 预览', 'AbortError');
  return new Promise((resolve, reject) => {
    const worker = new Worker('/step-preview-worker.js');
    let settled = false;
    const end = (error?: Error, group?: THREE.Group) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); worker.terminate();
      if (error) reject(error); else resolve(group!);
    };
    const abort = () => end(new DOMException('已取消 STEP 预览', 'AbortError'));
    const timer = setTimeout(() => end(new Error('STEP 解析超过 2 分钟，请降低预览精度或拆分模型')), 120000);
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = () => end(new Error('STEP 解析器启动失败或内存不足，请重试并检查本地运行资源'));
    worker.onmessage = ({ data }) => {
      if (settled) return;
      if (data.type === 'progress') options.progress?.(data.text);
      else if (data.type === 'error') end(new Error(data.message));
      else if (data.type === 'result') { try { end(undefined, stepScene(data.result, data.hash, data.quality)); } catch (e) { end(e as Error); } }
    };
    try { worker.postMessage({ buffer, quality: options.quality ?? 'standard' }, [buffer]); } catch (error) { end(error as Error); }
  });
}
