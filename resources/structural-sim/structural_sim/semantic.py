"""Validated CAD semantic groups mapped onto the existing cylinder midsurfaces."""
import math

def validate_binding(binding,source_sha=None,reference_sha=None):
    if binding.get('schema_version')!=1:raise ValueError('Unknown semantic boundary schema')
    if source_sha and binding.get('source_sha256')!=source_sha:raise ValueError('Stale semantic boundaries')
    eq=binding.get('equivalence',{})
    if eq.get('approved') is not True:raise ValueError('CAD equivalence not approved')
    if reference_sha and eq.get('reference_step_data_sha256')!=reference_sha:raise ValueError('Wrong shell reference CAD')
    diffs=eq.get('difference_volumes_mm3',[]);tol=eq.get('tolerance_mm3',0)
    if len(diffs)!=2 or not 0<tol<1 or any(not math.isfinite(x) or x<0 or x>tol for x in diffs):raise ValueError('CAD difference outside equivalence tolerance')
    mapping={'interface.fixed_support':'bottom','interface.axial_load':'top','interface.external_pressure':'skin'}
    end_area=math.pi*(500**2-450**2)-18*math.pi*7.5**2
    for tag,region in mapping.items():
        group=binding.get('bindings',{}).get(tag,{})
        target=2*math.pi*500*500 if region=='skin' else end_area
        ar=group.get('area_mm2',0)
        if group.get('shell_set')!=region or group.get('face_count',0)<1 or not math.isfinite(ar) or abs(ar-target)>target*1e-6:raise ValueError('Invalid CAD to shell boundary: '+tag)
    return binding
