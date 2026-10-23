import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCylinderEdits, canUseCylinderPublication, fieldKey, fieldText,
  setCylinderEdit, type CylinderObjectModel,
} from '../src/components/cylinder-objects-state';
const model: CylinderObjectModel = {
  schema_version: 1, units: 'mm', diameter_mm: 1000, height_mm: 500,
  components: [
    { id: 'skin', name: '蒙皮', kind: 'skin', thickness_mm: 2.5 },
    { id: 'frame.bottom', name: '下端框', kind: 'flange', end: 'bottom', thickness_mm: 12, width_mm: 50, hole_count: 18, hole_diameter_mm: 15, bolt_circle_mm: 970, phase_deg: 0 },
    { id: 'longitudinal.001', name: '纵筋 01', kind: 'longitudinal', width_mm: 8, height_mm: 12, angle_deg: 0 },
    { id: 'longitudinal.002', name: '纵筋 02', kind: 'longitudinal', width_mm: 8, height_mm: 12, angle_deg: 30 },
    { id: 'ring.001', name: '环筋 01', kind: 'ring', width_mm: 8, height_mm: 12, z_mm: 91.33333333333333 },
  ],
};
test('individual object edits preserve sibling dimensions, identity, and exact untouched coordinates', () => {
  const edited = applyCylinderEdits(model, { 'longitudinal.001:width_mm': '10', 'frame.bottom:hole_count': '20', '$global:diameter_mm': '1020' });
  assert.deepEqual(edited.issues, []);
  assert.equal(edited.model.components[2].width_mm, 10);
  assert.equal(edited.model.components[3].width_mm, 8);
  assert.equal(edited.model.components[1].hole_count, 20);
  assert.equal(edited.model.diameter_mm, 1020);
  assert.equal(model.components[2].width_mm, 8);
  assert.deepEqual(edited.model.components.map(c => c.id), model.components.map(c => c.id));
  assert.equal(edited.model.components[4].z_mm, model.components[4].z_mm);
  assert.equal(Number(fieldText(model.components[4].z_mm)), model.components[4].z_mm);
});
test('incomplete, nonfinite, fractional count and removed-object drafts cannot silently change model', () => {
  const result = applyCylinderEdits(model, { 'skin:thickness_mm': '', 'longitudinal.001:width_mm': 'Infinity', 'frame.bottom:hole_count': '18.2', 'ring.missing:z_mm': '20' });
  assert.equal(result.issues.length, 4);
  assert.deepEqual(result.model, model);
  assert.equal(applyCylinderEdits(model, { 'skin:thickness_mm': '-1' }).issues.length, 1);
});
test('numerically equivalent edits stay clean and stale or unsaved geometry cannot be simulated', () => {
  const key = fieldKey('skin', 'thickness_mm');
  assert.deepEqual(setCylinderEdit({}, key, '2.50', 2.5), {});
  assert.deepEqual(setCylinderEdit({ [key]: '3' }, key, '2.5', 2.5), {});
  assert.deepEqual(setCylinderEdit({}, key, '', 2.5), { [key]: '' });
  assert.equal(canUseCylinderPublication('revision-2', 'revision-2', false), true);
  assert.equal(canUseCylinderPublication(2, 1, false), false);
  assert.equal(canUseCylinderPublication('revision-2', 'revision-2', true), false);
  assert.equal(canUseCylinderPublication(undefined, undefined, false), false);
});
