import json
import pytest
from structural_sim.study import run_study

def test_resume_rejects_different_load_before_solver(tmp_path):
    old=tmp_path/'old';old.mkdir();new=tmp_path/'new';new.mkdir()
    previous={'geometry_sha256':'abc','axial_force_N':100,'external_pressure_MPa':.2,'E_MPa':70000,'nu':.33}
    (old/'request.json').write_text(json.dumps(previous))
    request={**previous,'axial_force_N':200,'resume_output':str(old)}
    def forbidden(*a,**k):raise AssertionError('Must not invoke solver')
    with pytest.raises(ValueError,match='axial_force_N'):run_study(new,request,lambda *a:None,forbidden)
    assert not list(new.iterdir())

def test_mesh_study_rejects_repeated_or_ascending_levels(tmp_path):
    for sizes in [[24,24,18],[18,24,32],[32,24],[32,24,8]]:
        with pytest.raises(ValueError,match='distinct descending'):
            run_study(tmp_path,{'mesh_levels_mm':sizes},lambda *a:None,None)

def test_reprocess_preserves_partial_status_without_solving(tmp_path,monkeypatch):
    from structural_sim import study
    old=tmp_path/'old';old.mkdir();new=tmp_path/'new';new.mkdir()
    req={'geometry_sha256':'abc','axial_force_N':100,'external_pressure_MPa':.2,'E_MPa':70000,'nu':.33,'diagnostics':False}
    (old/'request.json').write_text(json.dumps(req));(old/'status.json').write_text('{"stage":"completed"}')
    for size in [32,24,18]:
        mesh={'curvature_points':max(24,1280/size),'hole_phase_deg':0}
        for mode in ['linear','nonlinear']:
            folder=old/f'mesh-{size}'/mode;folder.mkdir(parents=True)
            (folder/'shell-mesh.json').write_text(json.dumps(mesh));(folder/'analysis.inp').write_text('same deck')
            (folder/'analysis.frd').write_text('unit test accepted-field placeholder')
            s={'load_factor':1 if mode=='linear' else .8,'full_load_reached':mode=='linear','solver_completed':mode=='linear','solver_error':None if mode=='linear' else 'cutback limit',
               'maximum_displacement_mm':2,'maximum_von_mises_MPa':30,'bulk_skin_max_mises_MPa':20,'history':[{'load_factor':.8,'maximum_displacement_mm':2,'maximum_von_mises_MPa':30}]}
            (folder/'summary.json').write_text(json.dumps(s))
    def deck(folder,*a,**k):(folder/'analysis.inp').write_text('same deck')
    def forbidden(*a,**k):raise AssertionError('Reprocessing must not mesh or solve')
    monkeypatch.setattr(study,'write_deck',deck);monkeypatch.setattr(study,'build_mesh',forbidden)
    monkeypatch.setattr(study,'parse_static',lambda folder:json.loads((folder/'summary.json').read_text()))
    monkeypatch.setattr(study,'plot_results',lambda *a:None);monkeypatch.setattr(study,'plot_study',lambda *a:None)
    result=run_study(new,{**req,'resume_output':str(old),'reprocess_only':True},lambda *a:None,forbidden)
    assert result['load_factor']==.8 and not result['full_load_reached']
    for level in result['mesh_study']['levels']:
        assert not level['nonlinear']['solver_completed']
        assert level['nonlinear']['solver_error']=='cutback limit'
        assert level['nonlinear']['reprocessed_only']

def test_reprocess_missing_result_never_falls_back_to_solver(tmp_path):
    old=tmp_path/'old';old.mkdir();new=tmp_path/'new';new.mkdir()
    (old/'request.json').write_text('{}');(old/'status.json').write_text('{"stage":"completed"}')
    def forbidden(*a,**k):raise AssertionError('Must not invoke solver')
    with pytest.raises(ValueError,match='never starts a solver'):
        run_study(new,{'resume_output':str(old),'reprocess_only':True},lambda *a:None,forbidden)

def test_recover_raw_status_preserves_failed_solver(tmp_path):
    from structural_sim.study import saved_state
    (tmp_path/'solver.log').write_text('*ERROR: increment size smaller than minimum')
    (tmp_path/'analysis.sta').write_text('1 29 2 2 0.847003E+00 0.847003E+00 0.128746E-05\n1 30 1U 10 0.847003E+00 0.847003E+00 0.128746E-05\n')
    s=saved_state(tmp_path)
    assert s['load_factor']==.847003
    assert not s['solver_completed'] and not s['full_load_reached']
    assert 'increment size smaller than minimum' in s['solver_error']
