import { useEffect, useRef, useState } from 'react';
import type { ReviewAnchor } from '../../shared/types';
import { measurementDifference, type Measurement, type MeasurementDocument, type MeshMetrics } from '../../shared/measurements';
import { api } from '../api';
const number = (n: number | null) => n === null ? '不可用' : Number(n.toPrecision(7)).toLocaleString(undefined, { maximumSignificantDigits: 7 });
const entity = (a: ReviewAnchor) => a.kind === 'step-face' ? `STEP 面 #${a.faceIndex}` : a.kind === 'triangle' ? `三角面 #${a.triangleIndex}` : '部件';
const label = (r: Measurement) => `${r.anchor.name} · ${entity(r.anchor)} · ${new Date(r.createdAt).toLocaleString()}`;
const limitation = '显示网格计算；不含自相交、壳体嵌套或实体干涉验证，不是 CAD 内核认证。代数体积可能因方向或多壳体抵消，不能直接当作材料用量或质量。';
export function MeasurementPanel({ projectId, anchor, busy, measure, currentFile, currentHash, context }: {
  projectId: string; anchor: ReviewAnchor | null; busy: boolean;
  measure: (anchor: ReviewAnchor, signal: AbortSignal) => Promise<MeshMetrics>;
  currentFile?: string; currentHash?: string; context: (text: string) => void;
}) {
  const [doc, setDoc] = useState<MeasurementDocument | null>(null), [current, setCurrent] = useState<Measurement | null>(null), [selected, setSelected] = useState('');
  const [baseline, setBaseline] = useState(''), [error, setError] = useState(''), [working, setWorking] = useState(false), [calculating, setCalculating] = useState(false);
  const controller = useRef<AbortController | null>(null), sequence = useRef(0);
  const anchorKey = anchor ? JSON.stringify([anchor.file, anchor.sourceHash, anchor.profile, anchor.meshKey, anchor.kind, anchor.faceIndex, anchor.triangleIndex]) : '';
  useEffect(() => {
    let live = true; void api.measurements(projectId).then(d => { if (live) setDoc(d); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; sequence.current++; controller.current?.abort(); };
  }, [projectId]);
  useEffect(() => { sequence.current++; controller.current?.abort(); setCurrent(null); setCalculating(false); }, [anchorKey]);
  const rows = doc?.measurements || [], displayed = (selected ? rows.find(r => r.id === selected) : undefined) || current || rows.at(-1), before = rows.find(r => r.id === baseline && r.id !== displayed?.id);
  useEffect(() => { if (baseline && baseline === displayed?.id) setBaseline(''); }, [baseline, displayed?.id]);
  const difference = before && displayed ? measurementDifference(before, displayed) : null;
  const calculate = async () => {
    if (!anchor) return; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const generation = ++sequence.current; setCalculating(true); setError('');
    try { const metrics = await measure(anchor, abort.signal); if (generation === sequence.current) { setCurrent({ id: 'current', createdAt: new Date().toISOString(), anchor: structuredClone(anchor), metrics }); setSelected(''); } }
    catch (e) { if (generation === sequence.current) setError((e as Error).message); }
    finally { if (generation === sequence.current) setCalculating(false); }
  };
  const save = async () => {
    if (!current || !doc) return; setWorking(true); setError('');
    try { const value = await api.saveMeasurement(projectId, doc.etag, current); setDoc(value); setSelected(value.measurements.at(-1)!.id); setCurrent(null); }
    catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  };
  const report = displayed && { version: 1, projectId, exportedAt: new Date().toISOString(), method: 'browser-preview-mesh', lengthUnit: displayed.anchor.units || 'model-unit', cadKernelVerified: false, limitation, measurement: displayed, baseline: before, difference };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })); const link = document.createElement('a');
    link.href = url; link.download = 'cadflow-mesh-inspection.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const unit = displayed?.anchor.units || '模型单位';
  return <div className="build-panel measurement-panel">
    <section><h3>测量当前选择</h3><p>{anchor ? `${anchor.name} · ${entity(anchor)}` : '先在模型树或视口中选择部件或面。示例模型不生成项目检查记录。'}</p><div className="build-actions"><button className="button primary" disabled={!anchor || calculating || working} onClick={() => void calculate()}>{calculating ? '正在计算…' : '测量当前选择'}</button>{calculating && <button className="button" onClick={() => controller.current?.abort()}>取消测量</button>}<button className="button" disabled={!current || !doc || busy || working || calculating} onClick={() => void save()}>保存检查记录</button></div><small>按原始装配位置计算，忽略拆分显示与剖切效果。每次选择最多 25 万个三角面；相同坐标顶点按精确相等合并。</small></section>
    {error && <p className="form-error" role="alert">{error}</p>}
    <section><h3>检查结果</h3><select aria-label="选择测量记录" value={displayed?.id || ''} onChange={e => setSelected(e.target.value === 'current' ? '' : e.target.value)}><option value="">暂无记录</option>{current && <option value="current">当前测量 · 尚未保存</option>}{rows.map(r => <option key={r.id} value={r.id}>{label(r)}</option>)}</select>
      {displayed && <>
        <p><strong>{displayed.anchor.name} · {entity(displayed.anchor)}</strong><small>{displayed.anchor.file}</small></p>
        <table className="parameter-history"><tbody>
          <tr><th>包围盒尺寸（{unit}）</th><td>{displayed.metrics.size.map(number).join(' × ')}</td></tr>
          <tr><th>表面积（{unit}²）</th><td>{number(displayed.metrics.surfaceArea)}</td></tr>
          <tr><th>代数体积（{unit}³）</th><td>{number(displayed.metrics.signedVolume)}</td></tr>
          <tr><th>三角面 / 合并后顶点</th><td>{displayed.metrics.triangles} / {displayed.metrics.vertices}</td></tr>
          <tr><th>边相连区域</th><td>{displayed.metrics.components}</td></tr>
          {([['边界边', 'boundaryEdges'], ['非流形边', 'nonManifoldEdges'], ['方向冲突边', 'orientationConflicts'], ['非流形顶点', 'nonManifoldVertices'], ['退化三角面', 'degenerateTriangles'], ['重复三角面', 'duplicateTriangles']] as const).map(([title, key]) => <tr key={key}><th>{title}</th><td className={displayed.metrics[key] ? 'error-text' : ''}>{displayed.metrics[key]}</td></tr>)}
        </tbody></table>
        <small>{displayed.metrics.signedVolume === null ? '未满足封闭且定向一致的网格条件，不提供封闭体积。' : '通过边连接、顶点邻域与方向检查；仍需检查自相交和壳体关系。'}</small><small>{limitation}</small>
        <details><summary>测量来源</summary><code>{displayed.anchor.sourceHash}</code><code>{displayed.anchor.profile}</code><small>{displayed.metrics.method} · {new Date(displayed.createdAt).toLocaleString()}</small><small>{displayed.anchor.file !== currentFile || !currentHash ? '未核对当前模型版本' : displayed.anchor.sourceHash === currentHash ? '与当前模型文件摘要一致' : '模型内容已变化，显示历史测量'}</small></details>
        <label>对比基准<select aria-label="测量对比基准" value={baseline} onChange={e => setBaseline(e.target.value)}><option value="">不对比</option>{rows.filter(r => r.id !== displayed.id).map(r => <option value={r.id} key={r.id}>{label(r)}</option>)}</select></label>
        {before && <><small>基准由你手动选定；请核对部件、选择范围与预览精度是否适合比较。</small>{difference ? <table className="parameter-history"><thead><tr><th>指标</th><th>基准 → 当前</th><th>变化</th></tr></thead><tbody>{[
          ...difference.size.map((value, i) => ({ name: `${['X', 'Y', 'Z'][i]} 尺寸 · mm`, value })), { name: '面积 · mm²', value: difference.surfaceArea }, ...(difference.signedVolume ? [{ name: '代数体积 · mm³', value: difference.signedVolume }] : []),
        ].map(({ name, value }) => <tr key={name}><th>{name}</th><td>{number(value.before)} → {number(value.after)}</td><td>{number(value.delta)}<small>{value.percent === null ? '基准为零' : `${number(value.percent)}%`}</small></td></tr>)}</tbody></table> : <p>两份记录都需要明确的毫米单位，才能计算变化。</p>}</>}
        <div className="build-actions"><button className="button" onClick={download}>导出检查报告</button><button className="button" onClick={() => context(`请检查以下预览网格测量结果。它不是 CAD 内核验证，不要把代数体积直接当作材料体积。先核对文件摘要和选择范围，再决定是否需要精确几何检查。\n${JSON.stringify(report, null, 2)}`)}>加入对话草稿</button>{displayed.id !== 'current' && <button className="button" disabled={busy || working || !doc} onClick={async () => { setWorking(true); setError(''); try { setDoc(await api.deleteMeasurement(projectId, doc!.etag, displayed.id)); setSelected(''); if (baseline === displayed.id) setBaseline(''); } catch (e) { setError((e as Error).message); } finally { setWorking(false); } }}>删除记录</button>}</div>
      </>}
      <button className="text-button" disabled={working} onClick={async () => { setError(''); try { setDoc(await api.measurements(projectId)); } catch (e) { setError((e as Error).message); } }}>刷新记录</button><small>记录保存在项目 studio/measurements.json，删除可从项目历史恢复。</small>
    </section>
  </div>;
}
