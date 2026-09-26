import * as THREE from 'three';
import { extractArchive, openCadPackage, type PackageFiles } from './vendor/product-package';
import type { SceneManifest, Transform } from './vendor/scene2';
import type { SceneDocument } from './vendor/cadflow-scene';

export type PackageSource = { id: string; name: string; uri: string; hash: string; text: string };
export type PackageSpan = { sourceId: string; start: number; end: number };
export type PackageFeature = { id: string; label: string; op: string; definitionIds: string[]; inputs: string[]; parameters: Record<string, unknown>; spans: PackageSpan[] };
export type PackageNode = { id: string; parent: string | null; name: string; definitionId: string; geometryId?: string | null; transform: Transform; visible: boolean; selectable: boolean; appearanceId?: string | null; meshIds: string[] };
export type PackageInfo = { format: 'cadflow-1.0' | 'simplecadapi-3.0'; archiveHash: string; revision: string; units: 'mm'; nodes: PackageNode[]; features: PackageFeature[]; sources: PackageSource[]; connectors: number; joints?: number };
export type PackageMesh = { nodeId: string; definitionId: string; archiveHash: string; selectable: boolean };
export type ArchiveValidation = { format: PackageInfo['format']; archiveHash: string; sceneRevision: string };
export type ValidateArchive = (bytes: ArrayBuffer, signal?: AbortSignal) => Promise<ArchiveValidation>;
export const validateArchiveOnServer: ValidateArchive = async (bytes, signal) => {
  const response = await fetch('/api/scene-package/validate', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, signal });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '场景校验失败'); return result;
};
const decode = new TextDecoder('utf-8', { fatal: true });
function json<T>(files: PackageFiles, path: string): T { const bytes = files[path]; if (!bytes) throw new Error(`缺少场景资源：${path}`); return JSON.parse(decode.decode(bytes)) as T; }
export function placement(t: Transform) {
  const vectors = [t.origin, t.x_axis, t.y_axis, t.z_axis];
  if (vectors.some(v => !Array.isArray(v) || v.length !== 3 || v.some(n => !Number.isFinite(n)))) throw new Error('装配变换包含无效坐标');
  const [x, y, z] = vectors.slice(1).map(v => new THREE.Vector3(...v));
  if ([x, y, z].some(v => Math.abs(v.length() - 1) > 1e-6) || Math.abs(x.dot(y)) > 1e-6 || new THREE.Vector3().crossVectors(x, y).distanceTo(z) > 1e-6) throw new Error('装配变换必须是右手正交刚体坐标系');
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(...t.origin);
}
function unique<T>(items: T[], id: (v: T) => string, what: string) { const map = new Map(items.map(item => [id(item), item])); if (map.size !== items.length) throw new Error(`${what}包含重复 ID`); return map; }
export function validateLinks(info: PackageInfo) {
  if (info.nodes.length > 25000 || info.features.length > 100000) throw new Error('场景实例或特征数量超过预览限制');
  const nodes = unique(info.nodes, n => n.id, '场景节点'), features = unique(info.features, f => f.id, '特征'), sources = unique(info.sources, s => s.id, '源码');
  const depths = new Map<string, number>();
  for (const node of info.nodes) {
    placement(node.transform);
    const chain: string[] = []; let cursor: PackageNode | undefined = node;
    while (cursor && !depths.has(cursor.id)) {
      if (chain.includes(cursor.id)) throw new Error('装配层级包含循环');
      chain.push(cursor.id); if (chain.length > 256) throw new Error('装配层级过深');
      if (cursor.parent !== null && !nodes.has(cursor.parent)) throw new Error(`装配父节点不存在：${cursor.parent}`);
      cursor = cursor.parent === null ? undefined : nodes.get(cursor.parent);
    }
    let depth = cursor ? depths.get(cursor.id)! : 0;
    for (const id of chain.reverse()) { if (++depth > 256) throw new Error('装配层级过深'); depths.set(id, depth); }
  }
  const incoming = new Map<string, number>(), dependants = new Map<string, string[]>();
  for (const feature of info.features) {
    incoming.set(feature.id, feature.inputs.length);
    for (const input of feature.inputs) { if (!features.has(input)) throw new Error(`特征依赖不存在：${input}`); const list = dependants.get(input) || []; list.push(feature.id); dependants.set(input, list); }
    for (const span of feature.spans) {
      const source = sources.get(span.sourceId);
      if (!source || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 1 || span.end < span.start || span.end > source.text.split('\n').length) throw new Error(`特征源码位置无效：${feature.id}`);
    }
  }
  const queue = [...incoming].filter(([, n]) => n === 0).map(([id]) => id);
  for (let i = 0; i < queue.length; i++) for (const id of dependants.get(queue[i]) || []) { const left = incoming.get(id)! - 1; incoming.set(id, left); if (!left) queue.push(id); }
  if (queue.length !== features.size) throw new Error('特征依赖包含循环');
}

export async function loadScenePackage(raw: ArrayBuffer, loadGlb: (bytes: ArrayBuffer) => Promise<THREE.Group>, options: { signal?: AbortSignal; progress?: (text: string) => void; validate?: ValidateArchive } = {}) {
  options.signal?.throwIfAborted();
  options.progress?.('正在校验场景包、资源摘要与引用…');
  const validation = await (options.validate || validateArchiveOnServer)(raw, options.signal);
  options.signal?.throwIfAborted();
  const files = validation.format === 'simplecadapi-3.0' ? (await openCadPackage(new Uint8Array(raw))).files : extractArchive(new Uint8Array(raw), ['scene.json']);
  const info: PackageInfo = { format: validation.format, archiveHash: validation.archiveHash, revision: validation.sceneRevision, units: 'mm', nodes: [], features: [], sources: [], connectors: 0 };
  let geometry: { id: string; uri: string; matrix: number[] }[];
  let appearances: SceneDocument['appearances'] = [];
  const toCad = [1000, 0, 0, 0, 0, 0, -1000, 0, 0, 1000, 0, 0, 0, 0, 0, 1];
  if (validation.format === 'simplecadapi-3.0') {
    const scene = json<SceneManifest>(files, 'scene.json');
    if (scene.units !== 'mm') throw new Error('当前仅支持毫米场景');
    const defs = unique(scene.definitions, d => d.definition_id, '零件定义');
    info.nodes = scene.nodes.map(n => { if (!defs.has(n.definition_id)) throw new Error(`零件定义不存在：${n.definition_id}`); return { id: n.node_id, parent: n.parent_node_id, name: n.display_name || n.node_id, definitionId: n.definition_id, geometryId: n.geometry_asset_id, transform: n.transform, visible: true, selectable: true, meshIds: [] }; });
    const roots = info.nodes.filter(n => n.parent === null).map(n => n.id).sort();
    if (JSON.stringify(roots) !== JSON.stringify([...scene.roots].sort())) throw new Error('场景根节点与装配层级不一致');
    info.sources = scene.source_assets.map(s => ({ id: s.source_asset_id, name: s.display_name, uri: s.uri, hash: s.sha256, text: decode.decode(files[s.uri]) }));
    info.features = scene.feature_index.map(f => { if (!defs.has(f.definition_id)) throw new Error(`特征定义不存在：${f.definition_id}`); return { id: f.feature_id, label: f.label || f.op, op: f.op, definitionIds: [f.definition_id], inputs: f.input_feature_ids, parameters: f.parameters, spans: f.source_spans.map(s => { if (!scene.source_assets.some(a => a.source_asset_id === s.source_asset_id && a.uri === s.uri)) throw new Error('源码位置引用不一致'); return { sourceId: s.source_asset_id, start: s.start_line, end: s.end_line }; }) }; });
    geometry = scene.geometry_assets.map(a => ({ id: a.asset_id, uri: a.uri, matrix: toCad }));
    info.connectors = scene.connectors.length; info.joints = scene.joints.length;
  } else {
    const scene = json<SceneDocument>(files, 'scene.json');
    const defs = new Map(scene.definitions.map(d => [d.definition_id, d]));
    info.nodes = scene.nodes.map(n => { const d = defs.get(n.definition_id)!; return { id: n.node_id, parent: n.parent_node_id, name: n.name || d.name || n.node_id, definitionId: n.definition_id, geometryId: d.geometry_asset_id, transform: n.transform, visible: n.visible, selectable: n.selectable, appearanceId: n.appearance_override_id || d.appearance_id, meshIds: [] }; });
    geometry = scene.geometry_assets.map(a => ({ id: a.asset_id, uri: a.uri, matrix: a.asset_to_scene })); appearances = scene.appearances;
    info.connectors = scene.connectors.length;
    if (scene.source.kind === 'model') {
      info.sources = (scene.source.source_files || []).map(s => ({ id: s.uri, name: s.path, uri: s.uri, hash: s.content_hash, text: decode.decode(files[s.uri]) }));
      if (scene.source.embedded_artifact_uri) {
        const model = json<{ graph: { nodes: { node_id: string; op: string; params: Record<string, unknown>; inputs: string[]; source?: { path?: string; line: number; end_line: number } }[] } }>(files, scene.source.embedded_artifact_uri);
        info.features = model.graph.nodes.map(f => {
          const source = info.sources.find(s => s.name === f.source?.path);
          return { id: f.node_id, label: f.op, op: f.op, parameters: f.params, inputs: f.inputs, definitionIds: scene.definitions.filter(d => 'node_id' in d.source && d.source.node_id === f.node_id).map(d => d.definition_id), spans: source && f.source ? [{ sourceId: source.id, start: f.source.line, end: f.source.end_line }] : [] };
        });
      }
    }
  }
  validateLinks(info);
  const assets = unique(geometry, a => a.id, '几何资源');
  for (const node of info.nodes) if (node.geometryId && !assets.has(node.geometryId)) throw new Error(`几何资源不存在：${node.geometryId}`);
  const root = new THREE.Group(), objects = new Map<string, THREE.Group>(), cache = new Map<string, THREE.Group>();
  const dispose = () => { for (const group of [root, ...cache.values()]) group.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); } }); };
  try {
    for (const [index, node] of info.nodes.entries()) {
      options.signal?.throwIfAborted(); options.progress?.(`正在装配 ${index + 1} / ${info.nodes.length}：${node.name}`);
      const object = new THREE.Group(); object.name = node.name; object.matrixAutoUpdate = false; object.matrix.copy(placement(node.transform)); object.visible = node.visible;
      objects.set(node.id, object); root.add(object);
      if (!node.geometryId) continue;
      const asset = assets.get(node.geometryId)!;
      let template = cache.get(asset.id);
      if (!template) { template = await loadGlb(files[asset.uri].slice().buffer as ArrayBuffer); cache.set(asset.id, template); }
      const instance = template.clone(true), conversion = new THREE.Group(); conversion.matrixAutoUpdate = false; conversion.matrix.fromArray(asset.matrix).transpose(); conversion.add(instance); object.add(conversion);
      const appearance = appearances.find(a => a.appearance_id === node.appearanceId);
      instance.traverse(o => {
        if (!(o instanceof THREE.Mesh)) return;
        o.name = node.name; o.userData.packageMesh = { nodeId: node.id, definitionId: node.definitionId, archiveHash: info.archiveHash, selectable: node.selectable } satisfies PackageMesh;
        node.meshIds.push(o.uuid);
        if (appearance) o.material = new THREE.MeshStandardMaterial({ color: new THREE.Color(...appearance.base_color.slice(0, 3) as [number, number, number]), metalness: appearance.metallic, roughness: appearance.roughness, side: appearance.double_sided ? THREE.DoubleSide : THREE.FrontSide });
      });
    }
    for (const node of info.nodes) if (node.parent !== null) objects.get(node.parent)!.add(objects.get(node.id)!);
    // Mesh-level effective visibility keeps tree controls and raycasting consistent.
    root.traverseVisible(o => { if (o instanceof THREE.Mesh) o.userData.packageVisible = true; });
    root.traverse(o => { if (o instanceof THREE.Mesh) o.visible = !!o.userData.packageVisible; else o.visible = true; });
    const usedMaterials = new Set<THREE.Material>();
    root.traverse(o => { if (o instanceof THREE.Mesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => usedMaterials.add(m)); });
    for (const template of cache.values()) template.traverse(o => { if (o instanceof THREE.Mesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (!usedMaterials.has(m)) m.dispose(); }); });
    root.updateMatrixWorld(true); root.userData.scenePackage = info;
    return root;
  } catch (error) { dispose(); throw error; }
}
