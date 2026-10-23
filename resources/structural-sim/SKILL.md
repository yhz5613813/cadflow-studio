---
name: structural-sim
description: Build and validate the supported cylinder in CAStudio, queue linear or geometric nonlinear elastic analysis, verify mesh convergence, diagnose high stresses, inspect Mises and displacement fields, and retrieve Word reports.
---

# Studio structural analysis

Use the current project API supplied in the system prompt. The integrated cylinder backend uses mm, N and MPa with quadratic S8R/S6 shells and a CalculiX solver. The migrated general solid API uses SI and is a separate CLI capability; do not route arbitrary solids into the cylinder profile.

The supported geometry is OD1000, overall height500 including two inward50×12 flanges, skin2.5, 18 holes per flange of diameter15 on PCD970, 12 inner longitudinal ribs and 5 equally spaced inner ring ribs, all8×12. Geometry differs from the FE model: the latter uses intersecting midsurfaces and integral common-node connections. A STEP DATA fingerprint binds this profile to the independently validated solid. Changed geometry requires a new validated idealization; never alter or bypass the fingerprint to make a job run.

For authorized modeling work, read the bundled CadFlow skill, edit the project Python source, execute it with the configured CadFlow interpreter and inspect its validity and exported STEP. Keep actual files in this project. Existing `build_model.py` implements this confirmed case; run it only when a build or change is needed. Preserve old build records.

After validating the source, queue a job using the terminal HTTP client:

```powershell
$case = @{
  source = 'artifacts/cylinder.step' # actual project-relative existing STEP
  mesh_size_mm = 24
  axial_force_N = 2451662.5
  external_pressure_MPa = 0.2
  E_MPa = 70000
  nu = 0.33
  buckling = $true
}
$body = $case | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri ($projectApi + '/structural/queue') -ContentType 'application/json' -Body $body
```

Set `$projectApi` to the exact current-project API from the system prompt. Use the actual STEP path, not the illustrative path above. The user confirmed assumed elastic material and integral connections for this case. Preserve different explicitly requested loads/material values. `250` metric tonne-force equals `2451662.5` N, not 250 N or 250000 N.

The current agent turn holds the project editing lock. Queueing returns promptly; **finish the turn after reporting the queued job ID** so execution can acquire that lock. Do not wait in this same turn for the queued job or call the immediate `/structural` POST. A later turn can GET `/structural` or `/structural/<id>`. Source changes after queueing reject the job. Queueing alone is not successful analysis.

For succeeded runs, GET `/structural/<id>/file?path=summary.json` and `manifest.json`. Check the source hash, completion state, force balance, material assumptions and mesh size before reporting numbers. `/file?path=static/display.json` contains the actual three-dimensional field; `/file?path=report.docx&download=1` downloads the generated report. The structural panel exposes rotation, sectioning, deformation scale, PNGs and the input deck. Cancel through POST `/structural/<id>/cancel` when requested.

Buckling uses a small reference load and converts factors back to the full specified load path; axial force and external pressure scale together. It is a perfect-elastic eigenvalue calculation, not nonlinear capacity. Large displacement or high elastic strain invalidates interpreting a linear reference field as the actual operating state. Without yield/plasticity and imperfection data, do not declare strength or stability compliance. Never write fabricated result records, reuse fields for changed geometry, or describe an interrupted/failed run as complete.

## Geometric nonlinear mesh verification
For geometric nonlinear and mesh convergence requests, submit the existing queue route with `mesh_study: true, mesh_levels_mm: [32,24,18], buckling: false`. This performs linear reference and NLGEOM incremental elastic calculations at all three sizes. Axial force is a consistent fixed-global-direction nodal traction with constant total resultant; outer pressure follows the deformed shell normal. Read achieved load_factor and full_load_reached: partial convergence must never be called a full-load result. Compare only equal load levels. The Word report omits the calculation provenance section at the user request.

The default study also runs separate linear load decomposition, direct skin-rim loading and a 5-degree bolt-circle phase diagnostic. The latter two deliberately differ from the requested case and must stay labeled as diagnostics. Do not substitute them for the main CAD or operating load result. A successful numerical study can still report a nonconverged stress peak; read `mesh_study.converged`, its relative changes, and force balance before drawing conclusions.

To reuse completed meshes from an identical earlier Studio run, supply `resume_run` with its actual run ID. The server resolves its output folder; the CLI checks CAD hash, material, loads, local mesh refinement policy and exact solver deck before reusing fields. Never provide an arbitrary output directory through the UI API. Partial or interrupted work is not automatically accepted as a completed mesh.

For report or parser updates after a terminal mesh study, set reprocess_only=true with resume_run. This validates identical CAD, material, loads and input decks and by default starts no solver. Preserve incomplete load paths and solver errors; do not relabel them as full-load results. The source run must be terminal (succeeded or failed). Raw accepted frames may be recovered after a postprocessing error. By default no solver starts; explicitly set diagnostics_fill_missing=true only when choosing to calculate missing load-path diagnostics. Main nonlinear analyses are never rerun in this mode.
