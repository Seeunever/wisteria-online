import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finalizeRuntimePolicy,
  RuntimePolicyError,
  type RuntimePolicyDraft,
} from '../lib/investigation/runtime-policy.ts';
import {
  ROTATING_BLIND_DRAW_KIND,
  type RotatingBlindDrawConfigV2,
} from '../lib/investigation/rotating-blind-draw.ts';
import {
  syntheticBundle,
  syntheticEvidence,
} from './runtime-policy-test-fixture.ts';

function config(): RotatingBlindDrawConfigV2 {
  return {
    cursor: {
      roleIds: ['role_aaaaaaaa'],
      requireFullRoleAssignment: true,
      carryAcrossStages: true,
      advanceAfter: 'successful_acquisition',
    },
    exhaustedLocationScope: 'room_lifetime',
    selection: {
      mode: 'collective_location_vote',
      ballotCompletion: 'all_active_assigned_members',
      resolution: 'plurality',
      tieBreak: 'current_cursor_choice',
      locationsToExhaust: 1,
    },
    candidateLocationIds: ['loc_aaaaaaaa'],
    locationClueIds: { loc_aaaaaaaa: ['clue_aaaaaaaa'] },
    draw: {
      mode: 'blind_choice_without_replacement',
      exhaust: 'selected_location_pool',
      perTurnAcquisitionLimit: 1,
      visibleBeforeAcquire: 'back_face_only',
    },
    publication: {
      privateHoldingLimit: 1,
      countScope: 'room_lifetime',
      mandatoryClueIds: [],
      blockedActions: ['location_ballot', 'blind_draw', 'completion_ballot'],
    },
    roleRestrictions: [],
    completion: {
      mode: 'member_consent',
      threshold: 1,
      requires: ['search_scope_exhausted', 'publication_obligations_cleared'],
    },
  };
}

function draft(
  bundle = syntheticBundle(),
  mechanismConfig: unknown = config(),
  version = 2,
): RuntimePolicyDraft {
  return {
    schemaVersion: 'wisteria-runtime-policy/1.0',
    versionId: bundle.script.versionId,
    canonicalPayloadHash: bundle.script.canonicalPayloadHash,
    capabilityMode: 'canonical_upper_bound',
    stageMechanisms: {
      stage_aaaaaaaa: {
        kind: ROTATING_BLIND_DRAW_KIND,
        version,
        config: mechanismConfig,
        evidence: [syntheticEvidence],
      },
    },
  };
}

function policyError(code: RuntimePolicyError['code'], action: () => unknown) {
  assert.throws(action, (error) => error instanceof RuntimePolicyError && error.code === code);
}

test('runtime-policy registry resolves the rotating blind draw config explicitly', () => {
  const bundle = syntheticBundle();
  const policy = finalizeRuntimePolicy(draft(bundle), bundle);
  assert.equal(policy.stageMechanisms.stage_aaaaaaaa.kind, ROTATING_BLIND_DRAW_KIND);
});

test('rotating registry rejects malformed, unsupported, and capability-widening configs', () => {
  const bundle = syntheticBundle();
  policyError('MALFORMED_RUNTIME_POLICY', () => finalizeRuntimePolicy(
    draft(bundle, { ...config(), kind: ROTATING_BLIND_DRAW_KIND }),
    bundle,
  ));
  policyError('UNSUPPORTED_RUNTIME_POLICY_VERSION', () => finalizeRuntimePolicy(
    draft(bundle, config(), 1),
    bundle,
  ));
  const hostDealt = syntheticBundle({ hostDealt: true });
  policyError('RUNTIME_POLICY_CAPABILITY_WIDENING', () => finalizeRuntimePolicy(
    draft(hostDealt),
    hostDealt,
  ));
  const fixedSequence = syntheticBundle();
  fixedSequence.locations.loc_aaaaaaaa.searchPolicy.mode = 'fixed_sequence';
  policyError('RUNTIME_POLICY_CAPABILITY_WIDENING', () => finalizeRuntimePolicy(
    draft(fixedSequence),
    fixedSequence,
  ));
  const nonPublishable = syntheticBundle({ publishable: false });
  policyError('RUNTIME_POLICY_CAPABILITY_WIDENING', () => finalizeRuntimePolicy(
    draft(nonPublishable),
    nonPublishable,
  ));
});
