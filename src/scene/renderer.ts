import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { faceForTriangle, type CadFaceSelection, type StepEvidence } from './step';
import { explodeMeshes } from './explode';
import type { PackageMesh } from './package';
import type { ReviewAnchor } from '../../shared/types';
import { resolveReview, type PreviewIdentity } from './review-selection';
import { metricInput } from './metric-input';
import { measureInWorker } from './measure';
import { MotorMotion, type MotorState } from './motor-motion';

export type MeshInfo = { id: string; name: string; triangles: number; visible: boolean; group?: string; faceCount?: number; units?: 'mm' };
export type Selection = { meshId: string; name: string; triangle?: number; point?: number[]; bounds: number[]; triangles: number; cadFace?: CadFaceSelection; faceCount?: number; units?: 'mm'; sourceHash?: string; packageMesh?: PackageMesh; review?: Omit<ReviewAnchor, 'file'> };
export type ViewOptions = { edges: boolean; grid: boolean; ortho: boolean; section: number; explode: number; mode: 'component' | 'face' };
export class CadRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls;
  model = new THREE.Group();
  private grid: THREE.GridHelper;
  private meshes: THREE.Mesh[] = [];
  private edges: THREE.LineSegments[] = [];
  private originals = new Map<string, THREE.Vector3>();
  private measurementFrames = new Map<string, THREE.Matrix4>();
  private bounds = new THREE.Box3();
  private highlight = new THREE.Group();
  private observer: ResizeObserver;
  private frameId = 0;
  private down = new THREE.Vector2();
  private disposed = false;
  private identity?: PreviewIdentity;
  private needsRender = true;
  motor?: MotorMotion;
  private recordingCanvas?: HTMLCanvasElement;
  private recorder?: MediaRecorder;
  private recordCancelled = false;
  private motorLights = new Map<THREE.Light,number>();
  private options: ViewOptions = { edges: true, grid: true, ortho: false, section: 100, explode: 0, mode: 'component' };
  constructor(private host: HTMLElement, private onPick: (s: Selection | null) => void, private onMotor: (state: MotorState | null) => void = () => {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); this.renderer.setClearColor('#1e1e1e');
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.05;
    this.renderer.localClippingEnabled = true; this.renderer.shadowMap.enabled = true;
    this.renderer.domElement.setAttribute('aria-label', '三维模型视口'); host.append(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100000); this.camera.up.set(0, 0, 1);
    this.camera.position.set(140, -180, 140);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => { this.needsRender = true; });
    this.controls.addEventListener('start', () => { if(this.motor&&!this.motor.recording)this.motor.autoCamera=false; });
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const environment = new RoomEnvironment(); const env = pmrem.fromScene(environment); this.scene.environment = env.texture;
    environment.dispose(); pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x65778b, 1.3));
    const key = new THREE.DirectionalLight(0xffffff, 2); key.position.set(70, -100, 180); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xc9d7f0, 1); fill.position.set(-100, 40, 100); this.scene.add(fill);
    this.grid = new THREE.GridHelper(300, 30, '#606060', '#404040'); this.grid.rotation.x = Math.PI / 2; this.grid.position.z = -2;
    (this.grid.material as THREE.Material).transparent = true; (this.grid.material as THREE.Material).opacity = 0.45;
    this.scene.add(this.grid, this.model, this.highlight);
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(host); this.resize();
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.pointerUp);
    const loop = (now=performance.now()) => {
      if (this.disposed) return;
      if(this.motor?.tick(now))this.needsRender=true;
      if(this.motor&&this.needsRender)this.motor.frame(this.camera,this.controls.target,this.recordingCanvas?16/9:Math.max(this.host.clientWidth,1)/Math.max(this.host.clientHeight,1));
      this.controls.update();
      if (this.needsRender) {
        this.renderer.render(this.scene, this.camera); this.needsRender = false;
        if(this.recordingCanvas&&this.motor){const ctx=this.recordingCanvas.getContext('2d')!;ctx.drawImage(this.renderer.domElement,0,0,1600,900);}
      }
      if(this.recorder?.state==='recording'&&this.motor&&!this.motor.playing)this.recorder.stop();
      this.frameId = requestAnimationFrame(loop);
    }; loop();
  }
  private pointerDown = (e: PointerEvent) => { this.down.set(e.clientX, e.clientY); };
  private pointerUp = (e: PointerEvent) => {
    if (e.button !== 0 || this.down.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 5) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    const hit = ray.intersectObjects(this.meshes.filter(m => m.visible && m.userData.packageMesh?.selectable !== false), false).find(h => !this.renderer.clippingPlanes.some(p => p.distanceToPoint(h.point) < 0));
    if (!hit) { this.select(null); return; }
    this.select(hit.object.uuid, this.options.mode === 'face' ? hit.faceIndex ?? undefined : undefined, hit.point);
  };
  private clearHighlight() { this.highlight.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) { o.geometry.dispose(); const mats = Array.isArray(o.material) ? o.material : [o.material]; mats.forEach(m => m.dispose()); } }); this.highlight.clear(); }
  select(id: string | null, triangle?: number, point?: THREE.Vector3) {
    this.needsRender = true;
    this.clearHighlight(); const mesh = this.meshes.find(m => m.uuid === id);
    if (!mesh || !mesh.visible || mesh.userData.packageMesh?.selectable === false) { this.onPick(null); return; }
    mesh.updateWorldMatrix(true, false);
    const evidence = mesh.userData.step as StepEvidence | undefined;
    const cadFace = faceForTriangle(evidence, triangle);
    if (triangle !== undefined) {
      const geo = mesh.geometry, pos = geo.getAttribute('position'), idx = geo.index;
      const first = cadFace?.firstTriangle ?? triangle, last = cadFace?.lastTriangle ?? triangle;
      const vertices = new Float32Array((last - first + 1) * 9), vertex = new THREE.Vector3();
      for (let i = first * 3; i < (last + 1) * 3; i++) vertex.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(mesh.matrixWorld).toArray(vertices, (i - first * 3) * 3);
      const selected = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)), new THREE.MeshBasicMaterial({ color: '#007acc', transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }));
      this.highlight.add(selected);
    } else {
      const box = new THREE.Box3().setFromObject(mesh);
      const helper = new THREE.Box3Helper(box, new THREE.Color('#4fc1ff')); this.highlight.add(helper);
    }
    const box = new THREE.Box3().setFromObject(mesh), size = box.getSize(new THREE.Vector3());
    const units = evidence?.units || (mesh.userData.packageMesh ? 'mm' : undefined);
    const review: Omit<ReviewAnchor, 'file'> | undefined = this.identity ? { ...this.identity, meshKey: mesh.userData.reviewKey, name: mesh.name, kind: cadFace ? 'step-face' : triangle !== undefined ? 'triangle' : 'component', faceIndex: cadFace?.index, triangleIndex: triangle, nodeId: mesh.userData.packageMesh?.nodeId, definitionId: mesh.userData.packageMesh?.definitionId, bounds: size.toArray(), units } : undefined;
    this.onPick({ meshId: mesh.uuid, name: mesh.name, triangle, point: point?.toArray(), bounds: size.toArray(), triangles: (mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0) / 3, cadFace, faceCount: evidence?.faces.length, units, sourceHash: evidence?.sourceHash, packageMesh: mesh.userData.packageMesh, review });
  }
  locateReview(anchor: ReviewAnchor) {
    try { const { mesh, triangle } = resolveReview(this.meshes, this.identity, anchor); mesh.visible = true; this.select(mesh.uuid, triangle); return { meshId: mesh.uuid }; }
    catch (e) { return { error: (e as Error).message }; }
  }
  measure(anchor: ReviewAnchor, signal: AbortSignal) {
    const { mesh, triangle } = resolveReview(this.meshes, this.identity, anchor);
    const frame = this.measurementFrames.get(mesh.uuid); if (!frame) throw new Error('测量坐标系已失效，请重新载入模型');
    const face = faceForTriangle(mesh.userData.step as StepEvidence | undefined, triangle);
    return measureInWorker(metricInput(mesh, frame, face?.firstTriangle ?? triangle ?? 0, face?.lastTriangle ?? triangle), signal);
  }
  selectFace(id: string, index: number) {
    const mesh = this.meshes.find(m => m.uuid === id), evidence = mesh?.userData.step as StepEvidence | undefined;
    if (!Number.isSafeInteger(index) || !evidence?.faces[index] || evidence.faces[index].last < evidence.faces[index].first) return false;
    this.select(id, evidence.faces[index].first); return true;
  }
  setModel(group: THREE.Group): MeshInfo[] {
    this.disposeModel(); this.identity = group.userData.previewIdentity; this.model.add(group); group.updateMatrixWorld(true);
    const outlines = new Map<THREE.BufferGeometry, THREE.EdgesGeometry>();
    const outlineMaterial = new THREE.LineBasicMaterial({ color: '#526172', transparent: true, opacity: 0.24 });
    group.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      this.measurementFrames.set(object.uuid, object.matrixWorld.clone());
      object.userData.reviewKey = `mesh/${this.meshes.length}`;
      if (!object.name) object.name = `部件 ${this.meshes.length + 1}`;
      let outline = outlines.get(object.geometry);
      if (!outline) { outline = new THREE.EdgesGeometry(object.geometry, 26); outlines.set(object.geometry, outline); }
      const line = new THREE.LineSegments(outline, outlineMaterial);
      line.raycast = () => {}; object.add(line); this.edges.push(line); this.meshes.push(object); this.originals.set(object.uuid, object.position.clone());
    });
    this.bounds.setFromObject(group); const size = this.bounds.getSize(new THREE.Vector3());
    if (!Number.isFinite(size.length()) || size.length() === 0) throw new Error('模型没有可显示的有效几何');
    this.grid.position.z = this.bounds.min.z - size.length() * 0.018;
    this.grid.scale.setScalar(Math.max(size.x, size.y, size.z) / 90);
    this.setOptions(this.options); this.fit();
    this.motor=MotorMotion.create(group,this.onMotor);this.needsRender=true;
    if(this.motor){
      this.renderer.toneMappingExposure=.85;this.scene.environmentIntensity=.65;this.renderer.setClearColor('#18222d');
      this.scene.children.forEach(n=>{if(n instanceof THREE.Light){this.motorLights.set(n,n.intensity);n.intensity*=n instanceof THREE.HemisphereLight?.25:.6;}});
    }
    return this.meshes.map(mesh => {
      let parent: THREE.Object3D | null = mesh; let group: string | undefined;
      while (parent && !group) { group = parent.userData.assembly_group; parent = parent.parent; }
      const evidence = mesh.userData.step as StepEvidence | undefined;
      return { id: mesh.uuid, name: mesh.name, triangles: (mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0) / 3, visible: mesh.visible, group, faceCount: evidence?.faces.length, units: evidence?.units };
    });
  }
  setOptions(options: ViewOptions) {
    const wasOrtho = this.options.ortho; this.options = options;
    this.grid.visible = options.grid; this.edges.forEach(e => e.visible = options.edges);
    if (wasOrtho !== options.ortho) {
      const old = this.camera, distance = old.position.distanceTo(this.controls.target), half = distance * Math.tan(THREE.MathUtils.degToRad(17)), aspect = Math.max(this.host.clientWidth, 1) / Math.max(this.host.clientHeight, 1);
      const camera = options.ortho ? new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, 0.01, 1000000) : new THREE.PerspectiveCamera(34, aspect, 0.01, 1000000);
      camera.position.copy(old.position); camera.up.set(0, 0, 1); camera.lookAt(this.controls.target);
      this.camera = camera; this.controls.object = camera; this.controls.update();
    }
    if (!this.bounds.isEmpty()) {
      const center = this.bounds.getCenter(new THREE.Vector3()), size = this.bounds.getSize(new THREE.Vector3());
      this.renderer.clippingPlanes = options.section < 100 ? [new THREE.Plane(new THREE.Vector3(0, 0, -1), this.bounds.min.z + size.z * options.section / 100)] : [];
      explodeMeshes(this.meshes, this.originals, center, size.length() * options.explode / 180);
    }
    this.clearHighlight(); this.onPick(null); this.resize();
  }
  setVisible(id: string, visible: boolean) { const m = this.meshes.find(m => m.uuid === id); if (m) m.visible = visible; this.needsRender = true; this.select(null); }
  fit(view: 'iso' | 'top' | 'front' | 'right' = 'iso') {
    const box = new THREE.Box3().setFromObject(this.model); if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const aspect = Math.max(this.host.clientWidth, 1) / Math.max(this.host.clientHeight, 1);
    const radius = size.length() * 0.5, distance = radius / Math.sin(THREE.MathUtils.degToRad(17)) * Math.max(1, 1 / aspect) * 1.12;
    const direction = view === 'top' ? new THREE.Vector3(0.001, 0, 1) : view === 'front' ? new THREE.Vector3(0, -1, 0.001) : view === 'right' ? new THREE.Vector3(1, 0, 0.001) : new THREE.Vector3(0.85, -1.3, 2.4);
    this.camera.position.copy(center).addScaledVector(direction.normalize(), distance); this.camera.near = Math.max(0.001, distance / 10000); this.camera.far = distance * 100;
    if (this.camera instanceof THREE.OrthographicCamera) { const half = radius * 1.3; this.camera.left = -half * aspect; this.camera.right = half * aspect; this.camera.top = half; this.camera.bottom = -half; this.camera.zoom = 1; }
    this.camera.updateProjectionMatrix(); this.controls.target.copy(center); this.controls.update();
  }
  snapshot() { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
  motorPlay() {this.select(null);this.motor?.play();this.needsRender=true;}
  motorPause() {this.motor?.pause();this.needsRender=true;}
  motorRestart() {this.select(null);this.motor?.restart();this.needsRender=true;}
  motorSeek(t:number) {this.motor?.pause();this.motor?.seek(t);this.needsRender=true;}
  async recordMotor(): Promise<Blob> {
    if(!this.motor||this.recorder)throw new Error('请先载入电机演示模型，或等待当前录制结束');
    if(typeof MediaRecorder==='undefined')throw new Error('当前浏览器不支持视口视频录制');
    const mime=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));
    if(!mime)throw new Error('当前浏览器没有可用的 WebM 编码器');
    const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=900;
    this.recordingCanvas=canvas;this.recordCancelled=false;
    const ratio=this.renderer.getPixelRatio();this.renderer.setPixelRatio(1);this.renderer.setSize(1600,900,false);
    this.controls.enabled=false;this.motor.recording=true;this.motor.restart();this.needsRender=true;
    const stream=canvas.captureStream(30), chunks:Blob[]=[];
    try {
      const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:10_000_000});this.recorder=recorder;
      return await new Promise<Blob>((resolve,reject)=>{
        recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
        recorder.onerror=()=>reject(new Error('视频编码失败，请重试'));
        recorder.onstop=()=>{if(this.recordCancelled)reject(new Error('模型切换，录制已取消'));else resolve(new Blob(chunks,{type:'video/webm'}));};
        recorder.start(1000);
      });
    } finally {
      if(this.recorder?.state==='recording')this.recorder.stop();
      stream.getTracks().forEach(t=>t.stop());this.recorder=undefined;this.recordingCanvas=undefined;
      if(this.motor){this.motor.recording=false;this.motor.pause();}
      this.controls.enabled=true;
      if(!this.disposed){this.renderer.setPixelRatio(ratio);this.resize();}
    }
  }
  private resize() {
    this.needsRender = true;
    if(this.recordingCanvas)return;
    const width = Math.max(this.host.clientWidth, 1), height = Math.max(this.host.clientHeight, 1); this.renderer.setSize(width, height);
    if (this.camera instanceof THREE.PerspectiveCamera) this.camera.aspect = width / height;
    else { const half = (this.camera.top - this.camera.bottom) / 2; this.camera.left = -half * width / height; this.camera.right = half * width / height; }
    this.camera.updateProjectionMatrix();
  }
  clearModel() { this.disposeModel(); this.onPick(null); this.bounds.makeEmpty(); this.renderer.clippingPlanes = []; this.needsRender = true; }
  private disposeModel() {
    if(this.recorder?.state==='recording'){this.recordCancelled=true;this.recorder.stop();}
    this.motor?.dispose();this.motor=undefined;this.onMotor(null);
    this.motorLights.forEach((intensity,light)=>{light.intensity=intensity;});this.motorLights.clear();this.renderer.toneMappingExposure=1.05;this.scene.environmentIntensity=1;this.renderer.setClearColor('#1e1e1e');
    this.clearHighlight();
    this.model.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) { o.geometry.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); } });
    this.model.clear(); this.meshes = []; this.edges = []; this.originals.clear(); this.measurementFrames.clear(); this.identity = undefined;
  }
  dispose() { this.disposed = true; cancelAnimationFrame(this.frameId); this.observer.disconnect(); this.controls.dispose(); this.disposeModel(); this.scene.environment?.dispose(); this.grid.geometry.dispose(); (this.grid.material as THREE.Material).dispose(); this.renderer.dispose(); this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown); this.renderer.domElement.removeEventListener('pointerup', this.pointerUp); this.renderer.domElement.remove(); }
}
