# STEP preview runtime

This directory contains the unmodified JavaScript and WebAssembly binaries from
`occt-import-js` **0.0.23** (npm), plus both upstream license notices.

- Source and build instructions: https://github.com/kovacsv/occt-import-js
- Exact distribution, including the interface source: https://registry.npmjs.org/occt-import-js/-/occt-import-js-0.0.23.tgz
- OCCT source revision is identified by the upstream `.gitmodules` and `occt` submodule.
- Licenses: `license.occt-import-js.txt`, `license.occt.txt`.

The importer is loaded as a separate script and WASM module by
`/step-preview-worker.js`. To replace it, rebuild the upstream interface and copy
the compatible `occt-import-js.js` / `occt-import-js.wasm` pair here, then rebuild
Studio. `npm run preview:prepare` restores the pinned npm distribution.

This is a STEP preview/import adapter. It is independent of the CadFlow modeling
runtime; it does not implement CadFlow's Python API or claim a Windows CadFlow
wheel exists. STEP coordinates are converted to millimetres, and face indices
are local to this importer and the specific source file.
