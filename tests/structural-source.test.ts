import test from 'node:test';
import assert from 'node:assert/strict';
import type { Artifact } from '../shared/types';
import { chooseStructuralSource } from '../src/scene/structural-source';

const file = (path: string): Artifact => ({ path, name: path.split('/').pop()!, kind: 'model', size: 1, modified: 1 });

test('first structural source uses the successful published solver STEP rather than snapshots or failed assemblies', () => {
  const files = [
    file('structural/latest/source.step'),
    file('cylinder-objects/exports/failed/assembly.step'),
    file('cylinder-objects/exports/failed/cylinder.step'),
    file('cylinder-objects/exports/published/assembly.step'),
    file('cylinder-objects/exports/published/cylinder.step'),
  ];
  const published = files[4].path;
  assert.equal(chooseStructuralSource(files, '', published), published);
  assert.equal(chooseStructuralSource(files, files[1].path, published), published, 'a late published default corrects an automatic fallback');
});

test('late publication defaults preserve manual and requested source selections', () => {
  const manual = file('imports/review.step'), published = file('cylinder-objects/exports/published/cylinder.step');
  assert.equal(chooseStructuralSource([manual, published], manual.path, published.path, true), manual.path);
  assert.equal(chooseStructuralSource([manual, published], published.path, manual.path, true), published.path);
});

test('ordinary projects retain their STEP fallback when no valid publication exists', () => {
  const snapshot = file('structural/run/source.step'), model = file('imports/model.step');
  assert.equal(chooseStructuralSource([snapshot, model], ''), model.path);
  assert.equal(chooseStructuralSource([snapshot, model], '', 'missing.step'), model.path);
  assert.equal(chooseStructuralSource([], ''), '');
});

test('CAD inspection outputs cannot become automatic structural inputs', () => {
  const inspection = file('studio/cad-inspections/run/excess_material.step'), model = file('imports/model.step');
  assert.equal(chooseStructuralSource([inspection, model], ''), model.path);
  assert.equal(chooseStructuralSource([inspection], ''), '');
});
