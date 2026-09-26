import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ThermalRun } from '../../shared/thermal';

export const thermalFileUrl=(project:string,run:string,file:string)=>`/api/projects/${project}/thermal/${run}/file?path=${encodeURIComponent(file)}`;
export function ThermalViewer({projectId,run}:{projectId:string;run:ThermalRun}) {
  const host=useRef<HTMLDivElement>(null), update=useRef<(frame:number)=>void>(()=>{});
  const [frame,setFrame]=useState(0),[error,setError]=useState(''),[ready,setReady]=useState(false);
  const result=run.result!.result;
  useEffect(()=>{
    const abort=new AbortController();let disposed=false,cleanup=()=>{};setError('');setReady(false);setFrame(0);
    async function load(){
      const [surfaceResponse,valuesResponse]=await Promise.all(['model/display.json','job/surface.bin'].map(file=>fetch(thermalFileUrl(projectId,run.id,file),{signal:abort.signal})));
      if(!surfaceResponse.ok||!valuesResponse.ok)throw new Error('温度场文件读取失败');
      const surface=await surfaceResponse.json() as {points:number[];faces:number[]};const buffer=await valuesResponse.arrayBuffer();
      if(disposed)return;
      const values=new Float32Array(buffer),vertices=surface.points.length/3;
      if(vertices!==result.vertices||values.length!==vertices*result.frames)throw new Error('温度场与几何顶点数量不一致');
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(surface.points,3));geometry.setIndex(surface.faces);geometry.computeVertexNormals();geometry.computeBoundingBox();
      const colors=new Float32Array(vertices*3);geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
      const material=new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide});
      const mesh=new THREE.Mesh(geometry,material),scene=new THREE.Scene();scene.background=new THREE.Color('#171b22');scene.add(mesh);
      const bounds=geometry.boundingBox!,center=bounds.getCenter(new THREE.Vector3()),span=Math.max(bounds.getSize(new THREE.Vector3()).length(),1e-6);
      const camera=new THREE.PerspectiveCamera(40,1,span/10000,span*100);camera.up.set(0,0,1);camera.position.copy(center).add(new THREE.Vector3(span,-span,span*.8));
      const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));host.current!.appendChild(renderer.domElement);
      const controls=new OrbitControls(camera,renderer.domElement);controls.target.copy(center);controls.update();
      const color=new THREE.Color(),low=result.minimum_C,range=Math.max(result.maximum_C-low,1e-8);
      update.current=(index)=>{for(let i=0;i<vertices;i++){const ratio=Math.max(0,Math.min(1,(values[index*vertices+i]-low)/range));color.setHSL((1-ratio)*.66,1,.5);color.toArray(colors,i*3);}geometry.attributes.color.needsUpdate=true;renderer.render(scene,camera);};
      const render=()=>renderer.render(scene,camera);controls.addEventListener('change',render);
      const resize=new ResizeObserver(()=>{if(!host.current)return;const w=host.current.clientWidth,h=host.current.clientHeight;renderer.setSize(w,h);camera.aspect=w/Math.max(1,h);camera.updateProjectionMatrix();render();});resize.observe(host.current!);
      update.current(result.frames-1);setFrame(result.frames-1);setReady(true);
      cleanup=()=>{resize.disconnect();controls.dispose();geometry.dispose();material.dispose();renderer.dispose();renderer.domElement.remove();};
    }
    void load().catch(e=>{if(!disposed)setError((e as Error).message);});
    return()=>{disposed=true;abort.abort();cleanup();update.current=()=>{};};
  },[projectId,run.id]);
  useEffect(()=>{if(ready)update.current(frame);},[frame,ready]);
  const min=result.minimum_C,max=result.maximum_C,span=Math.max(1e-6,max-min),time=Math.max(1,result.times_s.at(-1)||1);
  const line=(key:'minimum_C'|'maximum_C'|'average_C')=>result.stats.map((row,i)=>`${30+result.times_s[i]/time*560},${115-(row[key]-min)/span*95}`).join(' ');
  return <section className="thermal-view"><div className="thermal-canvas" ref={host}/>{error&&<p role="alert" className="form-error">{error}</p>}{!ready&&!error&&<p>正在加载真实温度场…</p>}<div className="thermal-legend"><span>{result.minimum_C.toFixed(2)} °C</span><i/><span>{result.maximum_C.toFixed(2)} °C</span></div><label>{result.analysis_mode==='steady'?(frame===0?'初始状态（未求稳态）':'稳态解'): `时刻 ${result.times_s[frame]?.toFixed(1)} s`}<input aria-label="温度场时刻" type="range" min={0} max={result.frames-1} step={1} value={frame} disabled={!ready} onChange={e=>setFrame(Number(e.target.value))}/></label><small>全时段统一色标 · 拖动旋转，滚轮缩放 · 仿真表面网格，原始 XYZ 坐标</small>{result.analysis_mode==='steady'?<p>稳态结果保留初始状态和稳态解两帧，不代表升温过程。</p>:<><svg viewBox="0 0 620 145" role="img" aria-label="温度随时间变化曲线" style={{width:'100%',maxHeight:180}}><path d="M30 15V115H590" fill="none" stroke="#596273"/>{(['minimum_C','average_C','maximum_C'] as const).map((key,i)=><polyline key={key} points={line(key)} fill="none" stroke={['#6aaaff','#72d6c2','#ffb56a'][i]} strokeWidth={2}/>)}<text x={30} y={137} fill="#aeb7c6" fontSize={11}>0 s</text><text x={555} y={137} fill="#aeb7c6" fontSize={11}>{time} s</text></svg><small>蓝：最低温度 · 绿：体积平均温度 · 橙：最高温度。仅连接实际保存帧。</small></>}</section>;
}
