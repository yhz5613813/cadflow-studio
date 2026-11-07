import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Artifact } from '../shared/types';
import { choosePreview } from '../src/scene/preview-file';
const file = (path: string): Artifact => ({path, name: path.split('/').pop()!, kind:'model', size:1, modified:1});
test('default STL opens CAD faces from the same export',()=>{
  const stl=file('exports/new/cylinder.stl'), step=file('exports/new/cylinder.step');
  assert.equal(choosePreview([stl,step]), step);
});
test('never replaces a new STL with an older CAD export',()=>{
  const stl=file('exports/new/cylinder.stl'), old=file('exports/old/cylinder.step');
  assert.equal(choosePreview([stl,old]),stl);
});
test('preserves assembly previews and standalone meshes',()=>{
  const assembly=file('assembly.scadpkg'), step=file('part.step');
  assert.equal(choosePreview([assembly,step]),assembly);
  const mesh=file('imported.stl');assert.equal(choosePreview([mesh]),mesh);
  assert.equal(choosePreview([]),undefined);
});

test('published assembly wins over a newer analysis snapshot and failed object export', () => {
  const snapshot = file('structural/new-analysis/source.step');
  const failed = file('cylinder-objects/exports/failed-build/assembly.step');
  const failedFused = file('cylinder-objects/exports/failed-build/cylinder.step');
  const published = file('cylinder-objects/exports/successful-build/assembly.step');
  const publishedFused = file('cylinder-objects/exports/successful-build/cylinder.step');
  snapshot.modified = 50; failed.modified = failedFused.modified = 40;
  published.modified = publishedFused.modified = 20;
  assert.equal(choosePreview([snapshot, failed, failedFused, publishedFused, published], published.path), published);
});

test('analysis snapshots never become the default model, including after preferred lookup fails', () => {
  const snapshot = file('structural/new-analysis/source.step');
  const imported = file('imports/part.step');
  assert.equal(choosePreview([snapshot, imported]), imported);
  assert.equal(choosePreview([snapshot, imported], 'missing/assembly.step'), imported);
  assert.equal(choosePreview([snapshot]), undefined);
});

test('CAD inspection snapshots and material differences do not replace the editable default design', () => {
  const snapshot = file('studio/cad-inspections/run/source.step');
  const difference = file('studio/cad-inspections/run/excess_material.step');
  const design = file('imports/design.step');
  assert.equal(choosePreview([difference, snapshot, design]), design);
  assert.equal(choosePreview([difference, snapshot]), undefined);
});

test('projects without cylinder objects retain their previous default and same-export CAD fallback', () => {
  const assembly = file('assembly.scadpkg');
  const step = file('exports/new/design.step');
  const stl = file('exports/new/design.stl');
  assert.equal(choosePreview([assembly, stl, step], undefined), assembly);
  assert.equal(choosePreview([stl, step], undefined), step);
  const matchingName = file('imports/assembly.step');
  assert.equal(choosePreview([matchingName, assembly], 'different/assembly.step'), matchingName, 'match exact paths, not basenames');
});
