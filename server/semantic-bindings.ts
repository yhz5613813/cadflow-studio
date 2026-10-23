import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {HttpError,jsonRead,safePath} from './storage.js';
import {runProcess} from './process.js';

export function validateBindings(value:any,sourceHash:string) {
  if(![1,2].includes(value?.schema_version)||value.source_sha256!==sourceHash||value.equivalence?.approved!==true)throw new HttpError(422,'CAD 或语义边界已改变，请重新发布和校验');
  if(value.schema_version===2&&(!value.geometry_model||value.geometry_model.schema_version!==1||!Array.isArray(value.geometry_model.components)||value.geometry_model.components.length!==20))throw new HttpError(422,'圆柱对象参数不完整，请重新发布');
  const map:Record<string,string>={'interface.fixed_support':'bottom','interface.axial_load':'top','interface.external_pressure':'skin'};
  for(const [name,region] of Object.entries(map)){
    const b=value.bindings?.[name];
    if(!b||b.shell_set!==region||!Number.isInteger(b.face_count)||b.face_count<1||!Number.isFinite(b.area_mm2)||b.area_mm2<=0)throw new HttpError(422,'仿真边界不完整或映射错误：'+name);
  }
  return value;
}

/** Freeze only renderer outputs bound to this exact published solid. */
export async function snapshotPresentation(source:string,folder:string,sourceHash:string) {
  const directory=path.dirname(source);
  const record=await jsonRead<any>(path.join(directory,'render-manifest.json'),null);
  if(!record)return undefined;
  if(record.source_sha256!==sourceHash||record.renderer!=='Blender Cycles')throw new HttpError(422,'CAD 渲染与当前模型不匹配，请重新构建');
  const result:any={source_sha256:sourceHash,renderer:record.renderer};
  for(const key of ['full','cutaway']){
    const name=record[key];
    if(typeof name!=='string'||!name.endsWith('.png'))throw new HttpError(422,'CAD 渲染图片记录无效');
    const file=await safePath(directory,name),bytes=await fs.readFile(file);
    if(createHash('sha256').update(bytes).digest('hex')!==record.image_sha256?.[name])throw new HttpError(422,'CAD 渲染图片已改变，请重新构建');
    const destination=path.join(folder,'cad-'+key+'.png');
    await fs.writeFile(destination,bytes);result[key]=destination;
  }
  return result;
}

export async function checkParametricBindings(dataRoot:string,source:string,folder:string,hash:string,signal?:AbortSignal,output?:(text:string)=>void){
  const sidecar=source.replace(/\.(step|stp)$/i,'.bindings.json');
  const record=await jsonRead<any>(sidecar,null);
  if(!record){
    if(source.replaceAll('\\','/').includes('/cylinder-objects/exports/'))throw new HttpError(422,'请选择已发布的计算实体 cylinder.step；对象预览不能直接作为计算实体');
    return null;
  }
  validateBindings(record,hash);
  const config=await jsonRead<any>(path.join(dataRoot,'parametric-runtime.json'),null);
  if(!config?.python)throw new HttpError(422,'语义边界复核需要参数化建模环境');
  const resource=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../resources/parametric');
  const receipt=path.join(folder,'validated-bindings.json');let log='';
  const frozenRecord=path.join(folder,'input-bindings.json');
  await fs.writeFile(frozenRecord,JSON.stringify(record));
  const args=record.schema_version===2
    ?['-u',path.join(resource,'objects.py'),'validate',path.join(folder,'source.step'),frozenRecord,receipt]
    :['-u',path.join(resource,'bridge.py'),'validate',path.join(folder,'source.step'),path.join(resource,'reference-cylinder.step'),receipt];
  const result=await runProcess(config.python,args,
    {cwd:resource,signal,timeout:15*60*1000,output:t=>{log=(log+t).slice(-5000);output?.(t);}});
  if(result.code!==0||result.timedOut)throw new HttpError(422,'CAD 实体与边界复核失败：'+log);
  const validated=validateBindings(await jsonRead(receipt,null),hash);
  if(record.schema_version===1){
    const referenceHash=createHash('sha256').update(await fs.readFile(path.join(resource,'reference-cylinder.step'))).digest('hex');
    if(validated.equivalence.reference_sha256!==referenceHash)throw new HttpError(422,'参考 CAD 校验失败');
  }else{
    validated.presentation_images=await snapshotPresentation(source,folder,hash);
  }
  return validated;
}
