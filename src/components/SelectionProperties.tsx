import { useEffect, useState } from 'react';
import type { Selection } from '../scene/renderer';
export function SelectionProperties({ selection, selectFace }: { selection: Selection | null; selectFace: (id: string, face: number) => boolean }) {
  const [face, setFace] = useState(0);
  const [message, setMessage] = useState('');
  useEffect(() => { setFace(selection?.cadFace?.index ?? 0); setMessage(''); }, [selection?.meshId, selection?.cadFace?.index]);
  if (!selection) return <div className="small-empty">在三维视口或模型树中选择一个部件，查看几何与来源信息。</div>;
  return <><div><span className="eyebrow">SELECTED ENTITY</span><strong>{selection.name}</strong><small>{selection.cadFace ? `STEP 面 #${selection.cadFace.index} · ${selection.cadFace.lastTriangle - selection.cadFace.firstTriangle + 1} 个三角面` : selection.triangle !== undefined ? `显示网格三角面 #${selection.triangle}` : selection.packageMesh ? '场景包部件' : selection.units ? 'STEP 导入部件' : '显示网格部件'}</small></div>
    <div><span>包围盒尺寸 · {selection.units || '模型单位'}</span><strong>{selection.bounds.map(n => Number(n.toPrecision(6)).toString()).join(' × ')}</strong><small>根据预览网格计算；曲面精度受预览设置影响</small></div>
    <div><span>三角面数量</span><strong>{Math.round(selection.triangles).toLocaleString()}</strong><small>随消息附带所选对象的上下文</small></div>
    {selection.faceCount !== undefined && <div className="step-face-selector"><span>STEP 面 · 共 {selection.faceCount} 个</span><div><input aria-label="STEP 面编号" type="number" min="0" max={selection.faceCount - 1} value={face} onChange={e => setFace(Number(e.target.value))}/><button className="button" disabled={!Number.isSafeInteger(face) || face < 0 || face >= selection.faceCount} onClick={() => setMessage(selectFace(selection.meshId, face) ? '' : '此面没有可显示的三角网格')}>定位此面</button></div><small>{message || '编号从 0 开始；仅对应本文件此次导入的面'}</small></div>}
    {selection.cadFace && <div className="step-face-evidence"><span>面来源</span><code title={selection.cadFace.id}>{selection.cadFace.id}</code><small>OCCT 导入器提供的面映射；不是 CadFlow 原生拓扑编号</small></div>}
  </>;
}
