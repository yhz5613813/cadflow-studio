import * as THREE from 'three';
import { ASSEMBLY_WINDOWS, MOTOR_DURATION, assemblyProgress, motorSample } from './motor-timeline';

export type MotorState = ReturnType<typeof motorSample> & { playing: boolean; recording: boolean };
type Part = { node: THREE.Object3D; id: string; assembled: THREE.Vector3; exploded: THREE.Vector3 };
const validVector = (v: unknown): v is number[] => Array.isArray(v) && v.length===3 && v.every(n=>typeof n==='number' && Number.isFinite(n) && Math.abs(n)<5);
const surfaceColors:Record<string,string>={cast:'#aab4b7',machined:'#d0d7db',steel:'#737b80',lamination:'#646b6c',copper:'#bd592e',copper_dark:'#8b361c',black:'#202830',seal:'#183c6d',brass:'#ac864b',insulator:'#bba988',darksteel:'#3d464d'};
function finishMaterial(source:THREE.Material) {
  const mat=source.clone();
  if(mat instanceof THREE.MeshStandardMaterial) {
    // The source reconstruction palette is sRGB; set() performs the linear conversion.
    if(surfaceColors[mat.name])mat.color.set(surfaceColors[mat.name]);
    mat.envMapIntensity=.8;
    const cast=mat.name==='cast';
    if(cast||['machined','steel','lamination'].includes(mat.name)) {
      mat.onBeforeCompile=shader=>{
        shader.vertexShader='varying vec3 motorSurface;\n'+shader.vertexShader;
        shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nmotorSurface=position;');
        shader.fragmentShader='varying vec3 motorSurface;\n'+shader.fragmentShader;
        shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>',cast?'#include <roughnessmap_fragment>\nfloat grain=fract(sin(dot(floor(motorSurface*11000.0),vec3(12.9898,78.233,39.425)))*43758.5453);roughnessFactor+=.13*(grain-.5);diffuseColor.rgb*=.93+.14*grain;':'#include <roughnessmap_fragment>\nroughnessFactor+=.035*sin(motorSurface.z*38000.0);');
      };
      mat.customProgramCacheKey=()=>`motor-finish-${mat.name}`;
    }
  }
  return mat;
}

/** Only the explicit, bounded metadata profile enables this presentation. */
export class MotorMotion {
  time=0; playing=false; recording=false; autoCamera=true;
  private parts: Part[]=[];
  private spinning: THREE.Object3D[]=[];
  private clipped: THREE.Material[]=[];
  private clip=new THREE.Plane(new THREE.Vector3(0,1,0),2);
  private helpers=new THREE.Group();
  private field=new THREE.Group();
  private rotorMarker=new THREE.Group();
  private phaseLights: THREE.MeshBasicMaterial[]=[];
  private rotorLine: THREE.Line;
  private fieldLine: THREE.Line;
  private last=0;
  private lastNotify=0;
  private root: THREE.Object3D;
  constructor(root: THREE.Object3D, private notify: (state: MotorState)=>void) {
    this.root=root;
    root.traverse(node=>{
      const d=node.userData;
      if (typeof d.motorPart==='string' && ASSEMBLY_WINDOWS[d.motorPart] && validVector(d.assembled) && validVector(d.exploded)) this.parts.push({node,id:d.motorPart,assembled:new THREE.Vector3(...d.assembled),exploded:new THREE.Vector3(...d.exploded)});
      if (node instanceof THREE.Mesh) {
        node.material=Array.isArray(node.material)?node.material.map(finishMaterial):finishMaterial(node.material);
        if (d.motorSpin===true) this.spinning.push(node);
        else if (['im_stator','im_jacket','im_housing','im_front','im_resolver'].includes(node.parent?.userData.motorPart)) {
          for(const mat of (Array.isArray(node.material)?node.material:[node.material])) {mat.clippingPlanes=[this.clip];mat.side=THREE.DoubleSide;this.clipped.push(mat);}
          for(const child of node.children) if(child instanceof THREE.LineSegments) {child.material=(child.material as THREE.Material).clone();(child.material as THREE.Material).clippingPlanes=[this.clip];this.clipped.push(child.material as THREE.Material);}
        }
      }
    });
    this.helpers.name='机理示意标记（非实体零件）'; this.helpers.add(this.field,this.rotorMarker);root.add(this.helpers);
    const ring=(radius:number,z:number,color:string,start=0,length=Math.PI*2)=>{
      const points=Array.from({length:97},(_,i)=>new THREE.Vector3(radius*Math.cos(start+length*i/96),radius*Math.sin(start+length*i/96),z));
      return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color,transparent:true,opacity:.95,depthTest:false,depthWrite:false,toneMapped:false}));
    };
    this.fieldLine=ring(.143,-.028,'#5cdfed',0,Math.PI*1.85);this.field.add(this.fieldLine);
    this.rotorLine=ring(.070,-.025,'#ffb34b',0,Math.PI*1.7);this.rotorMarker.add(this.rotorLine);
    for(let i=0;i<4;i++) {
      const a=i*Math.PI/2, color=i%2?'#718cff':'#5cdfed';
      const marker=new THREE.Mesh(new THREE.SphereGeometry(.004,16,10),new THREE.MeshBasicMaterial({color,depthTest:false,depthWrite:false,transparent:true,toneMapped:false}));marker.position.set(.143*Math.cos(a),.143*Math.sin(a),-.028);this.field.add(marker);
      const arrow=new THREE.Mesh(new THREE.ConeGeometry(.005,.018,12),new THREE.MeshBasicMaterial({color,depthTest:false,depthWrite:false,transparent:true,toneMapped:false}));arrow.position.copy(marker.position);arrow.rotation.z=a;this.field.add(arrow);
    }
    const rotorTip=new THREE.Mesh(new THREE.SphereGeometry(.005,16,10),new THREE.MeshBasicMaterial({color:'#ffb34b',depthTest:false,depthWrite:false,transparent:true,toneMapped:false}));rotorTip.position.set(.07,0,-.025);this.rotorMarker.add(rotorTip);
    const rotorStripe=new THREE.Mesh(new THREE.BoxGeometry(.0012,.003,.112),new THREE.MeshBasicMaterial({color:'#ffb34b',toneMapped:false}));rotorStripe.position.set(.066,0,.061);this.rotorMarker.add(rotorStripe);
    for(let i=0;i<3;i++) {
      const a=i*Math.PI*2/3, mat=new THREE.MeshBasicMaterial({color:['#eb7956','#80c496','#658fe1'][i],transparent:true,opacity:.8,depthTest:false});this.phaseLights.push(mat);
      const dot=new THREE.Mesh(new THREE.SphereGeometry(.004,12,8),mat);dot.position.set(.105*Math.cos(a),.105*Math.sin(a),-.03);this.helpers.add(dot);
    }
    this.helpers.traverse(n=>{n.renderOrder=20;});this.seek(0);
  }
  static create(group: THREE.Group, notify: (state: MotorState)=>void) {
    let candidate: THREE.Object3D|undefined;
    group.traverse(n=>{if(n.userData.motorDemo==='cadflow.induction-demo.v1')candidate=n;});
    if(!candidate) return undefined;
    // Require all ten named groups; malformed files remain ordinary static models.
    const keys=new Set<string>();candidate.traverse(n=>{if(ASSEMBLY_WINDOWS[n.userData.motorPart]&&validVector(n.userData.assembled)&&validVector(n.userData.exploded))keys.add(n.userData.motorPart);});
    return keys.size===10 ? new MotorMotion(candidate,notify):undefined;
  }
  get state(): MotorState {return {...motorSample(this.time),playing:this.playing,recording:this.recording};}
  play() {if(this.time>=MOTOR_DURATION)this.time=0;this.playing=true;this.last=0;this.publish();}
  pause() {this.playing=false;this.publish();}
  restart() {this.autoCamera=true;this.seek(0);this.play();}
  seek(t:number) {this.time=Math.max(0,Math.min(MOTOR_DURATION,t));this.last=0;this.apply();this.publish();}
  tick(now:number) {
    if(!this.playing)return false;
    if(this.last)this.time=Math.min(MOTOR_DURATION,this.time+Math.max(0,now-this.last)/1000);
    this.last=now;if(this.time>=MOTOR_DURATION)this.playing=false;this.apply();
    if(now-this.lastNotify>120||!this.playing){this.publish();this.lastNotify=now;}
    return true;
  }
  private publish(){this.notify(this.state);}
  private apply() {
    const sample=motorSample(this.time);
    for(const part of this.parts)part.node.position.lerpVectors(part.exploded,part.assembled,assemblyProgress(part.id,this.time));
    for(const node of this.spinning)node.rotation.z=sample.rotorAngle;
    this.clip.constant=2*(1-sample.cut);
    this.helpers.visible=this.time>=22;
    this.field.rotation.z=sample.fieldAngle;this.rotorMarker.rotation.z=sample.rotorAngle;
    this.phaseLights.forEach((mat,i)=>{mat.opacity=sample.energized?.25+.75*Math.abs(Math.sin(sample.fieldAngle*2-i*Math.PI*2/3)):.18;});
    this.root.updateWorldMatrix(true,true);
  }
  frame(camera: THREE.PerspectiveCamera|THREE.OrthographicCamera, target: THREE.Vector3, aspect:number) {
    if(!this.autoCamera)return;
    const box=new THREE.Box3();for(const part of this.parts)box.union(new THREE.Box3().setFromObject(part.node));
    const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
    const direction=new THREE.Vector3(-.58,-1,.63).normalize();
    const right=new THREE.Vector3().crossVectors(direction,new THREE.Vector3(0,0,1)).normalize();
    const up=new THREE.Vector3().crossVectors(right,direction).normalize();
    const extent=(v:THREE.Vector3)=>(Math.abs(v.x)*size.x+Math.abs(v.y)*size.y+Math.abs(v.z)*size.z)/2;
    const half=Math.max(extent(up),extent(right)/aspect)*1.12;
    const distance=half/Math.tan(THREE.MathUtils.degToRad(17))+extent(direction)*.65;
    center.z-=size.z*.025;camera.position.copy(center).addScaledVector(direction,distance);camera.up.set(0,0,1);camera.near=.001;camera.far=30;
    if(camera instanceof THREE.PerspectiveCamera)camera.aspect=aspect;
    else {camera.left=-half*aspect;camera.right=half*aspect;camera.top=half;camera.bottom=-half;}
    camera.lookAt(center);camera.updateProjectionMatrix();target.copy(center);
  }
  dispose() {
    this.playing=false;
    this.helpers.traverse(n=>{if(n instanceof THREE.Mesh||n instanceof THREE.Line){n.geometry.dispose();(Array.isArray(n.material)?n.material:[n.material]).forEach(m=>m.dispose());}});this.helpers.removeFromParent();
    this.clipped.forEach(m=>{m.clippingPlanes=[];});
  }
}
