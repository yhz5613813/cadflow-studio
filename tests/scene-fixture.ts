// Adapter fixture: uses CadFlow's upstream tetrahedron GLB, not a claim of a kernel build.
import { readFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { preflightZipBytes } from '../server/vendor/cadflow/zip.js';
import { canonicalJsonBytes as bytes, canonicalJsonHash as hash, sha256 } from '../server/vendor/cadflow/canonical.js';
export const identity = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], z_axis: [0, 0, 1] };
export function simpleFixture(edit?: (scene: any) => void) {
  const canonical = preflightZipBytes(readFileSync(new URL('./fixtures/scene/cadflow-canonical.zip', import.meta.url)));
  const geometry = [...canonical.members].find(([p]) => p.startsWith('geometry/'))![1];
  const source = Buffer.from('# 场景包定位验收\nwidth = 1000\nheight = 1000\n# 共享几何的两个实例\n');
  const featureBlob = bytes({ graph_id: 'demo.graph', nodes: [] });
  const entityBytes = bytes({ schema_version: '2.0', definition_id: 'demo.part', geometry_asset_id: sha256(geometry), edge_asset_id: null, entities: [], face_groups: [], edge_groups: [] });
  const payloads = [geometry, source, featureBlob, entityBytes];
  const files: Record<string, Uint8Array> = Object.fromEntries(payloads.map(b => [`blobs/${sha256(b).slice(7)}`, b]));
  const definitionBytes = bytes({ definition_id: 'demo.part', definition_kind: 'single_solid', note: 'Viewer adapter fixture only' });
  const definition = { definition_id: 'demo.part', definition_kind: 'single_solid', revision: 'fixture-v1', content_hash: sha256(definitionBytes) };
  const definitionPath = 'definitions/part/demo.json'; files[definitionPath] = definitionBytes;
  const record = (path: string, data: Uint8Array) => ({ path, sha256: sha256(data), byte_length: data.length });
  const asset = (uri: string, data: Uint8Array, media_type: string) => ({ asset_id: sha256(data), uri, sha256: sha256(data), byte_length: data.length, media_type });
  const geometryAsset = asset('geometry/tetra.glb', geometry, 'model/gltf-binary');
  const entityAsset = asset('entities/tetra.json', entityBytes, 'application/vnd.simplecad.entities+json');
  const graphAsset = { ...asset('graphs/demo.zip', featureBlob, 'application/vnd.simplecad.feature-graph+zip'), definition_id: 'demo.part', graph_id: 'demo.graph', graph_revision: sha256(featureBlob) };
  const sourceAsset = { source_asset_id: sha256(source), uri: 'sources/model.py', sha256: sha256(source), byte_length: source.length, media_type: 'text/x-python', display_name: 'model.py' };
  const node = (id: string, parent: string | null, transform: typeof identity, withGeometry = true) => ({ node_id: id, parent_node_id: parent, display_name: id, node_kind: 'part', definition_id: 'demo.part', definition_kind: 'single_solid', component_id: null, instance_id: id, transform, geometry_asset_id: withGeometry ? geometryAsset.asset_id : null, entity_asset_id: null, material_id: null, properties: {} });
  const scene: any = {
    schema_version: '2.0', scene_id: 'demo.scene', revision: '', units: 'mm', roots: ['assembly'],
    definitions: [{ ...definition, product_asset_id: definition.content_hash, feature_graph_asset_id: graphAsset.asset_id }],
    product_assets: [{ ...asset('products/part.zip', definitionBytes, 'application/vnd.simplecad.part-definition+zip'), ...definition }],
    feature_graph_assets: [graphAsset], geometry_assets: [geometryAsset], entity_assets: [entityAsset], source_assets: [sourceAsset],
    nodes: [node('assembly', null, { ...identity, origin: [100, 200, 300], x_axis: [0, 1, 0], y_axis: [-1, 0, 0] }, false), node('part.a', 'assembly', identity), node('part.b', 'assembly', { ...identity, origin: [2000, 0, 0] })],
    feature_index: [{ feature_id: 'feature.body', definition_id: 'demo.part', graph_id: 'demo.graph', node_id: 'body', op: 'make_tetrahedron', label: '四面体基体', parameters: { width: 1000, height: 1000, unit: 'mm' }, input_feature_ids: [], output_count: 1, source_spans: [{ source_asset_id: sourceAsset.source_asset_id, uri: sourceAsset.uri, start_line: 2, end_line: 3, symbol: null }] }],
    source_index: [], connectors: [], joints: [], connector_index: [], joint_index: [], camera: { target: [0, 0, 0], position: [3000, -3000, 3000], up: [0, 0, 1], near: 1, far: 10000, fit_mode: 'bounds', margin: 1.1 }, extensions: {},
  };
  for (const n of scene.nodes) n.transform = structuredClone(n.transform);
  edit?.(scene); delete scene.revision; scene.revision = hash(scene);
  const sceneBytes = bytes(scene), scenePath = 'projections/scene.json'; files[scenePath] = sceneBytes;
  const occurrence = bytes({ nodes: scene.nodes.map((n: any) => n.node_id) }); files['occurrences/root.json'] = occurrence;
  const manifest: any = { schema_version: '3.0', artifact_kind: 'product_package', root: { path: definitionPath, ...definition }, definitions: [{ ...record(definitionPath, definitionBytes), ...definition }],
    blobs: payloads.map((b, i) => ({ sha256: sha256(b), byte_length: b.length, media_type: i === 0 ? 'model/gltf-binary' : 'application/octet-stream', storage: { kind: 'member', path: `blobs/${sha256(b).slice(7)}` } })).sort((a, b) => a.sha256.localeCompare(b.sha256)),
    occurrence_graph: record('occurrences/root.json', occurrence), projections: { scene: { manifest: record(scenePath, sceneBytes), scene_id: scene.scene_id, revision: scene.revision, assets: [{ uri: geometryAsset.uri, source: { kind: 'blob', sha256: geometryAsset.sha256 } }, { uri: sourceAsset.uri, source: { kind: 'blob', sha256: sourceAsset.sha256 } }, { uri: graphAsset.uri, source: { kind: 'blob', sha256: graphAsset.sha256 } }, { uri: 'products/part.zip', source: { kind: 'definition', definition_id: definition.definition_id } }] } } };
  manifest.projections.scene.assets.push({ uri: entityAsset.uri, source: { kind: 'blob', sha256: entityAsset.sha256 } });
  manifest.content_hash = hash(manifest); files['package.json'] = bytes(manifest);
  return zipSync(files, { level: 0 });
}
