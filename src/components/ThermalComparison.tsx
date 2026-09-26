import {useState} from 'react';
import type {ThermalRun} from '../../shared/thermal';
export function ThermalComparison({run,runs}:{run:ThermalRun;runs:ThermalRun[]}){
  const [id,setId]=useState('');const options=runs.filter(r=>r.id!==run.id&&r.state==='succeeded'&&r.result),baseline=options.find(r=>r.id===id);
  if(!options.length)return null;
  return <section><h3>与另一次仿真比较</h3><select aria-label="热仿真对比基准" value={id} onChange={e=>setId(e.target.value)}><option value="">选择基准结果</option>{options.map(r=><option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString()} · {r.source}</option>)}</select>{baseline&&<><p>本次最高温度相对基准：<strong>{(run.result!.result.maximum_C-baseline.result!.result.maximum_C).toFixed(3)} °C</strong></p><p>基准 {baseline.result!.result.maximum_C.toFixed(3)} °C → 本次 {run.result!.result.maximum_C.toFixed(3)} °C</p><small>{JSON.stringify(run.config)===JSON.stringify(baseline.config)&&run.units===baseline.units?'工况配置和输入单位相同。':'工况配置或输入单位不同，请核对后解释温差。'} {run.sourceHash===baseline.sourceHash?'模型文件摘要相同。':'模型文件摘要不同。'} 比较保存帧的全局极值，不代替网格收敛或相同位置的温差评估。</small><code>基准 SHA-256: {baseline.sourceHash}</code></>}</section>;
}
