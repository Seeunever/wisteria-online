import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthorizationContext, BlindBundle, ContentBlock } from '../lib/blind-runtime.ts';
import {
  ROTATING_BLIND_DRAW_KIND,
  canProjectBlindDrawBackImage,
  canProjectRotatingBlindDrawImage,
  crossValidateRotatingBlindDrawMechanism,
  deriveRotatingBlindDrawCandidates,
  parseRotatingBlindDrawMechanism,
  projectBlindDrawBackOptions,
  RotatingBlindDrawConfigError,
  runtimeMechanismsRequireFullRoleAssignment,
} from '../lib/investigation/rotating-blind-draw.ts';

const ids = {
  stage: 'stage_aaaaaaaa',
  roleA: 'role_aaaaaaaa',
  roleB: 'role_bbbbbbbb',
  locationA: 'loc_aaaaaaaa',
  locationB: 'loc_bbbbbbbb',
  clueA: 'clue_aaaaaaaa',
  clueB: 'clue_bbbbbbbb',
  clueC: 'clue_cccccccc',
  backText: 'cnt_aaaaaaaa',
  frontText: 'cnt_bbbbbbbb',
  backImage: 'cnt_cccccccc',
  unsafeImage: 'cnt_dddddddd',
};

const always = { op: 'always' } as const;

function textBlock(
  contentId: string,
  text: string,
  options: {
    level?: 'L1' | 'L2' | 'L3' | 'L4';
    compartments?: string[];
    grant?: boolean;
  } = {},
): ContentBlock {
  return {
    contentId,
    kind: 'text',
    payload: { text },
    assetIds: [],
    classification: {
      level: options.level ?? 'L1',
      compartments: options.compartments ?? [],
    },
    visibility: {
      default: 'deny',
      grants: options.grant === false ? [] : [{
        principal: { kind: 'room_member', subjectId: null },
        when: always,
      }],
    },
    trace: { evidence: [], ocrExtractionId: null, reviewStatus: 'verified' },
  };
}

function imageBlock(contentId: string, level: 'L1' | 'L3'): ContentBlock {
  return {
    contentId,
    kind: 'image',
    payload: {},
    assetIds: ['asset_aaaaaaaa'],
    classification: { level, compartments: [] },
    visibility: {
      default: 'deny',
      grants: [{ principal: { kind: 'room_member', subjectId: null }, when: always }],
    },
    trace: {
      evidence: [{
        sourceId: 'src_aaaaaaaa',
        pageId: 'page_aaaaaaaa',
        region: { unit: 'normalized', x: 0, y: 0, width: 1, height: 1 },
        side: 'back',
        readingOrder: 1,
      }],
      ocrExtractionId: null,
      reviewStatus: 'verified',
    },
  };
}

function clue(clueId: string, backContentIds: string[], frontContentIds: string[]) {
  return {
    clueId,
    kind: 'synthetic',
    faces: [
      {
        faceId: `face_${clueId.slice(5)}a`,
        side: 'front' as const,
        assetIds: [],
        contentIds: frontContentIds,
        revealWhen: { op: 'clue_held' as const, clueId },
      },
      {
        faceId: `face_${clueId.slice(5)}b`,
        side: 'back' as const,
        assetIds: [],
        contentIds: backContentIds,
        revealWhen: always,
      },
    ],
    acquisition: { when: always, initialAudience: 'holder' as const },
    publication: { allowed: true, publishWhen: always, revealedFaceIds: [] },
  };
}

function makeBundle(modeB: BlindBundle['locations'][string]['searchPolicy']['mode'] = 'all_visible') {
  return {
    schemaVersion: 'blind-script/1.0',
    script: { versionId: 'ver_aaaaaaaa', titleContentId: ids.backText },
    sources: {},
    assets: {},
    contentBlocks: {
      [ids.backText]: textBlock(ids.backText, 'BACK_CANARY'),
      [ids.frontText]: textBlock(ids.frontText, 'FRONT_SECRET_CANARY'),
      [ids.backImage]: imageBlock(ids.backImage, 'L1'),
      [ids.unsafeImage]: imageBlock(ids.unsafeImage, 'L3'),
    },
    stages: {
      [ids.stage]: {
        stageId: ids.stage,
        sequence: 1,
        labelContentId: ids.backText,
        enterWhen: always,
        completeWhen: always,
        allowedActions: ['search', 'publish_clue'],
        locationIds: [ids.locationA, ids.locationB],
      },
    },
    locations: {
      [ids.locationA]: {
        locationId: ids.locationA,
        nameContentId: ids.backText,
        availableWhen: always,
        searchPolicy: {
          mode: 'all_visible', perPlayerLimit: null, globalLimit: null, resetAtStageIds: [],
        },
        cluePool: [
          { clueId: ids.clueA, order: 1, copies: 1, availableWhen: always },
          { clueId: ids.clueB, order: 2, copies: 1, availableWhen: always },
        ],
      },
      [ids.locationB]: {
        locationId: ids.locationB,
        nameContentId: ids.backText,
        availableWhen: always,
        searchPolicy: {
          mode: modeB, perPlayerLimit: 1, globalLimit: 2, resetAtStageIds: [],
        },
        cluePool: [{ clueId: ids.clueC, order: 1, copies: 1, availableWhen: always }],
      },
    },
    clues: {
      [ids.clueA]: clue(ids.clueA, [ids.backText, ids.backImage], [ids.frontText]),
      [ids.clueB]: clue(ids.clueB, [ids.unsafeImage], [ids.frontText]),
      [ids.clueC]: clue(ids.clueC, [ids.backText], [ids.frontText]),
    },
    roles: {
      [ids.roleA]: { roleId: ids.roleA, slot: 1, displayNameContentId: ids.backText, sections: [] },
      [ids.roleB]: { roleId: ids.roleB, slot: 2, displayNameContentId: ids.backText, sections: [] },
    },
    hostPack: { releasePlan: [] },
  } as unknown as BlindBundle;
}

function mechanismSource() {
  return {
    kind: ROTATING_BLIND_DRAW_KIND,
    version: 2,
    cursor: {
      roleIds: [ids.roleA, ids.roleB],
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
    candidateLocationIds: [ids.locationA, ids.locationB],
    locationClueIds: {
      [ids.locationA]: [ids.clueA, ids.clueB],
      [ids.locationB]: [ids.clueC],
    },
    draw: {
      mode: 'blind_choice_without_replacement',
      exhaust: 'selected_location_pool',
      perTurnAcquisitionLimit: 1,
      visibleBeforeAcquire: 'back_face_only',
    },
    publication: {
      privateHoldingLimit: 1,
      countScope: 'room_lifetime',
      mandatoryClueIds: [ids.clueC],
      blockedActions: ['location_ballot', 'blind_draw', 'completion_ballot'],
    },
    roleRestrictions: [{
      principalRoleId: ids.roleA,
      restrictedLocationIds: [ids.locationB],
      restrictedClueIds: [ids.clueB],
      mode: 'deny_unless_only_remaining_eligible',
    }],
    completion: {
      mode: 'member_consent',
      threshold: 1,
      requires: ['search_scope_exhausted', 'publication_obligations_cleared'],
    },
  };
}

function context(): AuthorizationContext {
  return {
    joined: true,
    assignedRoleId: ids.roleA,
    assignedRoleIds: new Set([ids.roleA, ids.roleB]),
    activeStageId: ids.stage,
    reachedStageIds: new Set([ids.stage]),
    heldClueIds: new Set(),
    roomHeldClueIds: new Set(),
    publishedClueIds: new Set(),
    hostReleaseIds: new Set(),
    sessionCompleted: false,
    investigationCompletedStageIds: new Set(),
  };
}

test('rotating blind draw config is strictly parsed and cloned', () => {
  const source = mechanismSource();
  const snapshot = structuredClone(source);
  const parsed = parseRotatingBlindDrawMechanism(source);
  assert.deepEqual(source, snapshot);
  assert.notEqual(parsed.cursor.roleIds, source.cursor.roleIds);
  assert.equal(parsed.kind, ROTATING_BLIND_DRAW_KIND);
  assert.throws(
    () => parseRotatingBlindDrawMechanism({ ...source, unexpected: true }),
    RotatingBlindDrawConfigError,
  );
  assert.throws(
    () => parseRotatingBlindDrawMechanism({ ...source, version: 1 }),
    RotatingBlindDrawConfigError,
  );
});

test('cross validation preserves the canonical bundle as an upper bound', () => {
  const mechanism = parseRotatingBlindDrawMechanism(mechanismSource());
  assert.doesNotThrow(() => crossValidateRotatingBlindDrawMechanism(
    mechanism, makeBundle(), ids.stage,
  ));
  assert.throws(() => crossValidateRotatingBlindDrawMechanism(
    mechanism, makeBundle('host_dealt'), ids.stage,
  ), RotatingBlindDrawConfigError);
  assert.throws(() => crossValidateRotatingBlindDrawMechanism(
    mechanism, makeBundle('fixed_sequence'), ids.stage,
  ), RotatingBlindDrawConfigError);
  assert.throws(() => crossValidateRotatingBlindDrawMechanism(
    parseRotatingBlindDrawMechanism({
      ...mechanismSource(),
      locationClueIds: {
        [ids.locationA]: [ids.clueA, ids.clueB],
        [ids.locationB]: ['clue_dddddddd'],
      },
    }),
    makeBundle(),
    ids.stage,
  ), RotatingBlindDrawConfigError);
});

test('candidate projection intersects role restrictions and canonical limits', () => {
  const bundle = makeBundle();
  const mechanism = parseRotatingBlindDrawMechanism(mechanismSource());
  const candidates = deriveRotatingBlindDrawCandidates(
    bundle,
    ids.stage,
    mechanism,
    context(),
    [
      { assignedRoleId: ids.roleA, heldClueIds: new Set() },
      {
        assignedRoleId: ids.roleB,
        heldClueIds: new Set(),
        searchUsesByLocation: { [ids.locationB]: 1 },
      },
    ],
    new Set(),
    { [ids.locationB]: 1 },
  );
  assert.deepEqual(candidates.actorLocationIds, [ids.locationA]);
  assert.deepEqual(candidates.actorClueIdsByLocation[ids.locationA], [ids.clueA]);
  assert.deepEqual(candidates.roomLocationIds, [ids.locationA]);

  const exhausted = deriveRotatingBlindDrawCandidates(
    bundle,
    ids.stage,
    mechanism,
    context(),
    [{ assignedRoleId: ids.roleA, heldClueIds: new Set() }],
    new Set([ids.locationA]),
  );
  assert.deepEqual(exhausted.actorLocationIds, [ids.locationB]);
  assert.deepEqual(exhausted.actorClueIdsByLocation[ids.locationB], [ids.clueC]);
});

test('blind selector projection exposes back content only', () => {
  const options = projectBlindDrawBackOptions(makeBundle(), context(), {
    [ids.locationA]: [ids.clueA, ids.clueB],
  });
  assert.equal(options.length, 1);
  assert.equal(options[0].clueId, ids.clueA);
  assert.deepEqual(options[0].content, [
    { kind: 'text', text: 'BACK_CANARY' },
    { kind: 'image', contentId: ids.backImage, parts: 1 },
  ]);
  assert.equal(JSON.stringify(options).includes('FRONT_SECRET_CANARY'), false);
  assert.equal(canProjectBlindDrawBackImage(options, ids.backImage), true);
  assert.equal(canProjectBlindDrawBackImage(options, ids.frontText), false);
  assert.equal(canProjectBlindDrawBackImage(options, ids.unsafeImage), false);
  const mechanism = parseRotatingBlindDrawMechanism(mechanismSource());
  assert.equal(canProjectRotatingBlindDrawImage(
    makeBundle(), mechanism, context(), [], ids.backImage, true,
  ), false);
  assert.equal(canProjectRotatingBlindDrawImage(
    makeBundle(), mechanism, context(), options, ids.backImage, false,
  ), true);
  assert.equal(canProjectRotatingBlindDrawImage(
    makeBundle(), mechanism, context(), [], ids.frontText, true,
  ), true);
});

test('resolved rotating mechanisms require a complete role assignment', () => {
  const mechanism = parseRotatingBlindDrawMechanism(mechanismSource());
  assert.equal(runtimeMechanismsRequireFullRoleAssignment({ [ids.stage]: mechanism }), true);
  assert.equal(runtimeMechanismsRequireFullRoleAssignment({
    [ids.stage]: { kind: 'canonical_search_policy', version: 1 },
  }), false);
});

test('blind selector projection never widens canonical face or block grants', () => {
  const authorization = context();

  const noFaceGrant = makeBundle();
  noFaceGrant.clues[ids.clueA].faces.find((face) => face.side === 'back')!.revealWhen = {
    op: 'not', arg: always,
  };
  assert.deepEqual(projectBlindDrawBackOptions(noFaceGrant, authorization, {
    [ids.locationA]: [ids.clueA],
  }), []);

  const noPrincipalGrant = makeBundle();
  noPrincipalGrant.contentBlocks[ids.backText].visibility.grants = [];
  const withoutText = projectBlindDrawBackOptions(noPrincipalGrant, authorization, {
    [ids.locationA]: [ids.clueA],
  });
  assert.equal(JSON.stringify(withoutText).includes('BACK_CANARY'), false);

  const otherRoleCompartment = makeBundle();
  otherRoleCompartment.contentBlocks[ids.backText].classification = {
    level: 'L2', compartments: [`role:${ids.roleB}`],
  };
  const compartmentDenied = projectBlindDrawBackOptions(otherRoleCompartment, authorization, {
    [ids.locationA]: [ids.clueA],
  });
  assert.equal(JSON.stringify(compartmentDenied).includes('BACK_CANARY'), false);

  const secretLevels = makeBundle();
  assert.deepEqual(projectBlindDrawBackOptions(secretLevels, authorization, {
    [ids.locationA]: [ids.clueB],
  }), []);
  secretLevels.contentBlocks[ids.unsafeImage].classification.level = 'L4';
  assert.deepEqual(projectBlindDrawBackOptions(secretLevels, authorization, {
    [ids.locationA]: [ids.clueB],
  }), []);
});
