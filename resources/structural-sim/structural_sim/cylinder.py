"""Conforming quadratic shell idealization of the confirmed stiffened cylinder.
Coordinates mm, loads N, stresses MPa. Junction midsurfaces intersect.
CAD remains an exact solid; shell junction extensions are documented separately.
"""
import json, math
from pathlib import Path
import gmsh
import numpy as np

def build_mesh(folder,size=25.,hole_phase_deg=0.,geometry_model=None):
    from .geometry_model import parameters,offset_hole_phase
    model,by,r,skin,rm,z0,z1=parameters(offset_hole_phase(geometry_model,hole_phase_deg))
    folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    gmsh.initialize([],readConfigFiles=False,interruptible=False)
    try:
        gmsh.option.setNumber('General.Terminal',0)
        gmsh.option.setNumber('General.NumThreads',1)
        gmsh.option.setNumber('Mesh.RandomSeed',1)
        o=gmsh.model.occ
        v=o.addCylinder(0,0,z0,0,0,z1-z0,rm)
        o.synchronize()
        bounds=gmsh.model.getBoundary([(3,v)],oriented=False)
        outer=[s for d,s in bounds if gmsh.model.getType(d,s)=='Cylinder'][0]
        o.remove([(3,v)],recursive=False)
        o.remove([(2,s) for d,s in bounds if s!=outer],recursive=False)
        sources=[(2,outer)]; groups=[('skin','skin')]
        sections={'skin':dict(kind='skin',thickness_mm=skin)}
        for part in [p for p in model['components'] if p['kind'] in ('flange','ring')]:
            kind=part['end'] if part['kind']=='flange' else 'ring'
            z=(z0 if kind=='bottom' else z1) if kind in ('bottom','top') else part['z_mm']
            ri=r-part['width_mm'] if part['kind']=='flange' else r-skin-part['height_mm']
            a=o.addDisk(0,0,z,rm,rm); b=o.addDisk(0,0,z,ri,ri)
            cuts=[(2,b)]
            if kind in ('bottom','top'):
                count=part['hole_count'];radius=part['bolt_circle_mm']/2;hole=part['hole_diameter_mm']/2
                phase=math.radians(part.get('phase_deg',0))
                cuts += [(2,o.addDisk(radius*math.cos(k*math.tau/count+phase),radius*math.sin(k*math.tau/count+phase),z,hole,hole)) for k in range(count)]
            ann,_=o.cut([(2,a)],cuts)
            sources.extend(ann);groups.extend([(kind,part['id'])]*len(ann))
            sections[part['id']]=dict(kind=kind,thickness_mm=part['thickness_mm'] if part['kind']=='flange' else part['width_mm'])
        for part in [p for p in model['components'] if p['kind']=='longitudinal']:
            a=math.radians(part['angle_deg']);ri=r-skin-part['height_mm']
            coords=[(rr*math.cos(a),rr*math.sin(a),z) for rr,z in [(ri,z0),(rm,z0),(rm,z1),(ri,z1)]]
            pts=[o.addPoint(*p) for p in coords]
            lines=[o.addLine(pts[j],pts[(j+1)%4]) for j in range(4)]
            sources.append((2,o.addPlaneSurface([o.addCurveLoop(lines)])));groups.append(('longitudinal',part['id']))
            sections[part['id']]=dict(kind='longitudinal',thickness_mm=part['width_mm'])
        _,mapping=o.fragment(sources[:1],sources[1:])
        o.synchronize()
        owners={}
        for identity,parts in zip(groups,mapping):
            for d,tag in parts:
                if d!=2:continue
                if tag in owners and owners[tag]!=identity:raise ValueError('Overlapping shell component midsurfaces')
                owners[tag]=identity
        gmsh.option.setNumber('Mesh.MeshSizeMax',size)
        gmsh.option.setNumber('Mesh.MeshSizeMin',min(size/8,4.))
        gmsh.option.setNumber('Mesh.MeshSizeFromCurvature',max(24,1280/size))
        gmsh.option.setNumber('Mesh.Algorithm',6)
        gmsh.option.setNumber('Mesh.RecombinationAlgorithm',1)
        for tag in owners:gmsh.model.mesh.setRecombine(2,tag)
        gmsh.model.mesh.generate(2)
        gmsh.option.setNumber('Mesh.SecondOrderIncomplete',1)
        gmsh.model.mesh.setOrder(2)
        tags,xyz,_=gmsh.model.mesh.getNodes();points=np.array(xyz).reshape(-1,3)
        lut={int(t):i for i,t in enumerate(tags)}
        elems=[];ek=[];types=[];component_ids=[]
        for tag,(kind,component) in owners.items():
            ts,_,ns=gmsh.model.mesh.getElements(2,tag)
            for ty,flat in zip(ts,ns):
                if ty not in (9,16):raise ValueError(('Unexpected shell type',ty))
                n=6 if ty==9 else 8
                for row in np.asarray(flat).reshape(-1,n):
                    ids=[lut[int(x)] for x in row]
                    p=points[ids];norm=np.cross(p[1]-p[0],p[2]-p[0]);c=p.mean(0)
                    target=np.array([c[0],c[1],0]) if kind=='skin' else (np.array([-c[1],c[0],0]) if kind=='longitudinal' else np.array([0,0,1]))
                    if norm@target<0:ids=[ids[j] for j in ([0,2,1,5,4,3] if n==6 else [0,3,2,1,7,6,5,4])]
                    elems.append(ids);ek.append(kind);types.append('S6' if n==6 else 'S8R');component_ids.append(component)
        used=np.unique(np.concatenate(elems));remap={int(n):i for i,n in enumerate(used)}
        points=points[used];elems=[[remap[n] for n in e] for e in elems]
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import connected_components
        aa=[];bb=[]
        for e in elems:
            aa.extend([e[0]]*(len(e)-1));bb.extend(e[1:])
        A=coo_matrix((np.ones(2*len(aa)),(aa+bb,bb+aa)),shape=(len(points),len(points)))
        count,_=connected_components(A)
        if count!=1:raise ValueError(f'{count} disconnected shell components')
        if set(component_ids)!=set(by):raise ValueError('A CAD component has no shell elements')
        data=dict(points=points.tolist(),elements=elems,kinds=ek,types=types,component_ids=component_ids,sections=sections,geometry_model=model,
                  size_mm=size,connected_components=count,curvature_points=max(24,1280/size),hole_phase_deg=hole_phase_deg,
                  idealization=f'Skin midsurface R{rm:g}; flange midsurfaces Z{z0:g}/{z1:g}; each rib retains its identity and section thickness; ribs extended to intersect midsurfaces; shared nodes at integral junctions; flange bolt holes explicit')
        (folder/'shell-mesh.json').write_text(json.dumps(data),encoding='utf-8')
        return data
    finally:
        gmsh.finalize()

def shape_quad(q):
    r,s=q
    return np.array([-(1-r)*(1-s)*(1+r+s),-(1+r)*(1-s)*(1-r+s),-(1+r)*(1+s)*(1-r-s),-(1-r)*(1+s)*(1+r-s),2*(1-r*r)*(1-s),2*(1+r)*(1-s*s),2*(1-r*r)*(1+s),2*(1-r)*(1-s*s)])/4

def element_quadrature(p):
    from strength.fem import tri_shape,triangle_quadrature
    if len(p)==6:
        for q,w in triangle_quadrature():
            N,d=tri_shape(q);J=p.T@d;yield N,np.cross(J[:,0],J[:,1])*w
    else:
        x,w=np.polynomial.legendre.leggauss(3)
        for r,wr in zip(x,w):
            for s,ws in zip(x,w):
                # Complex-step exact derivatives of polynomial Q8 shape functions.
                d=np.column_stack([shape_quad((r+1e-30j,s)).imag/1e-30,shape_quad((r,s+1e-30j)).imag/1e-30])
                J=p.T@d;yield shape_quad((r,s)),np.cross(J[:,0],J[:,1])*wr*ws

def write_deck(folder,mesh,mode='static',force=2451662.5,pressure=.2,E=70000.,nu=.33,axial_loading='dead',initial_increment=.02):
    folder=Path(folder);p=np.asarray(mesh['points']);elements=mesh['elements'];kinds=mesh['kinds'];types=mesh['types']
    binding=mesh.get('semantic_bindings')
    if binding:
        from .semantic import validate_binding
        validate_binding(binding,geometry_model=mesh.get('geometry_model'))
    fixed_kind=binding['bindings']['interface.fixed_support']['shell_set'] if binding else 'bottom'
    loaded_kind=binding['bindings']['interface.axial_load']['shell_set'] if binding else 'top'
    pressure_kind=binding['bindings']['interface.external_pressure']['shell_set'] if binding else 'skin'
    F=np.zeros_like(p);areas={};pressure_resultant=np.zeros(3)
    weights=[]
    for i,(e,kind) in enumerate(zip(elements,kinds)):
        if kind not in (loaded_kind,pressure_kind):continue
        area=0.
        for N,vec in element_quadrature(p[e]):
            ar=np.linalg.norm(vec);area+=ar
            if kind==loaded_kind:weights.append((e,N,ar))
            else:np.add.at(F,e,-pressure*N[:,None]*vec);pressure_resultant-=pressure*vec
        areas[kind]=areas.get(kind,0)+area
    for e,N,ar in weights:np.add.at(F[:,2],e,-force*N*ar/areas[loaded_kind])
    fixed=sorted(set(n for e,k in zip(elements,kinds) if k==fixed_kind for n in e))
    # Consistent reference-configuration tractions are stored independently.
    # DLOAD pressure uses the same signed normals and includes pressure stiffness.
    lines=['*HEADING','CadFlow Structural Sim: quadratic shell cylinder; mm N MPa','*NODE,NSET=NALL']
    lines += [f'{i+1},'+','.join(f'{x:.12g}' for x in v) for i,v in enumerate(p)]
    component_ids=mesh.get('component_ids')
    sections=mesh.get('sections')
    if component_ids is not None:
        if len(component_ids)!=len(elements) or not sections or set(component_ids)!=set(sections):
            raise ValueError('Shell component section mapping is incomplete')
        # Use indices as CalculiX names; preserve semantic IDs in the audit JSON.
        names={cid:f'COMP_{i+1:03}' for i,cid in enumerate(sorted(sections))}
        for cid,t in sorted(set(zip(component_ids,types))):
            name=names[cid]+'_'+t
            lines.append(f'*ELEMENT,TYPE={t},ELSET={name}')
            lines += [f'{i+1},'+','.join(str(n+1) for n in e) for i,e in enumerate(elements) if component_ids[i]==cid and types[i]==t]
        for cid,name in names.items():
            lines += [f'*ELSET,ELSET={name}',','.join(name+'_'+t for t in sorted(set(types[i] for i,c in enumerate(component_ids) if c==cid)))]
        for kind in sorted(set(kinds)):
            lines += [f'*ELSET,ELSET={kind}',','.join(names[cid] for cid in sorted(sections) if sections[cid]['kind']==kind)]
        lines += ['*ELSET,ELSET=EALL',','.join(sorted(set(kinds))),'*MATERIAL,NAME=AL_ASSUMED','*ELASTIC',f'{E},{nu}']
        for cid,name in names.items():
            thickness=sections[cid]['thickness_mm']
            if not isinstance(thickness,(int,float)) or not math.isfinite(thickness) or thickness<=0:raise ValueError('Invalid component shell thickness')
            lines += [f'*SHELL SECTION,ELSET={name},MATERIAL=AL_ASSUMED',f'{thickness:g}']
    else:
        # Keep legacy saved meshes byte-for-byte compatible for reprocessing.
        for kind,t in sorted(set(zip(kinds,types))):
            lines.append(f'*ELEMENT,TYPE={t},ELSET={kind}_{t}')
            lines += [f'{i+1},'+','.join(str(n+1) for n in e) for i,e in enumerate(elements) if kinds[i]==kind and types[i]==t]
        for kind in sorted(set(kinds)):
            lines += [f'*ELSET,ELSET={kind}',','.join(f'{kind}_{t}' for t in sorted(set(types[i] for i,k in enumerate(kinds) if k==kind)))]
        lines += ['*ELSET,ELSET=EALL',','.join(sorted(set(kinds))),'*MATERIAL,NAME=AL_ASSUMED','*ELASTIC',f'{E},{nu}']
        for kind in sorted(set(kinds)):
            lines += [f'*SHELL SECTION,ELSET={kind},MATERIAL=AL_ASSUMED',str(2.5 if kind=='skin' else 12 if kind in ('top','bottom') else 8)]
    lines+=['*NSET,NSET=FIXED']+[','.join(str(n+1) for n in fixed[i:i+16]) for i in range(0,len(fixed),16)]
    lines += ['*BOUNDARY','FIXED,1,6','*STEP,NLGEOM,INC=300' if mode=='nonlinear' else '*STEP']
    lines += ['*BUCKLE,SOLVER=SPOOLES','6,1.e-8'] if mode=='buckling' else ['*STATIC,SOLVER=SPOOLES']
    if mode=='nonlinear':lines += [f'{initial_increment},1.,1.e-6,0.05']
    reference_scale=1.e-4 if mode=='buckling' else 1.0
    lines += ['*DLOAD',f'{pressure_kind},P,{-pressure*reference_scale:.12g}']
    if axial_loading=='dead' and mode!='buckling':
        # Fixed global axial direction and constant resultant, even after end rotation.
        axial=np.zeros(len(p))
        for e,N,ar in weights:np.add.at(axial,e,-force*N*ar/areas[loaded_kind])
        lines += ['*CLOAD']+[f'{i+1},3,{v:.12g}' for i,v in enumerate(axial) if abs(v)>1.e-12]
    else:lines += [f'{loaded_kind},P,{-force*reference_scale/areas[loaded_kind]:.12g}']
    lines += ['*NODE FILE,OUTPUT=2D','U'] if mode=='buckling' else ['*NODE FILE,OUTPUT=2D','U,RF','*EL FILE,OUTPUT=2D','S','*EL PRINT,ELSET=EALL','S','*NODE PRINT,NSET=FIXED,GLOBAL=YES','RF']
    lines += ['*END STEP']
    (folder/'analysis.inp').write_text('\n'.join(lines)+'\n',encoding='ascii')
    np.savez_compressed(folder/'loads.npz',force=F,fixed=fixed)
    audit=dict(E_MPa=E,nu=nu,semantic_bindings=binding,geometry_model=mesh.get('geometry_model'),component_sections=sections,axial_force_N=force,external_pressure_MPa=pressure,top_loaded_area_mm2=areas['top'],skin_area_mm2=areas['skin'],
               mapped_force_N=F.sum(0).tolist(),pressure_resultant_N=pressure_resultant.tolist(),mode=mode,axial_loading=axial_loading,buckling_reference_scale=reference_scale,nodes=len(p),elements=len(elements))
    (folder/'load-audit.json').write_text(json.dumps(audit,indent=2),encoding='utf-8')
    if abs(F[:,2].sum()+force)>max(force,1)*1e-8:raise ValueError('Axial load mapping mismatch')
    return audit
