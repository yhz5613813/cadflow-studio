"""Increment isolation: reject failed frames and never sum reactions across time."""
import json
import numpy as np
import pytest
from structural_sim.results import parse_static

@pytest.mark.parametrize('times,sta_times',[
    ([.1,.2,.3],['0.100000E+00','0.200000E+00','0.300000E+00']),
    ([.8,.8470031,.8470044],['0.800000E+00','0.847003E+00','0.847004E+00'])])
def test_last_accepted_increment_is_used(tmp_path,times,sta_times):
    points=[[0,0,0],[1,0,0],[0,1,0],[.5,0,0],[.5,.5,0],[0,.5,0]]
    mesh={'points':points,'elements':[[0,1,2,3,4,5]],'kinds':['top'],'types':['S6'],'size_mm':24,'idealization':'test'}
    (tmp_path/'shell-mesh.json').write_text(json.dumps(mesh))
    audit={'mapped_force_N':[0,0,-100],'mode':'static'}
    (tmp_path/'load-audit.json').write_text(json.dumps(audit))
    # Third frame exists on disk but is an unaccepted attempt.
    (tmp_path/'analysis.sta').write_text(f'1 1 1 3 {sta_times[0]} 0.1 0.1\n1 2 1 3 {sta_times[1]} 0.2 0.1\n1 3 1U 12 {sta_times[2]} 0.3 0.1\n')
    dat='';frd=''
    for t,stress in zip(times,[100,50,9999]):
        dat+=f' stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz) for set EALL and time {t}\n 1 1 {stress} 0 0 0 0 0\n forces (fx,fy,fz) for set FIXED and time {t}\n 1 0 0 {100*t}\n'
        frd+=f'  100CL  101 {t:.5E} 6 0 1 1\n -4  DISP\n'
        for i in range(1,7):frd+=f' -1{i:10d}{0.:12.5E}{0.:12.5E}{-t:12.5E}\n'
        frd+=' -3\n'
        frd+=f'  100CL  101 {t:.5E} 6 0 1 1\n -4  FORC\n'
        for i in range(1,7):
            force=100*t if i==1 else -100*t if i==2 else 0.
            frd+=f' -1{i:10d}{0.:12.5E}{0.:12.5E}{force:12.5E}\n'
        frd+=' -3\n'
    (tmp_path/'analysis.dat').write_text(dat);(tmp_path/'analysis.frd').write_text(frd)
    np.savez(tmp_path/'loads.npz',fixed=[0])
    s=parse_static(tmp_path)
    assert s['load_factor']==times[1]
    assert s['maximum_von_mises_MPa']==50
    assert s['maximum_displacement_mm']==float(f'{times[1]:.5E}')
    assert np.allclose(s['reaction_N'],[0,0,100*times[1]])
    assert s['balance_passed'] and not s['full_load_reached']
    assert s['assembled_balance_relative']==0
    assert s['rf_dat_frd_relative_difference']<1.e-6
    assert len(s['history'])==2
