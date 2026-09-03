import { randomUUID } from 'node:crypto';
import type { AuthorizationContext, BlindBundle } from '../blind-runtime.ts';
import { getDatabase } from '../db.ts';
import { canonicalUsageWindowStageIds } from '../search-policy-window.ts';
import {
  crossValidateRotatingBlindDrawMechanism,
  deriveRotatingBlindDrawCandidates,
  parseRotatingBlindDrawMechanism,
  projectBlindDrawBackOptions,
  type BlindDrawBackOption,
  type RotatingBlindDrawAction,
  type RotatingBlindDrawCandidates,
  type RotatingBlindDrawMechanismV2,
} from './rotating-blind-draw.ts';

const ROOM_CODE = /^[23456789A-HJ-NP-Z]{6}$/;
const VERSION_ID = /^ver_[0-9a-f]{8,64}$/;
const STAGE_ID = /^stage_[0-9a-f]{8,64}$/;
const LOCATION_ID = /^loc_[0-9a-f]{8,64}$/;
const CLUE_ID = /^clue_[0-9a-f]{8,64}$/;

type Database = ReturnType<typeof getDatabase>;

type ActiveMember = {
  membershipId: string;
  roleId: string;
};

type Actor = ActiveMember & {
  roomId: string;
  authorizationVersion: number;
};

type Round = {
  roundNumber: number;
  selectedLocationId: string | null;
  cursorMembershipId: string | null;
  tieBreakMembershipId: string;
};

type Holding = {
  clueId: string;
  membershipId: string;
  publishedAt: number | null;
};

type Snapshot = {
  actor: Actor;
  activeMembers: ActiveMember[];
  context: AuthorizationContext;
  candidates: RotatingBlindDrawCandidates;
  openRound: Round | null;
  votes: Array<{ membershipId: string; locationId: string }>;
  tiedLocationIds: string[];
  currentTurnMembershipId: string | null;
  exhaustedLocationIds: string[];
  searchScopeExhausted: boolean;
  stageCompleted: boolean;
  completionVoteMembershipIds: string[];
  privateLimitBlockedMembershipIds: string[];
  mandatoryPublicationMembershipIds: string[];
};

export type RotatingBlindDrawPhase =
  | 'location_ballot'
  | 'tie_break'
  | 'blind_draw'
  | 'completion_ballot'
  | 'stage_complete';

export type RotatingBlindDrawRoomView = {
  kind: 'collective_vote_rotating_blind_draw';
  version: 2;
  authorizationVersion: number;
  phase: RotatingBlindDrawPhase;
  locationIds: string[];
  voteCandidateLocationIds: string[];
  ownVoteLocationId: string | null;
  voteCount: number;
  eligibleVoterCount: number;
  tiedLocationIds: string[];
  tieBreakMembershipId: string | null;
  currentTurnMembershipId: string | null;
  drawOptions: BlindDrawBackOption[];
  exhaustedLocationIds: string[];
  hasPublicationObligation: boolean;
  roomActionBlockedForPublication: boolean;
  completionVoteMembershipIds: string[];
  completionThreshold: number;
  stageCompleted: boolean;
};

function normalizeMechanism(
  value: RotatingBlindDrawMechanismV2 | unknown,
  bundle: BlindBundle,
  stageId: string,
) {
  return crossValidateRotatingBlindDrawMechanism(
    parseRotatingBlindDrawMechanism(value),
    bundle,
    stageId,
  );
}

function validBaseInput(input: {
  code: string;
  userId: string;
  versionId: string;
  authorizationVersion?: number;
  stageId: string;
}) {
  return ROOM_CODE.test(input.code)
    && typeof input.userId === 'string'
    && input.userId.length > 0
    && VERSION_ID.test(input.versionId)
    && STAGE_ID.test(input.stageId)
    && (
      input.authorizationVersion === undefined
      || (Number.isSafeInteger(input.authorizationVersion) && input.authorizationVersion > 0)
    );
}

function loadActor(
  database: Database,
  input: {
    code: string;
    userId: string;
    versionId: string;
    authorizationVersion?: number;
    stageId: string;
  },
) {
  const versionClause = input.authorizationVersion === undefined
    ? ''
    : 'AND rooms.authorization_version = ?';
  const parameters = input.authorizationVersion === undefined
    ? [input.stageId, input.code, input.versionId, input.userId]
    : [input.stageId, input.code, input.versionId, input.authorizationVersion, input.userId];
  return database.prepare(`
    SELECT rooms.id AS roomId, rooms.authorization_version AS authorizationVersion,
           memberships.id AS membershipId, role_assignments.role_id AS roleId
    FROM rooms
    JOIN memberships ON memberships.room_id = rooms.id
    JOIN role_assignments ON role_assignments.room_id = rooms.id
      AND role_assignments.membership_id = memberships.id
    JOIN room_stages ON room_stages.room_id = rooms.id
      AND room_stages.stage_id = ? AND room_stages.completed_at IS NULL
    WHERE rooms.code = ? AND rooms.version_id = ? AND rooms.status = 'running'
      ${versionClause}
      AND memberships.user_id = ? AND memberships.left_at IS NULL
  `).get(...parameters) as Actor | undefined;
}

function loadActiveMembers(
  database: Database,
  roomId: string,
  roleIds: readonly string[],
) {
  const rows = database.prepare(`
    SELECT memberships.id AS membershipId, role_assignments.role_id AS roleId
    FROM memberships
    JOIN role_assignments ON role_assignments.room_id = memberships.room_id
      AND role_assignments.membership_id = memberships.id
    WHERE memberships.room_id = ? AND memberships.left_at IS NULL
  `).all(roomId) as ActiveMember[];
  if (
    rows.length === 0
    || rows.length !== roleIds.length
    || rows.some((row) => !roleIds.includes(row.roleId))
    || new Set(rows.map((row) => row.membershipId)).size !== rows.length
    || new Set(rows.map((row) => row.roleId)).size !== rows.length
  ) throw new Error('INVESTIGATION_STATE_REJECTED');
  return roleIds.flatMap((roleId) => rows.filter((row) => row.roleId === roleId));
}

function loadContextAndHoldings(
  database: Database,
  bundle: BlindBundle,
  actor: Actor,
  stageId: string,
  activeMembers: readonly ActiveMember[],
) {
  const holdings = database.prepare(`
    SELECT clue_id AS clueId, holder_membership_id AS membershipId,
           published_at AS publishedAt
    FROM clue_holdings WHERE room_id = ?
  `).all(actor.roomId) as Holding[];
  const reachedStageIds = new Set((database.prepare(`
    SELECT stage_id AS stageId FROM room_stages WHERE room_id = ?
  `).all(actor.roomId) as Array<{ stageId: string }>).map((row) => row.stageId));
  const hostReleaseIds = new Set((database.prepare(`
    SELECT release_id AS releaseId FROM room_host_releases WHERE room_id = ?
  `).all(actor.roomId) as Array<{ releaseId: string }>).map((row) => row.releaseId));
  const completedStageIds = new Set((database.prepare(`
    SELECT stage_id AS stageId FROM investigation_stage_completions WHERE room_id = ?
  `).all(actor.roomId) as Array<{ stageId: string }>).map((row) => row.stageId));
  const heldByActor = new Set(
    holdings.filter((row) => row.membershipId === actor.membershipId).map((row) => row.clueId),
  );
  const context: AuthorizationContext = {
    joined: true,
    assignedRoleId: actor.roleId,
    assignedRoleIds: new Set(activeMembers.map((member) => member.roleId)),
    activeStageId: stageId,
    reachedStageIds,
    heldClueIds: heldByActor,
    roomHeldClueIds: new Set(holdings.map((row) => row.clueId)),
    publishedClueIds: new Set(
      holdings.filter((row) => row.publishedAt !== null).map((row) => row.clueId),
    ),
    hostReleaseIds,
    sessionCompleted: false,
    investigationCompletedStageIds: completedStageIds,
  };
  const heldByMembership = new Map<string, Set<string>>();
  for (const member of activeMembers) heldByMembership.set(member.membershipId, new Set());
  for (const holding of holdings) heldByMembership.get(holding.membershipId)?.add(holding.clueId);
  const bundleMandatoryClueIds = Object.values(bundle.clues)
    .filter((clue) => clue.publication.duty?.mode === 'mandatory_on_acquire')
    .map((clue) => clue.clueId);
  return { context, holdings, heldByMembership, bundleMandatoryClueIds };
}

function loadCanonicalUsage(
  database: Database,
  bundle: BlindBundle,
  roomId: string,
  stageId: string,
  activeMembers: readonly ActiveMember[],
) {
  const memberUses = database.prepare(`
    SELECT membership_id AS membershipId, location_id AS locationId, stage_id AS stageId, uses
    FROM search_uses WHERE room_id = ?
  `).all(roomId) as Array<{
    membershipId: string;
    locationId: string;
    stageId: string;
    uses: number;
  }>;
  const roomUses = database.prepare(`
    SELECT location_id AS locationId, stage_id AS stageId, uses
    FROM location_search_totals WHERE room_id = ?
  `).all(roomId) as Array<{ locationId: string; stageId: string; uses: number }>;
  const byMembership = new Map<string, Record<string, number>>(
    activeMembers.map((member) => [member.membershipId, {}]),
  );
  const activeLocationIds = bundle.stages[stageId]?.locationIds ?? [];
  const usageWindows = new Map(activeLocationIds.map((locationId) => [
    locationId,
    new Set(canonicalUsageWindowStageIds(bundle, stageId, locationId)),
  ]));
  for (const [locationId, window] of usageWindows) {
    if (window.size > 0) continue;
    for (const target of byMembership.values()) target[locationId] = Number.MAX_SAFE_INTEGER;
  }
  for (const use of memberUses) {
    const target = byMembership.get(use.membershipId);
    if (target && usageWindows.get(use.locationId)?.has(use.stageId)) {
      target[use.locationId] = (target[use.locationId] ?? 0) + use.uses;
    }
  }
  const room: Record<string, number> = {};
  for (const [locationId, window] of usageWindows) {
    if (window.size === 0) room[locationId] = Number.MAX_SAFE_INTEGER;
  }
  for (const use of roomUses) {
    if (usageWindows.get(use.locationId)?.has(use.stageId)) {
      room[use.locationId] = (room[use.locationId] ?? 0) + use.uses;
    }
  }
  return { byMembership, room };
}

function loadOpenRound(database: Database, roomId: string, stageId: string) {
  return database.prepare(`
    SELECT round_number AS roundNumber, selected_location_id AS selectedLocationId,
           cursor_membership_id AS cursorMembershipId,
           tie_break_membership_id AS tieBreakMembershipId
    FROM investigation_rounds
    WHERE room_id = ? AND stage_id = ? AND completed_at IS NULL
    ORDER BY round_number DESC LIMIT 1
  `).get(roomId, stageId) as Round | undefined;
}

function nextCursorMembershipId(
  database: Database,
  roomId: string,
  activeMembers: readonly ActiveMember[],
) {
  const latest = database.prepare(`
    SELECT membership_id AS membershipId
    FROM investigation_acquisitions
    WHERE room_id = ? ORDER BY acquired_at DESC, rowid DESC LIMIT 1
  `).get(roomId) as { membershipId: string } | undefined;
  if (!latest) return activeMembers[0]?.membershipId ?? null;
  const index = activeMembers.findIndex((member) => member.membershipId === latest.membershipId);
  if (index < 0) {
    const previousRole = database.prepare(`
      SELECT role_id AS roleId FROM role_assignments
      WHERE room_id = ? AND membership_id = ?
    `).get(roomId, latest.membershipId) as { roleId: string } | undefined;
    const roleIndex = previousRole
      ? activeMembers.findIndex((member) => member.roleId === previousRole.roleId)
      : -1;
    return activeMembers[(roleIndex + 1 + activeMembers.length) % activeMembers.length]?.membershipId
      ?? null;
  }
  return activeMembers[(index + 1) % activeMembers.length]?.membershipId ?? null;
}

function findEligibleCursor(
  activeMembers: readonly ActiveMember[],
  candidates: RotatingBlindDrawCandidates,
  startMembershipId: string | null,
  locationId: string | null,
  skipStart: boolean,
) {
  if (!startMembershipId || activeMembers.length === 0) return null;
  const start = activeMembers.findIndex((member) => member.membershipId === startMembershipId);
  if (start < 0) return null;
  for (let offset = skipStart ? 1 : 0; offset < activeMembers.length + (skipStart ? 1 : 0); offset += 1) {
    const member = activeMembers[(start + offset) % activeMembers.length];
    const perLocation = candidates.clueIdsByRoleId[member.roleId] ?? {};
    const eligible = locationId
      ? (perLocation[locationId]?.length ?? 0) > 0
      : Object.values(perLocation).some((clueIds) => clueIds.length > 0);
    if (eligible) return member.membershipId;
  }
  return null;
}

function publicationBlocks(
  activeMembers: readonly ActiveMember[],
  holdings: readonly Holding[],
  mechanism: RotatingBlindDrawMechanismV2,
  bundleMandatoryClueIds: readonly string[],
) {
  const mandatory = new Set([
    ...bundleMandatoryClueIds,
    ...mechanism.publication.mandatoryClueIds,
  ]);
  const mandatoryPublicationMembershipIds: string[] = [];
  const privateLimitBlockedMembershipIds: string[] = [];
  for (const member of activeMembers) {
    const unpublished = holdings.filter(
      (holding) => holding.membershipId === member.membershipId && holding.publishedAt === null,
    );
    if (unpublished.some((holding) => mandatory.has(holding.clueId))) {
      mandatoryPublicationMembershipIds.push(member.membershipId);
    }
    if (unpublished.length >= mechanism.publication.privateHoldingLimit) {
      privateLimitBlockedMembershipIds.push(member.membershipId);
    }
  }
  return { mandatoryPublicationMembershipIds, privateLimitBlockedMembershipIds };
}

function tiedLocations(
  votes: readonly { membershipId: string; locationId: string }[],
  activeMembers: readonly ActiveMember[],
  candidateLocationIds: readonly string[],
) {
  if (votes.length !== activeMembers.length || votes.length === 0) return [];
  const totals = new Map<string, number>();
  votes.forEach((vote) => totals.set(vote.locationId, (totals.get(vote.locationId) ?? 0) + 1));
  const highest = Math.max(...totals.values());
  return candidateLocationIds.filter((locationId) => totals.get(locationId) === highest);
}

function buildSnapshot(
  database: Database,
  bundle: BlindBundle,
  mechanism: RotatingBlindDrawMechanismV2,
  actor: Actor,
  stageId: string,
): Snapshot {
  const activeMembers = loadActiveMembers(database, actor.roomId, mechanism.cursor.roleIds);
  const { context, holdings, heldByMembership, bundleMandatoryClueIds } = loadContextAndHoldings(
    database,
    bundle,
    actor,
    stageId,
    activeMembers,
  );
  const canonicalUsage = loadCanonicalUsage(
    database,
    bundle,
    actor.roomId,
    stageId,
    activeMembers,
  );
  const exhaustedQuery = mechanism.exhaustedLocationScope === 'room_lifetime' ? `
    SELECT DISTINCT selected_location_id AS locationId
    FROM investigation_rounds
    WHERE room_id = ? AND completed_at IS NOT NULL AND selected_location_id IS NOT NULL
  ` : `
    SELECT DISTINCT selected_location_id AS locationId
    FROM investigation_rounds
    WHERE room_id = ? AND stage_id = ?
      AND completed_at IS NOT NULL AND selected_location_id IS NOT NULL
  `;
  const exhaustedLocationIds = (database.prepare(exhaustedQuery).all(
    ...(mechanism.exhaustedLocationScope === 'room_lifetime'
      ? [actor.roomId]
      : [actor.roomId, stageId]),
    ) as Array<{ locationId: string }>).map((row) => row.locationId);
  const invalidCanonicalWindowLocationIds = mechanism.candidateLocationIds.filter(
    (locationId) => canonicalUsageWindowStageIds(bundle, stageId, locationId).length === 0,
  );
  if (invalidCanonicalWindowLocationIds.length > 0) {
    throw new Error('INVESTIGATION_STATE_REJECTED');
  }
  const candidates = deriveRotatingBlindDrawCandidates(
    bundle,
    stageId,
    mechanism,
    context,
    activeMembers.map((member) => ({
      assignedRoleId: member.roleId,
      heldClueIds: heldByMembership.get(member.membershipId) ?? new Set(),
      searchUsesByLocation: canonicalUsage.byMembership.get(member.membershipId),
    })),
    new Set(exhaustedLocationIds),
    canonicalUsage.room,
  );
  const openRound = loadOpenRound(database, actor.roomId, stageId) ?? null;
  const votes = openRound ? database.prepare(`
    SELECT membership_id AS membershipId, location_id AS locationId
    FROM investigation_votes
    WHERE room_id = ? AND stage_id = ? AND round_number = ?
    ORDER BY voted_at, membership_id
  `).all(actor.roomId, stageId, openRound.roundNumber) as Array<{
    membershipId: string;
    locationId: string;
  }> : [];
  const tiedLocationIds = tiedLocations(
    votes,
    activeMembers,
    candidates.roomLocationIds,
  );
  const baseCursor = openRound?.cursorMembershipId
    ?? openRound?.tieBreakMembershipId
    ?? nextCursorMembershipId(database, actor.roomId, activeMembers);
  const currentTurnMembershipId = openRound?.selectedLocationId
    ? findEligibleCursor(
      activeMembers,
      candidates,
      baseCursor,
      openRound.selectedLocationId,
      false,
    )
    : mechanism.selection.mode === 'actor_blind_pick_all_remaining'
      ? findEligibleCursor(activeMembers, candidates, baseCursor, null, false)
      : baseCursor;
  const completedSelectedRounds = (database.prepare(`
    SELECT COUNT(*) AS count FROM investigation_rounds
    WHERE room_id = ? AND stage_id = ? AND completed_at IS NOT NULL
      AND selected_location_id IS NOT NULL
  `).get(actor.roomId, stageId) as { count: number }).count;
  const searchScopeExhausted = mechanism.selection.mode === 'collective_location_vote'
    ? completedSelectedRounds >= mechanism.selection.locationsToExhaust
    : candidates.roomLocationIds.length === 0 && !openRound;
  const stageCompleted = Boolean(database.prepare(`
    SELECT 1 FROM investigation_stage_completions
    WHERE room_id = ? AND stage_id = ?
  `).get(actor.roomId, stageId));
  const completionVoteMembershipIds = (database.prepare(`
    SELECT membership_id AS membershipId
    FROM investigation_completion_votes
    WHERE room_id = ? AND stage_id = ? AND authorization_version = ? AND consent = 1
    ORDER BY voted_at, membership_id
  `).all(actor.roomId, stageId, actor.authorizationVersion) as Array<{
    membershipId: string;
  }>).map((row) => row.membershipId);
  const publication = publicationBlocks(
    activeMembers,
    holdings,
    mechanism,
    bundleMandatoryClueIds,
  );
  return {
    actor,
    activeMembers,
    context,
    candidates,
    openRound,
    votes,
    tiedLocationIds,
    currentTurnMembershipId,
    exhaustedLocationIds,
    searchScopeExhausted,
    stageCompleted,
    completionVoteMembershipIds,
    ...publication,
  };
}

function phaseFor(
  mechanism: RotatingBlindDrawMechanismV2,
  snapshot: Snapshot,
): RotatingBlindDrawPhase {
  if (snapshot.stageCompleted) return 'stage_complete';
  if (snapshot.searchScopeExhausted) return 'completion_ballot';
  if (mechanism.selection.mode === 'actor_blind_pick_all_remaining') return 'blind_draw';
  if (snapshot.openRound?.selectedLocationId) return 'blind_draw';
  if (snapshot.tiedLocationIds.length > 1) return 'tie_break';
  return 'location_ballot';
}

function selectedActorClues(snapshot: Snapshot, mechanism: RotatingBlindDrawMechanismV2) {
  if (snapshot.currentTurnMembershipId !== snapshot.actor.membershipId) return {};
  if (
    snapshot.mandatoryPublicationMembershipIds.length > 0
    || snapshot.privateLimitBlockedMembershipIds.includes(snapshot.actor.membershipId)
  ) return {};
  const actorClues = snapshot.candidates.actorClueIdsByLocation;
  if (mechanism.selection.mode === 'actor_blind_pick_all_remaining') return actorClues;
  const selectedLocationId = snapshot.openRound?.selectedLocationId;
  return selectedLocationId && actorClues[selectedLocationId]
    ? { [selectedLocationId]: actorClues[selectedLocationId] }
    : {};
}

export function getRotatingBlindDrawRoomView(input: {
  code: string;
  userId: string;
  versionId: string;
  stageId: string;
  bundle: BlindBundle;
  mechanism: RotatingBlindDrawMechanismV2 | unknown;
}): RotatingBlindDrawRoomView | null {
  if (!validBaseInput(input) || input.bundle.script.versionId !== input.versionId) return null;
  let database: Database | null = null;
  try {
    const mechanism = normalizeMechanism(input.mechanism, input.bundle, input.stageId);
    database = getDatabase();
    beginReadSnapshot(database);
    const actor = loadActor(database, input);
    if (!actor) throw new Error('ACTOR_REJECTED');
    const snapshot = buildSnapshot(database, input.bundle, mechanism, actor, input.stageId);
    const phase = phaseFor(mechanism, snapshot);
    const canVote = phase === 'location_ballot'
      && snapshot.mandatoryPublicationMembershipIds.length === 0
      && !snapshot.privateLimitBlockedMembershipIds.includes(actor.membershipId);
    const canBreakTie = phase === 'tie_break'
      && snapshot.openRound?.tieBreakMembershipId === actor.membershipId
      && snapshot.mandatoryPublicationMembershipIds.length === 0
      && !snapshot.privateLimitBlockedMembershipIds.includes(actor.membershipId);
    const view: RotatingBlindDrawRoomView = {
      kind: mechanism.kind,
      version: mechanism.version,
      authorizationVersion: actor.authorizationVersion,
      phase,
      locationIds: snapshot.candidates.actorLocationIds,
      voteCandidateLocationIds: canVote
        ? snapshot.candidates.actorLocationIds
        : canBreakTie
          ? snapshot.tiedLocationIds.filter((id) => snapshot.candidates.actorLocationIds.includes(id))
          : [],
      ownVoteLocationId: snapshot.votes.find(
        (vote) => vote.membershipId === actor.membershipId,
      )?.locationId ?? null,
      voteCount: snapshot.votes.length,
      eligibleVoterCount: snapshot.activeMembers.length,
      tiedLocationIds: snapshot.tiedLocationIds,
      tieBreakMembershipId: snapshot.openRound?.tieBreakMembershipId ?? null,
      currentTurnMembershipId: snapshot.currentTurnMembershipId,
      drawOptions: phase === 'blind_draw'
        ? projectBlindDrawBackOptions(
          input.bundle,
          snapshot.context,
          selectedActorClues(snapshot, mechanism),
        )
        : [],
      exhaustedLocationIds: snapshot.exhaustedLocationIds,
      hasPublicationObligation: snapshot.mandatoryPublicationMembershipIds.includes(actor.membershipId)
        || snapshot.privateLimitBlockedMembershipIds.includes(actor.membershipId),
      roomActionBlockedForPublication: snapshot.mandatoryPublicationMembershipIds.length > 0,
      completionVoteMembershipIds: snapshot.completionVoteMembershipIds,
      completionThreshold: mechanism.completion.threshold,
      stageCompleted: snapshot.stageCompleted,
    };
    database.exec('COMMIT');
    return view;
  } catch {
    if (database) rollback(database);
    return null;
  }
}

function beginReadSnapshot(database: Database) {
  database.exec('BEGIN DEFERRED');
}

function begin(database: Database) {
  database.exec('BEGIN IMMEDIATE');
}

function rollback(database: Database) {
  try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
}

function commitAuthorizationVersion(
  database: Database,
  roomId: string,
  authorizationVersion: number,
) {
  const updated = database.prepare(`
    UPDATE rooms SET authorization_version = authorization_version + 1
    WHERE id = ? AND authorization_version = ?
  `).run(roomId, authorizationVersion);
  if (updated.changes !== 1) throw new Error('STALE_AUTHORIZATION');
}

function ensureRound(
  database: Database,
  snapshot: Snapshot,
  stageId: string,
) {
  if (snapshot.openRound) return snapshot.openRound;
  const latest = database.prepare(`
    SELECT COALESCE(MAX(round_number), 0) AS latest
    FROM investigation_rounds WHERE room_id = ? AND stage_id = ?
  `).get(snapshot.actor.roomId, stageId) as { latest: number };
  const roundNumber = latest.latest + 1;
  const tieBreakMembershipId = snapshot.currentTurnMembershipId;
  if (!tieBreakMembershipId) throw new Error('NO_CURSOR');
  database.prepare(`
    INSERT INTO investigation_rounds
      (room_id, stage_id, round_number, tie_break_membership_id,
       cursor_membership_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.actor.roomId,
    stageId,
    roundNumber,
    tieBreakMembershipId,
    tieBreakMembershipId,
    Date.now(),
  );
  return {
    roundNumber,
    selectedLocationId: null,
    cursorMembershipId: tieBreakMembershipId,
    tieBreakMembershipId,
  } satisfies Round;
}

function actionBlocked(
  mechanism: RotatingBlindDrawMechanismV2,
  snapshot: Snapshot,
  action: RotatingBlindDrawAction,
) {
  return mechanism.publication.blockedActions.includes(action)
    && (
      snapshot.mandatoryPublicationMembershipIds.length > 0
      || snapshot.privateLimitBlockedMembershipIds.includes(snapshot.actor.membershipId)
    );
}

export function castRotatingBlindDrawLocationVote(input: {
  code: string;
  userId: string;
  versionId: string;
  authorizationVersion: number;
  stageId: string;
  locationId: string;
  bundle: BlindBundle;
  mechanism: RotatingBlindDrawMechanismV2 | unknown;
}) {
  if (
    !validBaseInput(input)
    || !LOCATION_ID.test(input.locationId)
    || input.bundle.script.versionId !== input.versionId
  ) return false;
  const database = getDatabase();
  try {
    const mechanism = normalizeMechanism(input.mechanism, input.bundle, input.stageId);
    if (mechanism.selection.mode !== 'collective_location_vote') return false;
    begin(database);
    const actor = loadActor(database, input);
    if (!actor) throw new Error('ACTOR_REJECTED');
    let snapshot = buildSnapshot(database, input.bundle, mechanism, actor, input.stageId);
    if (
      snapshot.stageCompleted
      || snapshot.searchScopeExhausted
      || actionBlocked(mechanism, snapshot, 'location_ballot')
      || (snapshot.openRound !== null
        && snapshot.votes.length === snapshot.activeMembers.length)
      || !snapshot.candidates.actorLocationIds.includes(input.locationId)
      || snapshot.activeMembers.some((member) => (
        Object.keys(snapshot.candidates.clueIdsByRoleId[member.roleId] ?? {}).length === 0
      ))
    ) throw new Error('VOTE_REJECTED');
    const round = ensureRound(database, snapshot, input.stageId);
    if (round.selectedLocationId !== null) throw new Error('ROUND_RESOLVED');
    database.prepare(`
      INSERT INTO investigation_votes
        (room_id, stage_id, round_number, membership_id, location_id, voted_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, stage_id, round_number, membership_id)
      DO UPDATE SET location_id = excluded.location_id, voted_at = excluded.voted_at
    `).run(
      actor.roomId,
      input.stageId,
      round.roundNumber,
      actor.membershipId,
      input.locationId,
      Date.now(),
    );
    snapshot = buildSnapshot(database, input.bundle, mechanism, actor, input.stageId);
    if (snapshot.votes.length === snapshot.activeMembers.length) {
      const tied = snapshot.tiedLocationIds;
      if (tied.length === 1) {
        const selectedLocationId = tied[0];
        const cursor = findEligibleCursor(
          snapshot.activeMembers,
          snapshot.candidates,
          snapshot.openRound?.tieBreakMembershipId ?? null,
          selectedLocationId,
          false,
        );
        if (!cursor) throw new Error('NO_ELIGIBLE_CURSOR');
        database.prepare(`
          UPDATE investigation_rounds
          SET selected_location_id = ?, cursor_membership_id = ?
          WHERE room_id = ? AND stage_id = ? AND round_number = ?
            AND selected_location_id IS NULL
        `).run(selectedLocationId, cursor, actor.roomId, input.stageId, round.roundNumber);
      }
    }
    commitAuthorizationVersion(database, actor.roomId, input.authorizationVersion);
    database.exec('COMMIT');
    return true;
  } catch {
    rollback(database);
    return false;
  }
}

export function selectRotatingBlindDrawTieLocation(input: {
  code: string;
  userId: string;
  versionId: string;
  authorizationVersion: number;
  stageId: string;
  locationId: string;
  bundle: BlindBundle;
  mechanism: RotatingBlindDrawMechanismV2 | unknown;
}) {
  if (
    !validBaseInput(input)
    || !LOCATION_ID.test(input.locationId)
    || input.bundle.script.versionId !== input.versionId
  ) return false;
  const database = getDatabase();
  try {
    const mechanism = normalizeMechanism(input.mechanism, input.bundle, input.stageId);
    if (mechanism.selection.mode !== 'collective_location_vote') return false;
    begin(database);
    const actor = loadActor(database, input);
    if (!actor) throw new Error('ACTOR_REJECTED');
    const snapshot = buildSnapshot(database, input.bundle, mechanism, actor, input.stageId);
    if (
      snapshot.tiedLocationIds.length < 2
      || snapshot.openRound?.tieBreakMembershipId !== actor.membershipId
      || !snapshot.tiedLocationIds.includes(input.locationId)
      || !snapshot.candidates.actorLocationIds.includes(input.locationId)
      || actionBlocked(mechanism, snapshot, 'location_ballot')
    ) throw new Error('TIE_BREAK_REJECTED');
    const cursor = findEligibleCursor(
      snapshot.activeMembers,
      snapshot.candidates,
      actor.membershipId,
      input.locationId,
      false,
    );
    if (!cursor) throw new Error('NO_ELIGIBLE_CURSOR');
    const selected = database.prepare(`
      UPDATE investigation_rounds
      SET selected_location_id = ?, cursor_membership_id = ?
      WHERE room_id = ? AND stage_id = ? AND round_number = ?
        AND selected_location_id IS NULL
    `).run(
      input.locationId,
      cursor,
      actor.roomId,
      input.stageId,
      snapshot.openRound.roundNumber,
    );
    if (selected.changes !== 1) throw new Error('TIE_BREAK_REJECTED');
    commitAuthorizationVersion(database, actor.roomId, input.authorizationVersion);
    database.exec('COMMIT');
    return true;
  } catch {
    rollback(database);
    return false;
  }
}

function incrementCanonicalUse(
  database: Database,
  roomId: string,
  membershipId: string,
  stageId: string,
  locationId: string,
  bundle: BlindBundle,
) {
  const policy = bundle.locations[locationId]?.searchPolicy;
  if (
    !policy
    || policy.mode === 'host_dealt'
    || policy.mode === 'fixed_sequence'
  ) throw new Error('CANONICAL_SEARCH_REJECTED');
  const personalLimit = policy.perPlayerLimit ?? 2147483647;
  const roomLimit = policy.globalLimit ?? 2147483647;
  const usageStageIds = canonicalUsageWindowStageIds(bundle, stageId, locationId);
  if (usageStageIds.length === 0) throw new Error('CANONICAL_SEARCH_REJECTED');
  const placeholders = usageStageIds.map(() => '?').join(', ');
  const personalTotal = (database.prepare(`
    SELECT COALESCE(SUM(uses), 0) AS uses FROM search_uses
    WHERE room_id = ? AND location_id = ? AND membership_id = ?
      AND stage_id IN (${placeholders})
  `).get(roomId, locationId, membershipId, ...usageStageIds) as { uses: number }).uses;
  const roomTotal = (database.prepare(`
    SELECT COALESCE(SUM(uses), 0) AS uses FROM location_search_totals
    WHERE room_id = ? AND location_id = ?
      AND stage_id IN (${placeholders})
  `).get(roomId, locationId, ...usageStageIds) as { uses: number }).uses;
  if (personalTotal >= personalLimit || roomTotal >= roomLimit) {
    throw new Error('CANONICAL_LIMIT_REJECTED');
  }
  const personal = database.prepare(`
    INSERT INTO search_uses (room_id, location_id, stage_id, membership_id, uses)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(room_id, location_id, stage_id, membership_id)
    DO UPDATE SET uses = uses + 1
  `).run(roomId, locationId, stageId, membershipId);
  const room = database.prepare(`
    INSERT INTO location_search_totals (room_id, location_id, stage_id, uses)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(room_id, location_id, stage_id)
    DO UPDATE SET uses = uses + 1
  `).run(roomId, locationId, stageId);
  if (personal.changes !== 1 || room.changes !== 1) throw new Error('CANONICAL_LIMIT_REJECTED');
}

export function acquireRotatingBlindDrawClue(input: {
  code: string;
  userId: string;
  versionId: string;
  authorizationVersion: number;
  stageId: string;
  locationId: string;
  clueId: string;
  bundle: BlindBundle;
  mechanism: RotatingBlindDrawMechanismV2 | unknown;
}) {
  if (
    !validBaseInput(input)
    || !LOCATION_ID.test(input.locationId)
    || !CLUE_ID.test(input.clueId)
    || input.bundle.script.versionId !== input.versionId
  ) return false;
  const database = getDatabase();
  try {
    const mechanism = normalizeMechanism(input.mechanism, input.bundle, input.stageId);
    begin(database);
    const actor = loadActor(database, input);
    if (!actor) throw new Error('ACTOR_REJECTED');
    let snapshot = buildSnapshot(database, input.bundle, mechanism, actor, input.stageId);
    if (
      snapshot.stageCompleted
      || snapshot.searchScopeExhausted
      || actionBlocked(mechanism, snapshot, 'blind_draw')
    ) throw new Error('DRAW_REJECTED');
    let round = snapshot.openRound;
    if (mechanism.selection.mode === 'collective_location_vote') {
      if (!round?.selectedLocationId || round.selectedLocationId !== input.locationId) {
        throw new Error('LOCATION_REJECTED');
      }
    } else {
      round = ensureRound(database, snapshot, input.stageId);
      snapshot = buildSnapshot(database, input.bundle, mechanism, actor, input.stageId);
    }
    if (
      !round
      || snapshot.currentTurnMembershipId !== actor.membershipId
    ) throw new Error('CURSOR_REJECTED');
    const scoped = mechanism.selection.mode === 'collective_location_vote'
      ? { [input.locationId]: snapshot.candidates.actorClueIdsByLocation[input.locationId] ?? [] }
      : snapshot.candidates.actorClueIdsByLocation;
    const selectable = projectBlindDrawBackOptions(input.bundle, snapshot.context, scoped);
    if (!selectable.some((option) => (
      option.locationId === input.locationId && option.clueId === input.clueId
    ))) throw new Error('CLUE_REJECTED');

    incrementCanonicalUse(
      database,
      actor.roomId,
      actor.membershipId,
      input.stageId,
      input.locationId,
      input.bundle,
    );
    const now = Date.now();
    database.prepare(`
      INSERT INTO clue_holdings (room_id, clue_id, holder_membership_id, acquired_at)
      VALUES (?, ?, ?, ?)
    `).run(actor.roomId, input.clueId, actor.membershipId, now);
    database.prepare(`
      INSERT INTO investigation_acquisitions
        (room_id, clue_id, stage_id, round_number, membership_id, acquired_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      actor.roomId,
      input.clueId,
      input.stageId,
      round.roundNumber,
      actor.membershipId,
      now,
    );
    database.prepare(`
      INSERT INTO room_events
        (id, room_id, actor_membership_id, event_type, object_id, event_payload, created_at)
      VALUES (?, ?, ?, 'investigation_clue_acquired_v2', ?, '{}', ?)
    `).run(randomUUID(), actor.roomId, actor.membershipId, input.clueId, now);

    snapshot = buildSnapshot(database, input.bundle, mechanism, actor, input.stageId);
    const selectedLocationId = mechanism.selection.mode === 'collective_location_vote'
      ? input.locationId
      : null;
    const remaining = selectedLocationId
      ? snapshot.candidates.roomClueIdsByLocation[selectedLocationId] ?? []
      : Object.values(snapshot.candidates.roomClueIdsByLocation).flat();
    const nextCursor = findEligibleCursor(
      snapshot.activeMembers,
      snapshot.candidates,
      actor.membershipId,
      selectedLocationId,
      true,
    );
    if (remaining.length === 0 || !nextCursor) {
      database.prepare(`
        UPDATE investigation_rounds
        SET cursor_membership_id = NULL, completed_at = ?
        WHERE room_id = ? AND stage_id = ? AND round_number = ? AND completed_at IS NULL
      `).run(now, actor.roomId, input.stageId, round.roundNumber);
    } else {
      database.prepare(`
        UPDATE investigation_rounds SET cursor_membership_id = ?
        WHERE room_id = ? AND stage_id = ? AND round_number = ? AND completed_at IS NULL
      `).run(nextCursor, actor.roomId, input.stageId, round.roundNumber);
    }
    commitAuthorizationVersion(database, actor.roomId, input.authorizationVersion);
    database.exec('COMMIT');
    return true;
  } catch {
    rollback(database);
    return false;
  }
}

export function voteRotatingBlindDrawCompletion(input: {
  code: string;
  userId: string;
  versionId: string;
  authorizationVersion: number;
  stageId: string;
  bundle: BlindBundle;
  mechanism: RotatingBlindDrawMechanismV2 | unknown;
}) {
  if (!validBaseInput(input) || input.bundle.script.versionId !== input.versionId) return false;
  const database = getDatabase();
  try {
    const mechanism = normalizeMechanism(input.mechanism, input.bundle, input.stageId);
    begin(database);
    const actor = loadActor(database, input);
    if (!actor) throw new Error('ACTOR_REJECTED');
    const snapshot = buildSnapshot(database, input.bundle, mechanism, actor, input.stageId);
    if (
      snapshot.stageCompleted
      || !snapshot.searchScopeExhausted
      || actionBlocked(mechanism, snapshot, 'completion_ballot')
      || snapshot.mandatoryPublicationMembershipIds.length > 0
      || snapshot.privateLimitBlockedMembershipIds.length > 0
      || snapshot.completionVoteMembershipIds.includes(actor.membershipId)
    ) throw new Error('COMPLETION_REJECTED');
    const now = Date.now();
    database.prepare(`
      DELETE FROM investigation_completion_votes
      WHERE room_id = ? AND stage_id = ? AND authorization_version != ?
    `).run(actor.roomId, input.stageId, input.authorizationVersion);
    database.prepare(`
      INSERT INTO investigation_completion_votes
        (room_id, stage_id, membership_id, authorization_version, consent, voted_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(actor.roomId, input.stageId, actor.membershipId, input.authorizationVersion, now);
    const count = (database.prepare(`
      SELECT COUNT(*) AS count FROM investigation_completion_votes
      WHERE room_id = ? AND stage_id = ? AND authorization_version = ? AND consent = 1
    `).get(actor.roomId, input.stageId, input.authorizationVersion) as { count: number }).count;
    if (count >= mechanism.completion.threshold) {
      database.prepare(`
        INSERT INTO investigation_stage_completions (room_id, stage_id, completed_at)
        VALUES (?, ?, ?)
      `).run(actor.roomId, input.stageId, now);
      commitAuthorizationVersion(database, actor.roomId, input.authorizationVersion);
    }
    database.exec('COMMIT');
    return true;
  } catch {
    rollback(database);
    return false;
  }
}
