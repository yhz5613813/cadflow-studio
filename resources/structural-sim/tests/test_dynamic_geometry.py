"""Physical geometry edits must reach mesh, per-object sections and load mapping."""
import copy,json,math
import numpy as np
import pytest
from structural_sim.geometry_model import default_model,normalize_model,parameters,boundary_areas
from structural_sim.semantic import validate_binding
from structural_sim.cylinder import build_mesh,write_deck


def edited_model():
    model=default_model();by={c['id']:c for c in model['components']}
    by['skin']['thickness_mm']=3.
    by['frame.top'].update(thickness_mm=16.,width_mm=55.,phase_deg=3.)
    by['frame.bottom'].update(thickness_mm=14.,width_mm=52.)
    by['longitudinal.001'].update(width_mm=10.,height_mm=15.,angle_deg=2.)
    by['ring.001'].update(width_mm=10.,height_mm=16.,z_mm=96.)
    return model


def binding(model):
    area=boundary_areas(model)
    return dict(schema_version=2,source_sha256='current',geometry_model=model,
        equivalence=dict(approved=True,volume_mm3=6.e6,tolerance_mm3=.06,difference_volumes_mm3=[0.,0.]),
        bindings={tag:dict(shell_set=kind,face_count=1,area_mm2=area[kind]) for tag,kind in [
            ('interface.fixed_support','bottom'),('interface.axial_load','top'),('interface.external_pressure','skin')]})


@pytest.mark.parametrize('fault',['nan','overlap','missing','hole','id','ring'])
def test_invalid_geometry(fault):
    model=default_model();by={c['id']:c for c in model['components']}
    if fault=='nan':model['height_mm']=float('nan')
    if fault=='overlap':by['longitudinal.002']['angle_deg']=0.
    if fault=='missing':model['components'].pop()
    if fault=='hole':by['frame.top']['bolt_circle_mm']=1000.
    if fault=='id':by['skin']['id']=[]
    if fault=='ring':by['ring.002']['z_mm']=by['ring.001']['z_mm']
    with pytest.raises(ValueError):normalize_model(model)


def test_valid_geometry_has_no_mutation():
    model=edited_model();before=copy.deepcopy(model)
    assert normalize_model(model)==before
    assert model==before
    assert parameters(model)[-2:]==(7.,492.)


def test_v2_equivalence_is_bound_to_source_and_model():
    model=edited_model();b=binding(model)
    assert validate_binding(b,'current',geometry_model=model)==b
    for changed,sha in [(default_model(),'current'),(model,'stale')]:
        with pytest.raises(ValueError):validate_binding(b,sha,geometry_model=changed)
    b['bindings']['interface.axial_load']['area_mm2']*=.99
    with pytest.raises(ValueError):validate_binding(b,geometry_model=model)
    b=binding(model);b['equivalence']['difference_volumes_mm3'][0]=1.
    with pytest.raises(ValueError):validate_binding(b,geometry_model=model)


def test_actual_mesh_and_independent_sections(tmp_path):
    model=edited_model();mesh=build_mesh(tmp_path,60,geometry_model=model)
    assert mesh['geometry_model']==model
    assert mesh['connected_components']==1
    assert set(mesh['component_ids'])=={c['id'] for c in model['components']}
    sections=mesh['sections']
    assert sections['skin']['thickness_mm']==3.
    assert sections['frame.top']['thickness_mm']==16.
    assert sections['frame.bottom']['thickness_mm']==14.
    assert sections['longitudinal.001']['thickness_mm']==10.
    assert sections['longitudinal.002']['thickness_mm']==8.
    assert sections['ring.001']['thickness_mm']==10.
    assert sections['ring.002']['thickness_mm']==8.
    p=np.asarray(mesh['points'])
    for cid,z in [('frame.bottom',7.),('frame.top',492.),('ring.001',96.)]:
        nodes=np.unique(np.concatenate([e for e,c in zip(mesh['elements'],mesh['component_ids']) if c==cid]))
        assert np.allclose(p[nodes,2],z)
    skin_nodes=np.unique(np.concatenate([e for e,c in zip(mesh['elements'],mesh['component_ids']) if c=='skin']))
    assert np.allclose(np.linalg.norm(p[skin_nodes,:2],axis=1),498.5)
    mesh['semantic_bindings']=binding(model)
    audit=write_deck(tmp_path,mesh,force=123456.,pressure=.17)
    assert abs(audit['mapped_force_N'][2]+123456.)<1.e-5
    assert np.linalg.norm(audit['pressure_resultant_N'])<.1
    assert audit['component_sections']==sections
    deck=(tmp_path/'analysis.inp').read_text()
    assert deck.count('*SHELL SECTION,')==20
    names={cid:f'COMP_{i+1:03}' for i,cid in enumerate(sorted(sections))}
    for cid,section in sections.items():
        assert f'*SHELL SECTION,ELSET={names[cid]},MATERIAL=AL_ASSUMED\n{section["thickness_mm"]:g}\n' in deck


def test_resume_rejects_model_change_before_solver(tmp_path):
    from structural_sim.study import run_study
    old=tmp_path/'old';old.mkdir();out=tmp_path/'out';out.mkdir()
    (old/'request.json').write_text(json.dumps(dict(geometry_model=default_model())))
    def forbidden(*args,**kw):raise AssertionError('Must not solve changed cached geometry')
    with pytest.raises(ValueError,match='geometry_model'):
        run_study(out,dict(geometry_model=edited_model(),resume_output=str(old)),lambda *a:None,forbidden)


def test_changed_geometry_never_reuses_reference_render(tmp_path):
    from structural_sim.__main__ import finish
    out=tmp_path/'result';(out/'static').mkdir(parents=True)
    for name in ['cad-full.png','cad-cutaway.png']:(out/'static'/name).write_bytes(b'old render')
    solver=tmp_path/'solver.exe';solver.write_bytes(b'placeholder for manifest hash')
    finish(out,dict(analysis='cylinder_shell',semantic_bindings=binding(edited_model())),'current',{},solver,0,lambda *a:None)
    assert not (out/'static/cad-full.png').exists()
    assert not (out/'static/cad-cutaway.png').exists()


def test_rejects_stale_presentation(tmp_path):
    from structural_sim.__main__ import finish
    out=tmp_path/'out';out.mkdir()
    with pytest.raises(ValueError,match='presentation image source'):
        finish(out,dict(analysis='cylinder_shell',presentation_images={'source_sha256':'stale'}),'current',{},tmp_path/'solver',0,lambda *a:None)


def test_phase_shift_records_actual_geometry_and_legacy_cache(tmp_path):
    from structural_sim.geometry_model import offset_hole_phase
    from structural_sim.diagnostics import saved_phase_mesh
    model=edited_model();shifted=offset_hole_phase(model,5)
    top=next(c for c in shifted['components'] if c['id']=='frame.top')
    assert top['phase_deg']==8.
    assert model!=shifted
    legacy=dict(size_mm=32,hole_phase_deg=5,curvature_points=40)
    saved=tmp_path/'mesh.json';saved.write_text(json.dumps(legacy))
    assert saved_phase_mesh(saved,None,32)==legacy
    with pytest.raises(ValueError,match='geometry differs'):saved_phase_mesh(saved,model,32)
    current={**legacy,'geometry_model':shifted}
    saved.write_text(json.dumps(current))
    assert saved_phase_mesh(saved,model,32)==current


def test_v1_binding_cannot_admit_changed_model():
    from test_semantic import Boundaries
    fixture=Boundaries();fixture.setUp()
    with pytest.raises(ValueError,match='Legacy boundary'):validate_binding(fixture.b,geometry_model=edited_model())
