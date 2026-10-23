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
