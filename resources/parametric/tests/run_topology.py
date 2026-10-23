import runpy, time
from pathlib import Path
start=time.monotonic()
scope=runpy.run_path(str(Path(__file__).with_name('test_topology_identity.py')))
for name,fn in scope.items():
    if name.startswith('test_'):
        fn();print('PASS',name,flush=True)
import simplecadapi as scad
from simplecadapi.core import clone_semantic_shape_view, _same_semantic_topology
for original in [scad.make_box_rsolid(10,20,30), scad.make_cylinder_rsolid(20,50)]:
    clone=clone_semantic_shape_view(original)
    sources={e.topo_id:e for e in original._topology_cache.entities()}
    for entity in clone._topology_cache.entities():
        source=sources[entity.topo_id]
        assert entity is not source and _same_semantic_topology(entity.kind,entity.representative,source.representative)
    clone.set_metadata('independent',True)
    assert original.get_metadata('independent') is None
print('PASS full topology mapping and independent metadata; seconds',time.monotonic()-start,flush=True)
