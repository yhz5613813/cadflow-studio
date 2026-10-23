# Third-party notices

CAStudio includes components under their respective licenses. Existing copyright notices, license texts and modification notices are retained in the corresponding resource directories.

| Component | Retained notice |
| --- | --- |
| CadFlow resources and contracts | [resources/cadflow/LICENSE](resources/cadflow/LICENSE), [contract license](resources/contracts/cadflow/LICENSE) |
| SimpleCADAPI SDK/editor and contracts | [SDK license](resources/simplecadapi/LICENSE), [integration and modification notice](resources/parametric/THIRD_PARTY.txt), [contract license](resources/contracts/simplecadapi/LICENSE) |
| Structural analysis resources | [source and integration record](resources/structural-sim/README.txt), [source versions](resources/structural-sim/SOURCE_VERSIONS.json), [retained third-party notices](resources/structural-sim/THIRD_PARTY.md) |

The structural source record identifies ThermoForge-Studio commit 08f0a654e8625199be14c45f2cb0b443b0774cb0 and the underlying source versions. CAStudio-specific cylinder, nonlinear, result/report and semantic adapter modules are included alongside that source.

The structural package's retained upstream notice describes dependencies of the original distribution; it is not an inventory of bundled binaries in this repository. CalculiX, NVIDIA runtimes and system fonts are not distributed here.

JavaScript and Python dependencies retain their own licenses. Exact JavaScript dependency versions are recorded in the package-lock.json files; Python requirements are declared beside each runtime. Building or installing dependencies does not change their licensing.
