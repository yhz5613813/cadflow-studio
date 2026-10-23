"""Studio-owned nonlinear and mesh study; all plotted fields are converged solver frames."""
import json,shutil,threading,time,subprocess,math
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np
from .cylinder import build_mesh,write_deck
from .results import parse_static,plot_results
from .geometry_model import parameters

def write(p,v):Path(p).write_text(json.dumps(v,ensure_ascii=False,indent=2),encoding='utf-8')

def saved_state(folder):
    if (folder/'summary.json').exists():return json.loads((folder/'summary.json').read_text(encoding='utf-8'))
    log=(folder/'solver.log').read_text(errors='replace')
    accepted=[]
    for line in (folder/'analysis.sta').read_text().splitlines():
        row=line.split()
        if len(row)==7 and all(t.isdigit() for t in row[:4]):accepted.append(float(row[4]))
    if not accepted:raise ValueError('No accepted raw result to recover')
    completed='Job finished' in log and '*ERROR' not in log.upper()
    return {'load_factor':accepted[-1],'full_load_reached':abs(accepted[-1]-1)<1.e-6,
            'solver_completed':completed,'solver_error':None if completed else 'Saved solver terminated before full convergence: '+log[-2500:]}

def equilibrium_status(summary):
    """Legacy midsurface estimates cannot establish solver-level force balance."""
    assembled=summary.get('assembled_balance_relative')
    crosscheck=summary.get('rf_dat_frd_relative_difference')
    if assembled is None or crosscheck is None:return 'unverified'
    values=(assembled,crosscheck)
    valid=all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) and 0<=v<1.e-4 for v in values)
    return 'passed' if valid and summary.get('balance_passed') is True else 'failed'

def run_study(out,req,status,solver):
    sizes=[float(v) for v in req.get('mesh_levels_mm',[32,24,18])]
    if len(sizes)<3 or len(sizes)>5 or sizes!=sorted(set(sizes),reverse=True) or any(not 12<=s<=60 for s in sizes):
        raise ValueError('Mesh study needs 3 to 5 distinct descending sizes within 12..60 mm')
    levels=[];force=float(req.get('axial_force_N',2451662.5));pressure=float(req.get('external_pressure_MPa',.2))
    lock=threading.Lock();meshes={};cached={}
    resume=Path(req['resume_output']) if req.get('resume_output') else None
    reprocess=req.get('reprocess_only',False)
    if reprocess and not resume:raise ValueError('Reprocessing requires a finished source study')
    if resume:
        previous=json.loads((resume/'request.json').read_text(encoding='utf-8'))
        for key in ['geometry_sha256','geometry_model','axial_force_N','external_pressure_MPa','E_MPa','nu']:
            if previous.get(key)!=req.get(key):raise ValueError('Resume request differs: '+key)
        if reprocess and json.loads((resume/'status.json').read_text())['stage'] not in ['completed','failed']:raise ValueError('Source study is not finished')
    # Gmsh is process-global. Generate meshes serially, then solve independent folders.
    for size in sizes:
        root=out/f'mesh-{size:g}';root.mkdir()
        if resume and ((resume/f'mesh-{size:g}/nonlinear/summary.json').exists() or (reprocess and (resume/f'mesh-{size:g}/nonlinear/analysis.sta').exists())):
            old=saved_state(resume/f'mesh-{size:g}/nonlinear')
            if (old.get('full_load_reached') and old.get('solver_completed')) or (reprocess and old.get('load_factor',0)>0):
                status('processing',f'网格 {size:g} mm：校验输入并复制已保存的原始结果')
                mesh=json.loads((resume/f'mesh-{size:g}/linear/shell-mesh.json').read_text())
                if parameters(mesh.get('geometry_model'))[0]!=parameters(req.get('geometry_model'))[0]:raise ValueError('Resume mesh geometry differs')
                if mesh.get('curvature_points')!=max(24,1280/size) or mesh.get('hole_phase_deg',0)!=0:raise ValueError('Resume mesh policy differs')
                for mode in ['linear','nonlinear']:
                    target=root/mode;target.mkdir();write_deck(target,mesh,mode='nonlinear' if mode=='nonlinear' else 'static',force=force,pressure=pressure,E=float(req.get('E_MPa',70000)),nu=float(req.get('nu',.33)))
                    if (target/'analysis.inp').read_bytes()!=(resume/f'mesh-{size:g}'/mode/'analysis.inp').read_bytes():raise ValueError('Resume solver deck differs')
                    shutil.copytree(resume/f'mesh-{size:g}'/mode,target,dirs_exist_ok=True)
                cached[size]={mode:saved_state(resume/f'mesh-{size:g}'/mode) for mode in ['linear','nonlinear']};meshes[size]=mesh;continue
        if reprocess:raise ValueError(f'No accepted saved result for mesh {size:g}; reprocessing never starts a solver')
        status('meshing',f'网格 {size:g} mm：生成共节点二阶壳')
        meshes[size]=build_mesh(root/'linear',size,geometry_model=req.get('geometry_model'))
        if req.get('semantic_bindings'):meshes[size]['semantic_bindings']=req['semantic_bindings'];write(root/'linear'/'shell-mesh.json',meshes[size])
    progress_rows={}
    def calculate(size):
        root=out/f'mesh-{size:g}';mesh=meshes[size];row={'size_mm':size}
        for mode in ['linear','nonlinear']:
            folder=root/mode;folder.mkdir(exist_ok=True);write(folder/'shell-mesh.json',mesh)
            write_deck(folder,mesh,mode='nonlinear' if mode=='nonlinear' else 'static',force=force,pressure=pressure,E=float(req.get('E_MPa',70000)),nu=float(req.get('nu',.33)))
            with lock:status('processing' if size in cached else 'solving',f'网格 {size:g} mm：'+(f'读取既有 {mode} 收敛场' if size in cached else '几何非线性增量求解' if mode=='nonlinear' else '线性参考求解'))
            error=cached[size][mode].get('solver_error') if size in cached else None
            last_update=[0.]
            def progress():
                if time.monotonic()-last_update[0]<10:return
                last_update[0]=time.monotonic()
                sta=folder/'analysis.sta';accepted=[]
                if sta.exists():
                    for line in sta.read_text(errors='replace').splitlines():
                        fields=line.split()
                        if len(fields)==7 and all(v.isdigit() for v in fields[:4]):accepted.append(float(fields[4]))
                with lock:status('solving',f'网格 {size:g} mm {mode}：已收敛载荷比例 {accepted[-1] if accepted else 0:.5f}')
            try:
                if size not in cached:solver(folder,timeout_s=10800,progress=progress)
            except (RuntimeError,TimeoutError,subprocess.TimeoutExpired) as exc:error=str(exc)
            if error and not (folder/'analysis.frd').exists():raise RuntimeError(error)
            try:s=parse_static(folder)
            except (KeyError,ValueError,IndexError) as exc:raise RuntimeError(f'{mode} {size}: no converged result; {error}') from exc
            s['solver_completed']=cached[size][mode].get('solver_completed',False) if size in cached else error is None;s['solver_error']=error
            s['material']={'E_MPa':req.get('E_MPa',70000),'nu':req.get('nu',.33),'yield_strength':None}
            s['reused_from']=str(resume) if size in cached else None
            s['reprocessed_only']=bool(reprocess)
            s['equilibrium_status']=equilibrium_status(s)
            write(folder/'summary.json',s);row[mode]=s
            with lock:
                progress_rows[size]=row;write(out/'study-progress.json',[progress_rows[k] for k in sorted(progress_rows,reverse=True)])
        return row
    with ThreadPoolExecutor(max_workers=2) as pool:levels=list(pool.map(calculate,sizes))
    # Matplotlib is not thread safe.
    for row in levels:
        for mode in ['linear','nonlinear']:plot_results(out/f'mesh-{row["size_mm"]:g}'/mode)
    summary=dict(levels[-1]['nonlinear'])
    # The result viewer uses the finest nonlinear state, including a clear load-factor label.
    shutil.copytree(out/f'mesh-{sizes[-1]:g}'/'nonlinear',out/'static')
    comparisons=[]
    for a,b in zip(levels,levels[1:]):
        item={'from_mm':a['size_mm'],'to_mm':b['size_mm']}
        for mode in ['linear','nonlinear']:
            same=abs(a[mode]['load_factor']-b[mode]['load_factor'])<1.e-6
            item[mode]={'same_load':same}
            for metric in ['maximum_displacement_mm','maximum_von_mises_MPa','bulk_skin_max_mises_MPa']:
                item[mode][metric+'_relative_change']=abs(a[mode][metric]-b[mode][metric])/max(abs(b[mode][metric]),1.e-12) if same and a[mode].get(metric) is not None and b[mode].get(metric) is not None else None
        comparisons.append(item)
    last=comparisons[-1]['nonlinear']
    checks=[dict(size_mm=row['size_mm'],mode=mode,status=row[mode]['equilibrium_status']) for row in levels for mode in ['linear','nonlinear']]
    balance_status='failed' if any(c['status']=='failed' for c in checks) else ('unverified' if any(c['status']=='unverified' for c in checks) else 'passed')
    metrics_converged=bool(last['same_load'] and all(last[k] is not None and last[k]<.05 for k in ['maximum_displacement_mm_relative_change','maximum_von_mises_MPa_relative_change','bulk_skin_max_mises_MPa_relative_change']))
    summary['mesh_study']={'levels':levels,'comparisons':comparisons,'tolerance':.05,
        'metrics_converged':metrics_converged,'equilibrium_status':balance_status,'equilibrium_checks':checks,
        'converged':bool(metrics_converged and balance_status=='passed')}
    histories=[{round(h['load_factor'],6):h for h in r['nonlinear']['history']} for r in levels]
    common=set(histories[0]).intersection(*(set(h) for h in histories[1:]))
    if common:
        common_factor=max(common)
        summary['mesh_study']['common_load_factor']=common_factor
        summary['mesh_study']['common_load_levels']=[{'size_mm':r['size_mm'],**hist[common_factor]} for r,hist in zip(levels,histories)]
    summary['assessment']=('已得到目标全载荷的非线性输出。' if summary['full_load_reached'] else f'未达到全载荷；所示云图仅对应最后收敛载荷比例 {summary["load_factor"]:.5f}。终止原因保存在计算记录中，该比例不能直接当作失稳载荷。')
    if balance_status=='failed':
        summary['assessment']+='至少一档计算的求解器节点 RF 力平衡核验未通过，结果保留供诊断，不能认定网格收敛。'
    elif balance_status=='unverified':
        summary['assessment']+='部分记录缺少完整的求解器节点 RF 力平衡核验；中面近似残差仅作参考，当前状态为未验证，不能认定网格收敛。'
    else:
        summary['assessment']+=('各档计算的节点 RF 力平衡核验通过；非线性最后两级网格主要指标变化均小于 5%。' if summary['mesh_study']['converged'] else '各档计算的节点 RF 力平衡核验通过；当前非线性网格序列尚未满足全部指标 5% 的收敛准则。')
    summary['assessment']+='材料保持假设弹性，不作屈服或极限承载力判定。'
    write(out/'summary.json',summary)
    plot_study(out,summary)
    if req.get('diagnostics',True):
        from .diagnostics import run_diagnostics
        summary['diagnosis']=run_diagnostics(out,req,solver,status);write(out/'summary.json',summary)
    return summary

def plot_study(out,s):
    import matplotlib;matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig,axes=plt.subplots(1,2,figsize=(11,4.5),layout='constrained')
    for row in s['mesh_study']['levels']:
        hist=row['nonlinear']['history']
        axes[0].plot([0]+[h['maximum_displacement_mm'] for h in hist],[0]+[h['load_factor'] for h in hist],'.-',label=f'{row["size_mm"]:g} mm')
    axes[0].set(xlabel='Maximum displacement (mm)',ylabel='Load multiplier',title='Geometric nonlinear load path');axes[0].legend();axes[0].grid(alpha=.3)
    rows=s['mesh_study']['levels'];common=s['mesh_study'].get('common_load_levels')
    factor=s['mesh_study'].get('common_load_factor',1)
    if common:
        axes[1].plot([r['size_mm'] for r in rows],[r['linear']['maximum_von_mises_MPa']*factor for r in rows],'o-',label='linear' if factor==1 else 'linear (scaled)')
        axes[1].plot([r['size_mm'] for r in common],[r['maximum_von_mises_MPa'] for r in common],'o-',label='nonlinear (accepted)')
        title=f'Mesh comparison at load {factor:.5g}'
    else:
        title='No common accepted load for comparison'
        axes[1].text(.5,.5,'Different terminal loads are not compared',ha='center',va='center',transform=axes[1].transAxes)
    axes[1].set(xlabel='Target mesh size (mm)',ylabel='Peak Mises (MPa)',title=title)
    if common:axes[1].legend()
    axes[1].grid(alpha=.3)
    fig.savefig(out/'study.png',dpi=160);plt.close(fig)
