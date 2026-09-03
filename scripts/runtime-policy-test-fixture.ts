import type { BlindBundle, EvidenceRegion } from '../lib/blind-runtime';
import type {
  CollectiveVoteRoundRobinFlowFields,
} from '../lib/investigation/config';
import {
  RUNTIME_POLICY_CAPABILITY_MODE,
  RUNTIME_POLICY_SCHEMA,
  type RuntimePolicyDraft,
} from '../lib/investigation/runtime-policy.ts';

export const SYNTHETIC_HASH = `sha256:${'a'.repeat(64)}`;

export const syntheticEvidence: EvidenceRegion = {
  sourceId: 'src_aaaaaaaa',
  pageId: 'page_aaaaaaaa',
  region: { unit: 'normalized', x: 0, y: 0, width: 1, height: 1 },
  side: 'single',
  readingOrder: 1,
};

export const syntheticCollectiveConfig: CollectiveVoteRoundRobinFlowFields = {
  locationSelection: {
    mode: 'vote',
    scope: 'stage_scoped',
    resolution: 'plurality_all_cast',
    tieBreak: 'seat_cursor_choice',
  },
  turnOrder: { mode: 'seat_order' },
  clueDeal: { mode: 'verified_pool_order', commit: 'one_per_turn' },
  acquisitionLimit: { scope: 'stage', perPlayer: 1 },
  publicationDuty: {
    predicate: 'round_scoped_private_holding_count',
    maxPrivateCount: 1,
    action: 'publish_one_held',
    blockedActions: ['vote_location', 'search'],
  },
  roleRestrictions: [{
    principalRoleId: 'role_aaaaaaaa',
    restrictedLocationIds: ['loc_aaaaaaaa'],
    restrictedClueIds: ['clue_aaaaaaaa'],
    mode: 'deny_unless_only_remaining_eligible',
  }],
  completion: { mode: 'consent_vote', exhaustive: 'per_player_quota' },
};

export function syntheticBundle(options?: {
  versionId?: string;
  canonicalPayloadHash?: string;
  hostDealt?: boolean;
  publishable?: boolean;
  embeddedFlow?: boolean;
  verifiedEvidence?: boolean;
}): BlindBundle {
  const versionId = options?.versionId ?? 'ver_aaaaaaaa';
  const canonicalPayloadHash = options?.canonicalPayloadHash ?? SYNTHETIC_HASH;
  return {
    schemaVersion: 'blind-script/1.0',
    script: {
      versionId,
      canonicalPayloadHash,
      titleContentId: 'cnt_aaaaaaaa',
    },
    sources: {
      src_aaaaaaaa: {
        sourceId: 'src_aaaaaaaa',
        mediaType: 'image/png',
        sha256: `sha256:${'b'.repeat(64)}`,
        byteLength: 2,
        sourceClass: { kind: 'player_rules', subjectId: null },
        classification: {
          status: options?.verifiedEvidence === false ? 'proposed' : 'verified',
          method: options?.verifiedEvidence === false ? 'layout' : 'review',
          confidence: 1,
        },
        pages: [{
          pageId: 'page_aaaaaaaa',
          index: 0,
          width: 1,
          height: 1,
          rotation: 0,
          sha256: `sha256:${'c'.repeat(64)}`,
        }],
      },
    },
    assets: {},
    contentBlocks: {},
    stages: {
      stage_aaaaaaaa: {
        stageId: 'stage_aaaaaaaa',
        sequence: 1,
        labelContentId: 'cnt_aaaaaaaa',
        enterWhen: { op: 'always' },
        completeWhen: { op: 'always' },
        allowedActions: ['search', 'publish_clue'],
        locationIds: ['loc_aaaaaaaa'],
        ...(options?.embeddedFlow
          ? { investigationFlow: { ...syntheticCollectiveConfig } }
          : {}),
      },
    },
    locations: {
      loc_aaaaaaaa: {
        locationId: 'loc_aaaaaaaa',
        nameContentId: 'cnt_aaaaaaaa',
        availableWhen: { op: 'always' },
        searchPolicy: {
          mode: options?.hostDealt ? 'host_dealt' : 'draw_without_replacement',
          perPlayerLimit: 1,
          globalLimit: 2,
          resetAtStageIds: [],
        },
        cluePool: [{
          clueId: 'clue_aaaaaaaa',
          order: 1,
          copies: 1,
          availableWhen: { op: 'always' },
        }],
      },
    },
    clues: {
      clue_aaaaaaaa: {
        clueId: 'clue_aaaaaaaa',
        kind: 'synthetic',
        faces: [{
          faceId: 'face_aaaaaaaa',
          side: 'back',
          assetIds: [],
          contentIds: [],
          revealWhen: { op: 'always' },
        }],
        acquisition: { when: { op: 'always' }, initialAudience: 'holder' },
        publication: {
          allowed: options?.publishable !== false,
          publishWhen: { op: 'clue_held', clueId: 'clue_aaaaaaaa' },
          revealedFaceIds: [],
        },
      },
    },
    hostPack: { releasePlan: [] },
    roles: {
      role_aaaaaaaa: {
        roleId: 'role_aaaaaaaa',
        slot: 1,
        displayNameContentId: 'cnt_aaaaaaaa',
        sections: [],
      },
    },
  };
}

export function syntheticPolicyDraft(
  bundle: BlindBundle,
  kind: 'canonical_search_policy' | 'collective_vote_round_robin' = 'canonical_search_policy',
): RuntimePolicyDraft {
  return {
    schemaVersion: RUNTIME_POLICY_SCHEMA,
    versionId: bundle.script.versionId,
    canonicalPayloadHash: bundle.script.canonicalPayloadHash,
    capabilityMode: RUNTIME_POLICY_CAPABILITY_MODE,
    stageMechanisms: {
      stage_aaaaaaaa: kind === 'canonical_search_policy'
        ? {
          kind,
          version: 1,
          evidence: [syntheticEvidence],
        }
        : {
          kind,
          version: 1,
          config: syntheticCollectiveConfig,
          evidence: [syntheticEvidence],
        },
    },
  };
}
