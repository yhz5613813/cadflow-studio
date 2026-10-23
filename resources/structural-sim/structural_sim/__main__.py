import argparse,hashlib,json,os,shutil,subprocess,sys,time
from pathlib import Path

def write(path,value):
    path=Path(path);tmp=path.with_suffix(path.suffix+'.tmp');tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');tmp.replace(path)

def presentation_sources(req,sha):
    presentation=req.get('presentation_images')
    if not presentation:return None
    if not isinstance(presentation,dict) or presentation.get('source_sha256')!=sha:
        raise ValueError('CAD presentation image source differs from solved geometry')
    sources={}
    for key,name in [('full','cad-full.png'),('cutaway','cad-cutaway.png')]:
        value=presentation.get(key)
        if not isinstance(value,str):raise ValueError('Missing or invalid CAD presentation image: '+key)
        source=Path(value)
        if not source.is_file():raise ValueError('Missing or invalid CAD presentation image: '+key)
        with source.open('rb') as image:
            if image.read(8)!=b'\x89PNG\r\n\x1a\n':raise ValueError('Missing or invalid CAD presentation image: '+key)
        sources[name]=source
    return sources

def run(request,output,solver):
    req=json.loads(Path(request).read_text(encoding='utf-8-sig'));out=Path(output).resolve()
    out.mkdir(parents=True,exist_ok=False)
    os.environ['STRENGTH_DATA']=str(out/'data');os.environ['STRENGTH_CCX']=str(Path(solver).resolve());os.environ['STRENGTH_CPU_THREADS']='1'
    started=time.time()
    def status(stage,detail):
        write(out/'status.json',dict(stage=stage,detail=detail,updated=time.time()));print(detail,flush=True)
    try:
        source=Path(req['geometry']).resolve();sha=hashlib.sha256(source.read_bytes()).hexdigest()
        if sha!=req['geometry_sha256']:raise ValueError('Source geometry hash mismatch')
        shutil.copy2(source,out/('source'+source.suffix));write(out/'request.json',req)
        if req['analysis']=='cylinder_shell':
            # Accept the original fixture or an independently verified editable CAD model.
            baseline=json.loads((Path(__file__).parent/'cylinder-profile.json').read_text(encoding='utf-8-sig'))
            if b'DATA;' not in source.read_bytes():raise ValueError('Cylinder shell input must be a STEP file')
            datahash=hashlib.sha256(source.read_bytes().split(b'DATA;',1)[1]).hexdigest()
            binding=req.get('semantic_bindings')
            if binding:
                from .semantic import validate_binding
                validate_binding(binding,sha,baseline['step_data_sha256'],req.get('geometry_model'))
            elif req.get('geometry_model') is not None:raise ValueError('Edited geometry requires independently validated semantic boundaries')
            elif datahash!=baseline['step_data_sha256']:raise ValueError('Shell profile does not match this CAD. Rebuild/validate the shell idealization for changed geometry.')
            size=float(req.get('mesh_size_mm',24));force=float(req.get('axial_force_N',2451662.5));pressure=float(req.get('external_pressure_MPa',.2));E=float(req.get('E_MPa',70000));nu=float(req.get('nu',.33))
            import math
            if not all(math.isfinite(x) for x in [size,force,pressure,E,nu]) or not 12<=size<=60 or force<=0 or pressure<0 or E<=0 or not 0<nu<.49:raise ValueError('Invalid shell case parameters')
            presentation_sources(req,sha)
            from .cylinder import build_mesh,write_deck
            from .results import parse_static,plot_results,parse_buckling
            from strength.solver import run_ccx
            if req.get('mesh_study'):
                from .study import run_study
                summary=run_study(out,req,status,run_ccx)
                finish(out,req,sha,summary,solver,started,status)
                return
            static=out/'static';status('meshing','生成带孔二阶壳网格');mesh=build_mesh(static,size,geometry_model=req.get('geometry_model'))
            if binding:mesh['semantic_bindings']=binding;write(static/'shell-mesh.json',mesh)
            write_deck(static,mesh,force=force,pressure=pressure,E=E,nu=nu)
            status('solving','CalculiX 静力求解');run_ccx(static,timeout_s=1800)
            summary=parse_static(static)
            summary['material']={'E_MPa':E,'nu':nu,'yield_strength':None};write(static/'summary.json',summary)
            if not summary['balance_passed']:raise ValueError('Static force balance failed')
            status('rendering','生成真实应力与位移云图');plot_results(static)
            if req.get('buckling',True):
                status('buckling','求解组合载荷特征值屈曲');b=out/'buckling';b.mkdir();write(b/'shell-mesh.json',mesh)
                write_deck(b,mesh,'buckling',force,pressure,E,nu);run_ccx(b,timeout_s=1800);summary['buckling']=parse_buckling(b)
            summary['assessment']='本次为假设弹性材料的参考场；未提供屈服曲线，不作强度合格判定。'
            if summary['maximum_displacement_mm']>5 or summary['maximum_von_mises_MPa']/E>.01:
                summary['assessment']=f'线性参考场已显示明显变形或高弹性应变；不能作为 {force/9806.65:g} 公吨力与 {pressure:g} MPa 外压下的实际应力和变形预测，也不能据此判定安全。需结合屈曲结果，并补充材料曲线与几何非线性分析。'
            write(out/'summary.json',summary)
        elif req['analysis']=='solid_static':
            from strength.geometry import inspect_model
            from strength.solver import run_job
            m=out/'data'/'models'/'source';m.mkdir(parents=True,exist_ok=True);shutil.copy2(source,m/('source'+source.suffix))
            write(m/'source.json',{'file':'source'+source.suffix,'units':req.get('units','mm')});status('inspecting','检查实体 CAD');inspect_model(m)
            job=out/'static';job.mkdir();write(job/'config.json',{'model_id':'source','geometry_sha256':sha,'case':req['case']})
            summary=run_job(job);write(out/'summary.json',summary)
        else:raise ValueError('Unsupported analysis')
        finish(out,req,sha,summary,solver,started,status)
    except Exception as e:
        status('failed',str(e));raise

def finish(out,req,sha,summary,solver,started,status):
        presentation=presentation_sources(req,sha)
        binding=req.get('semantic_bindings') or {}
        (out/'static').mkdir(exist_ok=True)
        if presentation:
            for name,source in presentation.items():shutil.copy2(source,out/'static'/name)
        elif binding.get('schema_version')==1 and binding.get('equivalence',{}).get('approved'):
            images=Path(__file__).parent/'presentation'
            for name in ('cad-full.png','cad-cutaway.png'):
                if (images/name).is_file():shutil.copy2(images/name,out/'static'/name)
        else:
            # A changed model must never inherit the original case's render.
            for name in ('cad-full.png','cad-cutaway.png'):
                (out/'static'/name).unlink(missing_ok=True)
        if req.get('report_python') and req['analysis']=='cylinder_shell':
            status('reporting','生成 Word 报告')
            subprocess.run([req['report_python'],str(Path(__file__).with_name('report_docx.py')),str(out)],check=True,timeout=120,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        write(out/'manifest.json',dict(schema_version=1,source_sha256=sha,analysis=req['analysis'],summary=summary,elapsed_s=time.time()-started,
            upstream_commit='08f0a654e8625199be14c45f2cb0b443b0774cb0',solver_sha256=hashlib.sha256(Path(solver).read_bytes()).hexdigest()))
        status('completed','计算与结果导出完成')

def main():
    a=argparse.ArgumentParser();sub=a.add_subparsers(dest='command',required=True)
    sub.add_parser('doctor');p=sub.add_parser('run');p.add_argument('request');p.add_argument('--output',required=True);p.add_argument('--solver',required=True)
    v=a.parse_args()
    if v.command=='doctor':
        import gmsh,numpy,scipy
        print(json.dumps({'ok':True,'version':'0.2.0','gmsh':gmsh.__version__,'analyses':['solid_static','cylinder_shell_static','cylinder_shell_buckling','cylinder_shell_nonlinear_mesh_study']}))
    else:run(v.request,v.output,v.solver)
if __name__=='__main__':main()
