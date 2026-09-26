---
name: thermal-sim
description: Run solid thermal FEM simulation on STEP/STL using the independent thermal-sim Python package, configure materials and thermal boundaries, inspect temperature fields, and connect simulation evidence to CAD design changes.
---

# Solid thermal simulation

Use the installed `thermal-sim` package through its public Python API or CLI. It does not require CadFlow, Studio, a web server, an LLM account, or an upstream checkout. The host provides the Python interpreter; otherwise use the user-selected environment. Check `<python> -m thermal_sim doctor` before running. Do not modify an installed package to configure a case.

Read [references/interface.md](references/interface.md) when preparing requests, choosing faces, or interpreting files. Obtain the complete current material and simulation schema with `<python> -m thermal_sim schema`; do not guess field names.

Preserve the user's geometry, units, materials, heat input, boundary conditions and intended duration. Ask only for missing information that changes the physical problem. Label illustrative assumptions explicitly. Simulation authorization already provided by the user also applies to routine validation and reruns; do not invent a new confirmation step.

- Prefer closed solid STEP from the actual modeling source. STEP uses its embedded units; STL needs explicit mm/cm/m. Internal geometry and all configuration positions, lengths and mesh sizes use meters; temperatures use Celsius, power W, conductivity W/(m·K), density kg/m³, heat capacity J/(kg·K).
- `selector` resolves all or signed XYZ normals on the imported thermal surface. Studio preview triangle numbers and STEP face IDs are not thermal face IDs. Never copy those IDs into a thermal request. Explicit numeric faces require inspecting the exact thermal display mesh; bind the request to the geometry SHA-256.
- Heat source `end_s` is independent of simulation `duration_s`. A longer duration may include cooling after power switches off. Preserve this distinction when editing or reusing a case.
- For environment-only heating/cooling set `environment_only=true` with a nonzero heat-transfer boundary. Do not add an invented heat source. Validate closed geometry and report meshing failures instead of substituting a box or fabricated temperatures.
- Run into a new output directory. Check CLI exit status and `manifest.json`; read `job/audit.json`, `job/report.md` and warnings before interpreting temperature extrema. Check source SHA-256 before reusing a result for a changed model. A failed/cancelled run is not a valid result.
- The engine solves solid conduction with prescribed convection/radiation, optional reduced air-gap/contact transfer and small-strain linear thermoelasticity. It does not solve CFD airflow, plasticity, fatigue life or mechanical contact. Saved-frame maxima do not prove continuous-time peaks. Mesh/time-step convergence and measured boundary conditions are needed for engineering conclusions.

In Studio, `thermal-case.json` stores `{source,units,config}` relative to the project workspace. It is editable source data; `config` is the simulation section of the standalone request. Saved results under `simulations/<run>/` include the input geometry, resolved configuration, provenance, fields and report. Read them before proposing modeling changes. Update the CAD source and its parameter sidecar together, export a new STEP/STL, rerun the same physical case and compare results with both model hashes. Keep older results for comparison; do not imply an old temperature field was recomputed.
