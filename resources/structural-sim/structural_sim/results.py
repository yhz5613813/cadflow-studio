import json,re
from decimal import Decimal
from pathlib import Path
import numpy as np
from strength.fem import stress_invariants
from .geometry_model import parameters

def read_frd(path,wanted=None,max_time=float('inf'),last_only=(),time_tolerance=1.e-7):
    fields={};active=None;rows={};frame_time=0.
    for line in Path(path).open(errors='replace'):
        if line.startswith('  100CL'):frame_time=float(line.split()[2])
        elif line.startswith(' -4'):
            name=line.split()[1];active=name if (wanted is None or name in wanted) and frame_time<=max_time+time_tolerance else None;rows={}
        elif active and line.startswith(' -1'):
            node=int(line[3:13]);values=[float(x) for x in re.findall(r'[+-]?\d+\.\d+[Ee][+-]\d+',line[13:])]
            rows[node]=values
        elif active and line.startswith(' -3'):
            if active in last_only:fields[active]=[rows]
            else:fields.setdefault(active,[]).append(rows)
            active=None
    return fields

def parse_static(folder):
    folder=Path(folder);mesh=json.loads((folder/'shell-mesh.json').read_text());p=np.array(mesh['points']);n=len(p)
    max_time=float('inf')
    time_tolerance=1.e-7
    accepted=None
    if (folder/'analysis.sta').exists():
        accepted=[]
        for line in (folder/'analysis.sta').read_text().splitlines():
            row=line.split()
            if len(row)==7 and all(t.isdigit() for t in row[:4]):
                accepted.append(float(row[4]))
                # STA rounds more coarsely than DAT; allow half its printed unit.
                time_tolerance=.5001*10.**Decimal(row[4]).as_tuple().exponent+1.e-12
        if not accepted:raise ValueError('No accepted increment in solver status')
        max_time=accepted[-1]
    fields=read_frd(folder/'analysis.frd',{'DISP','FORC'},max_time,last_only={'FORC'},time_tolerance=time_tolerance);u=np.array([fields['DISP'][-1][i+1][:3] for i in range(n)])
    stress=[];ids=[];rf=[];active=None;history=[];load_factor=1.
    for line in (folder/'analysis.dat').open(errors='replace'):
        if line.strip().startswith('stresses '):
            if float(line.split('time')[-1])>max_time+time_tolerance:break
            if stress:
                history.append(dict(load_factor=load_factor,maximum_von_mises_MPa=float(stress_invariants(np.asarray(stress))[0].max()),reaction_N=np.asarray(rf).sum(0).tolist()))
            active='stress';stress=[];ids=[];rf=[];load_factor=float(line.split('time')[-1])
        elif line.strip().startswith('forces '):active='rf'
        elif re.match(r'^\s*\d+\s+',line):
            a=line.split()
            if active=='stress' and len(a)>=8:ids.append(int(a[0])-1);stress.append([float(v) for v in a[2:8]])
            elif active=='rf' and len(a)==4:rf.append([float(v) for v in a[1:]])
    stress=np.array(stress);vm,_=stress_invariants(stress)
    # Raw integration point envelope over thickness; no nodal averaging of bending stress.
    evm=np.zeros(len(mesh['elements']));np.maximum.at(evm,ids,vm)
    audit=json.loads((folder/'load-audit.json').read_text())
    resultant=np.array(rf).sum(0);applied=np.array(audit['mapped_force_N'])*load_factor
    if audit.get('mode')=='nonlinear':
        from .cylinder import element_quadrature
        # Follower external pressure is integrated on the converged configuration.
        applied=np.array([0.,0.,-audit['axial_force_N']*load_factor])
        for e,k in zip(mesh['elements'],mesh['kinds']):
            if k=='skin':
                for _,vec in element_quadrature((p+u)[e]):applied-=audit['external_pressure_MPa']*load_factor*vec
    residual=np.linalg.norm(resultant+applied)/max(np.linalg.norm(applied),1)
    mid_surface_residual=float(residual);assembled_balance=None;rf_crosscheck=None
    if fields.get('FORC'):
        # RF is total external nodal force, including loads and constraint forces.
        # Use the solver's expanded-shell load assembly for follower-load balance;
        # midsurface-only quadrature is an independent approximation, not its exact face.
        nodal=np.array([fields['FORC'][-1][i+1][:3] for i in range(n)])
        assembled_balance=float(np.linalg.norm(nodal.sum(0))/max(np.linalg.norm(resultant),1))
        fixed=np.load(folder/'loads.npz')['fixed']
        rf_crosscheck=float(np.linalg.norm(nodal[fixed].sum(0)-resultant)/max(np.linalg.norm(resultant),1))
        residual=max(assembled_balance,rf_crosscheck)
    kinds=np.array(mesh['kinds']);mag=np.linalg.norm(u,axis=1)
    history.append(dict(load_factor=load_factor,maximum_von_mises_MPa=float(vm.max()),reaction_N=resultant.tolist()))
    if len(history)!=len(fields['DISP']) or (accepted is not None and len(history)!=len(accepted)):
        raise ValueError('Stress and displacement frame counts differ; refusing to mix increments')
    for h,frame in zip(history,fields['DISP']):
        uu=np.array([frame[i+1][:3] for i in range(n)])
        h['maximum_displacement_mm']=float(np.linalg.norm(uu,axis=1).max())
    centers=np.array([p[e].mean(0) for e in mesh['elements']])
    model,by,radius,skin,rm,z0,z1=parameters(mesh.get('geometry_model'))
    lower=.1*model['height_mm'];upper=.9*model['height_mm']
    bulk=(kinds=='skin')&(centers[:,2]>lower)&(centers[:,2]<upper)
    # The same 20 mm exclusion distance follows the actual edited rib locations.
    for part in model['components']:
        if part['kind']=='ring':bulk &= np.abs(centers[:,2]-part['z_mm'])>20
    angle=np.arctan2(centers[:,1],centers[:,0])
    for part in model['components']:
        if part['kind']=='longitudinal':
            delta=(angle-np.deg2rad(part['angle_deg'])+np.pi)%(2*np.pi)-np.pi
            bulk &= 2*np.linalg.norm(centers[:,:2],axis=1)*np.sin(np.abs(delta)/2)>20
    peak=int(ids[int(vm.argmax())]);topnodes=np.unique(np.concatenate([e for e,k in zip(mesh['elements'],mesh['kinds']) if k=='top']))
    summary=dict(mode='geometric_nonlinear_shell' if audit.get('mode')=='nonlinear' else 'linear_static_shell',nodes=n,elements=len(evm),mesh_size_mm=mesh['size_mm'],
        maximum_von_mises_MPa=float(vm.max()),maximum_displacement_mm=float(mag.max()),
        maximum_axial_shortening_mm=float(-u[:,2].min()),stress_peak_element=int(ids[int(vm.argmax())])+1,
        reaction_N=resultant.tolist(),applied_current_N=applied.tolist(),balance_relative=float(residual),balance_passed=bool(residual<1e-4),
        mid_surface_balance_relative=mid_surface_residual,assembled_balance_relative=assembled_balance,rf_dat_frd_relative_difference=rf_crosscheck,
        equilibrium_basis='Total external nodal RF sum, including applied loads and constraints; fixed-node DAT/FRD cross-check. Midsurface follower-pressure quadrature is retained separately as an approximation.',
        load_factor=load_factor,full_load_reached=bool(abs(load_factor-1)<1.e-6),history=history,
        peak_component=str(kinds[peak]),peak_element_center_mm=centers[peak].tolist(),
        bulk_skin_max_mises_MPa=float(evm[bulk].max()) if bulk.any() else None,
        top_mean_axial_displacement_mm=float(u[topnodes,2].mean()),
        components={k:dict(maximum_von_mises_MPa=float(evm[kinds==k].max())) for k in sorted(set(kinds))},
        load=audit,material=dict(E_MPa=audit.get('E_MPa',70000),nu=audit.get('nu',.33),yield_strength=None),
        stress_basis='Raw integration-point Cauchy von Mises; last converged increment; per-element through-thickness maximum for plots',
        idealization=mesh['idealization'],geometry_model=model,
        bulk_skin_region=dict(z_min_mm=lower,z_max_mm=upper,junction_exclusion_mm=20))
    if mesh.get('component_ids'):
        component_ids=np.asarray(mesh['component_ids'])
        summary['peak_component_id']=str(component_ids[peak])
        summary['component_results']={}
        for cid in sorted(set(component_ids)):
            selected=np.flatnonzero(component_ids==cid)
            nodes=np.unique(np.concatenate([mesh['elements'][i] for i in selected]))
            summary['component_results'][cid]=dict(name=by[cid].get('name',cid),kind=by[cid]['kind'],
                maximum_von_mises_MPa=float(evm[selected].max()),maximum_displacement_mm=float(mag[nodes].max()),
                elements=len(selected),parameters=by[cid])

    np.savez_compressed(folder/'fields.npz',displacements=u,element_mises=evm,integration_stresses=stress,integration_elements=ids)
    (folder/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    return summary

def plot_results(folder):
    import matplotlib;matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    from matplotlib.colors import Normalize
    folder=Path(folder);mesh=json.loads((folder/'shell-mesh.json').read_text());s=json.loads((folder/'summary.json').read_text())
    f=np.load(folder/'fields.npz');p=np.array(mesh['points']);u=f['displacements'];e=mesh['elements'];vm=f['element_mises'];mag=np.linalg.norm(u,axis=1)
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':14})
    faces=[];owner=[]
    for i,row in enumerate(e):
        # Quadratic surface tessellation, four triangles for S6, six for Q8.
        patterns=([0,3,5],[3,1,4],[5,4,2],[3,4,5]) if len(row)==6 else ([0,4,7],[4,1,5],[5,2,6],[6,3,7],[4,5,6],[4,6,7])
        for q in patterns:faces.append([row[j] for j in q]);owner.append(i)
    faces=np.array(faces);owner=np.array(owner)
    for name,title,value,unit,scale in [('mises','Von Mises stress',vm[owner],'MPa',0),('displacement','Total displacement',mag[faces].mean(1),'mm',1),('deformed','Deformed shape',mag[faces].mean(1),'mm',20)]:
        fig=plt.figure(figsize=(10.4,7.2),dpi=160);ax=fig.add_axes([.02,.06,.79,.83],projection='3d')
        norm=Normalize(0,float(vm.max() if name=='mises' else mag.max()));cmap=plt.get_cmap('turbo')
        xyz=p+scale*u
        poly=Poly3DCollection(xyz[faces],facecolors=cmap(norm(value)),edgecolors='none',rasterized=True)
        lo=np.minimum(p.min(0),xyz.min(0))-20;hi=np.maximum(p.max(0),xyz.max(0))+20
        ax.add_collection3d(poly);ax.set_xlim(lo[0],hi[0]);ax.set_ylim(lo[1],hi[1]);ax.set_zlim(lo[2],hi[2]);ax.set_box_aspect(hi-lo);ax.view_init(28,-55)
        ax.set_axis_off();cax=fig.add_axes([.83,.2,.025,.56]);cb=fig.colorbar(plt.cm.ScalarMappable(norm=norm,cmap=cmap),cax=cax);cb.set_label(unit)
        factor=s.get('load_factor',1.)
        fig.text(.05,.95,title,fontsize=18,weight='bold');fig.text(.05,.91,f'Load {factor:.5f} x ({s["load"]["axial_force_N"]/9806.65:g} tonne-force + {s["load"]["external_pressure_MPa"]:g} MPa) | mesh {mesh["size_mm"]:g} mm')
        fig.text(.05,.035,f'Max = {norm.vmax:.6g} {unit} | geometry scale: {scale:g}x displacement | elastic assumed material')
        fig.savefig(folder/(name+'.png'));plt.close(fig)
    display=dict(points=p.tolist(),triangles=faces.tolist(),displacements=u.tolist(),element_mises=vm[owner].tolist(),maximum_mises=float(vm.max()),maximum_displacement=float(mag.max()))
    display['geometry_model']=mesh.get('geometry_model')
    if mesh.get('component_ids'):display['component_ids']=[mesh['component_ids'][i] for i in owner]
    (folder/'display.json').write_text(json.dumps(display),encoding='utf-8')
    # A local view keeps the small flange hotspot readable on a 1 m structure.
    from matplotlib.collections import PolyCollection
    kinds=np.array(mesh['kinds']);top_ids=np.flatnonzero(kinds=='top')
    if len(top_ids):
        peak=top_ids[np.argmax(vm[top_ids])];center=p[e[peak]].mean(0);theta=np.arctan2(center[1],center[0])
        radial=p[:,0]*np.cos(theta)+p[:,1]*np.sin(theta);tangent=-p[:,0]*np.sin(theta)+p[:,1]*np.cos(theta)
        xy=np.column_stack([tangent,radial]);keep=kinds[owner]=='top'
        fig,ax=plt.subplots(figsize=(8.6,4.2),layout='constrained');norm=Normalize(0,float(vm.max()))
        collection=PolyCollection(xy[faces[keep]],array=vm[owner[keep]],cmap='turbo',norm=norm,edgecolors='#555555',linewidths=.25)
        model,by,radius,skin,rm,z0,z1=parameters(mesh.get('geometry_model'))
        width=by['frame.top']['width_mm'];span=max(30,width*.65)
        ax.add_collection(collection);ax.set(xlim=(-span,span),ylim=(radius-width-3,radius+3),xlabel='Local tangential coordinate (mm)',ylabel='Local radial coordinate (mm)',title=f'Upper flange detail | load multiplier {s.get("load_factor",1):.5f}')
        ax.set_aspect('equal');fig.colorbar(collection,ax=ax,label='Mises (MPa)');fig.savefig(folder/'top-detail.png',dpi=160);plt.close(fig)

def parse_buckling(folder):
    folder=Path(folder);text=(folder/'analysis.dat').read_text(errors='replace');factors=[];active=False
    for line in text.splitlines():
        if 'B U C K L I N G' in line or 'BUCKLING FACTOR' in line.upper():active=True
        if active:
            a=line.split()
            if len(a)==2 and a[0].isdigit():
                try:factors.append(float(a[1]))
                except ValueError:pass
            elif factors and len(a)>2 and a[0].isdigit():break
    audit=json.loads((folder/'load-audit.json').read_text(encoding='utf-8'))
    reference_scale=audit.get('buckling_reference_scale',1.)
    raw_factors=list(factors);factors=[v*reference_scale for v in factors]
    positive=sorted(v for v in factors if v>0)
    if not positive:raise ValueError('No positive buckling eigenvalues in solver output')
    result=dict(factors=factors,raw_factors=raw_factors,reference_load_scale=reference_scale,first_positive_factor=positive[0],
                loading_path='Axial force and external pressure scaled together; eigenvalue buckling of perfect elastic geometry',
                capacity_verified=False)
    (folder/'summary.json').write_text(json.dumps(result,indent=2),encoding='utf-8');return result
