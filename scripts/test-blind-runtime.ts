import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyFallbackRestriction,
  canProjectImageContent,
  canReadContent,
  deriveInvestigationCandidates,
  evaluateCondition,
  evaluateStageFlowCondition,
  evaluateViewerCondition,
  projectAssignedRole,
  projectAvailableLocations,
  projectLobby,
  projectPlayerGuide,
  projectReleasedResolution,
  projectVisibleClues,
  withEligibleHostReleases,
  type AuthorizationContext,
  type BlindBundle,
  type ContentBlock,
} from '../lib/blind-runtime.ts';
import {
  InvestigationConfigError,
  normalizeSearchMechanism,
  validateStageSearchMechanisms,
} from '../lib/investigation/config.ts';

const PUBLIC_CANARY = 'PUBLIC_CANARY';
const LOBBY_PROFILE_CANARY = 'LOBBY_PROFILE_CANARY';
const ROLE_A_CANARY = 'ROLE_A_CANARY_NEVER_CROSS';
const ROLE_B_CANARY = 'ROLE_B_CANARY_NEVER_CROSS';
const HOST_CANARY = 'HOST_CANARY_NEVER_EXPORT';
const CLUE_CANARY = 'CLUE_HOLDER_CANARY';
const PLAYER_GUIDE_CANARY = 'PLAYER_GUIDE_CANARY';

function context(overrides: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    joined: true,
    assignedRoleId: null,
    assignedRoleIds: new Set(),
    activeStageId: null,
    reachedStageIds: new Set(),
    heldClueIds: new Set(),
    roomHeldClueIds: new Set(),
    publishedClueIds: new Set(),
    hostReleaseIds: new Set(),
    sessionCompleted: false,
    investigationCompletedStageIds: new Set(),
    ...overrides,
  };
}

function block(
  contentId: string,
  text: string,
  level: ContentBlock['classification']['level'],
  principal: 'room_member' | 'role_assignee' | 'system_only',
  subjectId: string | null,
  compartments: string[] = [],
): ContentBlock {
  return {
    contentId,
    kind: 'text',
    payload: { text },
    assetIds: [],
    classification: { level, compartments },
    visibility: {
      default: 'deny',
      grants: [{ principal: { kind: principal, subjectId }, when: { op: 'always' } }],
    },
    trace: { evidence: [], ocrExtractionId: null, reviewStatus: 'verified' },
  };
}

const bundle: BlindBundle = {
  schemaVersion: 'blind-script/1.0',
  script: {
    versionId: 'ver_aaaaaaaa',
    canonicalPayloadHash: `sha256:${'a'.repeat(64)}`,
    titleContentId: 'cnt_aaaaaaaa',
  },
  sources: {},
  assets: {},
  contentBlocks: {
    cnt_aaaaaaaa: block('cnt_aaaaaaaa', PUBLIC_CANARY, 'L1', 'room_member', null),
    cnt_ffffffff: block('cnt_ffffffff', LOBBY_PROFILE_CANARY, 'L1', 'room_member', null),
    cnt_bbbbbbbb: block(
      'cnt_bbbbbbbb', ROLE_A_CANARY, 'L2', 'role_assignee', 'role_aaaaaaaa',
      ['role:role_aaaaaaaa', 'stage:stage_aaaaaaaa'],
    ),
    cnt_cccccccc: block(
      'cnt_cccccccc', ROLE_B_CANARY, 'L2', 'role_assignee', 'role_bbbbbbbb',
      ['role:role_bbbbbbbb', 'stage:stage_aaaaaaaa'],
    ),
    cnt_dddddddd: block('cnt_dddddddd', HOST_CANARY, 'L3', 'system_only', null),
    cnt_eeeeeeee: {
      contentId: 'cnt_eeeeeeee', kind: 'text', payload: { text: CLUE_CANARY },
      assetIds: [],
      classification: { level: 'L2', compartments: ['clue:clue_aaaaaaaa'] },
      visibility: {
        default: 'deny',
        grants: [{
          principal: { kind: 'clue_holder', subjectId: 'clue_aaaaaaaa' },
          when: { op: 'clue_held', clueId: 'clue_aaaaaaaa' },
        }],
      },
      trace: { evidence: [], ocrExtractionId: null, reviewStatus: 'verified' },
    },
  },
  stages: {
    stage_aaaaaaaa: {
      stageId: 'stage_aaaaaaaa', sequence: 1, labelContentId: 'cnt_aaaaaaaa',
      enterWhen: { op: 'always' }, completeWhen: { op: 'always' },
      allowedActions: ['read_role_section'], locationIds: [],
    },
  },
  locations: {
    loc_aaaaaaaa: {
      locationId: 'loc_aaaaaaaa', nameContentId: 'cnt_aaaaaaaa',
      availableWhen: { op: 'stage_active', stageId: 'stage_aaaaaaaa' },
      searchPolicy: {
        mode: 'draw_without_replacement', perPlayerLimit: 1, globalLimit: 2,
        resetAtStageIds: [],
      },
      cluePool: [{
        clueId: 'clue_aaaaaaaa', order: 1, copies: 1, availableWhen: { op: 'always' },
      }],
    },
  },
  clues: {
    clue_aaaaaaaa: {
      clueId: 'clue_aaaaaaaa', kind: 'card',
      faces: [{
        faceId: 'face_aaaaaaaa', side: 'single', assetIds: [],
        contentIds: ['cnt_eeeeeeee'],
        revealWhen: { op: 'clue_held', clueId: 'clue_aaaaaaaa' },
      }],
      acquisition: { when: { op: 'always' }, initialAudience: 'holder' },
      publication: {
        allowed: false,
        publishWhen: { op: 'clue_held', clueId: 'clue_aaaaaaaa' },
        revealedFaceIds: [],
      },
    },
  },
  hostPack: { releasePlan: [] },
  roles: {
    role_aaaaaaaa: {
      roleId: 'role_aaaaaaaa', slot: 1, displayNameContentId: 'cnt_aaaaaaaa',
      sections: [{
        sectionId: 'section_cccccccc', kind: 'lobby_profile', stageId: 'stage_aaaaaaaa', order: 1,
        contentIds: ['cnt_ffffffff', 'cnt_bbbbbbbb'],
        unlockWhen: { op: 'always' },
      }, {
        sectionId: 'section_aaaaaaaa', kind: 'background', stageId: 'stage_aaaaaaaa', order: 2,
        contentIds: ['cnt_bbbbbbbb', 'cnt_dddddddd'],
        unlockWhen: { op: 'stage_reached', stageId: 'stage_aaaaaaaa' },
      }],
    },
    role_bbbbbbbb: {
      roleId: 'role_bbbbbbbb', slot: 2, displayNameContentId: 'cnt_aaaaaaaa',
      sections: [{
        sectionId: 'section_bbbbbbbb', kind: 'background', stageId: 'stage_aaaaaaaa', order: 1,
        contentIds: ['cnt_cccccccc'],
        unlockWhen: { op: 'stage_reached', stageId: 'stage_aaaaaaaa' },
      }],
    },
  },
};

const legacyCollectiveFlow = {
  locationSelection: {
    mode: 'vote',
    scope: 'room_scoped',
    resolution: 'plurality_all_cast',
    tieBreak: 'seat_cursor_choice',
  },
  turnOrder: { mode: 'seat_order' },
  clueDeal: { mode: 'verified_pool_order', commit: 'one_per_turn' },
  acquisitionLimit: { scope: 'stage', perPlayer: 2 },
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

function expectInvestigationConfigError(
  value: unknown,
  code: InvestigationConfigError['code'],
) {
  assert.throws(
    () => normalizeSearchMechanism(value),
    (error) => error instanceof InvestigationConfigError && error.code === code,
  );
}

test('search mechanism normalization supports direct, legacy, and tagged v1 without mutation', () => {
  assert.deepEqual(normalizeSearchMechanism(undefined), { kind: 'direct_pick', version: 1 });

  const legacySnapshot = structuredClone(legacyCollectiveFlow);
  const legacy = normalizeSearchMechanism(legacyCollectiveFlow);
  const taggedSource = {
    kind: 'collective_vote_round_robin',
    version: 1,
    ...legacyCollectiveFlow,
  };
  const taggedSnapshot = structuredClone(taggedSource);
  const tagged = normalizeSearchMechanism(taggedSource);

  assert.deepEqual(legacy, tagged);
  assert.equal(legacy.kind, 'collective_vote_round_robin');
  assert.equal(legacy.version, 1);
  assert.deepEqual(legacyCollectiveFlow, legacySnapshot);
  assert.deepEqual(taggedSource, taggedSnapshot);
  assert.notEqual(legacy.locationSelection, legacyCollectiveFlow.locationSelection);
  assert.notEqual(legacy.publicationDuty.blockedActions, legacyCollectiveFlow.publicationDuty.blockedActions);
  assert.notEqual(legacy.roleRestrictions, legacyCollectiveFlow.roleRestrictions);
  assert.notEqual(legacy.roleRestrictions?.[0], legacyCollectiveFlow.roleRestrictions[0]);
});

test('search mechanism normalization rejects unknown tags and malformed flows', () => {
  expectInvestigationConfigError(
    { ...legacyCollectiveFlow, kind: 'future_mechanism', version: 1 },
    'UNSUPPORTED_INVESTIGATION_KIND',
  );
  expectInvestigationConfigError(
    { ...legacyCollectiveFlow, kind: 'collective_vote_round_robin', version: 2 },
    'UNSUPPORTED_INVESTIGATION_VERSION',
  );
  expectInvestigationConfigError(
    { ...legacyCollectiveFlow, kind: 'collective_vote_round_robin' },
    'MALFORMED_INVESTIGATION_FLOW',
  );
  expectInvestigationConfigError(
    { ...legacyCollectiveFlow, unexpected: true },
    'MALFORMED_INVESTIGATION_FLOW',
  );
  expectInvestigationConfigError(
    { ...legacyCollectiveFlow, acquisitionLimit: { scope: 'stage', perPlayer: 0 } },
    'MALFORMED_INVESTIGATION_FLOW',
  );
  expectInvestigationConfigError(
    {
      ...legacyCollectiveFlow,
      publicationDuty: {
        ...legacyCollectiveFlow.publicationDuty,
        blockedActions: ['search', 'search'],
      },
    },
    'MALFORMED_INVESTIGATION_FLOW',
  );
  expectInvestigationConfigError(null, 'MALFORMED_INVESTIGATION_FLOW');
});

test('stage mechanism validation accepts old stages and fails closed on unsupported flows', () => {
  assert.doesNotThrow(() => validateStageSearchMechanisms({
    stage_direct: { stageId: 'stage_direct' },
    stage_legacy: { stageId: 'stage_legacy', investigationFlow: legacyCollectiveFlow },
    stage_tagged: {
      stageId: 'stage_tagged',
      investigationFlow: {
        kind: 'collective_vote_round_robin',
        version: 1,
        ...legacyCollectiveFlow,
      },
    },
  }));
  assert.throws(() => validateStageSearchMechanisms({
    stage_unknown: {
      investigationFlow: { ...legacyCollectiveFlow, kind: 'unknown', version: 1 },
    },
  }), InvestigationConfigError);
  assert.throws(() => validateStageSearchMechanisms({
    stage_malformed: {
      investigationFlow: { ...legacyCollectiveFlow, turnOrder: { mode: 'random' } },
    },
  }), InvestigationConfigError);
});

test('condition evaluation fails closed and respects current state', () => {
  const current = context({ reachedStageIds: new Set(['stage_aaaaaaaa']) });
  assert.equal(evaluateCondition({ op: 'stage_reached', stageId: 'stage_aaaaaaaa' }, current), true);
  assert.equal(evaluateCondition({ op: 'clue_held', clueId: 'clue_aaaaaaaa' }, current), false);
  assert.equal(evaluateCondition({ op: 'role_assigned', roleId: 'role_aaaaaaaa' }, current), false);
  assert.equal(evaluateCondition(
    { op: 'role_assigned', roleId: 'role_aaaaaaaa' },
    { ...current, assignedRoleIds: new Set(['role_aaaaaaaa']) },
  ), true);
  assert.equal(evaluateCondition({ op: 'all', args: [] }, current), false);
  assert.equal(evaluateCondition({ op: 'unknown' } as never, current), false);
  assert.equal(evaluateCondition({ op: 'not', arg: { op: 'unknown' } } as never, current), false);
  assert.equal(evaluateCondition({
    op: 'any',
    args: [{ op: 'always' }, { op: 'unknown' }],
  } as never, current), false);
});

test('room acquisition and collective investigation completion use room-scoped state', () => {
  const viewerOnlyHolding = context({
    heldClueIds: new Set(['clue_aaaaaaaa']),
  });
  assert.equal(
    evaluateCondition({ op: 'clue_acquired_in_room', clueId: 'clue_aaaaaaaa' }, viewerOnlyHolding),
    false,
  );

  const acquiredInRoom = context({
    roomHeldClueIds: new Set(['clue_aaaaaaaa']),
  });
  assert.equal(
    evaluateCondition({ op: 'clue_acquired_in_room', clueId: 'clue_aaaaaaaa' }, acquiredInRoom),
    true,
  );

  const completed = context({
    investigationCompletedStageIds: new Set(['stage_aaaaaaaa']),
  });
  assert.equal(
    evaluateCondition({ op: 'investigation_complete', stageId: 'stage_aaaaaaaa' }, completed),
    true,
  );
  assert.equal(
    evaluateCondition({ op: 'completion_vote_satisfied', stageId: 'stage_aaaaaaaa' }, completed),
    true,
  );
  assert.equal(
    evaluateCondition({ op: 'investigation_complete', stageId: 'stage_bbbbbbbb' }, completed),
    false,
  );
});

test('fallback role restrictions prefer eligible unrestricted choices and fail open only as fallback', () => {
  const candidates = ['loc_aaaaaaaa', 'loc_bbbbbbbb', 'loc_cccccccc'];
  const restriction = {
    restrictedLocationIds: ['loc_aaaaaaaa', 'loc_cccccccc'],
    restrictedClueIds: ['clue_aaaaaaaa'],
  };

  assert.deepEqual(
    applyFallbackRestriction(candidates, restriction, 'location'),
    ['loc_bbbbbbbb'],
  );
  assert.deepEqual(
    applyFallbackRestriction(['loc_aaaaaaaa', 'loc_cccccccc'], restriction, 'location'),
    ['loc_aaaaaaaa', 'loc_cccccccc'],
  );
  assert.deepEqual(
    applyFallbackRestriction(['clue_aaaaaaaa', 'clue_bbbbbbbb'], restriction, 'clue'),
    ['clue_bbbbbbbb'],
  );
  assert.deepEqual(applyFallbackRestriction(candidates, undefined, 'location'), candidates);
  assert.deepEqual(candidates, ['loc_aaaaaaaa', 'loc_bbbbbbbb', 'loc_cccccccc']);
});

test('viewer-scoped role gates do not inherit another member role', () => {
  const roomContext = context({
    assignedRoleId: 'role_aaaaaaaa',
    assignedRoleIds: new Set(['role_aaaaaaaa', 'role_bbbbbbbb']),
  });
  assert.equal(
    evaluateCondition({ op: 'role_assigned', roleId: 'role_bbbbbbbb' }, roomContext),
    true,
  );
  assert.equal(
    evaluateViewerCondition({ op: 'role_assigned', roleId: 'role_bbbbbbbb' }, roomContext),
    false,
  );
  assert.equal(
    evaluateViewerCondition({ op: 'role_assigned', roleId: 'role_aaaaaaaa' }, roomContext),
    true,
  );

  const restrictedBundle: BlindBundle = {
    ...bundle,
    stages: {
      ...bundle.stages,
      stage_aaaaaaaa: {
        ...bundle.stages.stage_aaaaaaaa,
        allowedActions: ['read_role_section', 'search'],
        locationIds: ['loc_aaaaaaaa'],
      },
    },
    locations: {
      ...bundle.locations,
      loc_aaaaaaaa: {
        ...bundle.locations.loc_aaaaaaaa,
        availableWhen: {
          op: 'not',
          arg: { op: 'role_assigned', roleId: 'role_aaaaaaaa' },
        },
      },
    },
  };
  const activeContext = {
    ...roomContext,
    activeStageId: 'stage_aaaaaaaa',
    reachedStageIds: new Set(['stage_aaaaaaaa']),
  };
  assert.deepEqual(projectAvailableLocations(restrictedBundle, activeContext), []);
  assert.equal(projectAvailableLocations(restrictedBundle, {
    ...activeContext,
    assignedRoleId: 'role_bbbbbbbb',
  }).length, 1);
});

test('investigation candidates union assigned viewer contexts and exclude empty locations', () => {
  const markerClue = {
    ...bundle.clues.clue_aaaaaaaa,
    clueId: 'clue_dddddddd',
    faces: [],
  };
  const viewerBundle: BlindBundle = {
    ...bundle,
    stages: {
      stage_aaaaaaaa: {
        ...bundle.stages.stage_aaaaaaaa,
        allowedActions: ['search'],
        locationIds: ['loc_aaaaaaaa', 'loc_bbbbbbbb', 'loc_cccccccc'],
        investigationFlow: {
          locationSelection: {
            mode: 'vote', scope: 'room_scoped', resolution: 'plurality_all_cast',
            tieBreak: 'seat_cursor_choice',
          },
          turnOrder: { mode: 'seat_order' },
          clueDeal: { mode: 'verified_pool_order', commit: 'one_per_turn' },
          acquisitionLimit: { scope: 'stage', perPlayer: 1 },
          publicationDuty: {
            predicate: 'round_scoped_private_holding_count', maxPrivateCount: 1,
            action: 'publish_one_held', blockedActions: ['vote_location', 'search'],
          },
        },
      },
    },
    locations: {
      loc_aaaaaaaa: {
        ...bundle.locations.loc_aaaaaaaa,
        availableWhen: { op: 'role_assigned', roleId: 'role_bbbbbbbb' },
      },
      loc_bbbbbbbb: {
        ...bundle.locations.loc_aaaaaaaa,
        locationId: 'loc_bbbbbbbb',
        cluePool: [{
          clueId: 'clue_bbbbbbbb', order: 1, copies: 1,
          availableWhen: { op: 'clue_held', clueId: 'clue_dddddddd' },
        }],
      },
      loc_cccccccc: {
        ...bundle.locations.loc_aaaaaaaa,
        locationId: 'loc_cccccccc',
        cluePool: [{
          clueId: 'clue_cccccccc', order: 1, copies: 1, availableWhen: { op: 'always' },
        }],
      },
    },
    clues: {
      ...bundle.clues,
      clue_bbbbbbbb: { ...markerClue, clueId: 'clue_bbbbbbbb' },
      clue_cccccccc: { ...markerClue, clueId: 'clue_cccccccc' },
      clue_dddddddd: markerClue,
    },
  };
  const authorization = context({
    assignedRoleId: 'role_aaaaaaaa',
    assignedRoleIds: new Set(['role_aaaaaaaa', 'role_bbbbbbbb']),
    activeStageId: 'stage_aaaaaaaa',
    reachedStageIds: new Set(['stage_aaaaaaaa']),
    roomHeldClueIds: new Set(['clue_cccccccc', 'clue_dddddddd']),
  });
  const candidates = deriveInvestigationCandidates(
    viewerBundle,
    'stage_aaaaaaaa',
    authorization,
    [
      { assignedRoleId: 'role_aaaaaaaa', heldClueIds: new Set() },
      { assignedRoleId: 'role_bbbbbbbb', heldClueIds: new Set(['clue_dddddddd']) },
    ],
    new Set(),
  );

  assert.deepEqual(candidates.roomLocationIds, ['loc_aaaaaaaa', 'loc_bbbbbbbb']);
  assert.deepEqual(candidates.actorLocationIds, []);
  assert.deepEqual(candidates.roomClueIdsByLocation.loc_aaaaaaaa, ['clue_aaaaaaaa']);
  assert.deepEqual(candidates.roomClueIdsByLocation.loc_bbbbbbbb, ['clue_bbbbbbbb']);
  assert.equal(candidates.roomClueIdsByLocation.loc_cccccccc, undefined);
});

test('investigation candidates filter held clues before fallback and fixed sequence', () => {
  const extraClue = {
    ...bundle.clues.clue_aaaaaaaa,
    clueId: 'clue_bbbbbbbb',
    faces: [],
  };
  const restrictedBundle: BlindBundle = {
    ...bundle,
    stages: {
      stage_aaaaaaaa: {
        ...bundle.stages.stage_aaaaaaaa,
        allowedActions: ['search'],
        locationIds: ['loc_aaaaaaaa', 'loc_bbbbbbbb'],
        investigationFlow: {
          locationSelection: {
            mode: 'vote', scope: 'room_scoped', resolution: 'plurality_all_cast',
            tieBreak: 'seat_cursor_choice',
          },
          turnOrder: { mode: 'seat_order' },
          clueDeal: { mode: 'verified_pool_order', commit: 'one_per_turn' },
          acquisitionLimit: { scope: 'stage', perPlayer: 1 },
          publicationDuty: {
            predicate: 'round_scoped_private_holding_count', maxPrivateCount: 1,
            action: 'publish_one_held', blockedActions: ['vote_location', 'search'],
          },
          roleRestrictions: [{
            principalRoleId: 'role_aaaaaaaa',
            restrictedLocationIds: ['loc_aaaaaaaa'],
            restrictedClueIds: ['clue_aaaaaaaa'],
            mode: 'deny_unless_only_remaining_eligible',
          }],
        },
      },
    },
    locations: {
      loc_aaaaaaaa: {
        ...bundle.locations.loc_aaaaaaaa,
        searchPolicy: { ...bundle.locations.loc_aaaaaaaa.searchPolicy, mode: 'fixed_sequence' },
        cluePool: [
          { clueId: 'clue_aaaaaaaa', order: 1, copies: 1, availableWhen: { op: 'always' } },
          { clueId: 'clue_bbbbbbbb', order: 2, copies: 1, availableWhen: { op: 'always' } },
        ],
      },
      loc_bbbbbbbb: {
        ...bundle.locations.loc_aaaaaaaa,
        locationId: 'loc_bbbbbbbb',
        cluePool: [{
          clueId: 'clue_cccccccc', order: 1, copies: 1, availableWhen: { op: 'always' },
        }],
      },
    },
    clues: {
      ...bundle.clues,
      clue_bbbbbbbb: extraClue,
      clue_cccccccc: { ...extraClue, clueId: 'clue_cccccccc' },
    },
  };
  const authorization = context({
    assignedRoleId: 'role_aaaaaaaa',
    assignedRoleIds: new Set(['role_aaaaaaaa']),
    activeStageId: 'stage_aaaaaaaa',
    reachedStageIds: new Set(['stage_aaaaaaaa']),
  });
  const initial = deriveInvestigationCandidates(
    restrictedBundle,
    'stage_aaaaaaaa',
    authorization,
    [{ assignedRoleId: 'role_aaaaaaaa', heldClueIds: new Set() }],
    new Set(),
  );
  assert.deepEqual(initial.roomLocationIds, ['loc_bbbbbbbb']);
  assert.deepEqual(initial.actorLocationIds, ['loc_bbbbbbbb']);
  assert.deepEqual(initial.roomClueIdsByLocation.loc_aaaaaaaa, [
    'clue_aaaaaaaa', 'clue_bbbbbbbb',
  ]);
  assert.deepEqual(initial.actorClueIdsByLocation.loc_aaaaaaaa, ['clue_bbbbbbbb']);
  assert.deepEqual(
    projectAvailableLocations(restrictedBundle, authorization, {
      clueIdsByLocation: initial.actorClueIdsByLocation,
    }).find((location) => location.locationId === 'loc_aaaaaaaa')?.clueChoices,
    [{ clueId: 'clue_bbbbbbbb', number: 2 }],
  );

  const heldContext = {
    ...authorization,
    roomHeldClueIds: new Set(['clue_bbbbbbbb', 'clue_cccccccc']),
  };
  const fallback = deriveInvestigationCandidates(
    restrictedBundle,
    'stage_aaaaaaaa',
    heldContext,
    [{ assignedRoleId: 'role_aaaaaaaa', heldClueIds: new Set() }],
    new Set(),
  );
  assert.deepEqual(fallback.roomLocationIds, ['loc_aaaaaaaa']);
  assert.deepEqual(fallback.actorLocationIds, ['loc_aaaaaaaa']);
  assert.deepEqual(fallback.roomClueIdsByLocation.loc_aaaaaaaa, ['clue_aaaaaaaa']);
  assert.deepEqual(fallback.actorClueIdsByLocation.loc_aaaaaaaa, ['clue_aaaaaaaa']);
});

test('unjoined and unassigned viewers receive no role content', () => {
  assert.equal(projectLobby(bundle, context({ joined: false })), null);
  const lobby = projectLobby(bundle, context());
  assert.equal(lobby?.title, PUBLIC_CANARY);
  assert.equal(JSON.stringify(lobby).includes(LOBBY_PROFILE_CANARY), true);
  assert.equal(JSON.stringify(lobby).includes(ROLE_A_CANARY), false);
  assert.equal(JSON.stringify(lobby).includes(ROLE_B_CANARY), false);
  assert.equal(JSON.stringify(lobby).includes(HOST_CANARY), false);
});

test('verified player rules are visible to joined members without widening other content', () => {
  const guideBundle: BlindBundle = {
    ...bundle,
    sources: {
      src_aaaaaaaa: {
        sourceId: 'src_aaaaaaaa',
        mediaType: 'application/pdf',
        sha256: 'sha256:synthetic',
        byteLength: 1,
        sourceClass: { kind: 'player_rules', subjectId: null },
        classification: { status: 'verified', method: 'review', confidence: 1 },
        pages: [{
          pageId: 'page_aaaaaaaa', index: 0, width: 1, height: 1, rotation: 0,
          sha256: `sha256:${'a'.repeat(64)}`,
        }],
      },
    },
    contentBlocks: {
      ...bundle.contentBlocks,
      cnt_99999999: {
        contentId: 'cnt_99999999',
        kind: 'text',
        payload: { text: PLAYER_GUIDE_CANARY },
        assetIds: [],
        classification: {
          level: 'L1', compartments: [], taintSourceIds: ['src_aaaaaaaa'],
        },
        visibility: {
          default: 'deny',
          grants: [{
            principal: { kind: 'room_member', subjectId: null },
            when: { op: 'always' },
          }],
        },
        trace: {
          evidence: [{
            sourceId: 'src_aaaaaaaa',
            pageId: 'page_aaaaaaaa',
            region: { unit: 'normalized', x: 0, y: 0, width: 1, height: 1 },
            side: 'single',
            readingOrder: 1,
          }],
          ocrExtractionId: null,
          reviewStatus: 'verified',
        },
      },
    },
  };
  assert.equal(JSON.stringify(projectPlayerGuide(guideBundle, context())).includes(PLAYER_GUIDE_CANARY), true);
  assert.deepEqual(projectPlayerGuide(guideBundle, context({ joined: false })), []);
  assert.deepEqual(projectPlayerGuide({
    ...guideBundle,
    sources: {
      src_aaaaaaaa: {
        ...guideBundle.sources.src_aaaaaaaa,
        classification: { status: 'proposed', method: 'ocr', confidence: 1 },
      },
    },
  }, context()), []);
});

test('each assignee receives only that role and never host material', () => {
  const common = {
    reachedStageIds: new Set(['stage_aaaaaaaa']),
    assignedRoleIds: new Set(['role_aaaaaaaa', 'role_bbbbbbbb']),
  };
  const roleA = projectAssignedRole(bundle, context({ ...common, assignedRoleId: 'role_aaaaaaaa' }));
  const roleB = projectAssignedRole(bundle, context({ ...common, assignedRoleId: 'role_bbbbbbbb' }));
  const roleAJson = JSON.stringify(roleA);
  const roleBJson = JSON.stringify(roleB);
  assert.equal(roleAJson.includes(ROLE_A_CANARY), true);
  assert.equal(roleAJson.includes(ROLE_B_CANARY), false);
  assert.equal(roleAJson.includes(HOST_CANARY), false);
  assert.equal(roleBJson.includes(ROLE_B_CANARY), true);
  assert.equal(roleBJson.includes(ROLE_A_CANARY), false);
  assert.equal(roleBJson.includes(HOST_CANARY), false);
});

test('an incomplete room assignment never widens role access', () => {
  const partial = context({
    assignedRoleId: 'role_aaaaaaaa',
    assignedRoleIds: new Set(['role_aaaaaaaa']),
    activeStageId: 'stage_aaaaaaaa',
    reachedStageIds: new Set(['stage_aaaaaaaa']),
  });
  const assignedJson = JSON.stringify(projectAssignedRole(bundle, partial));
  assert.equal(assignedJson.includes(ROLE_A_CANARY), true);
  assert.equal(assignedJson.includes(ROLE_B_CANARY), false);
  assert.equal(assignedJson.includes(HOST_CANARY), false);
  assert.equal(evaluateStageFlowCondition(
    { op: 'role_assigned', roleId: 'role_bbbbbbbb' },
    partial,
    new Set(['role_aaaaaaaa', 'role_bbbbbbbb']),
  ), true);
  const roleGatedReleaseBundle: BlindBundle = {
    ...bundle,
    hostPack: {
      releasePlan: [{
        releaseId: 'release_bbbbbbbb',
        contentIds: ['cnt_dddddddd'],
        when: { op: 'role_assigned', roleId: 'role_bbbbbbbb' },
      }],
    },
  };
  assert.equal(
    withEligibleHostReleases(roleGatedReleaseBundle, partial).hostReleaseIds.size,
    0,
  );

  const unassigned = { ...partial, assignedRoleId: null };
  assert.equal(projectAssignedRole(bundle, unassigned), null);
  assert.deepEqual(projectAvailableLocations(bundle, unassigned), []);
  assert.deepEqual(projectVisibleClues(bundle, unassigned), []);
});

test('L3 content is denied even when presented with a system-only grant', () => {
  assert.equal(
    canReadContent(bundle.contentBlocks.cnt_dddddddd, context({ assignedRoleId: 'role_aaaaaaaa' })),
    false,
  );
});

test('ending resolution stays denied until the room is completed', () => {
  const resolutionContentId = 'cnt_99999999';
  const resolutionBundle: BlindBundle = {
    ...bundle,
    sources: {
      ...bundle.sources,
      src_99999999: {
        sourceId: 'src_99999999',
        mediaType: 'image/png',
        sha256: `sha256:${'9'.repeat(64)}`,
        byteLength: 1,
        sourceClass: { kind: 'solution', subjectId: null },
        classification: { status: 'verified', method: 'review', confidence: 1 },
        pages: [{
          pageId: 'page_99999999', index: 0, width: 1, height: 1, rotation: 0,
          sha256: `sha256:${'8'.repeat(64)}`,
        }],
      },
    },
    assets: {
      ...bundle.assets,
      asset_99999999: { assetId: 'asset_99999999', sourceIds: ['src_99999999'] },
    },
    contentBlocks: {
      ...bundle.contentBlocks,
      [resolutionContentId]: {
        contentId: resolutionContentId,
        kind: 'image',
        payload: {},
        assetIds: ['asset_99999999'],
        classification: {
          level: 'L3', compartments: [], taintSourceIds: ['src_99999999'],
        },
        visibility: {
          default: 'deny',
          grants: [{ principal: { kind: 'system_only', subjectId: null }, when: { op: 'session_completed' } }],
        },
        trace: {
          evidence: [{
            sourceId: 'src_99999999', pageId: 'page_99999999',
            region: { unit: 'normalized', x: 0, y: 0, width: 1, height: 1 },
            side: 'single', readingOrder: 0,
          }],
          ocrExtractionId: null,
          reviewStatus: 'verified',
        },
      },
    },
    hostPack: {
      resolutionSections: [{
        sectionId: 'section_99999999',
        contentIds: [resolutionContentId],
        releaseId: 'release_99999999',
      }],
      releasePlan: [{
        releaseId: 'release_99999999',
        contentIds: [resolutionContentId],
        when: { op: 'session_completed' },
      }],
    },
  };
  const running = context({ sessionCompleted: false });
  const completed = context({ sessionCompleted: true });
  assert.deepEqual(projectReleasedResolution(resolutionBundle, running), []);
  assert.equal(canProjectImageContent(resolutionBundle, resolutionContentId, running), false);
  assert.equal(projectReleasedResolution(resolutionBundle, completed).length, 1);
  assert.equal(canProjectImageContent(resolutionBundle, resolutionContentId, completed), true);
  assert.equal(canReadContent(resolutionBundle.contentBlocks[resolutionContentId], completed), false);
});

test('locations and held clues follow stage and ownership state', () => {
  const assigned = context({
    assignedRoleId: 'role_aaaaaaaa',
    assignedRoleIds: new Set(['role_aaaaaaaa']),
    activeStageId: 'stage_aaaaaaaa',
    reachedStageIds: new Set(['stage_aaaaaaaa']),
  });
  const searchableBundle: BlindBundle = {
    ...bundle,
    stages: {
      ...bundle.stages,
      stage_aaaaaaaa: {
        ...bundle.stages.stage_aaaaaaaa,
        allowedActions: ['read_role_section', 'search'],
        locationIds: ['loc_bbbbbbbb', 'loc_aaaaaaaa'],
      },
    },
    locations: {
      ...bundle.locations,
      loc_bbbbbbbb: {
        ...bundle.locations.loc_aaaaaaaa,
        locationId: 'loc_bbbbbbbb',
        availableWhen: { op: 'always' },
      },
      loc_cccccccc: {
        ...bundle.locations.loc_aaaaaaaa,
        locationId: 'loc_cccccccc',
        availableWhen: { op: 'always' },
      },
    },
  };
  const locations = projectAvailableLocations(searchableBundle, assigned);
  assert.deepEqual(locations.map((location) => location.locationId), [
    'loc_bbbbbbbb',
    'loc_aaaaaaaa',
  ]);
  assert.deepEqual(locations[0].clueChoices, [{ clueId: 'clue_aaaaaaaa', number: 1 }]);
  assert.deepEqual(projectAvailableLocations(searchableBundle, {
    ...assigned,
    roomHeldClueIds: new Set(['clue_aaaaaaaa']),
  })[0].clueChoices, []);
  assert.deepEqual(projectAvailableLocations(searchableBundle, {
    ...assigned,
    activeStageId: null,
  }), []);
  assert.equal(
    projectAvailableLocations(searchableBundle, assigned)
      .some((location) => location.locationId === 'loc_cccccccc'),
    false,
  );
  assert.equal(JSON.stringify(projectVisibleClues(bundle, assigned)).includes(CLUE_CANARY), false);
  const holder = {
    ...assigned,
    heldClueIds: new Set(['clue_aaaaaaaa']),
    roomHeldClueIds: new Set(['clue_aaaaaaaa']),
  };
  assert.equal(JSON.stringify(projectVisibleClues(bundle, holder)).includes(CLUE_CANARY), true);
  assert.equal(projectVisibleClues(bundle, holder)[0].isHeld, true);
  assert.equal(projectVisibleClues(bundle, holder)[0].isPublished, false);
  const mandatoryBundle: BlindBundle = {
    ...bundle,
    clues: {
      ...bundle.clues,
      clue_aaaaaaaa: {
        ...bundle.clues.clue_aaaaaaaa,
        publication: {
          ...bundle.clues.clue_aaaaaaaa.publication,
          allowed: true,
          revealedFaceIds: ['face_aaaaaaaa'],
          duty: { mode: 'mandatory_on_acquire' },
        },
      },
    },
  };
  assert.equal(projectVisibleClues(mandatoryBundle, holder)[0].publicationRequired, true);
  assert.equal(projectVisibleClues(mandatoryBundle, {
    ...holder,
    publishedClueIds: new Set(['clue_aaaaaaaa']),
  })[0].publicationRequired, false);
  assert.equal(JSON.stringify(projectVisibleClues(bundle, context({
    ...assigned,
    assignedRoleId: 'role_bbbbbbbb',
  }))).includes(CLUE_CANARY), false);
});

test('published clues are projected directly to every joined room member', () => {
  const publicClueBundle: BlindBundle = {
    ...bundle,
    contentBlocks: {
      ...bundle.contentBlocks,
      cnt_eeeeeeee: {
        ...bundle.contentBlocks.cnt_eeeeeeee,
        visibility: {
          default: 'deny',
          grants: [{
            principal: { kind: 'room_after_event', subjectId: null },
            when: { op: 'clue_published', clueId: 'clue_aaaaaaaa' },
          }],
        },
      },
    },
    clues: {
      ...bundle.clues,
      clue_aaaaaaaa: {
        ...bundle.clues.clue_aaaaaaaa,
        publication: {
          ...bundle.clues.clue_aaaaaaaa.publication,
          allowed: true,
          revealedFaceIds: ['face_aaaaaaaa'],
        },
      },
    },
  };
  const published = context({
    assignedRoleId: null,
    assignedRoleIds: new Set(['role_aaaaaaaa']),
    roomHeldClueIds: new Set(['clue_aaaaaaaa']),
    publishedClueIds: new Set(['clue_aaaaaaaa']),
  });
  const projection = projectVisibleClues(publicClueBundle, published);
  assert.equal(projection.length, 1);
  assert.equal(projection[0].isPublished, true);
  assert.equal(JSON.stringify(projection).includes(CLUE_CANARY), true);
  assert.deepEqual(projectVisibleClues(publicClueBundle, { ...published, joined: false }), []);
});

test('direct image projection denies a readable but unrevealed clue face', () => {
  const publishedImage = (contentId: string, assetId: string): ContentBlock => ({
    contentId,
    kind: 'image',
    payload: {},
    assetIds: [assetId],
    classification: { level: 'L2', compartments: ['clue:clue_aaaaaaaa'] },
    visibility: {
      default: 'deny',
      grants: [{
        principal: { kind: 'room_after_event', subjectId: null },
        when: { op: 'clue_published', clueId: 'clue_aaaaaaaa' },
      }],
    },
    trace: {
      evidence: [{
        sourceId: 'src_aaaaaaaa',
        pageId: 'page_aaaaaaaa',
        region: { unit: 'normalized', x: 0, y: 0, width: 1, height: 1 },
        side: 'single',
        readingOrder: 1,
      }],
      ocrExtractionId: null,
      reviewStatus: 'verified',
    },
  });
  const imageBundle: BlindBundle = {
    ...bundle,
    assets: {
      asset_aaaaaaaa: { assetId: 'asset_aaaaaaaa', sourceIds: ['src_aaaaaaaa'] },
      asset_bbbbbbbb: { assetId: 'asset_bbbbbbbb', sourceIds: ['src_aaaaaaaa'] },
    },
    contentBlocks: {
      ...bundle.contentBlocks,
      cnt_11111111: publishedImage('cnt_11111111', 'asset_aaaaaaaa'),
      cnt_22222222: publishedImage('cnt_22222222', 'asset_bbbbbbbb'),
    },
    clues: {
      ...bundle.clues,
      clue_aaaaaaaa: {
        ...bundle.clues.clue_aaaaaaaa,
        faces: [{
          faceId: 'face_aaaaaaaa', side: 'front', assetIds: ['asset_aaaaaaaa'],
          contentIds: ['cnt_11111111'], revealWhen: { op: 'not', arg: { op: 'always' } },
        }, {
          faceId: 'face_bbbbbbbb', side: 'back', assetIds: ['asset_bbbbbbbb'],
          contentIds: ['cnt_22222222'], revealWhen: { op: 'not', arg: { op: 'always' } },
        }],
        publication: {
          allowed: true,
          publishWhen: { op: 'clue_held', clueId: 'clue_aaaaaaaa' },
          revealedFaceIds: ['face_aaaaaaaa'],
        },
      },
    },
  };
  const published = context({
    roomHeldClueIds: new Set(['clue_aaaaaaaa']),
    publishedClueIds: new Set(['clue_aaaaaaaa']),
  });

  assert.equal(canReadContent(imageBundle.contentBlocks.cnt_22222222, published), true);
  assert.equal(canProjectImageContent(imageBundle, 'cnt_11111111', published), true);
  assert.equal(canProjectImageContent(imageBundle, 'cnt_22222222', published), false);

  const bothFacesRevealed: BlindBundle = {
    ...imageBundle,
    clues: {
      ...imageBundle.clues,
      clue_aaaaaaaa: {
        ...imageBundle.clues.clue_aaaaaaaa,
        publication: {
          ...imageBundle.clues.clue_aaaaaaaa.publication,
          revealedFaceIds: ['face_aaaaaaaa', 'face_bbbbbbbb'],
        },
      },
    },
  };
  assert.equal(canProjectImageContent(bothFacesRevealed, 'cnt_22222222', published), true);
});

test('eligible host releases are derived without exposing host content', () => {
  const releaseBundle: BlindBundle = {
    ...bundle,
    hostPack: {
      releasePlan: [{
        releaseId: 'release_aaaaaaaa', contentIds: ['cnt_dddddddd'], when: { op: 'always' },
      }],
    },
  };
  const released = withEligibleHostReleases(releaseBundle, context());
  assert.equal(released.hostReleaseIds.has('release_aaaaaaaa'), true);
  assert.equal(JSON.stringify(released).includes(HOST_CANARY), false);
});
