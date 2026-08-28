import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('room versions freeze atomically and incomplete starts require an explicit override', async () => {
  const temporaryRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wisteria-room-test-')));
  process.env.WISTERIA_DATA_DIR = temporaryRoot;
  let closeDatabase: (() => void) | undefined;
  try {
    const [{ getDatabase }, {
      attachFrozenPackToRoom,
      advanceRoom,
      claimRole,
      createRoom,
      deleteRoom,
      getRoomForMember,
      joinRoom,
      listRooms,
      publishHeldClue,
      searchLocation,
      startRoom,
    }] = await Promise.all([
      import('../lib/db.ts'),
      import('../lib/rooms.ts'),
    ]);
    const database = getDatabase();
    closeDatabase = () => database.close();
    const authorizationVersion = (roomCode: string) => (
      database.prepare(
        'SELECT authorization_version AS value FROM rooms WHERE code = ?',
      ).get(roomCode) as { value: number }
    ).value;
    const now = Date.now();
    database.prepare(`
      INSERT INTO users (id, username_key, display_name, password_salt, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('user-owner', 'owner', 'Owner', 'salt', 'hash', now);
    database.prepare(`
      INSERT INTO users (id, username_key, display_name, password_salt, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('user-other', 'other', 'Other', 'salt', 'hash', now);
    database.prepare(`
      INSERT INTO pack_versions
        (id, public_label, payload_path, source_hash, state, created_at, frozen_at)
      VALUES (?, ?, ?, ?, 'frozen', ?, ?)
    `).run(
      'ver_aaaaaaaa', 'Synthetic pack', 'packs/ver_aaaaaaaa/bundle.internal.json',
      `sha256:${'a'.repeat(64)}`, now, now,
    );
    database.prepare(`
      INSERT INTO pack_versions
        (id, public_label, payload_path, source_hash, state, created_at, frozen_at)
      VALUES (?, ?, ?, ?, 'validated', ?, NULL)
    `).run(
      'ver_bbbbbbbb', 'Unfrozen synthetic pack', 'packs/ver_bbbbbbbb/bundle.internal.json',
      `sha256:${'b'.repeat(64)}`, now,
    );

    assert.equal(createRoom('user-owner', 'ver_bbbbbbbb'), null);
    assert.equal(createRoom('user-owner', 'ver_cccccccc'), null);
    const selectedCode = createRoom('user-owner', 'ver_aaaaaaaa');
    assert.notEqual(selectedCode, null);
    const selectedRoom = database.prepare(
      'SELECT version_id AS versionId FROM rooms WHERE code = ?',
    ).get(selectedCode) as { versionId: string };
    assert.equal(selectedRoom.versionId, 'ver_aaaaaaaa');
    const discoveredRoom = listRooms('user-other').find((item) => item.code === selectedCode);
    assert.equal(discoveredRoom?.isMember, 0);
    assert.equal(discoveredRoom?.packLabel, 'Synthetic pack');
    assert.equal(joinRoom('user-other', selectedCode!), true);
    assert.equal(
      listRooms('user-other').find((item) => item.code === selectedCode)?.isMember,
      1,
    );

    const deletedCode = createRoom('user-owner', 'ver_aaaaaaaa');
    assert.notEqual(deletedCode, null);
    assert.equal(joinRoom('user-other', deletedCode!), true);
    assert.equal(deleteRoom(deletedCode!, 'user-stranger'), false);
    assert.notEqual(getRoomForMember(deletedCode!, 'user-owner'), null);
    assert.equal(deleteRoom(deletedCode!, 'user-other'), true);
    assert.equal(getRoomForMember(deletedCode!, 'user-owner'), null);
    assert.equal(
      (database.prepare('SELECT COUNT(*) AS count FROM memberships WHERE room_id NOT IN (SELECT id FROM rooms)').get() as { count: number }).count,
      0,
    );

    const code = createRoom('user-owner');
    assert.notEqual(code, null);
    assert.equal(attachFrozenPackToRoom(code!, 'user-other', 'ver_aaaaaaaa'), false);
    assert.equal(attachFrozenPackToRoom(code!, 'user-owner', 'ver_aaaaaaaa'), true);
    assert.equal(attachFrozenPackToRoom(code!, 'user-owner', 'ver_aaaaaaaa'), false);

    const room = database.prepare(
      'SELECT version_id AS versionId, authorization_version AS authorizationVersion FROM rooms WHERE code = ?',
    ).get(code) as { versionId: string; authorizationVersion: number };
    assert.equal(room.versionId, 'ver_aaaaaaaa');
    assert.equal(room.authorizationVersion, 2);
    assert.equal(claimRole(code!, 'user-other', 'role_aaaaaaaa'), false);
    assert.equal(claimRole(code!, 'user-owner', 'role_aaaaaaaa'), true);
    assert.equal(claimRole(code!, 'user-owner', 'role_bbbbbbbb'), false);
    assert.equal(startRoom(
      code!, 'user-owner', 'ver_aaaaaaaa', ['role_aaaaaaaa'], 'stage_aaaaaaaa', 1,
      authorizationVersion(code!),
    ), true);
    assert.equal(startRoom(
      code!, 'user-owner', 'ver_aaaaaaaa', ['role_aaaaaaaa'], 'stage_aaaaaaaa', 1, 3,
    ), false);

    const emptyForceCode = createRoom('user-owner', 'ver_aaaaaaaa');
    assert.notEqual(emptyForceCode, null);
    assert.equal(startRoom(
      emptyForceCode!, 'user-owner', 'ver_aaaaaaaa',
      ['role_aaaaaaaa', 'role_bbbbbbbb'], 'stage_aaaaaaaa', 1,
      authorizationVersion(emptyForceCode!), true,
    ), false);

    const staleCode = createRoom('user-owner', 'ver_aaaaaaaa');
    assert.notEqual(staleCode, null);
    assert.equal(claimRole(staleCode!, 'user-owner', 'role_aaaaaaaa'), true);
    const staleAuthorizationVersion = authorizationVersion(staleCode!);
    assert.equal(joinRoom('user-other', staleCode!), true);
    assert.equal(authorizationVersion(staleCode!), staleAuthorizationVersion + 1);
    assert.equal(joinRoom('user-other', staleCode!), true);
    assert.equal(authorizationVersion(staleCode!), staleAuthorizationVersion + 1);
    assert.equal(startRoom(
      staleCode!, 'user-owner', 'ver_aaaaaaaa',
      ['role_aaaaaaaa'], 'stage_aaaaaaaa', 1, staleAuthorizationVersion,
    ), false);
    assert.equal(
      (database.prepare('SELECT status FROM rooms WHERE code = ?').get(staleCode) as { status: string }).status,
      'lobby',
    );

    const forceCode = createRoom('user-owner', 'ver_aaaaaaaa');
    assert.notEqual(forceCode, null);
    assert.equal(claimRole(forceCode!, 'user-owner', 'role_aaaaaaaa'), true);
    assert.equal(startRoom(
      forceCode!, 'user-other', 'ver_aaaaaaaa',
      ['role_aaaaaaaa', 'role_bbbbbbbb'], 'stage_aaaaaaaa', 1,
      authorizationVersion(forceCode!), true,
    ), false);
    assert.equal(startRoom(
      forceCode!, 'user-owner', 'ver_aaaaaaaa',
      ['role_aaaaaaaa', 'role_bbbbbbbb'], 'stage_aaaaaaaa', 1,
      authorizationVersion(forceCode!),
    ), false);
    assert.equal(startRoom(
      forceCode!, 'user-owner', 'ver_aaaaaaaa',
      ['role_aaaaaaaa', 'role_bbbbbbbb'], 'stage_aaaaaaaa', 1,
      authorizationVersion(forceCode!), true,
    ), true);
    const forceEvent = database.prepare(`
      SELECT COUNT(*) AS count
      FROM room_events
      JOIN rooms ON rooms.id = room_events.room_id
      WHERE rooms.code = ? AND room_events.event_type = 'room_force_started'
    `).get(forceCode) as { count: number };
    assert.equal(forceEvent.count, 1);
    assert.equal(getRoomForMember(forceCode!, 'user-owner')?.incompleteStart, 1);

    const departedCode = createRoom('user-owner', 'ver_aaaaaaaa');
    assert.notEqual(departedCode, null);
    assert.equal(joinRoom('user-other', departedCode!), true);
    assert.equal(claimRole(departedCode!, 'user-owner', 'role_aaaaaaaa'), true);
    assert.equal(claimRole(departedCode!, 'user-other', 'role_bbbbbbbb'), true);
    database.prepare(`
      UPDATE memberships SET left_at = ?
      WHERE room_id = (SELECT id FROM rooms WHERE code = ?) AND user_id = ?
    `).run(Date.now(), departedCode, 'user-other');
    assert.equal(startRoom(
      departedCode!, 'user-owner', 'ver_aaaaaaaa',
      ['role_aaaaaaaa', 'role_bbbbbbbb'], 'stage_aaaaaaaa', 1,
      authorizationVersion(departedCode!),
    ), false);
    assert.equal(startRoom(
      departedCode!, 'user-owner', 'ver_aaaaaaaa',
      ['role_aaaaaaaa', 'role_bbbbbbbb'], 'stage_aaaaaaaa', 1,
      authorizationVersion(departedCode!), true,
    ), true);
    assert.equal(joinRoom('user-other', departedCode!), false);

    const tamperedCode = createRoom('user-owner', 'ver_aaaaaaaa');
    assert.notEqual(tamperedCode, null);
    assert.equal(claimRole(tamperedCode!, 'user-owner', 'role_cccccccc'), true);
    assert.equal(startRoom(
      tamperedCode!, 'user-owner', 'ver_aaaaaaaa',
      ['role_aaaaaaaa', 'role_bbbbbbbb'], 'stage_aaaaaaaa', 1,
      authorizationVersion(tamperedCode!), true,
    ), false);
    assert.equal(searchLocation({
      code: code!, userId: 'user-owner', versionId: 'ver_aaaaaaaa',
      locationId: 'loc_aaaaaaaa', stageId: 'stage_aaaaaaaa',
      selectedClueId: 'clue_aaaaaaaa',
      eligibleClueIds: ['clue_aaaaaaaa'], mode: 'fixed_sequence',
      perPlayerLimit: 1, globalLimit: 1,
    }), true);
    assert.equal(searchLocation({
      code: code!, userId: 'user-owner', versionId: 'ver_aaaaaaaa',
      locationId: 'loc_aaaaaaaa', stageId: 'stage_aaaaaaaa',
      selectedClueId: 'clue_bbbbbbbb',
      eligibleClueIds: ['clue_bbbbbbbb'], mode: 'fixed_sequence',
      perPlayerLimit: 1, globalLimit: 1,
    }), false);
    assert.equal(publishHeldClue(code!, 'user-other', 'clue_aaaaaaaa'), false);
    assert.equal(publishHeldClue(code!, 'user-owner', 'clue_aaaaaaaa'), true);
    assert.equal(publishHeldClue(code!, 'user-owner', 'clue_aaaaaaaa'), false);
    const version = database.prepare(
      'SELECT authorization_version AS value FROM rooms WHERE code = ?',
    ).get(code) as { value: number };
    assert.equal(advanceRoom({
      code: code!, ownerUserId: 'user-owner', versionId: 'ver_aaaaaaaa',
      authorizationVersion: version.value, currentStageId: 'stage_aaaaaaaa',
      releaseIds: [], nextStage: null,
    }), true);
    assert.equal(advanceRoom({
      code: code!, ownerUserId: 'user-owner', versionId: 'ver_aaaaaaaa',
      authorizationVersion: version.value, currentStageId: 'stage_aaaaaaaa',
      releaseIds: [], nextStage: null,
    }), false);
  } finally {
    closeDatabase?.();
    const resolved = realpathSync(temporaryRoot);
    const expectedPrefix = `${realpathSync(os.tmpdir())}${path.sep}`;
    if (!resolved.startsWith(expectedPrefix) || !path.basename(resolved).startsWith('wisteria-room-test-')) {
      throw new Error('UNSAFE_TEST_CLEANUP_TARGET');
    }
    rmSync(resolved, { recursive: true, force: false });
  }
});
