import test from 'node:test';
import assert from 'node:assert/strict';
import type { CadInspectionJob, CadInspectionSummary } from '../shared/cad-inspections.js';
import { cadInspectionMatches, cadMassKg } from '../src/components/cad-inspection-state.js';

const summary = { material_valid: true, material_volume_mm3: 1_000_000 } as CadInspectionSummary;
test('CAD mass uses valid material union in mm3 and an explicit positive density', () => {
  assert.equal(cadMassKg(summary, 2700), 2.7);
  assert.equal(cadMassKg(summary, undefined), null);
  assert.equal(cadMassKg(summary, NaN), null);
  assert.equal(cadMassKg(summary, -2700), null);
  assert.equal(cadMassKg({ ...summary, material_valid: false }, 2700), null);
  assert.equal(cadMassKg({ ...summary, material_volume_mm3: null }, 2700), null);
});

test('history, density and source mutations cannot look like the current CAD inspection', () => {
  const job = { source: { path: 'design.step', sha256: 'abc' }, baseline: { path: 'design.step', revision: 'previous', sha256: 'def' }, density_kg_m3: 2700 } as CadInspectionJob;
  const source = { path: 'design.step' }, baseline = { path: 'design.step', revision: 'previous' };
  assert.equal(cadInspectionMatches(job, source, baseline, 2700, 'abc'), true);
  assert.equal(cadInspectionMatches(job, source, baseline, 2700, 'sha256:abc'), true);
  assert.equal(cadInspectionMatches(job, source, { path: 'design.step' }, 2700, 'abc'), false);
  assert.equal(cadInspectionMatches(job, source, baseline, 7850, 'abc'), false);
  assert.equal(cadInspectionMatches(job, source, baseline, 2700, 'changed'), false);
  assert.equal(cadInspectionMatches({ ...job, stale: true }, source, baseline, 2700, 'abc'), false);
});
