"""Validated CAD semantic groups mapped onto integral cylinder midsurfaces."""
import math
from .geometry_model import normalize_model, default_model, boundary_areas


def validate_binding(binding,source_sha=None,reference_sha=None,geometry_model=None):
    if not isinstance(binding,dict):raise ValueError('Invalid semantic boundaries')
    version=binding.get('schema_version')
    if version not in (1,2):raise ValueError('Unknown semantic boundary schema')
    if source_sha and binding.get('source_sha256')!=source_sha:raise ValueError('Stale semantic boundaries')
    eq=binding.get('equivalence',{})
    if not isinstance(eq,dict) or eq.get('approved') is not True:raise ValueError('CAD equivalence not approved')
    if version==1:
        if reference_sha and eq.get('reference_step_data_sha256')!=reference_sha:raise ValueError('Wrong shell reference CAD')
        if geometry_model is not None and normalize_model(geometry_model)!=default_model():
            raise ValueError('Legacy boundary cannot validate changed geometry model')
        targets=boundary_areas()
        max_tol=1.
    else:
        model=normalize_model(binding.get('geometry_model'))
        if geometry_model is None or normalize_model(geometry_model)!=model:
            raise ValueError('Semantic geometry model differs from requested geometry')
        volume=eq.get('volume_mm3',0)
        if isinstance(volume,bool) or not isinstance(volume,(int,float)) or not math.isfinite(volume) or volume<=0:raise ValueError('Invalid CAD equivalence volume')
        max_tol=max(volume*1.e-8,.01)*1.01
        targets=boundary_areas(model)
    diffs=eq.get('difference_volumes_mm3',[]);tol=eq.get('tolerance_mm3',0)
    if (isinstance(tol,bool) or not isinstance(tol,(int,float)) or not math.isfinite(tol) or not 0<tol<=max_tol or
        not isinstance(diffs,list) or len(diffs)!=2 or any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) or x<0 or x>tol for x in diffs)):
        raise ValueError('CAD difference outside equivalence tolerance')
    mapping={'interface.fixed_support':'bottom','interface.axial_load':'top','interface.external_pressure':'skin'}
    for tag,region in mapping.items():
        group=binding.get('bindings',{}).get(tag,{})
        target=targets[region];ar=group.get('area_mm2',0);count=group.get('face_count',0)
        if group.get('shell_set')!=region or isinstance(count,bool) or not isinstance(count,int) or count<1 or isinstance(ar,bool) or not isinstance(ar,(int,float)) or not math.isfinite(ar) or abs(ar-target)>target*1e-6:
            raise ValueError('Invalid CAD to shell boundary: '+tag)
    return binding
