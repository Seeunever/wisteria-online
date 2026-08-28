import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canReadContent,
  evaluateCondition,
  evaluateStageFlowCondition,
  projectAssignedRole,
  projectAvailableLocations,
  projectLobby,
  projectVisibleClues,
  withEligibleHostReleases,
  type AuthorizationContext,
  type BlindBundle,
  type ContentBlock,
} from '../lib/blind-runtime.ts';

const PUBLIC_CANARY = 'PUBLIC_CANARY';
const ROLE_A_CANARY = 'ROLE_A_CANARY_NEVER_CROSS';
const ROLE_B_CANARY = 'ROLE_B_CANARY_NEVER_CROSS';
const HOST_CANARY = 'HOST_CANARY_NEVER_EXPORT';
const CLUE_CANARY = 'CLUE_HOLDER_CANARY';

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
  script: { versionId: 'ver_aaaaaaaa', titleContentId: 'cnt_aaaaaaaa' },
  sources: {},
  assets: {},
  contentBlocks: {
    cnt_aaaaaaaa: block('cnt_aaaaaaaa', PUBLIC_CANARY, 'L1', 'room_member', null),
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
        sectionId: 'section_aaaaaaaa', kind: 'background', stageId: 'stage_aaaaaaaa', order: 1,
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

test('unjoined and unassigned viewers receive no role content', () => {
  assert.equal(projectLobby(bundle, context({ joined: false })), null);
  const lobby = projectLobby(bundle, context());
  assert.equal(lobby?.title, PUBLIC_CANARY);
  assert.equal(JSON.stringify(lobby).includes(ROLE_A_CANARY), false);
  assert.equal(JSON.stringify(lobby).includes(ROLE_B_CANARY), false);
  assert.equal(JSON.stringify(lobby).includes(HOST_CANARY), false);
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

test('locations and held clues follow stage and ownership state', () => {
  const assigned = context({
    assignedRoleId: 'role_aaaaaaaa',
    assignedRoleIds: new Set(['role_aaaaaaaa']),
    activeStageId: 'stage_aaaaaaaa',
    reachedStageIds: new Set(['stage_aaaaaaaa']),
  });
  assert.equal(projectAvailableLocations(bundle, assigned).length, 1);
  assert.equal(JSON.stringify(projectVisibleClues(bundle, assigned)).includes(CLUE_CANARY), false);
  const holder = {
    ...assigned,
    heldClueIds: new Set(['clue_aaaaaaaa']),
    roomHeldClueIds: new Set(['clue_aaaaaaaa']),
  };
  assert.equal(JSON.stringify(projectVisibleClues(bundle, holder)).includes(CLUE_CANARY), true);
  assert.equal(JSON.stringify(projectVisibleClues(bundle, context({
    ...assigned,
    assignedRoleId: 'role_bbbbbbbb',
  }))).includes(CLUE_CANARY), false);
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
