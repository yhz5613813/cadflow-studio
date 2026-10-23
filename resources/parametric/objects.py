"""Build named editable cylinder objects and independently verify exported solids."""
import sys, json, math, hashlib, os
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'structural-sim'))
from structural_sim.geometry_model import normalize_model, boundary_areas, default_model

# Parameter edits do not need to load the CAD kernel.
if __name__=='__main__' and len(sys.argv)>1 and sys.argv[1] in ('default-model','validate-model'):
    value=default_model() if sys.argv[1]=='default-model' else normalize_model(json.loads(Path(sys.argv[2]).read_text(encoding='utf-8')))
    print(json.dumps(value,ensure_ascii=True));sys.exit(0)

from OCP.gp import gp_Pnt, gp_Ax2, gp_Dir, gp_Ax1, gp_Trsf
from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeBox
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse, BRepAlgoAPI_Common
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.STEPControl import STEPControl_Writer, STEPControl_Reader, STEPControl_AsIs
from OCP.IFSelect import IFSelect_RetDone
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps

def disk_path(p):
    value=os.path.abspath(p)
    if os.name=='nt' and not value.startswith('\\\\?\\'):
        value=('\\\\?\\UNC\\'+value[2:]) if value.startswith('\\\\') else '\\\\?\\'+value
    return Path(value)

def digest(p): return hashlib.sha256(disk_path(p).read_bytes()).hexdigest()
def dump(p,v): disk_path(p).write_text(json.dumps(v,ensure_ascii=False,indent=2),encoding='utf-8')
def cyl(r,h,z=0,x=0,y=0): return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x,y,z),gp_Dir(0,0,1)),r,h).Shape()
def boolean(cls,a,b):
    op=cls(a,b);op.Build()
    if not op.IsDone(): raise ValueError('CAD boolean failed')
    return op.Shape()
def cut(a,b): return boolean(BRepAlgoAPI_Cut,a,b)
def fuse(a,b): return boolean(BRepAlgoAPI_Fuse,a,b)
def common(a,b): return boolean(BRepAlgoAPI_Common,a,b)
def mass(s):
    p=GProp_GProps();BRepGProp.VolumeProperties_s(s,p);return p.Mass()
def step_read(p):
    r=STEPControl_Reader()
    if r.ReadFile(str(p))!=IFSelect_RetDone: raise ValueError('Cannot read exported STEP')
    r.TransferRoots();return r.OneShape()
def step_write(s,p):
    w=STEPControl_Writer();w.Transfer(s,STEPControl_AsIs)
    if w.Write(str(p))!=IFSelect_RetDone: raise ValueError('STEP write failed')

def build_shapes(value):
    model=normalize_model(value);by={p['id']:p for p in model['components']}
    R=model['diameter_mm']/2;H=model['height_mm'];t=by['skin']['thickness_mm']
    tb=by['frame.bottom']['thickness_mm'];tt=by['frame.top']['thickness_mm']
    envelope=cyl(R,H);skin=cut(envelope,cyl(R-t,H))
    parts={};display={}
    for p in model['components']:
        id=p['id'];kind=p['kind']
        if kind=='skin':
            shape=skin
            visual=cut(cyl(R,H-tb-tt,tb),cyl(R-t,H-tb-tt,tb))
        elif kind=='flange':
            z=0 if p['end']=='bottom' else H-p['thickness_mm']
            shape=cut(cyl(R,p['thickness_mm'],z),cyl(R-p['width_mm'],p['thickness_mm'],z))
            for i in range(p['hole_count']):
                a=math.tau*i/p['hole_count']+math.radians(p['phase_deg'])
                shape=cut(shape,cyl(p['hole_diameter_mm']/2,p['thickness_mm']+2,z-1,p['bolt_circle_mm']/2*math.cos(a),p['bolt_circle_mm']/2*math.sin(a)))
            visual=shape
        elif kind=='longitudinal':
            inner=R-t-p['height_mm'];w=p['width_mm']
            shape=BRepPrimAPI_MakeBox(gp_Pnt(inner,-w/2,tb),R-inner,w,H-tb-tt).Shape()
            tr=gp_Trsf();tr.SetRotation(gp_Ax1(gp_Pnt(0,0,0),gp_Dir(0,0,1)),math.radians(p['angle_deg']))
            shape=common(BRepBuilderAPI_Transform(shape,tr,True).Shape(),envelope)
            visual=common(shape,cyl(R-t,H))
        else:
            z=p['z_mm']-p['width_mm']/2
            shape=cut(cyl(R-t+min(.5,t/2),p['width_mm'],z),cyl(R-t-p['height_mm'],p['width_mm'],z))
            visual=common(shape,cyl(R-t,H))
        if not BRepCheck_Analyzer(shape).IsValid() or mass(shape)<=0: raise ValueError('Invalid CAD component '+id)
        parts[id]=shape;display[id]=visual
    # The feature objects are preserved for selection. Fusion is the physical integral solid.
    solid=parts['skin']
    for id,shape in parts.items():
        if id!='skin':
            print('Fuse '+id,flush=True);solid=fuse(solid,shape)
    if not BRepCheck_Analyzer(solid).IsValid(): raise ValueError('Invalid integral solid')
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_SOLID
    it=TopExp_Explorer(solid,TopAbs_SOLID);count=0
    while it.More():count+=1;it.Next()
    if count!=1: raise ValueError('Integral cylinder must have one connected solid')
    return model,solid,display

def assembly_write(parts,model,p):
    from OCP.TDocStd import TDocStd_Document
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorGen
    from OCP.TDataStd import TDataStd_Name
    from OCP.STEPCAFControl import STEPCAFControl_Writer
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound
    from OCP.TDF import TDF_LabelSequence, TDF_Label
    from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
    doc=TDocStd_Document(TCollection_ExtendedString('CAStudio objects'))
    st=XCAFDoc_DocumentTool.ShapeTool_s(doc.Main());ct=XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    compound=TopoDS_Compound();b=BRep_Builder();b.MakeCompound(compound)
    for shape in parts.values():b.Add(compound,shape)
    root=st.AddShape(compound,True)
    TDataStd_Name.Set_s(root,TCollection_ExtendedString('CAStudio cylinder'))
    seq=TDF_LabelSequence();st.GetComponents_s(root,seq)
    palette={'skin':(.68,.73,.79),'flange':(.43,.52,.64),'longitudinal':(.37,.64,.68),'ring':(.74,.60,.40)}
    for index,c in enumerate(model['components'],1):
        label=seq.Value(index);ref=TDF_Label();st.GetReferredShape_s(label,ref)
        text=TCollection_ExtendedString(c['id']+' | '+c.get('name',c['id']),True)
        TDataStd_Name.Set_s(label,text);TDataStd_Name.Set_s(ref,text)
        ct.SetColor(ref,Quantity_Color(*palette[c['kind']],Quantity_TOC_RGB),XCAFDoc_ColorGen)
    w=STEPCAFControl_Writer();w.SetNameMode(True);w.SetColorMode(True);w.Transfer(doc,STEPControl_AsIs)
    if w.Write(str(p))!=IFSelect_RetDone:raise ValueError('Assembly STEP write failed')

def boundaries(solid,model):
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopoDS import TopoDS
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane,GeomAbs_Cylinder
    groups={'bottom':[],'top':[],'skin':[]};it=TopExp_Explorer(solid,TopAbs_FACE)
    R=model['diameter_mm']/2;H=model['height_mm']
    while it.More():
        face=TopoDS.Face_s(it.Current());surf=BRepAdaptor_Surface(face);kind=None
        if surf.GetType()==GeomAbs_Plane:
            pl=surf.Plane()
            if abs(pl.Axis().Direction().Z())>1-1e-8:
                if abs(pl.Location().Z())<1e-6:kind='bottom'
                elif abs(pl.Location().Z()-H)<1e-6:kind='top'
        elif surf.GetType()==GeomAbs_Cylinder:
            c=surf.Cylinder();axis=c.Axis()
            if abs(c.Radius()-R)<1e-6 and abs(axis.Direction().Z())>1-1e-8 and math.hypot(axis.Location().X(),axis.Location().Y())<1e-6:kind='skin'
        if kind:
            p=GProp_GProps();BRepGProp.SurfaceProperties_s(face,p);groups[kind].append(p.Mass())
        it.Next()
    expected=boundary_areas(model);out={}
    for name,kind in [('interface.fixed_support','bottom'),('interface.axial_load','top'),('interface.external_pressure','skin')]:
        actual=sum(groups[kind])
        if not groups[kind] or abs(actual-expected[kind])>max(1e-4,expected[kind]*1e-7):raise ValueError('CAD boundary mismatch '+name)
        out[name]={'shell_set':kind,'face_count':len(groups[kind]),'area_mm2':actual}
    return out

def compare(a,b):
    va=mass(a);vb=mass(b);tol=max(abs(vb)*1e-8,.01);diffs=[]
    if abs(va-vb)<=tol:diffs=[abs(mass(cut(a,b))),abs(mass(cut(b,a)))]
    return {'approved':len(diffs)==2 and max(diffs)<=tol,'volume_mm3':va,'reference_volume_mm3':vb,'difference_volumes_mm3':diffs,'tolerance_mm3':tol}

def stl_write(s,p):
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.StlAPI import StlAPI_Writer
    BRepMesh_IncrementalMesh(s,.3,False,.25,True).Perform()
    writer=StlAPI_Writer()
    if not writer.Write(s,str(p)):raise ValueError('STL export failed')

def build(model_path,out):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    model,solid,parts=build_shapes(json.loads(Path(model_path).read_text(encoding='utf-8')))
    step_write(solid,out/'cylinder.step');assembly_write(parts,model,out/'assembly.step')
    check=compare(step_read(out/'cylinder.step'),solid)
    if not check['approved']:raise ValueError('CAD roundtrip failed')
    receipt={'schema_version':2,'source_sha256':digest(out/'cylinder.step'),'geometry_model':model,'equivalence':check,
             'bindings':boundaries(solid,model),'components':[{'id':p['id'],'name':p.get('name',p['id']),'kind':p['kind'],'volume_mm3':mass(parts[p['id']])} for p in model['components']]}
    dump(out/'model.json',model);dump(out/'cylinder.bindings.json',receipt)
    stl_write(solid,out/'cad-full.stl')
    R=model['diameter_mm']/2;H=model['height_mm']
    section=cut(solid,BRepPrimAPI_MakeBox(gp_Pnt(0,-R-1,-1),R+1,R+1,H+2).Shape())
    stl_write(section,out/'cad-cutaway.stl')
    print('CAD build and independent STEP verification complete',flush=True)

def validate(candidate,record,out):
    receipt=json.loads(disk_path(record).read_text(encoding='utf-8'))
    if receipt.get('schema_version')!=2 or receipt.get('source_sha256')!=digest(candidate):raise ValueError('Stale CAD source')
    model,expected,_=build_shapes(receipt['geometry_model']);actual=step_read(candidate)
    if not BRepCheck_Analyzer(actual).IsValid():raise ValueError('Invalid submitted CAD')
    check=compare(actual,expected)
    if not check['approved']:raise ValueError('Submitted CAD differs from editable object model')
    receipt.update(geometry_model=model,equivalence=check,bindings=boundaries(actual,model))
    dump(out,receipt)
if __name__=='__main__':
    if sys.argv[1]=='build':build(sys.argv[2],sys.argv[3])
    elif sys.argv[1]=='validate':validate(*sys.argv[2:5])
    elif sys.argv[1]=='default-model':print(json.dumps(default_model(),ensure_ascii=True))
    elif sys.argv[1]=='validate-model':print(json.dumps(normalize_model(json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))),ensure_ascii=True))
    else:raise ValueError('Unknown command')
