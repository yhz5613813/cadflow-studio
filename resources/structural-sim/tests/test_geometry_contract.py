"""Reject stale, changed or nonphysical cases before invoking a solver."""
import hashlib,json
from pathlib import Path
import pytest
from structural_sim.__main__ import run

CANONICAL=Path(__file__).resolve().parents[2]/'parametric'/'reference-cylinder.step'

@pytest.mark.parametrize('fault',['stale_hash','changed_geometry','invalid_mesh','stale_image'])
def test_reject_unverified_case_before_solver(tmp_path,fault):
    data=CANONICAL.read_bytes()
    if fault=='changed_geometry': data=data.replace(b'DATA;',b'DATA;\n/* changed entity section */',1)
    source=tmp_path/'source.step';source.write_bytes(data)
    request={'analysis':'cylinder_shell','geometry':str(source),'geometry_sha256':hashlib.sha256(data).hexdigest(),'mesh_size_mm':24}
    if fault=='stale_hash':request['geometry_sha256']='0'*64
    if fault=='invalid_mesh':request['mesh_size_mm']=-1
    if fault=='stale_image':request['presentation_images']={'source_sha256':'stale'}
    req=tmp_path/'request.json';req.write_text(json.dumps(request))
    output=tmp_path/'result'
    with pytest.raises(ValueError):run(req,output,tmp_path/'solver-must-not-be-called.exe')
    assert json.loads((output/'status.json').read_text())['stage']=='failed'
    assert not (output/'manifest.json').exists()
    assert not (output/'static').exists()
