CAStudio Structural Simulation 0.2.0

Source: https://github.com/tianyuzong/ThermoForge-Studio
Pinned commit: 08f0a654e8625199be14c45f2cb0b443b0774cb0

The strength package is migrated upstream code for solid linear static FEM,
load mapping, constraints, CalculiX execution, field extraction and reports.
The forge directory retains upstream coupled-analysis source for future adapters;
its coupled workflows are not exposed or acceptance-tested by this release.
Only the capabilities listed by structural_sim doctor are enabled.

New structural_sim modules implement:
- Explicit request/output CLI and geometry-hash validation.
- A quadratic S8R/S6 shell idealization bound to the verified cylinder CAD.
- Static pressure and axial loading, connected junctions, force-balance checks.
- Perfect-elastic eigenvalue buckling with simultaneous load scaling.
- Integration-point stress-envelope plots and editable Word reports.
- CadFlow Studio project build, calculation history and result viewing adapters.
- Incremental NLGEOM elastic analysis with accepted-increment-only fields.
- Three or more mesh levels, refining both surfaces and bolt-hole perimeters.
- Constant-resultant global axial traction and follower external pressure.
- Load decomposition, direct-rim and hole-phase diagnostic comparisons.
- Mesh-study resume with identical geometry, material, loads and solver decks.

In Studio, select geometric nonlinear and mesh verification. The default sizes
are 32,24,18 mm. The CLI request uses mesh_study=true, mesh_levels_mm=[32,24,18].
Independent mesh solves run in two worker threads; Gmsh and plotting remain
serial. Each worker launches its own single-thread CalculiX process and files.
Only achieved load factors are plotted. Failure to reach full load is reported
as a partial converged path, never relabeled as a full-load response. Mesh
comparisons only compare identical load factors. The defined bulk-skin metric
excludes 20 mm bands around ring and longitudinal junctions and end regions.
The default criterion is less than 5 percent change in all three reported
metrics between the final two meshes; this is a numerical check, not a strength
or imperfection-sensitive capacity certification.

The editable Word report omits the calculation-provenance section as requested.
For an already finished study, reprocess_only=true plus resume_output regenerates
fields, diagnostics and reports from saved accepted states without solving.
Inputs must match exactly. Partial load factors and solver errors are preserved;
missing or mismatched results fail instead of silently starting a new analysis.
Terminal failed pipelines may also recover their saved accepted raw frames.
Only the explicit diagnostics_fill_missing option permits new diagnostic solves;
the main mesh analyses are never restarted by reprocessing.

Run with a Python 3.12 environment containing the pyproject dependencies:
  python -m structural_sim doctor
  python -m structural_sim run request.json --output NEW_DIRECTORY --solver CCX_EXE

The output directory must not already exist. A mesh study with accepted partial
paths may finish its report pipeline and write a manifest even if an individual
solver did not reach the target load. Its load factor, solver_completed flag and
solver_error remain explicit; pipeline completion is not full-load convergence.
Top-level failures without usable results do not write a success manifest.
Cancelled or interrupted jobs are not presented as completed calculations.
The Word exporter runs with the separate configured document Python runtime.

For general solid models, use analysis=solid_static and the upstream LoadCase
schema. For this cylinder, analysis=cylinder_shell is bound to its STEP DATA
fingerprint. STEP header dates and names may change; geometric entity data may
not change without rebuilding and revalidating the shell idealization.

Units: cylinder shell path uses mm, N, MPa. The migrated solid path uses SI.
Do not mix their field arrays. Display JSON explicitly uses shell mm/MPa fields.

Engineering scope:
The cylinder uses assumed E=70000 MPa, nu=0.33, integral connections. No yield
strength or plastic curve is supplied. Linear fields above small-deformation
or elastic-strain applicability limits are diagnostic reference fields, not
validated operating-state predictions. Eigenvalue factors are not allowable
loads or imperfection-sensitive nonlinear collapse capacities.

The CAD is an exact single solid. The FE model uses intersecting midsurfaces,
with rib extensions to skin and flange midsurfaces. This idealization does not
resolve welds, finite joint radii, bolt preload/contact or local 3D joint stress.

Licensing and provenance:
No new license is imposed on copied upstream code. The upstream repository
does not provide a unified root license. Preserve its THIRD_PARTY.md and
SOURCE_VERSIONS.json. CalculiX is GPL; the GPL text is in vendor/.
The official executable is downloaded separately and SHA-256 verified.
Official binary: https://www.dhondt.de/calculix_2.23_4win.zip
Archive SHA-256: 87FC4E1721DF37370EC67D0A244BB14F9BF804B0A95DF49E2AE7369D30EC72E8
Executable SHA-256: E18360EB32A5CD48F91A212C57069212CD8E27D2F798A599A78106BD0B3ECC1F
Matching source: https://www.dhondt.de/ccx_2.23.src.tar.bz2

Studio changes are provided separately as a patch and integration source files.
The installed Studio's structural-runtime.json holds executable/package paths.
Existing modeling and thermal workflows are retained.
