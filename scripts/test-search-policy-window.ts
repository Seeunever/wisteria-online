import assert from 'node:assert/strict';
import test from 'node:test';
import type { BlindBundle } from '../lib/blind-runtime.ts';
import { canonicalUsageWindowStageIds } from '../lib/search-policy-window.ts';

const stageIds = ['stage_aaaaaaaa', 'stage_bbbbbbbb', 'stage_cccccccc'];
const locationId = 'loc_aaaaaaaa';

function bundle(resetAtStageIds: string[] = []) {
  return {
    stages: Object.fromEntries(stageIds.map((stageId, index) => [stageId, {
      stageId,
      sequence: index + 1,
      locationIds: index === 2 ? [] : [locationId],
    }])),
    locations: {
      [locationId]: { searchPolicy: { resetAtStageIds } },
    },
  } as unknown as BlindBundle;
}

test('canonical usage is lifetime-scoped until a declared reset stage', () => {
  assert.deepEqual(
    canonicalUsageWindowStageIds(bundle(), stageIds[1], locationId),
    stageIds.slice(0, 2),
  );
  assert.deepEqual(
    canonicalUsageWindowStageIds(bundle([stageIds[1]]), stageIds[1], locationId),
    [stageIds[1]],
  );
});

test('future resets do not alter the current usage window', () => {
  assert.deepEqual(
    canonicalUsageWindowStageIds(bundle([stageIds[2]]), stageIds[1], locationId),
    stageIds.slice(0, 2),
  );
});

test('a location outside the active canonical stage has no usage window', () => {
  assert.deepEqual(
    canonicalUsageWindowStageIds(bundle(), stageIds[2], locationId),
    [],
  );
});
