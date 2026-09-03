import { randomBytes, randomUUID } from 'node:crypto';
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
           mine.id IS NOT NULL AS isMember,
           COUNT(active.id) AS memberCount
    FROM rooms
    LEFT JOIN memberships mine
      ON mine.room_id = rooms.id AND mine.user_id = ? AND mine.left_at IS NULL
    LEFT JOIN pack_versions ON pack_versions.id = rooms.version_id
    LEFT JOIN memberships active ON active.room_id = rooms.id AND active.left_at IS NULL
    WHERE rooms.status != 'completed' OR mine.id IS NOT NULL
    GROUP BY rooms.id
    ORDER BY (mine.id IS NOT NULL) DESC, rooms.created_at DESC
  `).all(userId, userId) as Array<{
    code: string;
    status: string;
    createdAt: number;
    packLabel: string | null;
    isOwner: number;
    isMember: number;
    memberCount: number;
  }>;
}

export function deleteRoom(codeInput: string, memberUserId: string) {
  const code = codeInput.normalize('NFKC').trim().toUpperCase();
  if (!/^[23456789A-HJ-NP-Z]{6}$/.test(code)) return false;

  const database = getDatabase();
  try {
    database.exec('BEGIN IMMEDIATE');
    const deleted = database.prepare(`
      DELETE FROM rooms
      WHERE code = ?
        AND EXISTS (
          SELECT 1 FROM memberships
          WHERE memberships.room_id = rooms.id
            AND memberships.user_id = ?
            AND memberships.left_at IS NULL
        )
    `).run(code, memberUserId);
    if (deleted.changes !== 1) {
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
  const memberRows = getDatabase().prepare(`
    SELECT memberships.id AS membershipId, users.display_name AS displayName,
           memberships.joined_at AS joinedAt,
           memberships.user_id = ? AS isOwner,
           role_assignments.role_id AS assignedRoleId
    FROM memberships
    JOIN users ON users.id = memberships.user_id
    LEFT JOIN role_assignments
      ON role_assignments.room_id = memberships.room_id
      AND role_assignments.membership_id = memberships.id
    WHERE memberships.room_id = ? AND memberships.left_at IS NULL
    ORDER BY memberships.joined_at
  `).all(room.ownerUserId, room.id) as Array<{
    membershipId: string;
    displayName: string;
    joinedAt: number;
    isOwner: number;
    assignedRoleId: string | null;
  }>;
  const heldRows = getDatabase().prepare(`
    SELECT holder_membership_id AS membershipId, clue_id AS clueId
    FROM clue_holdings
    WHERE room_id = ?
    ORDER BY acquired_at, clue_id
  `).all(room.id) as Array<{ membershipId: string; clueId: string }>;
  const heldByMembership = new Map<string, string[]>();
  for (const row of heldRows) {
    const held = heldByMembership.get(row.membershipId) ?? [];
    held.push(row.clueId);
    heldByMembership.set(row.membershipId, held);
  }
  const members = memberRows.map((member) => ({
    ...member,
    heldClueIds: heldByMembership.get(member.membershipId) ?? [],
  }));
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
  const investigationCompletedStageIds = (getDatabase().prepare(`
    SELECT stage_id AS stageId
    FROM investigation_stage_completions
    WHERE room_id = ?
  `).all(room.id) as Array<{ stageId: string }>).map((item) => item.stageId);
  return {
    ...room,
    members,
    reachedStages,
    clues,
    roomHeldClueIds,
    hostReleaseIds,
    investigationCompletedStageIds,
  };
}

export type InvestigationState = {
  roundNumber: number;
  selectedLocationId: string | null;
  currentTurnMembershipId: string | null;
  tieBreakMembershipId: string | null;
  votes: Array<{ membershipId: string; locationId: string }>;
  searchedLocationIds: string[];
  acquisitionsThisStage: number;
  roomQuotaReached: boolean;
  hasPublicationObligation: boolean;
  completionVoteMembershipIds: string[];
  stageCompleted: boolean;
};

function hasPublicationObligation(
  database: ReturnType<typeof getDatabase>,
  roomId: string,
  membershipId: string,
  stageId: string,
  maxPrivateCount: number,
  mandatoryClueIds: string[],
) {
  const row = database.prepare(`
    SELECT 1
    FROM investigation_acquisitions
    JOIN clue_holdings
      ON clue_holdings.room_id = investigation_acquisitions.room_id
      AND clue_holdings.clue_id = investigation_acquisitions.clue_id
    WHERE investigation_acquisitions.room_id = ?
      AND investigation_acquisitions.membership_id = ?
      AND investigation_acquisitions.stage_id = ?
      AND clue_holdings.published_at IS NULL
    GROUP BY investigation_acquisitions.stage_id, investigation_acquisitions.round_number
    HAVING COUNT(*) > ?
    LIMIT 1
  `).get(roomId, membershipId, stageId, maxPrivateCount);
  if (row) return true;
  if (!mandatoryClueIds.length) return false;
  const placeholders = mandatoryClueIds.map(() => '?').join(', ');
  const mandatory = database.prepare(`
    SELECT 1 FROM clue_holdings
    WHERE room_id = ? AND holder_membership_id = ? AND published_at IS NULL
      AND clue_id IN (${placeholders})
    LIMIT 1
  `).get(roomId, membershipId, ...mandatoryClueIds);
  return Boolean(mandatory);
}

function stageAcquisitionCounts(
  database: ReturnType<typeof getDatabase>,
  roomId: string,
  stageId: string,
) {
  return new Map((database.prepare(`
    SELECT memberships.id AS membershipId,
           COUNT(investigation_acquisitions.clue_id) AS acquiredCount
    FROM memberships
    JOIN role_assignments ON role_assignments.room_id = memberships.room_id
      AND role_assignments.membership_id = memberships.id
    LEFT JOIN investigation_acquisitions
      ON investigation_acquisitions.room_id = memberships.room_id
      AND investigation_acquisitions.membership_id = memberships.id
      AND investigation_acquisitions.stage_id = ?
    WHERE memberships.room_id = ? AND memberships.left_at IS NULL
    GROUP BY memberships.id
  `).all(stageId, roomId) as Array<{
    membershipId: string;
    acquiredCount: number;
  }>).map((row) => [row.membershipId, row.acquiredCount]));
}

export function getInvestigationState(input: {
  roomId: string;
  membershipId: string;
  stageId: string;
  scope: 'room_scoped' | 'stage_scoped';
  perPlayerStageLimit?: number;
  maxPrivateCount: number;
  mandatoryClueIds: string[];
}) : InvestigationState {
  const database = getDatabase();
  const perPlayerStageLimit = input.perPlayerStageLimit ?? Number.MAX_SAFE_INTEGER;
  const current = database.prepare(`
    SELECT round_number AS roundNumber, selected_location_id AS selectedLocationId,
           cursor_membership_id AS currentTurnMembershipId,
           tie_break_membership_id AS tieBreakMembershipId
    FROM investigation_rounds
    WHERE room_id = ? AND stage_id = ? AND completed_at IS NULL
    ORDER BY round_number DESC
    LIMIT 1
  `).get(input.roomId, input.stageId) as {
    roundNumber: number;
    selectedLocationId: string | null;
    currentTurnMembershipId: string | null;
    tieBreakMembershipId: string;
  } | undefined;
  const latest = database.prepare(`
    SELECT COALESCE(MAX(round_number), 0) AS latest
    FROM investigation_rounds WHERE room_id = ? AND stage_id = ?
  `).get(input.roomId, input.stageId) as { latest: number };
  const roundNumber = current?.roundNumber ?? latest.latest + 1;
  const votes = current ? database.prepare(`
    SELECT membership_id AS membershipId, location_id AS locationId
    FROM investigation_votes
    WHERE room_id = ? AND stage_id = ? AND round_number = ?
    ORDER BY voted_at, membership_id
  `).all(input.roomId, input.stageId, current.roundNumber) as Array<{
    membershipId: string;
    locationId: string;
  }> : [];
  const searchedLocationIds = (database.prepare(input.scope === 'room_scoped' ? `
    SELECT DISTINCT selected_location_id AS locationId
    FROM investigation_rounds
    WHERE room_id = ? AND selected_location_id IS NOT NULL
  ` : `
    SELECT DISTINCT selected_location_id AS locationId
    FROM investigation_rounds
    WHERE room_id = ? AND stage_id = ? AND selected_location_id IS NOT NULL
  `).all(...(input.scope === 'room_scoped'
    ? [input.roomId]
    : [input.roomId, input.stageId])) as Array<{ locationId: string }>).map((row) => row.locationId);
  const completionVoteMembershipIds = (database.prepare(`
    SELECT votes.membership_id AS membershipId
    FROM investigation_completion_votes votes
    JOIN rooms ON rooms.id = votes.room_id
    WHERE votes.room_id = ? AND votes.stage_id = ? AND votes.consent = 1
      AND votes.authorization_version = rooms.authorization_version
    ORDER BY votes.voted_at, votes.membership_id
  `).all(input.roomId, input.stageId) as Array<{ membershipId: string }>).map(
    (row) => row.membershipId,
  );
  const stageCompleted = Boolean(database.prepare(`
    SELECT 1 FROM investigation_stage_completions
    WHERE room_id = ? AND stage_id = ?
  `).get(input.roomId, input.stageId));
  const acquisitionCounts = stageAcquisitionCounts(database, input.roomId, input.stageId);
  return {
    roundNumber,
    selectedLocationId: current?.selectedLocationId ?? null,
    currentTurnMembershipId: current?.currentTurnMembershipId ?? null,
    tieBreakMembershipId: current?.tieBreakMembershipId ?? null,
    votes,
    searchedLocationIds,
    acquisitionsThisStage: acquisitionCounts.get(input.membershipId) ?? 0,
    roomQuotaReached: acquisitionCounts.size > 0 && [...acquisitionCounts.values()].every(
      (count) => count >= perPlayerStageLimit,
    ),
    hasPublicationObligation: hasPublicationObligation(
      database,
      input.roomId,
      input.membershipId,
      input.stageId,
      input.maxPrivateCount,
      input.mandatoryClueIds,
    ),
    completionVoteMembershipIds,
    stageCompleted,
  };
}

export function voteInvestigationLocation(input: {
  code: string;
  userId: string;
  versionId: string;
  authorizationVersion: number;
  stageId: string;
  locationId: string;
  eligibleLocationIds: string[];
  actorEligibleLocationIds: string[];
  orderedMembershipIds: string[];
  scope: 'room_scoped' | 'stage_scoped';
  maxPrivateCount: number;
  perPlayerStageLimit?: number;
  mandatoryClueIds: string[];
  blockForPublication: boolean;
}) {
  const perPlayerStageLimit = input.perPlayerStageLimit ?? Number.MAX_SAFE_INTEGER;
  if (
    !/^[23456789A-HJ-NP-Z]{6}$/.test(input.code)
    || !/^ver_[0-9a-f]{8,64}$/.test(input.versionId)
    || !/^stage_[0-9a-f]{8,64}$/.test(input.stageId)
    || !/^loc_[0-9a-f]{8,64}$/.test(input.locationId)
    || !Number.isInteger(input.authorizationVersion)
    || input.authorizationVersion < 1
    || !Number.isInteger(input.maxPrivateCount)
    || input.maxPrivateCount < 0
    || !Number.isInteger(perPlayerStageLimit)
    || perPlayerStageLimit < 1
    || input.mandatoryClueIds.some((id) => !/^clue_[0-9a-f]{8,64}$/.test(id))
    || new Set(input.mandatoryClueIds).size !== input.mandatoryClueIds.length
    || !input.actorEligibleLocationIds.includes(input.locationId)
    || input.eligibleLocationIds.length === 0
    || input.eligibleLocationIds.some((id) => !/^loc_[0-9a-f]{8,64}$/.test(id))
    || input.actorEligibleLocationIds.some((id) => !input.eligibleLocationIds.includes(id))
    || new Set(input.eligibleLocationIds).size !== input.eligibleLocationIds.length
    || new Set(input.actorEligibleLocationIds).size !== input.actorEligibleLocationIds.length
    || input.orderedMembershipIds.length === 0
    || new Set(input.orderedMembershipIds).size !== input.orderedMembershipIds.length
  ) return false;
  const database = getDatabase();
  try {
    database.exec('BEGIN IMMEDIATE');
    const actor = database.prepare(`
      SELECT rooms.id AS roomId, memberships.id AS membershipId
      FROM rooms
      JOIN memberships ON memberships.room_id = rooms.id
      JOIN role_assignments ON role_assignments.room_id = rooms.id
        AND role_assignments.membership_id = memberships.id
      JOIN room_stages ON room_stages.room_id = rooms.id
        AND room_stages.stage_id = ? AND room_stages.completed_at IS NULL
      WHERE rooms.code = ? AND rooms.version_id = ? AND rooms.status = 'running'
        AND rooms.authorization_version = ?
        AND memberships.user_id = ? AND memberships.left_at IS NULL
    `).get(input.stageId, input.code, input.versionId, input.authorizationVersion, input.userId) as {
      roomId: string;
      membershipId: string;
    } | undefined;
    if (!actor || !input.orderedMembershipIds.includes(actor.membershipId)) {
      database.exec('ROLLBACK');
      return false;
    }
    if (input.blockForPublication && hasPublicationObligation(
      database, actor.roomId, actor.membershipId, input.stageId,
      input.maxPrivateCount, input.mandatoryClueIds,
    )) {
      database.exec('ROLLBACK');
      return false;
    }
    const assigned = (database.prepare(`
      SELECT memberships.id AS membershipId
      FROM memberships
      JOIN role_assignments ON role_assignments.room_id = memberships.room_id
        AND role_assignments.membership_id = memberships.id
      WHERE memberships.room_id = ? AND memberships.left_at IS NULL
    `).all(actor.roomId) as Array<{ membershipId: string }>).map((row) => row.membershipId).sort();
    if (assigned.length !== input.orderedMembershipIds.length
      || [...input.orderedMembershipIds].sort().some((id, index) => id !== assigned[index])) {
      database.exec('ROLLBACK');
      return false;
    }
    const acquisitionCounts = stageAcquisitionCounts(database, actor.roomId, input.stageId);
    if (input.orderedMembershipIds.every(
      (membershipId) => (acquisitionCounts.get(membershipId) ?? 0) >= perPlayerStageLimit,
    )) {
      database.exec('ROLLBACK');
      return false;
    }
    const alreadySearched = database.prepare(input.scope === 'room_scoped' ? `
      SELECT 1 FROM investigation_rounds
      WHERE room_id = ? AND selected_location_id = ? LIMIT 1
    ` : `
      SELECT 1 FROM investigation_rounds
      WHERE room_id = ? AND stage_id = ? AND selected_location_id = ? LIMIT 1
    `).get(...(input.scope === 'room_scoped'
      ? [actor.roomId, input.locationId]
      : [actor.roomId, input.stageId, input.locationId]));
    if (alreadySearched) {
      database.exec('ROLLBACK');
      return false;
    }
    let round = database.prepare(`
      SELECT round_number AS roundNumber, selected_location_id AS selectedLocationId,
             tie_break_membership_id AS tieBreakMembershipId
      FROM investigation_rounds
      WHERE room_id = ? AND stage_id = ? AND completed_at IS NULL
      ORDER BY round_number DESC LIMIT 1
    `).get(actor.roomId, input.stageId) as {
      roundNumber: number;
      selectedLocationId: string | null;
      tieBreakMembershipId: string;
    } | undefined;
    if (!round) {
      const latest = database.prepare(`
        SELECT COALESCE(MAX(round_number), 0) AS latest
        FROM investigation_rounds WHERE room_id = ? AND stage_id = ?
      `).get(actor.roomId, input.stageId) as { latest: number };
      const roundNumber = latest.latest + 1;
      const tieBreakMembershipId = input.orderedMembershipIds[(roundNumber - 1) % input.orderedMembershipIds.length];
      database.prepare(`
        INSERT INTO investigation_rounds
          (room_id, stage_id, round_number, tie_break_membership_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(actor.roomId, input.stageId, roundNumber, tieBreakMembershipId, Date.now());
      round = { roundNumber, selectedLocationId: null, tieBreakMembershipId };
    }
    if (round.selectedLocationId !== null) {
      database.exec('ROLLBACK');
      return false;
    }
    const eligiblePlaceholders = input.eligibleLocationIds.map(() => '?').join(', ');
    database.prepare(`
      DELETE FROM investigation_votes
      WHERE room_id = ? AND stage_id = ? AND round_number = ?
        AND location_id NOT IN (${eligiblePlaceholders})
    `).run(
      actor.roomId,
      input.stageId,
      round.roundNumber,
      ...input.eligibleLocationIds,
    );
    database.prepare(`
      INSERT INTO investigation_votes
        (room_id, stage_id, round_number, membership_id, location_id, voted_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, stage_id, round_number, membership_id)
      DO UPDATE SET location_id = excluded.location_id, voted_at = excluded.voted_at
    `).run(actor.roomId, input.stageId, round.roundNumber, actor.membershipId, input.locationId, Date.now());
    const votes = database.prepare(`
      SELECT membership_id AS membershipId, location_id AS locationId
      FROM investigation_votes
      WHERE room_id = ? AND stage_id = ? AND round_number = ?
    `).all(actor.roomId, input.stageId, round.roundNumber) as Array<{
      membershipId: string;
      locationId: string;
    }>;
    if (votes.length === input.orderedMembershipIds.length) {
      const totals = new Map<string, number>();
      for (const vote of votes) totals.set(vote.locationId, (totals.get(vote.locationId) ?? 0) + 1);
      const highest = Math.max(...totals.values());
      const tied = input.eligibleLocationIds.filter((id) => totals.get(id) === highest);
      const tieBreakVote = votes.find((vote) => vote.membershipId === round.tieBreakMembershipId)?.locationId;
      const selectedLocationId = tieBreakVote && tied.includes(tieBreakVote) ? tieBreakVote : tied[0];
      if (!selectedLocationId) {
        database.exec('ROLLBACK');
        return false;
      }
      const cursorMembershipId = input.orderedMembershipIds
        .map((_, offset) => input.orderedMembershipIds[
          (input.orderedMembershipIds.indexOf(round.tieBreakMembershipId) + offset)
          % input.orderedMembershipIds.length
        ])
        .find((membershipId) => (
          (acquisitionCounts.get(membershipId) ?? 0) < perPlayerStageLimit
        ));
      if (!cursorMembershipId) {
        database.exec('ROLLBACK');
        return false;
      }
      database.prepare(`
        UPDATE investigation_rounds
        SET selected_location_id = ?, cursor_membership_id = ?
        WHERE room_id = ? AND stage_id = ? AND round_number = ?
          AND selected_location_id IS NULL
      `).run(
        selectedLocationId,
        cursorMembershipId,
        actor.roomId,
        input.stageId,
        round.roundNumber,
      );
    }
    database.prepare(`
      UPDATE rooms SET authorization_version = authorization_version + 1 WHERE id = ?
    `).run(actor.roomId);
    database.exec('COMMIT');
    return true;
  } catch {
    try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    return false;
  }
}

export function searchInvestigationLocation(input: {
  code: string;
  userId: string;
  versionId: string;
  authorizationVersion: number;
  stageId: string;
  locationId: string;
  selectedClueId: string;
  eligibleClueIds: string[];
  actorEligibleClueIds: string[];
  orderedMembershipIds: string[];
  maxPrivateCount: number;
  perPlayerStageLimit?: number;
  mandatoryClueIds: string[];
  blockForPublication: boolean;
}) {
  const perPlayerStageLimit = input.perPlayerStageLimit ?? Number.MAX_SAFE_INTEGER;
  if (
    !/^[23456789A-HJ-NP-Z]{6}$/.test(input.code)
    || !/^ver_[0-9a-f]{8,64}$/.test(input.versionId)
    || !/^stage_[0-9a-f]{8,64}$/.test(input.stageId)
    || !/^loc_[0-9a-f]{8,64}$/.test(input.locationId)
    || !/^clue_[0-9a-f]{8,64}$/.test(input.selectedClueId)
    || !Number.isInteger(input.authorizationVersion)
    || input.authorizationVersion < 1
    || !Number.isInteger(input.maxPrivateCount)
    || input.maxPrivateCount < 0
    || !Number.isInteger(perPlayerStageLimit)
    || perPlayerStageLimit < 1
    || input.mandatoryClueIds.some((id) => !/^clue_[0-9a-f]{8,64}$/.test(id))
    || new Set(input.mandatoryClueIds).size !== input.mandatoryClueIds.length
    || input.eligibleClueIds.length === 0
    || !input.actorEligibleClueIds.includes(input.selectedClueId)
    || new Set(input.eligibleClueIds).size !== input.eligibleClueIds.length
    || input.eligibleClueIds.some((id) => !/^clue_[0-9a-f]{8,64}$/.test(id))
    || input.actorEligibleClueIds.some((id) => !input.eligibleClueIds.includes(id))
    || new Set(input.actorEligibleClueIds).size !== input.actorEligibleClueIds.length
    || input.orderedMembershipIds.length === 0
    || new Set(input.orderedMembershipIds).size !== input.orderedMembershipIds.length
  ) return false;
  const database = getDatabase();
  try {
    database.exec('BEGIN IMMEDIATE');
    const actor = database.prepare(`
      SELECT rooms.id AS roomId, memberships.id AS membershipId
      FROM rooms
      JOIN memberships ON memberships.room_id = rooms.id
      JOIN role_assignments ON role_assignments.room_id = rooms.id
        AND role_assignments.membership_id = memberships.id
      JOIN room_stages ON room_stages.room_id = rooms.id
        AND room_stages.stage_id = ? AND room_stages.completed_at IS NULL
      WHERE rooms.code = ? AND rooms.version_id = ? AND rooms.status = 'running'
        AND rooms.authorization_version = ?
        AND memberships.user_id = ? AND memberships.left_at IS NULL
    `).get(input.stageId, input.code, input.versionId, input.authorizationVersion, input.userId) as {
      roomId: string;
      membershipId: string;
    } | undefined;
    if (!actor || !input.orderedMembershipIds.includes(actor.membershipId)) {
      database.exec('ROLLBACK');
      return false;
    }
    const acquisitionCounts = stageAcquisitionCounts(database, actor.roomId, input.stageId);
    if ((acquisitionCounts.get(actor.membershipId) ?? 0) >= perPlayerStageLimit) {
      database.exec('ROLLBACK');
      return false;
    }
    if (input.blockForPublication && hasPublicationObligation(
      database, actor.roomId, actor.membershipId, input.stageId,
      input.maxPrivateCount, input.mandatoryClueIds,
    )) {
      database.exec('ROLLBACK');
      return false;
    }
    const round = database.prepare(`
      SELECT round_number AS roundNumber, cursor_membership_id AS cursorMembershipId
      FROM investigation_rounds
      WHERE room_id = ? AND stage_id = ? AND completed_at IS NULL
        AND selected_location_id = ?
      ORDER BY round_number DESC LIMIT 1
    `).get(actor.roomId, input.stageId, input.locationId) as {
      roundNumber: number;
      cursorMembershipId: string | null;
    } | undefined;
    if (!round || round.cursorMembershipId !== actor.membershipId) {
      database.exec('ROLLBACK');
      return false;
    }
    const held = new Set((database.prepare(`
      SELECT clue_id AS clueId FROM clue_holdings WHERE room_id = ?
    `).all(actor.roomId) as Array<{ clueId: string }>).map((row) => row.clueId));
    const remaining = input.eligibleClueIds.filter((clueId) => !held.has(clueId));
    if (!remaining.includes(input.selectedClueId)) {
      database.exec('ROLLBACK');
      return false;
    }
    const now = Date.now();
    database.prepare(`
      INSERT INTO clue_holdings (room_id, clue_id, holder_membership_id, acquired_at)
      VALUES (?, ?, ?, ?)
    `).run(actor.roomId, input.selectedClueId, actor.membershipId, now);
    database.prepare(`
      INSERT INTO investigation_acquisitions
        (room_id, clue_id, stage_id, round_number, membership_id, acquired_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      actor.roomId,
      input.selectedClueId,
      input.stageId,
      round.roundNumber,
      actor.membershipId,
      now,
    );
    acquisitionCounts.set(
      actor.membershipId,
      (acquisitionCounts.get(actor.membershipId) ?? 0) + 1,
    );
    const afterRemaining = remaining.filter((clueId) => clueId !== input.selectedClueId);
    const actorIndex = input.orderedMembershipIds.indexOf(actor.membershipId);
    const nextMembershipId = input.orderedMembershipIds
      .map((_, offset) => input.orderedMembershipIds[
        (actorIndex + offset + 1) % input.orderedMembershipIds.length
      ])
      .find((membershipId) => (
        (acquisitionCounts.get(membershipId) ?? 0) < perPlayerStageLimit
      ));
    if (afterRemaining.length === 0 || !nextMembershipId) {
      database.prepare(`
        UPDATE investigation_rounds
        SET cursor_membership_id = NULL, completed_at = ?
        WHERE room_id = ? AND stage_id = ? AND round_number = ?
      `).run(now, actor.roomId, input.stageId, round.roundNumber);
    } else {
      database.prepare(`
        UPDATE investigation_rounds
        SET cursor_membership_id = ?
        WHERE room_id = ? AND stage_id = ? AND round_number = ?
      `).run(nextMembershipId, actor.roomId, input.stageId, round.roundNumber);
    }
    database.prepare(`
      UPDATE rooms SET authorization_version = authorization_version + 1 WHERE id = ?
    `).run(actor.roomId);
    database.exec('COMMIT');
    return true;
  } catch {
    try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    return false;
  }
}

export function voteInvestigationCompletion(input: {
  code: string;
  userId: string;
  versionId: string;
  authorizationVersion: number;
  stageId: string;
  orderedMembershipIds: string[];
  remainingLocationIds: string[];
  maxPrivateCount: number;
  mandatoryClueIds: string[];
}) {
  if (
    !/^[23456789A-HJ-NP-Z]{6}$/.test(input.code)
    || !/^ver_[0-9a-f]{8,64}$/.test(input.versionId)
    || !/^stage_[0-9a-f]{8,64}$/.test(input.stageId)
    || !Number.isInteger(input.authorizationVersion)
    || input.authorizationVersion < 1
    || input.orderedMembershipIds.length === 0
    || new Set(input.orderedMembershipIds).size !== input.orderedMembershipIds.length
    || input.remainingLocationIds.length !== 0
    || !Number.isInteger(input.maxPrivateCount)
    || input.maxPrivateCount < 0
    || input.mandatoryClueIds.some((id) => !/^clue_[0-9a-f]{8,64}$/.test(id))
    || new Set(input.mandatoryClueIds).size !== input.mandatoryClueIds.length
  ) return false;
  const database = getDatabase();
  try {
    database.exec('BEGIN IMMEDIATE');
    const actor = database.prepare(`
      SELECT rooms.id AS roomId, memberships.id AS membershipId
      FROM rooms
      JOIN memberships ON memberships.room_id = rooms.id
      JOIN role_assignments ON role_assignments.room_id = rooms.id
        AND role_assignments.membership_id = memberships.id
      JOIN room_stages ON room_stages.room_id = rooms.id
        AND room_stages.stage_id = ? AND room_stages.completed_at IS NULL
      WHERE rooms.code = ? AND rooms.version_id = ? AND rooms.status = 'running'
        AND rooms.authorization_version = ?
        AND memberships.user_id = ? AND memberships.left_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM investigation_rounds
          WHERE investigation_rounds.room_id = rooms.id
            AND investigation_rounds.stage_id = ?
            AND investigation_rounds.completed_at IS NULL
        )
    `).get(
      input.stageId,
      input.code,
      input.versionId,
      input.authorizationVersion,
      input.userId,
      input.stageId,
    ) as { roomId: string; membershipId: string } | undefined;
    if (!actor || !input.orderedMembershipIds.includes(actor.membershipId)) {
      database.exec('ROLLBACK');
      return false;
    }
    if (hasPublicationObligation(
      database,
      actor.roomId,
      actor.membershipId,
      input.stageId,
      input.maxPrivateCount,
      input.mandatoryClueIds,
    )) {
      database.exec('ROLLBACK');
      return false;
    }
    const activeMembershipIds = (database.prepare(`
      SELECT memberships.id AS membershipId
      FROM memberships
      JOIN role_assignments ON role_assignments.room_id = memberships.room_id
        AND role_assignments.membership_id = memberships.id
      WHERE memberships.room_id = ? AND memberships.left_at IS NULL
    `).all(actor.roomId) as Array<{ membershipId: string }>).map((row) => row.membershipId).sort();
    if (activeMembershipIds.length !== input.orderedMembershipIds.length
      || [...input.orderedMembershipIds].sort().some((id, index) => id !== activeMembershipIds[index])) {
      database.exec('ROLLBACK');
      return false;
    }
    const now = Date.now();
    database.prepare(`
      DELETE FROM investigation_completion_votes
      WHERE room_id = ? AND stage_id = ? AND authorization_version != ?
    `).run(actor.roomId, input.stageId, input.authorizationVersion);
    database.prepare(`
      INSERT INTO investigation_completion_votes
        (room_id, stage_id, membership_id, authorization_version, consent, voted_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(room_id, stage_id, membership_id)
      DO UPDATE SET authorization_version = excluded.authorization_version,
                    consent = 1, voted_at = excluded.voted_at
    `).run(
      actor.roomId,
      input.stageId,
      actor.membershipId,
      input.authorizationVersion,
      now,
    );
    const consentCount = (database.prepare(`
      SELECT COUNT(*) AS count
      FROM investigation_completion_votes
      WHERE room_id = ? AND stage_id = ? AND authorization_version = ? AND consent = 1
    `).get(actor.roomId, input.stageId, input.authorizationVersion) as { count: number }).count;
    if (consentCount === input.orderedMembershipIds.length) {
      database.prepare(`
        INSERT INTO investigation_stage_completions (room_id, stage_id, completed_at)
        VALUES (?, ?, ?)
        ON CONFLICT(room_id, stage_id) DO NOTHING
      `).run(actor.roomId, input.stageId, now);
      database.prepare(`
        UPDATE rooms SET authorization_version = authorization_version + 1 WHERE id = ?
      `).run(actor.roomId);
    }
    database.exec('COMMIT');
    return true;
  } catch {
    try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    return false;
  }
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
  selectedClueId: string;
  eligibleClueIds: string[];
  mode: 'draw_without_replacement' | 'fixed_sequence' | 'all_visible' | 'host_dealt';
  perPlayerLimit: number | null;
  globalLimit: number | null;
}) {
  if (
    !/^[23456789A-HJ-NP-Z]{6}$/.test(input.code)
    || !/^ver_[0-9a-f]{8,64}$/.test(input.versionId)
    || !/^loc_[0-9a-f]{8,64}$/.test(input.locationId)
    || !/^stage_[0-9a-f]{8,64}$/.test(input.stageId)
    || !/^clue_[0-9a-f]{8,64}$/.test(input.selectedClueId)
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
      : input.selectedClueId;
    if (clueId !== input.selectedClueId || !candidates.includes(clueId)) {
      database.exec('ROLLBACK');
      return false;
    }
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

export function publishHeldClue(input: {
  code: string;
  userId: string;
  versionId: string;
  authorizationVersion: number;
  clueId: string;
}) {
  const code = input.code.normalize('NFKC').trim().toUpperCase();
  if (
    !/^[23456789A-HJ-NP-Z]{6}$/.test(code)
    || !/^ver_[0-9a-f]{8,64}$/.test(input.versionId)
    || !/^clue_[0-9a-f]{8,64}$/.test(input.clueId)
    || !Number.isInteger(input.authorizationVersion)
    || input.authorizationVersion < 1
  ) {
    return false;
  }
  const database = getDatabase();
  try {
    database.exec('BEGIN IMMEDIATE');
    const actor = database.prepare(`
      SELECT rooms.id AS roomId, memberships.id AS membershipId
      FROM rooms
      JOIN memberships ON memberships.room_id = rooms.id
      JOIN clue_holdings ON clue_holdings.room_id = rooms.id
        AND clue_holdings.clue_id = ?
        AND clue_holdings.holder_membership_id = memberships.id
        AND clue_holdings.published_at IS NULL
      WHERE rooms.code = ? AND rooms.version_id = ? AND rooms.status = 'running'
        AND rooms.authorization_version = ?
        AND memberships.user_id = ? AND memberships.left_at IS NULL
    `).get(
      input.clueId,
      code,
      input.versionId,
      input.authorizationVersion,
      input.userId,
    ) as { roomId: string; membershipId: string } | undefined;
    if (!actor) {
      database.exec('ROLLBACK');
      return false;
    }
    const now = Date.now();
    const result = database.prepare(`
      UPDATE clue_holdings
      SET published_at = ?
      WHERE room_id = ? AND clue_id = ? AND holder_membership_id = ?
        AND published_at IS NULL
    `).run(now, actor.roomId, input.clueId, actor.membershipId);
    if (result.changes !== 1) {
      database.exec('ROLLBACK');
      return false;
    }
    database.prepare(`
      INSERT INTO room_events
        (id, room_id, actor_membership_id, event_type, object_id, event_payload, created_at)
      VALUES (?, ?, ?, 'clue_published', ?, '{}', ?)
    `).run(randomUUID(), actor.roomId, actor.membershipId, input.clueId, now);
    const authorizationUpdate = database.prepare(`
      UPDATE rooms SET authorization_version = authorization_version + 1
      WHERE id = ? AND authorization_version = ?
    `).run(actor.roomId, input.authorizationVersion);
    if (authorizationUpdate.changes !== 1) {
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
