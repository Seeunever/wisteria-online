import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { getDatabase } from './db.ts';

const ROOM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function newRoomCode() {
  const bytes = randomBytes(6);
  return Array.from(bytes, (value) => ROOM_ALPHABET[value % ROOM_ALPHABET.length]).join('');
}

export function createRoom(ownerUserId: string, versionId?: string) {
  if (versionId !== undefined && !/^ver_[0-9a-f]{8,64}$/.test(versionId)) return null;
  const database = getDatabase();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = randomUUID();
    const code = newRoomCode();
    const now = Date.now();
    try {
      database.exec('BEGIN IMMEDIATE');
      if (versionId) {
        const inserted = database.prepare(`
          INSERT INTO rooms (id, code, owner_user_id, version_id, status, created_at)
          SELECT ?, ?, ?, id, 'lobby', ?
          FROM pack_versions
          WHERE id = ? AND state = 'frozen'
        `).run(id, code, ownerUserId, now, versionId);
        if (inserted.changes !== 1) {
          database.exec('ROLLBACK');
          return null;
        }
      } else {
        database.prepare(`
          INSERT INTO rooms (id, code, owner_user_id, status, created_at)
          VALUES (?, ?, ?, 'lobby', ?)
        `).run(id, code, ownerUserId, now);
      }
      database.prepare(`
        INSERT INTO memberships (id, room_id, user_id, joined_at)
        VALUES (?, ?, ?, ?)
      `).run(randomUUID(), id, ownerUserId, now);
      database.exec('COMMIT');
      return code;
    } catch {
      try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    }
  }
  return null;
}

export function joinRoom(userId: string, rawCode: string) {
  const code = rawCode.normalize('NFKC').trim().toUpperCase();
  if (!/^[23456789A-HJ-NP-Z]{6}$/.test(code)) return false;
  const database = getDatabase();
  try {
    database.exec('BEGIN IMMEDIATE');
    const room = database.prepare(
      "SELECT id FROM rooms WHERE code = ? AND status = 'lobby'",
    ).get(code) as { id: string } | undefined;
    if (!room) {
      database.exec('ROLLBACK');
      return false;
    }
    const joined = database.prepare(`
      INSERT INTO memberships (id, room_id, user_id, joined_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(room_id, user_id) DO UPDATE SET left_at = NULL
      WHERE memberships.left_at IS NOT NULL
    `).run(randomUUID(), room.id, userId, Date.now());
    if (joined.changes === 1) {
      database.prepare(`
        UPDATE rooms SET authorization_version = authorization_version + 1 WHERE id = ?
      `).run(room.id);
    }
    database.exec('COMMIT');
    return true;
  } catch {
    try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    return false;
  }
}

export function listRooms(userId: string) {
  return getDatabase().prepare(`
    SELECT rooms.code, rooms.status, rooms.created_at AS createdAt,
           pack_versions.public_label AS packLabel,
           rooms.owner_user_id = ? AS isOwner,
           COUNT(active.id) AS memberCount
    FROM memberships mine
    JOIN rooms ON rooms.id = mine.room_id
    LEFT JOIN pack_versions ON pack_versions.id = rooms.version_id
    LEFT JOIN memberships active ON active.room_id = rooms.id AND active.left_at IS NULL
    WHERE mine.user_id = ? AND mine.left_at IS NULL
    GROUP BY rooms.id
    ORDER BY rooms.created_at DESC
  `).all(userId, userId) as Array<{
    code: string;
    status: string;
    createdAt: number;
    packLabel: string | null;
    isOwner: number;
    memberCount: number;
  }>;
}

export function getRoomForMember(codeInput: string, userId: string) {
  const code = codeInput.toUpperCase();
  const room = getDatabase().prepare(`
    SELECT rooms.id, rooms.code, rooms.status, rooms.owner_user_id AS ownerUserId,
           rooms.version_id AS versionId, rooms.authorization_version AS authorizationVersion,
           pack_versions.public_label AS packLabel,
           EXISTS (
             SELECT 1 FROM room_events
             WHERE room_events.room_id = rooms.id
               AND room_events.event_type = 'room_force_started'
           ) AS incompleteStart,
           memberships.id AS membershipId, role_assignments.role_id AS assignedRoleId
    FROM rooms
    JOIN memberships ON memberships.room_id = rooms.id
    LEFT JOIN pack_versions ON pack_versions.id = rooms.version_id
    LEFT JOIN role_assignments
      ON role_assignments.room_id = rooms.id
      AND role_assignments.membership_id = memberships.id
    WHERE rooms.code = ? AND memberships.user_id = ? AND memberships.left_at IS NULL
  `).get(code, userId) as {
    id: string;
    code: string;
    status: string;
    ownerUserId: string;
    versionId: string | null;
    packLabel: string | null;
    incompleteStart: number;
    authorizationVersion: number;
    membershipId: string;
    assignedRoleId: string | null;
  } | undefined;
  if (!room) return null;
  const members = getDatabase().prepare(`
    SELECT memberships.id AS membershipId, users.display_name AS displayName,
           memberships.joined_at AS joinedAt,
           role_assignments.role_id AS assignedRoleId
    FROM memberships
    JOIN users ON users.id = memberships.user_id
    LEFT JOIN role_assignments
      ON role_assignments.room_id = memberships.room_id
      AND role_assignments.membership_id = memberships.id
    WHERE memberships.room_id = ? AND memberships.left_at IS NULL
    ORDER BY memberships.joined_at
  `).all(room.id) as Array<{
    membershipId: string;
    displayName: string;
    joinedAt: number;
    assignedRoleId: string | null;
  }>;
  const reachedStages = getDatabase().prepare(`
    SELECT stage_id AS stageId, sequence, completed_at AS completedAt
    FROM room_stages
    WHERE room_id = ?
    ORDER BY sequence
  `).all(room.id) as Array<{ stageId: string; sequence: number; completedAt: number | null }>;
  const clues = getDatabase().prepare(`
    SELECT clue_id AS clueId,
           holder_membership_id = ? AS isHeld,
           published_at AS publishedAt
    FROM clue_holdings
    WHERE room_id = ? AND (holder_membership_id = ? OR published_at IS NOT NULL)
  `).all(room.membershipId, room.id, room.membershipId) as Array<{
    clueId: string;
    isHeld: number;
    publishedAt: number | null;
  }>;
  const roomHeldClueIds = (getDatabase().prepare(`
    SELECT clue_id AS clueId FROM clue_holdings WHERE room_id = ?
  `).all(room.id) as Array<{ clueId: string }>).map((item) => item.clueId);
  const hostReleaseIds = (getDatabase().prepare(`
    SELECT release_id AS releaseId FROM room_host_releases WHERE room_id = ?
  `).all(room.id) as Array<{ releaseId: string }>).map((item) => item.releaseId);
  return { ...room, members, reachedStages, clues, roomHeldClueIds, hostReleaseIds };
}

export function attachFrozenPackToRoom(codeInput: string, ownerUserId: string, versionId: string) {
  const code = codeInput.normalize('NFKC').trim().toUpperCase();
  if (!/^[23456789A-HJ-NP-Z]{6}$/.test(code) || !/^ver_[0-9a-f]{8,64}$/.test(versionId)) {
    return false;
  }
  const database = getDatabase();
  try {
    database.exec('BEGIN IMMEDIATE');
    const result = database.prepare(`
      UPDATE rooms
      SET version_id = ?, authorization_version = authorization_version + 1
      WHERE code = ?
        AND owner_user_id = ?
        AND status = 'lobby'
        AND version_id IS NULL
        AND EXISTS (
          SELECT 1 FROM pack_versions
          WHERE pack_versions.id = ? AND pack_versions.state = 'frozen'
        )
    `).run(versionId, code, ownerUserId, versionId);
    if (result.changes !== 1) {
      database.exec('ROLLBACK');
      return false;
    }
    database.exec('COMMIT');
    return true;
  } catch {
    try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    return false;
  }
}

export function claimRole(codeInput: string, userId: string, roleId: string) {
  const code = codeInput.normalize('NFKC').trim().toUpperCase();
  if (!/^[23456789A-HJ-NP-Z]{6}$/.test(code) || !/^role_[0-9a-f]{8,64}$/.test(roleId)) {
    return false;
  }
  const database = getDatabase();
  try {
    database.exec('BEGIN IMMEDIATE');
    const result = database.prepare(`
      INSERT INTO role_assignments (room_id, role_id, membership_id, assigned_at)
      SELECT rooms.id, ?, memberships.id, ?
      FROM rooms
      JOIN memberships ON memberships.room_id = rooms.id
      WHERE rooms.code = ?
        AND rooms.status = 'lobby'
        AND rooms.version_id IS NOT NULL
        AND memberships.user_id = ?
        AND memberships.left_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM role_assignments existing
          WHERE existing.membership_id = memberships.id
        )
    `).run(roleId, Date.now(), code, userId);
    if (result.changes !== 1) {
      database.exec('ROLLBACK');
      return false;
    }
    database.prepare(`
      UPDATE rooms SET authorization_version = authorization_version + 1 WHERE code = ?
    `).run(code);
    database.exec('COMMIT');
    return true;
  } catch {
    try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    return false;
  }
}

export function startRoom(
  codeInput: string,
  ownerUserId: string,
  versionId: string,
  requiredRoleIds: string[],
  firstStageId: string,
  firstStageSequence: number,
  expectedAuthorizationVersion: number,
  allowIncompleteRoles = false,
) {
  const code = codeInput.normalize('NFKC').trim().toUpperCase();
  if (
    !/^[23456789A-HJ-NP-Z]{6}$/.test(code)
    || !/^ver_[0-9a-f]{8,64}$/.test(versionId)
    || !/^stage_[0-9a-f]{8,64}$/.test(firstStageId)
    || !Number.isInteger(firstStageSequence)
    || firstStageSequence !== 1
    || !Number.isInteger(expectedAuthorizationVersion)
    || expectedAuthorizationVersion < 1
    || requiredRoleIds.length === 0
    || requiredRoleIds.some((id) => !/^role_[0-9a-f]{8,64}$/.test(id))
    || new Set(requiredRoleIds).size !== requiredRoleIds.length
    || typeof allowIncompleteRoles !== 'boolean'
  ) return false;

  const database = getDatabase();
  try {
    database.exec('BEGIN IMMEDIATE');
    const room = database.prepare(`
      SELECT rooms.id, memberships.id AS actorMembershipId
      FROM rooms
      JOIN memberships ON memberships.room_id = rooms.id
        AND memberships.user_id = rooms.owner_user_id
        AND memberships.left_at IS NULL
      WHERE rooms.code = ? AND rooms.owner_user_id = ?
        AND rooms.version_id = ? AND rooms.status = 'lobby'
        AND rooms.authorization_version = ?
    `).get(code, ownerUserId, versionId, expectedAuthorizationVersion) as {
      id: string;
      actorMembershipId: string;
    } | undefined;
    if (!room) {
      database.exec('ROLLBACK');
      return false;
    }
    const assigned = database.prepare(`
      SELECT role_assignments.role_id AS roleId
      FROM role_assignments
      JOIN memberships
        ON memberships.id = role_assignments.membership_id
        AND memberships.room_id = role_assignments.room_id
        AND memberships.left_at IS NULL
      WHERE role_assignments.room_id = ?
      ORDER BY role_assignments.role_id
    `).all(room.id) as Array<{ roleId: string }>;
    const actual = assigned.map((item) => item.roleId).sort();
    const expected = [...requiredRoleIds].sort();
    const expectedSet = new Set(expected);
    const allRolesAssigned = actual.length === expected.length
      && actual.every((roleId, index) => roleId === expected[index]);
    const validAssignedSubset = actual.length > 0
      && actual.every((roleId) => expectedSet.has(roleId));
    if (!validAssignedSubset || (!allRolesAssigned && !allowIncompleteRoles)) {
      database.exec('ROLLBACK');
      return false;
    }
    const now = Date.now();
    if (!allRolesAssigned) {
      database.prepare(`
        INSERT INTO room_events
          (id, room_id, actor_membership_id, event_type, object_id, event_payload, created_at)
        VALUES (?, ?, ?, 'room_force_started', NULL, '{}', ?)
      `).run(randomUUID(), room.id, room.actorMembershipId, now);
    }
    database.prepare(`
      INSERT INTO room_stages (room_id, stage_id, sequence, entered_at)
      VALUES (?, ?, ?, ?)
    `).run(room.id, firstStageId, firstStageSequence, now);
    database.prepare(`
      UPDATE rooms
      SET status = 'running', authorization_version = authorization_version + 1
      WHERE id = ?
    `).run(room.id);
    database.exec('COMMIT');
    return true;
  } catch {
    try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    return false;
  }
}

export function searchLocation(input: {
  code: string;
  userId: string;
  versionId: string;
  locationId: string;
  stageId: string;
  eligibleClueIds: string[];
  mode: 'draw_without_replacement' | 'fixed_sequence';
  perPlayerLimit: number | null;
  globalLimit: number | null;
}) {
  if (
    !/^[23456789A-HJ-NP-Z]{6}$/.test(input.code)
    || !/^ver_[0-9a-f]{8,64}$/.test(input.versionId)
    || !/^loc_[0-9a-f]{8,64}$/.test(input.locationId)
    || !/^stage_[0-9a-f]{8,64}$/.test(input.stageId)
    || input.eligibleClueIds.length === 0
    || input.eligibleClueIds.some((id) => !/^clue_[0-9a-f]{8,64}$/.test(id))
    || new Set(input.eligibleClueIds).size !== input.eligibleClueIds.length
  ) return false;
  const perPlayerLimit = input.perPlayerLimit ?? 2147483647;
  const globalLimit = input.globalLimit ?? 2147483647;
  if (!Number.isInteger(perPlayerLimit) || perPlayerLimit < 1 || !Number.isInteger(globalLimit) || globalLimit < 1) {
    return false;
  }

  const database = getDatabase();
  try {
    database.exec('BEGIN IMMEDIATE');
    const state = database.prepare(`
      SELECT rooms.id AS roomId, memberships.id AS membershipId
      FROM rooms
      JOIN memberships ON memberships.room_id = rooms.id
      JOIN role_assignments ON role_assignments.membership_id = memberships.id
        AND role_assignments.room_id = rooms.id
      JOIN room_stages ON room_stages.room_id = rooms.id
        AND room_stages.stage_id = ? AND room_stages.completed_at IS NULL
      WHERE rooms.code = ? AND rooms.version_id = ? AND rooms.status = 'running'
        AND memberships.user_id = ? AND memberships.left_at IS NULL
    `).get(input.stageId, input.code, input.versionId, input.userId) as {
      roomId: string;
      membershipId: string;
    } | undefined;
    if (!state) {
      database.exec('ROLLBACK');
      return false;
    }

    const personal = database.prepare(`
      INSERT INTO search_uses (room_id, location_id, stage_id, membership_id, uses)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(room_id, location_id, stage_id, membership_id)
      DO UPDATE SET uses = uses + 1 WHERE uses < ?
    `).run(state.roomId, input.locationId, input.stageId, state.membershipId, perPlayerLimit);
    const global = database.prepare(`
      INSERT INTO location_search_totals (room_id, location_id, stage_id, uses)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(room_id, location_id, stage_id)
      DO UPDATE SET uses = uses + 1 WHERE uses < ?
    `).run(state.roomId, input.locationId, input.stageId, globalLimit);
    if (personal.changes !== 1 || global.changes !== 1) {
      database.exec('ROLLBACK');
      return false;
    }

    const held = new Set((database.prepare(`
      SELECT clue_id AS clueId FROM clue_holdings WHERE room_id = ?
    `).all(state.roomId) as Array<{ clueId: string }>).map((item) => item.clueId));
    const candidates = input.eligibleClueIds.filter((clueId) => !held.has(clueId));
    if (!candidates.length) {
      database.exec('ROLLBACK');
      return false;
    }
    const clueId = input.mode === 'fixed_sequence'
      ? candidates[0]
      : candidates[randomInt(candidates.length)];
    database.prepare(`
      INSERT INTO clue_holdings (room_id, clue_id, holder_membership_id, acquired_at)
      VALUES (?, ?, ?, ?)
    `).run(state.roomId, clueId, state.membershipId, Date.now());
    database.prepare(`
      UPDATE rooms SET authorization_version = authorization_version + 1 WHERE id = ?
    `).run(state.roomId);
    database.exec('COMMIT');
    return true;
  } catch {
    try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    return false;
  }
}

export function dealLocationClue(input: {
  code: string;
  ownerUserId: string;
  versionId: string;
  authorizationVersion: number;
  locationId: string;
  stageId: string;
  targetMembershipId: string;
  eligibleClueIds: string[];
  perPlayerLimit: number | null;
  globalLimit: number | null;
}) {
  if (
    !/^[23456789A-HJ-NP-Z]{6}$/.test(input.code)
    || !/^ver_[0-9a-f]{8,64}$/.test(input.versionId)
    || !/^loc_[0-9a-f]{8,64}$/.test(input.locationId)
    || !/^stage_[0-9a-f]{8,64}$/.test(input.stageId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.targetMembershipId,
    )
    || !Number.isInteger(input.authorizationVersion)
    || input.authorizationVersion < 1
    || input.eligibleClueIds.length === 0
    || input.eligibleClueIds.some((id) => !/^clue_[0-9a-f]{8,64}$/.test(id))
  ) return false;
  const perPlayerLimit = input.perPlayerLimit ?? 2147483647;
  const globalLimit = input.globalLimit ?? 2147483647;
  if (!Number.isInteger(perPlayerLimit) || perPlayerLimit < 1 || !Number.isInteger(globalLimit) || globalLimit < 1) {
    return false;
  }

  const database = getDatabase();
  try {
    database.exec('BEGIN IMMEDIATE');
    const state = database.prepare(`
      SELECT rooms.id AS roomId, owner_membership.id AS actorMembershipId
      FROM rooms
      JOIN memberships owner_membership ON owner_membership.room_id = rooms.id
        AND owner_membership.user_id = rooms.owner_user_id AND owner_membership.left_at IS NULL
      JOIN room_stages ON room_stages.room_id = rooms.id
        AND room_stages.stage_id = ? AND room_stages.completed_at IS NULL
      WHERE rooms.code = ? AND rooms.owner_user_id = ? AND rooms.version_id = ?
        AND rooms.status = 'running' AND rooms.authorization_version = ?
    `).get(
      input.stageId,
      input.code,
      input.ownerUserId,
      input.versionId,
      input.authorizationVersion,
    ) as { roomId: string; actorMembershipId: string } | undefined;
    if (!state) {
      database.exec('ROLLBACK');
      return false;
    }
    const target = database.prepare(`
      SELECT memberships.id
      FROM memberships
      JOIN role_assignments ON role_assignments.room_id = memberships.room_id
        AND role_assignments.membership_id = memberships.id
      WHERE memberships.id = ? AND memberships.room_id = ? AND memberships.left_at IS NULL
    `).get(input.targetMembershipId, state.roomId) as { id: string } | undefined;
    if (!target) {
      database.exec('ROLLBACK');
      return false;
    }
    const personal = database.prepare(`
      INSERT INTO search_uses (room_id, location_id, stage_id, membership_id, uses)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(room_id, location_id, stage_id, membership_id)
      DO UPDATE SET uses = uses + 1 WHERE uses < ?
    `).run(state.roomId, input.locationId, input.stageId, target.id, perPlayerLimit);
    const global = database.prepare(`
      INSERT INTO location_search_totals (room_id, location_id, stage_id, uses)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(room_id, location_id, stage_id)
      DO UPDATE SET uses = uses + 1 WHERE uses < ?
    `).run(state.roomId, input.locationId, input.stageId, globalLimit);
    if (personal.changes !== 1 || global.changes !== 1) {
      database.exec('ROLLBACK');
      return false;
    }
    const held = new Set((database.prepare(`
      SELECT clue_id AS clueId FROM clue_holdings WHERE room_id = ?
    `).all(state.roomId) as Array<{ clueId: string }>).map((item) => item.clueId));
    const clueId = input.eligibleClueIds.find((candidate) => !held.has(candidate));
    if (!clueId) {
      database.exec('ROLLBACK');
      return false;
    }
    const now = Date.now();
    database.prepare(`
      INSERT INTO clue_holdings (room_id, clue_id, holder_membership_id, acquired_at)
      VALUES (?, ?, ?, ?)
    `).run(state.roomId, clueId, target.id, now);
    database.prepare(`
      INSERT INTO room_events
        (id, room_id, actor_membership_id, event_type, object_id, event_payload, created_at)
      VALUES (?, ?, ?, 'clue_acquired', ?, '{}', ?)
    `).run(randomUUID(), state.roomId, state.actorMembershipId, clueId, now);
    database.prepare(`
      UPDATE rooms SET authorization_version = authorization_version + 1 WHERE id = ?
    `).run(state.roomId);
    database.exec('COMMIT');
    return true;
  } catch {
    try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    return false;
  }
}

export function publishHeldClue(codeInput: string, userId: string, clueId: string) {
  const code = codeInput.normalize('NFKC').trim().toUpperCase();
  if (!/^[23456789A-HJ-NP-Z]{6}$/.test(code) || !/^clue_[0-9a-f]{8,64}$/.test(clueId)) {
    return false;
  }
  const database = getDatabase();
  try {
    database.exec('BEGIN IMMEDIATE');
    const result = database.prepare(`
      UPDATE clue_holdings
      SET published_at = ?
      WHERE clue_id = ? AND published_at IS NULL
        AND room_id = (SELECT id FROM rooms WHERE code = ? AND status = 'running')
        AND holder_membership_id = (
          SELECT memberships.id FROM memberships
          JOIN rooms ON rooms.id = memberships.room_id
          WHERE rooms.code = ? AND memberships.user_id = ? AND memberships.left_at IS NULL
        )
    `).run(Date.now(), clueId, code, code, userId);
    if (result.changes !== 1) {
      database.exec('ROLLBACK');
      return false;
    }
    database.prepare(`
      UPDATE rooms SET authorization_version = authorization_version + 1 WHERE code = ?
    `).run(code);
    database.exec('COMMIT');
    return true;
  } catch {
    try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    return false;
  }
}

export function advanceRoom(input: {
  code: string;
  ownerUserId: string;
  versionId: string;
  authorizationVersion: number;
  currentStageId: string;
  releaseIds: string[];
  nextStage: { stageId: string; sequence: number } | null;
}) {
  if (
    !/^[23456789A-HJ-NP-Z]{6}$/.test(input.code)
    || !/^ver_[0-9a-f]{8,64}$/.test(input.versionId)
    || !/^stage_[0-9a-f]{8,64}$/.test(input.currentStageId)
    || !Number.isInteger(input.authorizationVersion)
    || input.authorizationVersion < 1
    || input.releaseIds.some((id) => !/^release_[0-9a-f]{8,64}$/.test(id))
    || new Set(input.releaseIds).size !== input.releaseIds.length
    || (input.nextStage !== null && (
      !/^stage_[0-9a-f]{8,64}$/.test(input.nextStage.stageId)
      || !Number.isInteger(input.nextStage.sequence)
      || input.nextStage.sequence < 2
    ))
  ) return false;
  const database = getDatabase();
  try {
    database.exec('BEGIN IMMEDIATE');
    const room = database.prepare(`
      SELECT rooms.id
      FROM rooms
      JOIN room_stages ON room_stages.room_id = rooms.id
        AND room_stages.stage_id = ? AND room_stages.completed_at IS NULL
      WHERE rooms.code = ? AND rooms.owner_user_id = ? AND rooms.version_id = ?
        AND rooms.status = 'running' AND rooms.authorization_version = ?
    `).get(
      input.currentStageId,
      input.code,
      input.ownerUserId,
      input.versionId,
      input.authorizationVersion,
    ) as { id: string } | undefined;
    if (!room) {
      database.exec('ROLLBACK');
      return false;
    }
    const now = Date.now();
    const insertRelease = database.prepare(`
      INSERT OR IGNORE INTO room_host_releases (room_id, release_id, released_at)
      VALUES (?, ?, ?)
    `);
    for (const releaseId of input.releaseIds) insertRelease.run(room.id, releaseId, now);
    database.prepare(`
      UPDATE room_stages SET completed_at = ? WHERE room_id = ? AND stage_id = ?
    `).run(now, room.id, input.currentStageId);
    if (input.nextStage) {
      database.prepare(`
        INSERT INTO room_stages (room_id, stage_id, sequence, entered_at)
        VALUES (?, ?, ?, ?)
      `).run(room.id, input.nextStage.stageId, input.nextStage.sequence, now);
    }
    database.prepare(`
      UPDATE rooms
      SET status = ?, authorization_version = authorization_version + 1
      WHERE id = ?
    `).run(input.nextStage ? 'running' : 'completed', room.id);
    database.exec('COMMIT');
    return true;
  } catch {
    try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    return false;
  }
}
