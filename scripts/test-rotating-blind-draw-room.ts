import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BlindBundle, ContentBlock } from '../lib/blind-runtime.ts';

const ids = {
  version: 'ver_aaaaaaaa',
  stage: 'stage_aaaaaaaa',
  stageB: 'stage_bbbbbbbb',
  roleA: 'role_aaaaaaaa',
  roleB: 'role_bbbbbbbb',
  locationA: 'loc_aaaaaaaa',
  locationB: 'loc_bbbbbbbb',
  clueA: 'clue_aaaaaaaa',
  clueB: 'clue_bbbbbbbb',
  clueC: 'clue_cccccccc',
  clueD: 'clue_dddddddd',
  backA: 'cnt_aaaaaaaa',
  backB: 'cnt_bbbbbbbb',
  backC: 'cnt_cccccccc',
  front: 'cnt_dddddddd',
  backD: 'cnt_eeeeeeee',
};

const always = { op: 'always' } as const;

function block(contentId: string, text: string): ContentBlock {
  return {
    contentId,
    kind: 'text',
    payload: { text },
    assetIds: [],
    classification: { level: 'L1', compartments: [] },
    visibility: {
      default: 'deny',
      grants: [{ principal: { kind: 'room_member', subjectId: null }, when: always }],
    },
    trace: { evidence: [], ocrExtractionId: null, reviewStatus: 'verified' },
  };
}

function clue(clueId: string, backId: string) {
  return {
    clueId,
    kind: 'synthetic',
    faces: [
      {
        faceId: `face_${clueId.slice(5)}a`,
        side: 'back' as const,
        assetIds: [],
        contentIds: [backId],
        revealWhen: always,
      },
      {
        faceId: `face_${clueId.slice(5)}b`,
        side: 'front' as const,
        assetIds: [],
        contentIds: [ids.front],
        revealWhen: { op: 'clue_held' as const, clueId },
      },
    ],
    acquisition: { when: always, initialAudience: 'holder' as const },
    publication: { allowed: true, publishWhen: always, revealedFaceIds: [] },
  };
}

function bundle(): BlindBundle {
  return {
    schemaVersion: 'blind-script/1.0',
    script: { versionId: ids.version, titleContentId: ids.backA },
    sources: {},
    assets: {},
    contentBlocks: {
      [ids.backA]: block(ids.backA, 'BACK_A'),
      [ids.backB]: block(ids.backB, 'BACK_B'),
      [ids.backC]: block(ids.backC, 'BACK_C'),
      [ids.front]: block(ids.front, 'FRONT_SECRET'),
      [ids.backD]: block(ids.backD, 'BACK_D'),
    },
    stages: {
      [ids.stage]: {
        stageId: ids.stage,
        sequence: 1,
        labelContentId: ids.backA,
        enterWhen: always,
        completeWhen: always,
        allowedActions: ['search', 'publish_clue'],
        locationIds: [ids.locationA, ids.locationB],
      },
      [ids.stageB]: {
        stageId: ids.stageB,
        sequence: 2,
        labelContentId: ids.backB,
        enterWhen: always,
        completeWhen: always,
        allowedActions: ['search', 'publish_clue'],
        locationIds: [ids.locationA, ids.locationB],
      },
    },
    locations: {
      [ids.locationA]: {
        locationId: ids.locationA,
        nameContentId: ids.backA,
        availableWhen: always,
        searchPolicy: {
          mode: 'all_visible', perPlayerLimit: null, globalLimit: null, resetAtStageIds: [],
        },
        cluePool: [
          { clueId: ids.clueA, order: 1, copies: 1, availableWhen: always },
          { clueId: ids.clueB, order: 2, copies: 1, availableWhen: always },
          { clueId: ids.clueD, order: 3, copies: 1, availableWhen: always },
        ],
      },
      [ids.locationB]: {
        locationId: ids.locationB,
        nameContentId: ids.backB,
        availableWhen: always,
        searchPolicy: {
          mode: 'all_visible', perPlayerLimit: null, globalLimit: null, resetAtStageIds: [],
        },
        cluePool: [{ clueId: ids.clueC, order: 1, copies: 1, availableWhen: always }],
      },
    },
    clues: {
      [ids.clueA]: clue(ids.clueA, ids.backA),
      [ids.clueB]: clue(ids.clueB, ids.backB),
      [ids.clueC]: clue(ids.clueC, ids.backC),
      [ids.clueD]: clue(ids.clueD, ids.backD),
    },
    roles: {
      [ids.roleA]: { roleId: ids.roleA, slot: 1, displayNameContentId: ids.backA, sections: [] },
      [ids.roleB]: { roleId: ids.roleB, slot: 2, displayNameContentId: ids.backB, sections: [] },
    },
    hostPack: { releasePlan: [] },
  } as unknown as BlindBundle;
}

function mechanism() {
  return {
    kind: 'collective_vote_rotating_blind_draw',
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

function actorChoiceMechanism() {
  return {
    ...mechanism(),
    selection: {
      mode: 'actor_blind_pick_all_remaining',
      locationsToExhaust: 'all_remaining',
    },
    locationClueIds: {
      [ids.locationA]: [ids.clueA, ids.clueB, ids.clueD],
      [ids.locationB]: [ids.clueC],
    },
    draw: {
      mode: 'blind_choice_without_replacement',
      exhaust: 'all_remaining_location_pools',
      perTurnAcquisitionLimit: 1,
      visibleBeforeAcquire: 'back_face_only',
    },
    publication: {
      ...mechanism().publication,
      mandatoryClueIds: [ids.clueC],
    },
  };
}

test('safe room views use a read snapshot and equal-time cursor order is insertion-stable', () => {
  const source = readFileSync(
    new URL('../lib/investigation/rotating-blind-draw-room.ts', import.meta.url),
    'utf8',
  );
  const viewStart = source.indexOf('export function getRotatingBlindDrawRoomView');
  const viewEnd = source.indexOf('function beginReadSnapshot', viewStart);
  assert.notEqual(viewStart, -1);
  assert.notEqual(viewEnd, -1);
  assert.match(source.slice(viewStart, viewEnd), /beginReadSnapshot\(database\)/);
  assert.match(source, /function beginReadSnapshot[\s\S]*?BEGIN DEFERRED/);
  assert.match(source, /ORDER BY acquired_at DESC, rowid DESC LIMIT 1/);
});

test('versioned room handler votes, tie-breaks, rotates, blocks stale writes, and completes', async () => {
  const temporaryRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wisteria-rotating-test-')));
  process.env.WISTERIA_DATA_DIR = temporaryRoot;
  let closeDatabase: (() => void) | undefined;
  try {
    const [{ getDatabase }, rooms, handler] = await Promise.all([
      import('../lib/db.ts'),
      import('../lib/rooms.ts'),
      import('../lib/investigation/rotating-blind-draw-room.ts'),
    ]);
    const database = getDatabase();
    closeDatabase = () => database.close();
    const now = Date.now();
    const roomId = '10000000-0000-4000-8000-000000000000';
    const membershipA = '20000000-0000-4000-8000-000000000000';
    const membershipB = '30000000-0000-4000-8000-000000000000';
    database.prepare(`
      INSERT INTO users (id, username_key, display_name, password_salt, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)
    `).run(
      'user-a', 'a', 'A', 'salt', 'hash', now,
      'user-b', 'b', 'B', 'salt', 'hash', now,
    );
    database.prepare(`
      INSERT INTO pack_versions
        (id, public_label, payload_path, source_hash, state, created_at, frozen_at)
      VALUES (?, 'Synthetic', 'synthetic', ?, 'frozen', ?, ?)
    `).run(ids.version, `sha256:${'a'.repeat(64)}`, now, now);
    database.prepare(`
      INSERT INTO rooms
        (id, code, owner_user_id, version_id, status, authorization_version, created_at)
      VALUES (?, 'ABC234', 'user-a', ?, 'running', 1, ?)
    `).run(roomId, ids.version, now);
    database.prepare(`
      INSERT INTO memberships (id, room_id, user_id, joined_at)
      VALUES (?, ?, 'user-a', ?), (?, ?, 'user-b', ?)
    `).run(membershipA, roomId, now, membershipB, roomId, now + 1);
    database.prepare(`
      INSERT INTO role_assignments (room_id, role_id, membership_id, assigned_at)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      roomId, ids.roleA, membershipA, now,
      roomId, ids.roleB, membershipB, now,
    );
    database.prepare(`
      INSERT INTO room_stages (room_id, stage_id, sequence, entered_at)
      VALUES (?, ?, 1, ?)
    `).run(roomId, ids.stage, now);

    const pack = bundle();
    const policy = mechanism();
    const auth = () => (database.prepare(`
      SELECT authorization_version AS value FROM rooms WHERE id = ?
    `).get(roomId) as { value: number }).value;
    const view = (userId: string) => handler.getRotatingBlindDrawRoomView({
      code: 'ABC234', userId, versionId: ids.version, stageId: ids.stage,
      bundle: pack, mechanism: policy,
    });

    assert.equal(view('user-a')?.phase, 'location_ballot');
    assert.equal(handler.castRotatingBlindDrawLocationVote({
      code: 'ABC234', userId: 'user-a', versionId: ids.version,
      authorizationVersion: auth(), stageId: ids.stage, locationId: ids.locationA,
      bundle: pack, mechanism: policy,
    }), true);
    assert.equal(handler.castRotatingBlindDrawLocationVote({
      code: 'ABC234', userId: 'user-b', versionId: ids.version,
      authorizationVersion: 1, stageId: ids.stage, locationId: ids.locationB,
      bundle: pack, mechanism: policy,
    }), false);
    assert.equal(handler.castRotatingBlindDrawLocationVote({
      code: 'ABC234', userId: 'user-b', versionId: ids.version,
      authorizationVersion: auth(), stageId: ids.stage, locationId: ids.locationB,
      bundle: pack, mechanism: policy,
    }), true);
    assert.equal(view('user-a')?.phase, 'tie_break');
    const tieAuthorizationVersion = auth();
    assert.equal(handler.castRotatingBlindDrawLocationVote({
      code: 'ABC234', userId: 'user-b', versionId: ids.version,
      authorizationVersion: tieAuthorizationVersion, stageId: ids.stage,
      locationId: ids.locationA, bundle: pack, mechanism: policy,
    }), false);
    assert.equal(auth(), tieAuthorizationVersion);
    assert.equal(handler.selectRotatingBlindDrawTieLocation({
      code: 'ABC234', userId: 'user-b', versionId: ids.version,
      authorizationVersion: auth(), stageId: ids.stage, locationId: ids.locationB,
      bundle: pack, mechanism: policy,
    }), false);
    assert.equal(handler.selectRotatingBlindDrawTieLocation({
      code: 'ABC234', userId: 'user-a', versionId: ids.version,
      authorizationVersion: auth(), stageId: ids.stage, locationId: ids.locationA,
      bundle: pack, mechanism: policy,
    }), true);

    const ownerDraw = view('user-a');
    assert.equal(ownerDraw?.phase, 'blind_draw');
    assert.equal(ownerDraw?.currentTurnMembershipId, membershipA);
    assert.deepEqual(ownerDraw?.drawOptions.map((item) => item.clueId), [ids.clueA, ids.clueB]);
    assert.equal(JSON.stringify(ownerDraw).includes('FRONT_SECRET'), false);
    assert.equal(handler.acquireRotatingBlindDrawClue({
      code: 'ABC234', userId: 'user-b', versionId: ids.version,
      authorizationVersion: auth(), stageId: ids.stage,
      locationId: ids.locationA, clueId: ids.clueA,
      bundle: pack, mechanism: policy,
    }), false);
    assert.equal(handler.acquireRotatingBlindDrawClue({
      code: 'ABC234', userId: 'user-a', versionId: ids.version,
      authorizationVersion: auth(), stageId: ids.stage,
      locationId: ids.locationA, clueId: ids.clueA,
      bundle: pack, mechanism: policy,
    }), true);

    assert.equal(view('user-a')?.hasPublicationObligation, true);
    const otherDraw = view('user-b');
    assert.equal(otherDraw?.currentTurnMembershipId, membershipB);
    assert.deepEqual(otherDraw?.drawOptions.map((item) => item.clueId), [ids.clueB]);
    assert.equal(handler.acquireRotatingBlindDrawClue({
      code: 'ABC234', userId: 'user-b', versionId: ids.version,
      authorizationVersion: auth(), stageId: ids.stage,
      locationId: ids.locationA, clueId: ids.clueB,
      bundle: pack, mechanism: policy,
    }), true);
    assert.equal(view('user-a')?.phase, 'completion_ballot');
    assert.equal(handler.voteRotatingBlindDrawCompletion({
      code: 'ABC234', userId: 'user-a', versionId: ids.version,
      authorizationVersion: auth(), stageId: ids.stage,
      bundle: pack, mechanism: policy,
    }), false);

    assert.equal(rooms.publishHeldClue({
      code: 'ABC234', userId: 'user-a', versionId: ids.version,
      authorizationVersion: auth(), clueId: ids.clueA,
    }), true);
    assert.equal(rooms.publishHeldClue({
      code: 'ABC234', userId: 'user-b', versionId: ids.version,
      authorizationVersion: auth(), clueId: ids.clueB,
    }), true);
    assert.equal(handler.voteRotatingBlindDrawCompletion({
      code: 'ABC234', userId: 'user-a', versionId: ids.version,
      authorizationVersion: auth(), stageId: ids.stage,
      bundle: pack, mechanism: policy,
    }), true);
    assert.equal(view('user-a')?.stageCompleted, true);
    assert.equal((database.prepare(`
      SELECT COUNT(*) AS count FROM clue_holdings WHERE room_id = ?
    `).get(roomId) as { count: number }).count, 2);

    const transitionTime = Date.now();
    database.prepare(`
      UPDATE room_stages SET completed_at = ? WHERE room_id = ? AND stage_id = ?
    `).run(transitionTime, roomId, ids.stage);
    database.prepare(`
      INSERT INTO room_stages (room_id, stage_id, sequence, entered_at)
      VALUES (?, ?, 2, ?)
    `).run(roomId, ids.stageB, transitionTime);
    database.prepare(`
      UPDATE rooms SET authorization_version = authorization_version + 1 WHERE id = ?
    `).run(roomId);
    const actorPolicy = actorChoiceMechanism();
    const stageScopedPolicy = { ...actorPolicy, exhaustedLocationScope: 'stage' };
    const lifetimeLimitedPack = structuredClone(pack);
    lifetimeLimitedPack.locations[ids.locationA].searchPolicy = {
      ...lifetimeLimitedPack.locations[ids.locationA].searchPolicy,
      perPlayerLimit: 1,
      globalLimit: 2,
      resetAtStageIds: [],
    };
    assert.deepEqual(handler.getRotatingBlindDrawRoomView({
      code: 'ABC234', userId: 'user-a', versionId: ids.version, stageId: ids.stageB,
      bundle: lifetimeLimitedPack, mechanism: stageScopedPolicy,
    })?.drawOptions.map((item) => item.clueId), [ids.clueC]);
    const resetLimitedPack = structuredClone(lifetimeLimitedPack);
    resetLimitedPack.locations[ids.locationA].searchPolicy.resetAtStageIds = [ids.stageB];
    assert.deepEqual(handler.getRotatingBlindDrawRoomView({
      code: 'ABC234', userId: 'user-a', versionId: ids.version, stageId: ids.stageB,
      bundle: resetLimitedPack, mechanism: stageScopedPolicy,
    })?.drawOptions.map((item) => item.clueId), [ids.clueD, ids.clueC]);
    const stageScopedView = handler.getRotatingBlindDrawRoomView({
      code: 'ABC234', userId: 'user-a', versionId: ids.version, stageId: ids.stageB,
      bundle: pack, mechanism: stageScopedPolicy,
    });
    assert.deepEqual(
      stageScopedView?.drawOptions.map((item) => item.clueId),
      [ids.clueD, ids.clueC],
    );
    const secondView = (userId: string) => handler.getRotatingBlindDrawRoomView({
      code: 'ABC234', userId, versionId: ids.version, stageId: ids.stageB,
      bundle: pack, mechanism: actorPolicy,
    });
    const firstActorView = secondView('user-a');
    assert.equal(firstActorView?.phase, 'blind_draw');
    assert.equal(firstActorView?.currentTurnMembershipId, membershipA);
    assert.deepEqual(firstActorView?.drawOptions.map((item) => item.clueId), [ids.clueC]);
    assert.equal(handler.acquireRotatingBlindDrawClue({
      code: 'ABC234', userId: 'user-a', versionId: ids.version,
      authorizationVersion: auth(), stageId: ids.stageB,
      locationId: ids.locationB, clueId: ids.clueC,
      bundle: pack, mechanism: actorPolicy,
    }), true);
    assert.equal(secondView('user-b')?.roomActionBlockedForPublication, true);
    assert.equal(handler.voteRotatingBlindDrawCompletion({
      code: 'ABC234', userId: 'user-b', versionId: ids.version,
      authorizationVersion: auth(), stageId: ids.stageB,
      bundle: pack, mechanism: actorPolicy,
    }), false);
    assert.equal(rooms.publishHeldClue({
      code: 'ABC234', userId: 'user-a', versionId: ids.version,
      authorizationVersion: auth(), clueId: ids.clueC,
    }), true);
    assert.equal(handler.voteRotatingBlindDrawCompletion({
      code: 'ABC234', userId: 'user-b', versionId: ids.version,
      authorizationVersion: auth(), stageId: ids.stageB,
      bundle: pack, mechanism: actorPolicy,
    }), true);
    assert.equal(secondView('user-a')?.stageCompleted, true);

    const incompleteRoomId = '40000000-0000-4000-8000-000000000000';
    const incompleteMembershipId = '50000000-0000-4000-8000-000000000000';
    database.prepare(`
      INSERT INTO rooms
        (id, code, owner_user_id, version_id, status, authorization_version, created_at)
      VALUES (?, 'DEF567', 'user-a', ?, 'running', 1, ?)
    `).run(incompleteRoomId, ids.version, now);
    database.prepare(`
      INSERT INTO memberships (id, room_id, user_id, joined_at)
      VALUES (?, ?, 'user-a', ?)
    `).run(incompleteMembershipId, incompleteRoomId, now);
    database.prepare(`
      INSERT INTO role_assignments (room_id, role_id, membership_id, assigned_at)
      VALUES (?, ?, ?, ?)
    `).run(incompleteRoomId, ids.roleA, incompleteMembershipId, now);
    database.prepare(`
      INSERT INTO room_stages (room_id, stage_id, sequence, entered_at)
      VALUES (?, ?, 1, ?)
    `).run(incompleteRoomId, ids.stage, now);
    assert.equal(handler.getRotatingBlindDrawRoomView({
      code: 'DEF567', userId: 'user-a', versionId: ids.version, stageId: ids.stage,
      bundle: pack, mechanism: policy,
    }), null);
    assert.equal(handler.castRotatingBlindDrawLocationVote({
      code: 'DEF567', userId: 'user-a', versionId: ids.version,
      authorizationVersion: 1, stageId: ids.stage, locationId: ids.locationA,
      bundle: pack, mechanism: policy,
    }), false);
  } finally {
    closeDatabase?.();
    const resolved = realpathSync(temporaryRoot);
    const expectedPrefix = `${realpathSync(os.tmpdir())}${path.sep}`;
    if (!resolved.startsWith(expectedPrefix) || !path.basename(resolved).startsWith('wisteria-rotating-test-')) {
      throw new Error('UNSAFE_TEST_CLEANUP_TARGET');
    }
    rmSync(resolved, { recursive: true, force: false });
  }
});
