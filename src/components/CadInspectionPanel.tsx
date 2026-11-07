import { useEffect, useRef, useState } from 'react';
import type { Artifact } from '../../shared/types';
import type { CadInspectionJob, CadInspectionSource, CadInspectionSummary } from '../../shared/cad-inspections';
import { request } from '../api';
import { cadInspectionMatches, cadMassKg, cadSourceKey } from './cad-inspection-state';
import './CadInspectionPanel.css';

const numeric = (n: number | null | undefined) => typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString(undefined, { maximumSignificantDigits: 8 }) : '不可用';
const vector = (v: number[] | null | undefined) => v?.map(numeric).join(' / ') || '不可用';
const statusLabel: Record<string, string> = { queued: '排队中', running: '计算中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
const running = (job: CadInspectionJob) => ['queued', 'running'].includes(job.state);
const json = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

function Properties({ value, density, title }: { value: CadInspectionSummary; density?: number; title: string }) {
  return <section className="cad-properties"><h4>{title}</h4><dl>
    <div><dt>材料体积 · mm³</dt><dd>{numeric(value.material_valid ? value.material_volume_mm3 : null)}</dd></div>
    <div><dt>质量估算 · kg</dt><dd>{density === undefined ? '未设置密度' : numeric(cadMassKg(value, density))}</dd></div>
    <div><dt>{value.surface_area_basis === 'material-union' ? '材料表面积' : '源几何表面积'} · mm²</dt><dd>{numeric(value.surface_area_mm2)}</dd></div>
    <div><dt>质心 X / Y / Z · mm</dt><dd>{vector(value.centroid_mm)}</dd></div>
    <div><dt>包围盒 X / Y / Z · mm</dt><dd>{vector(value.bbox_mm?.size)}</dd></div>
    <div><dt>源实体数量</dt><dd>{value.solid_count}</dd></div>
    <div><dt>实体体积直接求和 · mm³</dt><dd>{numeric(value.raw_solid_volume_sum_mm3)}</dd></div>
    <div><dt>重叠重复体积 · mm³</dt><dd>{numeric(value.overlap_volume_mm3)}</dd></div>
  </dl><p className={value.material_valid ? 'cad-check-ok' : 'cad-check-warning'}>{value.material_valid ? '材料并集通过有效性检查' : '未取得有效封闭材料实体，质量不可用'}</p>
  {value.warnings?.map((warning, i) => <p className="cad-check-warning" key={i}>{warning}</p>)}
  </section>;
}

export function CadInspectionPanel({ projectId, files, currentFile, currentHash, reference, context, preview, compare, changed }: {
  projectId: string; files: Artifact[]; currentFile?: string; currentHash?: string;
  reference?: { path: string; revision?: string; label?: string };
  context: (text: string) => void; preview: (path: string) => void;
  compare: (source: string, baseline: string) => void; changed: () => Promise<void>;
}) {
  const steps = files.filter(file => /\.(step|stp)$/i.test(file.name) && !file.path.startsWith('studio/cad-inspections/') && !file.path.startsWith('structural/'));
  const [source, setSource] = useState(steps.some(f => f.path === currentFile) ? currentFile! : steps[0]?.path || '');
  const [baseline, setBaseline] = useState(''), [density, setDensity] = useState('');
  const [jobs, setJobs] = useState<CadInspectionJob[]>([]), [selected, setSelected] = useState('');
  const [error, setError] = useState(''), [working, setWorking] = useState(false);
  const live = useRef(true), readEpoch = useRef(0), callbacks = useRef({ changed }); callbacks.current = { changed };
  const base = '/api/projects/' + encodeURIComponent(projectId) + '/cad-inspections';
  const row = jobs.find(job => job.id === selected) || jobs[0];
  const densityValue = density.trim() ? Number(density) : undefined;
  const densityValid = densityValue === undefined || (Number.isFinite(densityValue) && densityValue > 0 && densityValue <= 100000);
  const baselineSource: CadInspectionSource | undefined = baseline === '__reference__' && reference ? { path: reference.path, revision: reference.revision } : baseline ? { path: baseline } : undefined;
  const sourceRef = { path: source };
  const expectedHash = source === currentFile ? currentHash?.replace(/^sha256:/, '') : undefined;
  const matches = row && cadInspectionMatches(row, sourceRef, baselineSource, densityValue, expectedHash);
  const referenceAvailable = reference && /\.(step|stp)$/i.test(reference.path);

  useEffect(() => {
    live.current = true;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const refresh = async () => {
      const epoch = readEpoch.current;
      try {
        const next = await request<CadInspectionJob[]>(base, { signal: abort.signal });
        if (!active) return;
        if (epoch === readEpoch.current) setJobs(next);
        timer = setTimeout(refresh, next.some(running) ? 1200 : 5000);
      } catch (e) { if (active) { setError((e as Error).message); timer = setTimeout(refresh, 5000); } }
    };
    void refresh();
    return () => { active = false; live.current = false; abort.abort(); clearTimeout(timer); };
  }, [base]);
  useEffect(() => { if (!source && steps.length) setSource(steps.find(f => f.path === currentFile)?.path || steps[0].path); }, [files, currentFile, source]);
  const completed = jobs.filter(j => j.state === 'succeeded').map(j => j.id).join('|');
  useEffect(() => { if (completed) void callbacks.current.changed().catch(() => {}); }, [completed]);

  const start = async () => {
    if (!source || !densityValid) return;
    setWorking(true); setError('');
    try {
      const job = await request<CadInspectionJob>(base, json({ source: sourceRef, baseline: baselineSource, density_kg_m3: densityValue, expected_source_hash: expectedHash }));
      if (live.current) { readEpoch.current++; setJobs(old => [job, ...old.filter(j => j.id !== job.id)]); setSelected(job.id); }
    } catch (e) { if (live.current) setError((e as Error).message); }
    finally { if (live.current) setWorking(false); }
  };
  const cancel = async (job: CadInspectionJob) => {
    setWorking(true); setError('');
    try { const value = await request<CadInspectionJob>(base + '/' + job.id + '/cancel', json({})); if (live.current) { readEpoch.current++; setJobs(old => old.map(j => j.id === value.id ? value : j)); } }
    catch (e) { if (live.current) setError((e as Error).message); }
    finally { if (live.current) setWorking(false); }
  };
  const result = row?.result, summary = result?.summary, prior = result?.baseline?.summary, difference = result?.comparison;
  const deltaValid = difference?.status === 'succeeded' && difference.boolean_valid && difference.volume_balance_valid;
  const massCurrent = cadMassKg(summary, row?.density_kg_m3), massBefore = cadMassKg(prior, row?.density_kg_m3);
  const exportJSON = () => {
    if (!row?.result) return;
    const body = { source: row.source, baseline: row.baseline, createdAt: row.createdAt, density_kg_m3: row.density_kg_m3, mass_kg: massCurrent, baseline_mass_kg: massBefore, result: row.result };
    const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'castudio-cad-inspection.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <div className="cad-inspection-panel">
    <section className="cad-inspection-setup"><p>从 STEP 实体计算尺寸、体积、表面积和质心。选择基准模型后，可检查实际增加与减少的材料；沿用文件坐标，不自动对齐模型。</p>
      <div className="cad-inspection-inputs">
        <label>检查模型<select aria-label="CAD 检查模型" value={source} onChange={e => setSource(e.target.value)}><option value="">选择 STEP 模型</option>{steps.map(f => <option key={f.path} value={f.path}>{f.path}</option>)}</select></label>
        <label>对比基准<select aria-label="CAD 对比基准" value={baseline} onChange={e => setBaseline(e.target.value)}><option value="">只检查当前模型</option>{referenceAvailable && <option value="__reference__">已加载参考：{reference.label || reference.path}{reference.revision ? '（历史版本）' : ''}</option>}{steps.map(f => <option key={f.path} value={f.path}>{f.path}</option>)}</select></label>
        <label>统一密度 · kg/m³<input aria-label="质量估算密度" type="number" min="0.001" max="100000" placeholder="可选，例如 2700" value={density} onChange={e => setDensity(e.target.value)}/><small>仅用于质量估算，不修改仿真材料。</small></label>
      </div>
      {!densityValid && <p role="alert" className="form-error">密度需为大于 0、不超过 100000 的数值，或留空。</p>}
      <div className="build-actions"><button className="button primary" disabled={!source || !densityValid || working || jobs.some(running)} onClick={() => void start()}>{working ? '正在处理…' : baseline ? '检查并比较实体' : '检查 CAD 实体'}</button><span>检查范围：整个 STEP，单位统一为 mm。</span></div>
      {source && baselineSource && cadSourceKey(sourceRef) === cadSourceKey(baselineSource) && <small>当前选择相同文件，可用于检查几何一致性。</small>}
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}
    <section className="cad-inspection-results"><div className="cad-inspection-heading"><h3>检查记录</h3><select aria-label="CAD 检查记录" value={row?.id || ''} onChange={e => setSelected(e.target.value)}><option value="">暂无记录</option>{jobs.map(job => <option key={job.id} value={job.id}>{new Date(job.createdAt).toLocaleString()} · {statusLabel[job.state] || job.state}</option>)}</select></div>
      {row && <><div className="cad-inspection-run"><strong>{statusLabel[row.state] || row.state}</strong><span>{row.source.path}{row.source.revision ? '（历史版本）' : ''}</span>{running(row) && <button className="button" disabled={working} onClick={() => void cancel(row)}>取消检查</button>}</div>
        {!matches && <p className="cad-check-warning">{row.stale ? '原模型文件已变化，当前记录来自已冻结的历史几何。' : '当前显示历史检查记录，与上方选择或密度不同。'}执行检查可生成新记录。</p>}
        {row.error && <p className="form-error" role="alert">{row.error}</p>}
        {row.log && <details className="cad-inspection-log"><summary>计算详情</summary><pre>{row.log}</pre></details>}
      </>}
      {row?.state === 'succeeded' && result && summary && <>
        {row.density_kg_m3 !== undefined && <p>本记录质量估算采用统一密度 <strong>{numeric(row.density_kg_m3)} kg/m³</strong>。</p>}
        <div className={'cad-property-columns' + (prior ? ' compared' : '')}>{prior && <Properties title="基准模型" value={prior} density={row.density_kg_m3}/>}<Properties title={prior ? '当前模型' : 'CAD 属性'} value={summary} density={row.density_kg_m3}/></div>
        {difference && <section className="cad-material-difference"><h4>材料变化</h4>{deltaValid ? <>
          <dl><div><dt>增加材料 · mm³</dt><dd>{numeric(difference.excess_volume_mm3)}</dd></div><div><dt>减少材料 · mm³</dt><dd>{numeric(difference.missing_volume_mm3)}</dd></div><div><dt>净体积变化 · mm³</dt><dd>{numeric(difference.volume_delta_mm3)}</dd></div><div><dt>质心移动 · mm</dt><dd>{numeric(difference.centroid_distance_mm)}</dd></div>{massCurrent !== null && massBefore !== null && <div><dt>质量变化 · kg</dt><dd>{numeric(massCurrent - massBefore)}</dd></div>}</dl>
          <p className="cad-check-ok">双向布尔差与体积平衡校验通过</p>
          <div className="build-actions">{difference.exported_files?.excess_material && <button className="button" onClick={() => preview(row.outputPath + '/' + difference.exported_files.excess_material)}>查看增加材料</button>}{difference.exported_files?.missing_material && <button className="button" onClick={() => preview(row.outputPath + '/' + difference.exported_files.missing_material)}>查看减少材料</button>}<button className="button" onClick={() => compare(row.outputPath + '/source.step', row.outputPath + '/baseline.step')}>双视图比较模型</button></div>
        </> : <p className="cad-check-warning">材料差异未通过完整校验，不据此判断几何等价或材料变化。</p>}{difference.warnings?.map((w, i) => <p className="cad-check-warning" key={i}>{w}</p>)}</section>}
        <details className="cad-inspection-bodies"><summary>源文件中的 {summary.bodies.length} 个实体</summary><p>实体编号仅用于当前文件；各实体体积可能重叠，材料总量使用上方并集结果。</p><div className="cad-table-scroll"><table><thead><tr><th>实体</th><th>封闭 / 有效</th><th>体积 · mm³</th><th>质心 X / Y / Z · mm</th></tr></thead><tbody>{summary.bodies.map(body => <tr key={body.id}><th>{body.id}</th><td>{body.closed ? '封闭' : '开放'} / {body.valid ? '有效' : '无效'}</td><td>{numeric(body.volume_mm3)}</td><td>{vector(body.centroid_mm)}</td></tr>)}</tbody></table></div></details>
        <div className="build-actions"><button className="button" onClick={exportJSON}>下载检查 JSON</button><button className="button" onClick={() => context('请根据以下 CAD 内核检查结果分析设计差异。质量采用记录中的统一密度；无效或不可用的材料结果不能用于质量与几何等价判断。\n' + JSON.stringify({ source: row.source, baseline: row.baseline, density_kg_m3: row.density_kg_m3, result }, null, 2))}>加入对话草稿</button></div>
      </>}
    </section>
  </div>;
}
