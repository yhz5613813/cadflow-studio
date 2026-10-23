import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {HttpError,jsonRead} from './storage.js';
import {runProcess} from './process.js';

export function validateBindings(value:any,sourceHash:string) {
  if(value?.schema_version!==1||value.source_sha256!==sourceHash||value.equivalence?.approved!==true)throw new HttpError(422,'CAD 或语义边界已改变，请重新发布和校验');
  const map:Record<string,string>={'interface.fixed_support':'bottom','interface.axial_load':'top','interface.external_pressure':'skin'};
  for(const [name,region] of Object.entries(map)){
    const b=value.bindings?.[name];
    if(!b||b.shell_set!==region||!Number.isInteger(b.face_count)||b.face_count<1||!Number.isFinite(b.area_mm2)||b.area_mm2<=0)throw new HttpError(422,'仿真边界不完整或映射错误：'+name);
  }
  return value;
}
export async function checkParametricBindings(dataRoot:string,source:string,folder:string,hash:string,signal?:AbortSignal,output?:(text:string)=>void){
  const sidecar=source.replace(/\.(step|stp)$/i,'.bindings.json');
  const record=await jsonRead<any>(sidecar,null);
  if(!record)return null;
  validateBindings(record,hash);
  const config=await jsonRead<any>(path.join(dataRoot,'parametric-runtime.json'),null);
  if(!config)throw new HttpError(422,'语义边界复核需要参数化建模环境');
  const resource=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../resources/parametric');
  const receipt=path.join(folder,'validated-bindings.json');let log='';
  const result=await runProcess(config.python,['-u',path.join(resource,'bridge.py'),'validate',path.join(folder,'source.step'),path.join(resource,'reference-cylinder.step'),receipt],
    {cwd:resource,signal,timeout:15*60*1000,output:t=>{log=(log+t).slice(-5000);output?.(t);}});
  if(result.code!==0||result.timedOut)throw new HttpError(422,'CAD 实体与边界复核失败：'+log);
  const validated=validateBindings(await jsonRead(receipt,null),hash);
  const referenceHash=createHash('sha256').update(await fs.readFile(path.join(resource,'reference-cylinder.step'))).digest('hex');
  if(validated.equivalence.reference_sha256!==referenceHash)throw new HttpError(422,'参考 CAD 校验失败');
  return validated;
}
