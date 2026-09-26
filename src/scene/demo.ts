import * as THREE from 'three';

function ring(outer: number, inner: number, depth: number, holes: { x: number; y: number; radius: number }[] = []) {
  const shape = new THREE.Shape(); shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
  for (const h of [{ x: 0, y: 0, radius: inner }, ...holes]) { const p = new THREE.Path(); p.absarc(h.x, h.y, h.radius, 0, Math.PI * 2, true); shape.holes.push(p); }
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.35, bevelThickness: 0.35, curveSegments: 72 });
}
export function createDemo() {
  const group = new THREE.Group(); group.name = '法兰装配 · 界面示例';
  const metal = new THREE.MeshStandardMaterial({ color: '#a8b1ae', metalness: 0.72, roughness: 0.3 });
  const steel = new THREE.MeshStandardMaterial({ color: '#434f4a', metalness: 0.8, roughness: 0.34 });
  const accent = new THREE.MeshStandardMaterial({ color: '#829866', metalness: 0.45, roughness: 0.37 });
  const holes = Array.from({ length: 6 }, (_, i) => ({ x: 38 * Math.cos(i * Math.PI / 3), y: 38 * Math.sin(i * Math.PI / 3), radius: 4.5 }));
  const plate = new THREE.Mesh(ring(50, 20, 8, holes), metal); plate.name = '法兰底座'; group.add(plate);
  const hub = new THREE.Mesh(ring(28, 20, 22), metal.clone()); hub.name = '定位轴套'; hub.position.z = 8.5; group.add(hub);
  const collar = new THREE.Mesh(ring(28.5, 20, 2), accent); collar.name = '上端定位环'; collar.position.z = 31; group.add(collar);
  holes.forEach((p, i) => {
    const washer = new THREE.Mesh(ring(6.8, 3.9, 1), metal.clone()); washer.position.set(p.x, p.y, 8.7); washer.name = `垫圈 ${String(i + 1).padStart(2, '0')}`; group.add(washer);
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 5, 6), steel.clone()); bolt.rotation.x = Math.PI / 2; bolt.position.set(p.x, p.y, 12.5); bolt.name = `六角螺栓 ${String(i + 1).padStart(2, '0')}`; group.add(bolt);
  });
  group.userData.demo = true;
  return group;
}
