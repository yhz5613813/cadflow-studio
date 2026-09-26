import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { unzipSync, strFromU8 } from 'fflate';
import { importStep, type ImportOptions } from './step';
import { loadScenePackage } from './package';

const MAX = 128 * 1024 * 1024;
export function unpackPreview(data: Uint8Array) {
  let total = 0;
  return unzipSync(data, { filter: file => {
    if (file.name.includes('..') || file.name.startsWith('/')) throw new Error('场景包含有无效文件路径');
    total += file.originalSize;
    if (file.originalSize > MAX || total > MAX * 2) throw new Error('场景包解压后过大');
    return /\.(glb|json)$/i.test(file.name);
  } });
}
async function glb(data: ArrayBuffer) {
  const manager = new THREE.LoadingManager();
  // Uploaded files must be self-contained. Never let model data fetch arbitrary URLs.
  manager.setURLModifier(url => { if (!url.startsWith('blob:') && !url.startsWith('data:')) throw new Error('请使用内嵌资源的 GLB；不加载外部 URL'); return url; });
  const loaded = await new GLTFLoader(manager).parseAsync(data, '');
  return loaded.scene;
}
async function parseModel(name: string, data: ArrayBuffer, options: ImportOptions = {}): Promise<THREE.Group> {
  if (data.byteLength > MAX) throw new Error('模型超过 128 MB');
  const root = new THREE.Group(); root.name = name;
  if (/\.glb$/i.test(name)) root.add(await glb(data));
  else if (/\.gltf$/i.test(name)) root.add(await glb(data));
  else if (/\.stl$/i.test(name)) {
    const geo = new STLLoader().parse(data); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#a8b3b0', metalness: 0.55, roughness: 0.34 })); mesh.name = name; root.add(mesh);
  } else if (/\.obj$/i.test(name)) root.add(new OBJLoader().parse(new TextDecoder().decode(data)));
  else if (/\.(zip|scadpkg)$/i.test(name)) {
    let structured = false;
    unzipSync(new Uint8Array(data), { filter: entry => { if (entry.name === 'scene.json' || entry.name === 'package.json') structured = true; return false; } });
    if (structured) { const scene = await loadScenePackage(data, glb, options); scene.name = name; return scene; }
    if (/\.scadpkg$/i.test(name)) throw new Error('场景包缺少 package.json 或 scene.json');
    const files = unpackPreview(new Uint8Array(data));
    const entries = Object.entries(files).filter(([file]) => file.toLowerCase().endsWith('.glb'));
    if (!entries.length) throw new Error('场景包中没有内嵌 GLB，请让 Agent 导出 GLB 或 STL');
    // This importer exposes the archive's render assets; it does not pretend to reconstruct BREP or a feature graph.
    // Prefer a single unified model when available; otherwise each asset is independently named.
    const preferred = entries.find(([file]) => /(^|\/)(model|preview)\.glb$/i.test(file));
    if (!preferred && entries.length > 1) throw new Error('普通 ZIP 包含多个 GLB，但没有装配清单；请选择单个模型，或导出正式场景包');
    for (const [file, bytes] of preferred ? [preferred] : entries) {
      const scene = await glb(bytes.slice().buffer as ArrayBuffer); scene.name = file; root.add(scene);
    }
    root.userData.archiveAssets = true;
    const report = Object.entries(files).find(([file]) => /(^|\/)(measurements|report)\.json$/i.test(file));
    if (report) { try { root.userData.report = JSON.parse(strFromU8(report[1])); } catch { /* optional report */ } }
  } else if (/\.(step|stp)$/i.test(name)) root.add(await importStep(data, options));
  else throw new Error('不支持的预览格式');
  // glTF defines Y-up. The studio uses Z-up; CadFlow GLB exporters use glTF coordinates too.
  if (/\.(glb|gltf|zip|scadpkg)$/i.test(name)) root.rotation.x = Math.PI / 2;
  return root;
}
export async function loadModel(name: string, data: ArrayBuffer, options: ImportOptions = {}): Promise<THREE.Group> {
  options.signal?.throwIfAborted();
  if (data.byteLength > MAX) throw new Error('模型超过 128 MB');
  // STEP transfers ownership of this buffer to its worker. Hash before parsing
  // so every selection identifies the original file, never a detached buffer.
  const hash = await crypto.subtle.digest('SHA-256', data);
  options.signal?.throwIfAborted();
  const root = await parseModel(name, data, options);
  const sourceHash = 'sha256:' + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  const extension = name.split('.').at(-1)!.toLowerCase();
  root.userData.previewIdentity = { sourceHash, profile: `studio-1/three-0.178.0/${extension}${/^(step|stp)$/.test(extension) ? `/occt-0.0.23/${options.quality || 'standard'}` : ''}` };
  return root;
}
