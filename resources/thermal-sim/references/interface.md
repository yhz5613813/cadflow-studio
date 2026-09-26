# Interface v1

CLI commands (prepend the chosen Python interpreter):

```text
-m thermal_sim doctor
-m thermal_sim schema
-m thermal_sim inspect part.step --output inspection
-m thermal_sim run request.json --output result-001
```

`inspect` and `run` require new output directories. CLI relative geometry paths resolve against the request file, not the current directory. Python API paths resolve against the caller's current directory. Importing `thermal_sim` has no filesystem side effects.

```python
from thermal_sim import run_simulation
manifest = run_simulation(request, "result-001")
```

Example for an illustrative 80 × 50 × 8 mm aluminum plate:

```json
{
  "schema_version": 1,
  "device": "cpu",
  "geometry": {"path": "part.step", "units": "mm"},
  "simulation": {
    "name": "Top heater",
    "base_material": {"name": "Aluminum example", "k": 205, "rho": 2700, "cp": 900},
    "analysis_mode": "transient",
    "initial_C": 25,
    "ambient_C": 25,
    "default_h": 10,
    "duration_s": 60,
    "dt_s": 2,
    "save_s": 10,
    "mesh_size_m": 0.004,
    "air_gap_enabled": false,
    "heat_sources": [{"name": "Heater", "power_W": 5, "start_s": 0, "end_s": 60, "selector": "+z"}]
  }
}
```

Optional `geometry.sha256` rejects changed input. Engine owns `model_id="model"`; omit it. Portable requests reject `initial_from_job` because no external job store is implied. Do not claim upstream workflow orchestration or animation export is part of this package.

`selector` can be `all`, `+x`, `-x`, `+y`, `-y`, `+z`, `-z` on heat sources, cooling groups, structural supports and surface evaluation. Directional selection means surface normals within acos(0.9) of the signed source coordinate axis, not the highest surface or a named assembly part. It can match multiple disconnected surfaces. Use `inspect` and `model/display.json` for exact selections, or the upstream `surface_box` with appropriately selected faces. For curved/complex parts, inspect before deciding a direction is sufficient.

`THERMAL_RESULT=` prefixes the final CLI JSON. Progress lines have `event="progress"`; failures exit nonzero. Standard output can include Gmsh messages. Studio consumes this documented boundary and never imports solver internals.

Outputs:

- `manifest.json`: version, source hash, geometry metadata, frame count/times/extrema, file references.
- `model/source.step` or `.stl`: exact input copy; `metadata.json` and `display.json` bind mesh and source.
- `job/config.json`: complete resolved configuration, including selected thermal triangle IDs.
- `job/surface.bin`: little-endian float32 Celsius, shape `(frames, display_vertices)`; display XYZ is meters. Vertex order must match `display.json` exactly. Do not apply GLB axis/unit conversions.
- `job/history.csv`, `audit.json`, `assessment.json`, `report.md`, `report.pdf`: curves, physical checks and scope.
- `job/result.zip`: raw HDF5/XDMF and reports for external inspection. Optional structural fields retain upstream conventions.

For controlled design comparison, keep physical boundaries and units identical, identify both input hashes, check mesh/time convergence, then compare temperatures and report warnings. Preserve geometry provenance when changing parameters or source files.
