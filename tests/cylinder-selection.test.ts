import test from 'node:test';
import assert from 'node:assert/strict';
import { cylinderObjectId, cylinderObjectName, cylinderMeshId, decodeStepLabel } from '../src/scene/cylinder-selection.js';

test('cylinder selection resolves by stable occurrence identity after rebuilding or reordering', () => {
  const before = [{ id: 'old-uuid', cylinderObjectId: 'ring.002' }];
  const after = [{ id: 'new-other', cylinderObjectId: 'skin' }, { id: 'new-uuid', cylinderObjectId: 'ring.002' }];
  assert.equal(cylinderMeshId(before, 'ring.002'), 'old-uuid');
  assert.equal(cylinderMeshId(after, 'ring.002'), 'new-uuid');
  assert.equal(cylinderMeshId(after, 'ring.005'), undefined);
  assert.equal(cylinderObjectId('SOLID'), undefined);
  assert.equal(cylinderObjectId('notes ring.002 | 环筋 02'), undefined);
  assert.equal(cylinderObjectId('ring.0022 | 环筋'), undefined);
});

test('STEP labels display Chinese names without leaking the stable identity into the UI', () => {
  const label = 'frame.bottom | 下端框';
  assert.equal(cylinderObjectId(label), 'frame.bottom');
  assert.equal(cylinderObjectName(Buffer.from(label).toString('latin1')), '下端框');
  assert.equal(cylinderObjectName('ring.005'), '环筋 05');
  assert.equal(decodeStepLabel('普通装配'), '普通装配');
  assert.equal(decodeStepLabel('Pièce'), 'Pièce', 'do not corrupt valid Latin-1 names');
});
