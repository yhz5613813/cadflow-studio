"""Reproducible load-path diagnostics, explicitly distinct from the requested case."""
import json,shutil
from pathlib import Path
import numpy as np
from .cylinder import write_deck,build_mesh,element_quadrature
from .results import parse_static
from .geometry_model import parameters,offset_hole_phase

def save(p,x):Path(p).write_text(json.dumps(x,ensure_ascii=False,indent=2),encoding='utf-8')

def saved_phase_mesh(path,geometry_model,size):
    model=json.loads(Path(path).read_text(encoding='utf-8'))
    expected=offset_hole_phase(geometry_model,5)
    actual=model.get('geometry_model') or offset_hole_phase(None,model.get('hole_phase_deg',0))
    if parameters(actual)[0]!=expected or model.get('size_mm')!=size or model.get('hole_phase_deg',0)!=5 or model.get('curvature_points')!=max(24,1280/size):
        raise ValueError('Saved diagnostic mesh geometry differs')
    return model

def run_diagnostics(out,req,solver,status):
    study=json.loads((out/'summary.json').read_text(encoding='utf-8'))['mesh_study']
    size=study['levels'][0]['size_mm']
    mesh=json.loads((out/f'mesh-{size:g}/linear/shell-mesh.json').read_text())
    p=np.array(mesh['points']);F=float(req['axial_force_N']);pressure=float(req['external_pressure_MPa']);results={}
    geometry,by,radius,skin,rm,z0,z1=parameters(mesh.get('geometry_model'))
    diag=out/'diagnostics';diag.mkdir(exist_ok=True)
    for name,force,q in [('axial_only',F,0),('pressure_only',0,pressure),('direct_rim',F,pressure),('phase5',F,pressure)]:
        folder=diag/name;folder.mkdir(exist_ok=True)
        status('diagnosing','补充载荷路径诊断：'+name)
        previous=Path(req['resume_output'])/'diagnostics'/name if req.get('resume_output') else None
        model=mesh
        if name=='phase5':
            cached_mesh=previous/'shell-mesh.json' if previous else None
            if cached_mesh and cached_mesh.exists():
                model=saved_phase_mesh(cached_mesh,req.get('geometry_model'),size)
            else:model=build_mesh(folder,size,hole_phase_deg=5,geometry_model=req.get('geometry_model'))
        save(folder/'shell-mesh.json',model)
        write_deck(folder,model,force=force,pressure=q,E=req.get('E_MPa',70000),nu=req.get('nu',.33))
        if name=='direct_rim':
            weights=np.zeros(len(p));xx,ww=np.polynomial.legendre.leggauss(3)
            for e,k in zip(mesh['elements'],mesh['kinds']):
                if k!='skin':continue
                for pat in ([(0,1,3),(1,2,4),(2,0,5)] if len(e)==6 else [(0,1,4),(1,2,5),(2,3,6),(3,0,7)]):
                    edge=[e[j] for j in pat]
                    if not np.allclose(p[edge,2],z1):continue
                    for t,w in zip(xx,ww):
                        N=np.array([t*(t-1)/2,t*(t+1)/2,1-t*t]);d=np.array([t-.5,t+.5,-2*t])
                        np.add.at(weights,edge,N*np.linalg.norm(d@p[edge])*w)
            weights*=-F/weights.sum();deck=(folder/'analysis.inp').read_text();a=deck.index('*CLOAD\n');b=deck.index('*NODE FILE',a)
            (folder/'analysis.inp').write_text(deck[:a]+'*CLOAD\n'+'\n'.join(f'{i+1},3,{v:.12g}' for i,v in enumerate(weights) if abs(v)>1.e-12)+'\n'+deck[b:])
        reused=False
        if previous and (previous/'summary.json').exists() and (previous/'analysis.inp').read_bytes()==(folder/'analysis.inp').read_bytes():
            old=json.loads((previous/'summary.json').read_text(encoding='utf-8'));log=(previous/'solver.log').read_text(errors='replace')
            if old.get('full_load_reached') and 'Job finished' in log and '*ERROR' not in log.upper():
                shutil.copytree(previous,folder,dirs_exist_ok=True);reused=True
        if not reused and req.get('reprocess_only') and not req.get('diagnostics_fill_missing'):raise ValueError('Saved diagnostic is missing or differs; enable explicit missing-diagnostic calculation: '+name)
        if not reused:solver(folder,timeout_s=1800)
        s=parse_static(folder);s['diagnostic_only']=True;s['reused_from']=str(previous) if reused else None;save(folder/'summary.json',s);results[name]=s
    reference=np.load(out/f'mesh-{size:g}/linear/fields.npz');ax=np.load(diag/'axial_only/fields.npz');pr=np.load(diag/'pressure_only/fields.npz')
    errors={k:float(np.linalg.norm(ax[k]+pr[k]-reference[k])/np.linalg.norm(reference[k])) for k in ['integration_stresses','displacements']}
    if max(errors.values())>1.e-4:raise ValueError('Independent load superposition check failed')
    area=first=0.
    for e,k in zip(mesh['elements'],mesh['kinds']):
        if k=='top':
            for N,vec in element_quadrature(p[e]):
                a=np.linalg.norm(vec);area+=a;first+=a*np.linalg.norm((N@p[e])[:2])
    axial_area=np.pi*(radius**2-(radius-skin)**2)+sum(c['width_mm']*c['height_mm'] for c in geometry['components'] if c['kind']=='longitudinal')
    nominal=F/axial_area;ecc=rm-first/area
    original=study['levels'][0]['linear']
    stresses=reference['integration_stresses']
    vm2=.5*((stresses[:,0]-stresses[:,1])**2+(stresses[:,1]-stresses[:,2])**2+(stresses[:,2]-stresses[:,0])**2)+3*(stresses[:,3:]**2).sum(1)
    peak_stress=stresses[int(vm2.argmax())]
    z_shear_fraction=float(3*(peak_stress[4]**2+peak_stress[5]**2)/vm2.max())
    fine=study['levels'][-1];nl=fine['nonlinear'];lin=fine['linear'];fraction=nl['load_factor']
    top=by['frame.top'];outer_ligament=radius-(top['bolt_circle_mm']+top['hole_diameter_mm'])/2
    dominant='轴向载荷' if results['axial_only']['maximum_von_mises_MPa']>=results['pressure_only']['maximum_von_mises_MPa'] else '外压载荷'
    paragraphs=[
        f'最细 {fine["size_mm"]:g} mm 网格在载荷比例 {fraction:.5f} 下，非线性峰值应力为 {nl["maximum_von_mises_MPa"]:.1f} MPa、最大位移为 {nl["maximum_displacement_mm"]:.3f} mm。相对同载荷比例的线性预测，分别变化 {(nl["maximum_von_mises_MPa"]/(lin["maximum_von_mises_MPa"]*fraction)-1)*100:+.1f}% 和 {(nl["maximum_displacement_mm"]/(lin["maximum_displacement_mm"]*fraction)-1)*100:+.1f}%。几何非线性引起了传力和应力重分配，但本材料模型仍保持弹性。',
        f'载荷换算无误：轴向总力 {F:,.1f} N 对应 {F/9806.65:g} 公吨力；端框净面平均载荷约 {F/area:.3f} MPa。按筒皮及纵筋截面面积估算的均匀轴向应力为 {nominal:.1f} MPa，远低于局部峰值，说明峰值不能解释成均匀受压。',
        f'同一 {size:g} mm 线性参考模型的载荷分解：仅轴向力的峰值为 {results["axial_only"]["maximum_von_mises_MPa"]:.1f} MPa，仅外压为 {results["pressure_only"]["maximum_von_mises_MPa"]:.1f} MPa；组合为 {original["maximum_von_mises_MPa"]:.1f} MPa。薄壁筒外压环向膜应力量级 pR/t 约为 {pressure*rm/skin:.1f} MPa。两份应力张量叠加与组合场的相对误差为 {errors["integration_stresses"]:.2e}，分项峰值较大的是{dominant}；峰值位置可能随分项工况变化。',
        f'翻边净面载荷的平均作用半径约 {first/area:.2f} mm，相对筒皮中面存在 {ecc:.2f} mm 的径向偏心。向内翻边先弯曲，再把力传给薄筒皮和纵筋。在线性因果诊断中，把相同总力直接传至筒皮上缘时，峰值为 {results["direct_rim"]["maximum_von_mises_MPa"]:.1f} MPa，最大位移为 {results["direct_rim"]["maximum_displacement_mm"]:.3f} mm，与均匀轴压缩短约 {nominal*(z1-z0)/req.get("E_MPa",70000):.2f} mm 的量级相符。此诊断改变了加载位置，不能替代原端面加载结果。',
        f'当前线性峰值位于 {original.get("peak_component_id",original["peak_component"])}，单元中心坐标为 ({original["peak_element_center_mm"][0]:.2f}, {original["peak_element_center_mm"][1]:.2f}, {original["peak_element_center_mm"][2]:.2f}) mm。保持尺寸、数量及筋条位置，仅将两端孔圈各转动 5° 的诊断模型，峰值为 {results["phase5"]["maximum_von_mises_MPa"]:.1f} MPa，位移为 {results["phase5"]["maximum_displacement_mm"]:.3f} mm；该比较量化孔圈相位对本模型的影响，主工况仍保持当前 CAD 布置。',
        f'在线性参考场的峰值积分点，涉及全局 Z 方向的两项剪应力对 Mises 应力平方的贡献为 {100*z_shear_fraction:.1f}%。上端框孔外缘至筒体外径的净距为 {outer_ligament:.3f} mm，翻边厚度为 {top["thickness_mm"]:g} mm；壳模型截至筒皮中面后，该净距为 {outer_ligament-skin/2:.3f} mm。当前壳模型以中面相交和共节点表示一体连接，未建立孔筋交汇处的三维圆角与实际过渡；局部峰值需三维连接模型复核。几何非线性更新变形后的平衡，弹性材料本身不会发生屈服和塑性应力重分配，不能用弹性峰值给出材料强度合格结论。'
    ]
    termination=None
    if not nl['full_load_reached']:
        error=(nl.get('solver_error') or '').lower()
        if 'minimum' in error and 'increment' in error:termination='自动缩步要求的增量小于设定最小步长'
        elif 'too many cutbacks' in error:termination='达到自动缩步次数上限'
        elif 'too many increments' in error:termination='达到允许增量数上限'
        elif '超过' in error or 'timeout' in error or 'timed out' in error:termination='达到设定求解时限'
        else:termination='求解器未得到目标全载荷的收敛平衡解'
        paragraphs.insert(1,f'最细网格终止原因：{termination}。当前云图对应 {F*fraction/9806.65:.3f} 公吨力及 {pressure*fraction:.5f} MPa 外压。数值不收敛不能单独证明结构失稳，该载荷比例不能直接当作极限承载系数；目标 {F/9806.65:g} 公吨力下的最细网格结果尚未获得。')
    result={'mesh_size_mm':size,'load_cases':results,'superposition_relative_errors':errors,'nominal_axial_stress_MPa':nominal,'eccentricity_mm':ecc,'linear_peak_stress_components_MPa':peak_stress.tolist(),'linear_peak_z_shear_fraction_of_mises_squared':z_shear_fraction,'termination_reason':termination,'paragraphs':paragraphs}
    save(diag/'diagnosis.json',result);return result
