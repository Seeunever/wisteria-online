import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('only the room owner can lock one frozen version into a lobby', async () => {
  const temporaryRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wisteria-room-test-')));
  process.env.WISTERIA_DATA_DIR = temporaryRoot;
  let closeDatabase: (() => void) | undefined;
  try {
    const [{ getDatabase }, {
      attachFrozenPackToRoom,
      advanceRoom,
      claimRole,
      createRoom,
      publishHeldClue,
      searchLocation,
      startRoom,
    }] = await Promise.all([
      import('../lib/db.ts'),
      import('../lib/rooms.ts'),
    ]);
    const database = getDatabase();
    closeDatabase = () => database.close();
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
    ), true);
    assert.equal(startRoom(
      code!, 'user-owner', 'ver_aaaaaaaa', ['role_aaaaaaaa'], 'stage_aaaaaaaa', 1,
    ), false);
    assert.equal(searchLocation({
      code: code!, userId: 'user-owner', versionId: 'ver_aaaaaaaa',
      locationId: 'loc_aaaaaaaa', stageId: 'stage_aaaaaaaa',
      eligibleClueIds: ['clue_aaaaaaaa'], mode: 'fixed_sequence',
      perPlayerLimit: 1, globalLimit: 1,
    }), true);
    assert.equal(searchLocation({
      code: code!, userId: 'user-owner', versionId: 'ver_aaaaaaaa',
      locationId: 'loc_aaaaaaaa', stageId: 'stage_aaaaaaaa',
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
