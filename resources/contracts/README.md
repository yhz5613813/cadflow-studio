# Scene format sources

CadFlow: https://github.com/yhz5613813/CadFlow/tree/7e6197f78b7505f3c7f6e5c3f126efe4c6e10ef9/scene-contract (MIT). Vendored validation modules are unchanged except the local resource directories in schema.ts and report.ts.

SimpleCADAPI: https://github.com/NiJingzhe/SimpleCADAPI/tree/a4ee014c27e5318c2cf3fa4881ed9b189e38f850/viewer/src (Apache-2.0). product-package.ts and scene2.ts retain upstream code; extractArchive is additionally exported for format detection. Schemas are copied from the same revision.

Studio adapters and UI live outside these vendor directories.
