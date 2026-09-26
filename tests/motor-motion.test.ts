import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ASSEMBLY_WINDOWS, assemblyProgress, motorSample, MOTOR_SLOWDOWN } from '../src/scene/motor-timeline';
import { MotorMotion } from '../src/scene/motor-motion';

test('all components assemble before energization; rotor stays sub-synchronous',()=>{
  for(const part of Object.keys(ASSEMBLY_WINDOWS)){assert.equal(assemblyProgress(part,0),0);assert.equal(assemblyProgress(part,17),1);}
  for(let t=0;t<=40;t+=.01){const s=motorSample(t);assert.ok(s.rotorRpm>=0&&s.rotorRpm<=s.fieldRpm);if(t<23)assert.equal(s.rotorAngle,0);}
  const run=motorSample(35);assert.equal(run.fieldRpm,1500);assert.equal(run.rotorRpm,1440);assert.equal(run.slip,4);
  // Angular displacement and reported speed must agree during the entire ramp.
  for(let t=23.01;t<39;t+=.07){const dt=.00001, s=motorSample(t);const derived=(motorSample(t+dt).rotorAngle-motorSample(t-dt).rotorAngle)/(2*dt)*60*MOTOR_SLOWDOWN/(2*Math.PI);assert.ok(Math.abs(derived-s.rotorRpm)<.001);}
});

test('only rotor domains rotate; timeline seeking restores original component placements',()=>{
  const root=new THREE.Group();root.userData.motorDemo='cadflow.induction-demo.v1';
  const moving:THREE.Mesh[]=[];const fixed:THREE.Mesh[]=[];
  for(const [i,id] of Object.keys(ASSEMBLY_WINDOWS).entries()){
    const part=new THREE.Group();part.userData={motorPart:id,assembled:[0,0,i/100],exploded:[0,0,i/10]};root.add(part);
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(.01,.01,.01),new THREE.MeshStandardMaterial());mesh.userData.motorSpin=id==='im_rotor';part.add(mesh);(mesh.userData.motorSpin?moving:fixed).push(mesh);
  }
  const controller=MotorMotion.create(root,()=>{});assert.ok(controller);controller.seek(35);
  fixed.forEach(mesh=>assert.equal(mesh.rotation.z,0));moving.forEach(mesh=>assert.notEqual(mesh.rotation.z,0));
  root.children.filter(n=>n.userData.motorPart).forEach(part=>assert.ok(part.position.distanceTo(new THREE.Vector3(...part.userData.assembled))<1e-12));
  controller.seek(0);moving.forEach(mesh=>assert.equal(mesh.rotation.z,0));root.children.filter(n=>n.userData.motorPart).forEach(part=>assert.deepEqual(part.position.toArray(),part.userData.exploded));controller.dispose();
  assert.equal(root.children.length,10);
});

test('ordinary and malformed models do not enable induction animation',()=>{
  const root=new THREE.Group();assert.equal(MotorMotion.create(root,()=>{}),undefined);
  root.userData.motorDemo='cadflow.induction-demo.v1';assert.equal(MotorMotion.create(root,()=>{}),undefined);
});
