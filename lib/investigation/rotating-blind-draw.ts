import {
  canReadContent,
  evaluateViewerCondition,
  type AuthorizationContext,
  type BlindBundle,
  type ProjectedContent,
} from '../blind-runtime.ts';
import type {
  RuntimeMechanismSpec,
  RuntimeMechanismValidationContext,
  RuntimePolicyErrorCode,
} from './runtime-policy.ts';

export const ROTATING_BLIND_DRAW_KIND = 'collective_vote_rotating_blind_draw' as const;
export const ROTATING_BLIND_DRAW_VERSION = 2 as const;

export type RotatingBlindDrawAction =
  | 'location_ballot'
  | 'blind_draw'
  | 'completion_ballot';

export type RotatingBlindDrawRestriction = {
  principalRoleId: string;
  restrictedLocationIds: string[];
  restrictedClueIds: string[];
  mode: 'deny_unless_only_remaining_eligible';
};

export type CollectiveLocationVoteSelection = {
  mode: 'collective_location_vote';
  ballotCompletion: 'all_active_assigned_members';
  resolution: 'plurality';
  tieBreak: 'current_cursor_choice';
  locationsToExhaust: 1;
};

export type ActorBlindPickSelection = {
  mode: 'actor_blind_pick_all_remaining';
  locationsToExhaust: 'all_remaining';
};

export type RotatingBlindDrawMechanismV2 = {
  kind: typeof ROTATING_BLIND_DRAW_KIND;
  version: typeof ROTATING_BLIND_DRAW_VERSION;
  cursor: {
    roleIds: string[];
    requireFullRoleAssignment: true;
    carryAcrossStages: true;
    advanceAfter: 'successful_acquisition';
  };
  exhaustedLocationScope: 'stage' | 'room_lifetime';
  selection: CollectiveLocationVoteSelection | ActorBlindPickSelection;
  candidateLocationIds: string[];
  locationClueIds: Record<string, string[]>;
  draw: {
    mode: 'blind_choice_without_replacement';
    exhaust: 'selected_location_pool' | 'all_remaining_location_pools';
    perTurnAcquisitionLimit: 1;
    visibleBeforeAcquire: 'back_face_only';
  };
  publication: {
    privateHoldingLimit: number;
    countScope: 'room_lifetime';
    mandatoryClueIds: string[];
    blockedActions: RotatingBlindDrawAction[];
  };
  roleRestrictions: RotatingBlindDrawRestriction[];
  completion: {
    mode: 'member_consent';
    threshold: number;
    requires: ['search_scope_exhausted', 'publication_obligations_cleared'];
  };
};

export type RotatingBlindDrawConfigV2 = Omit<
  RotatingBlindDrawMechanismV2,
  'kind' | 'version'
>;

export type RotatingBlindDrawViewer = {
  assignedRoleId: string;
  heldClueIds: ReadonlySet<string>;
  searchUsesByLocation?: Readonly<Record<string, number>>;
};

export type RotatingBlindDrawCandidates = {
  roomLocationIds: string[];
  actorLocationIds: string[];
  roomClueIdsByLocation: Record<string, string[]>;
  actorClueIdsByLocation: Record<string, string[]>;
  clueIdsByRoleId: Record<string, Record<string, string[]>>;
};

export type BlindDrawBackOption = {
  clueId: string;
  locationId: string;
  faceId: string;
  content: ProjectedContent[];
};

export type RotatingBlindDrawConfigErrorCode =
  | 'MALFORMED_ROTATING_BLIND_DRAW'
  | 'ROTATING_BLIND_DRAW_BUNDLE_MISMATCH';

export class RotatingBlindDrawConfigError extends Error {
  readonly code: RotatingBlindDrawConfigErrorCode;

  constructor(code: RotatingBlindDrawConfigErrorCode) {
    super(code);
    this.name = 'RotatingBlindDrawConfigError';
    this.code = code;
  }
}

type UnknownRecord = Record<string, unknown>;

const own = (value: UnknownRecord, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function malformed(): never {
  throw new RotatingBlindDrawConfigError('MALFORMED_ROTATING_BLIND_DRAW');
}

function mismatch(): never {
  throw new RotatingBlindDrawConfigError('ROTATING_BLIND_DRAW_BUNDLE_MISMATCH');
}

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) malformed();
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, required: readonly string[]) {
  const allowed = new Set(required);
  if (
    required.some((key) => !own(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) malformed();
}

function literal<T extends string | number | boolean>(value: unknown, expected: T): T {
  if (value !== expected) malformed();
  return expected;
}

function identifier(value: unknown, prefix: 'role' | 'loc' | 'clue') {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[0-9a-f]{8,64}$`).test(value)) {
    malformed();
  }
  return value;
}

function uniqueIdentifiers(value: unknown, prefix: 'role' | 'loc' | 'clue') {
  if (!Array.isArray(value)) malformed();
  const result = value.map((item) => identifier(item, prefix));
  if (result.length === 0 || new Set(result).size !== result.length) malformed();
  return result;
}

function positiveInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) malformed();
  return value as number;
}

function parseSelection(value: unknown): RotatingBlindDrawMechanismV2['selection'] {
  const candidate = record(value);
  if (candidate.mode === 'collective_location_vote') {
    exactKeys(candidate, ['mode', 'ballotCompletion', 'resolution', 'tieBreak', 'locationsToExhaust']);
    return {
      mode: literal(candidate.mode, 'collective_location_vote'),
      ballotCompletion: literal(candidate.ballotCompletion, 'all_active_assigned_members'),
      resolution: literal(candidate.resolution, 'plurality'),
      tieBreak: literal(candidate.tieBreak, 'current_cursor_choice'),
      locationsToExhaust: literal(candidate.locationsToExhaust, 1),
    };
  }
  if (candidate.mode === 'actor_blind_pick_all_remaining') {
    exactKeys(candidate, ['mode', 'locationsToExhaust']);
    return {
      mode: literal(candidate.mode, 'actor_blind_pick_all_remaining'),
      locationsToExhaust: literal(candidate.locationsToExhaust, 'all_remaining'),
    };
  }
  malformed();
}

function parseLocationClueIds(value: unknown, candidateLocationIds: readonly string[]) {
  const candidate = record(value);
  if (
    Object.keys(candidate).length !== candidateLocationIds.length
    || Object.keys(candidate).some((locationId) => !candidateLocationIds.includes(locationId))
  ) malformed();
  const result: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const locationId of candidateLocationIds) {
    const clueIds = uniqueIdentifiers(candidate[locationId], 'clue');
    if (clueIds.some((clueId) => seen.has(clueId))) malformed();
    clueIds.forEach((clueId) => seen.add(clueId));
    result[locationId] = clueIds;
  }
  return result;
}

function parseBlockedActions(value: unknown) {
  if (!Array.isArray(value)) malformed();
  const result = value.map((action) => {
    if (action !== 'location_ballot' && action !== 'blind_draw' && action !== 'completion_ballot') {
      malformed();
    }
    return action;
  });
  if (new Set(result).size !== result.length) malformed();
  return result;
}

function parseRestrictions(value: unknown) {
  if (!Array.isArray(value)) malformed();
  const result = value.map((entry) => {
    const candidate = record(entry);
    exactKeys(candidate, [
      'principalRoleId',
      'restrictedLocationIds',
      'restrictedClueIds',
      'mode',
    ]);
    return {
      principalRoleId: identifier(candidate.principalRoleId, 'role'),
      restrictedLocationIds: Array.isArray(candidate.restrictedLocationIds)
        ? candidate.restrictedLocationIds.map((id) => identifier(id, 'loc'))
        : malformed(),
      restrictedClueIds: Array.isArray(candidate.restrictedClueIds)
        ? candidate.restrictedClueIds.map((id) => identifier(id, 'clue'))
        : malformed(),
      mode: literal(candidate.mode, 'deny_unless_only_remaining_eligible'),
    } satisfies RotatingBlindDrawRestriction;
  });
  if (
    new Set(result.map((item) => item.principalRoleId)).size !== result.length
    || result.some((item) => (
      new Set(item.restrictedLocationIds).size !== item.restrictedLocationIds.length
      || new Set(item.restrictedClueIds).size !== item.restrictedClueIds.length
    ))
  ) malformed();
  return result;
}

export function parseRotatingBlindDrawMechanism(value: unknown): RotatingBlindDrawMechanismV2 {
  const candidate = record(value);
  exactKeys(candidate, [
    'kind',
    'version',
    'cursor',
    'exhaustedLocationScope',
    'selection',
    'candidateLocationIds',
    'locationClueIds',
    'draw',
    'publication',
    'roleRestrictions',
    'completion',
  ]);
  literal(candidate.kind, ROTATING_BLIND_DRAW_KIND);
  literal(candidate.version, ROTATING_BLIND_DRAW_VERSION);

  const cursor = record(candidate.cursor);
  exactKeys(cursor, [
    'roleIds',
    'requireFullRoleAssignment',
    'carryAcrossStages',
    'advanceAfter',
  ]);
  const selection = parseSelection(candidate.selection);
  const candidateLocationIds = uniqueIdentifiers(candidate.candidateLocationIds, 'loc');
  const locationClueIds = parseLocationClueIds(candidate.locationClueIds, candidateLocationIds);

  const draw = record(candidate.draw);
  exactKeys(draw, [
    'mode',
    'exhaust',
    'perTurnAcquisitionLimit',
    'visibleBeforeAcquire',
  ]);
  if (draw.exhaust !== 'selected_location_pool' && draw.exhaust !== 'all_remaining_location_pools') {
    malformed();
  }
  if (
    (selection.mode === 'collective_location_vote' && draw.exhaust !== 'selected_location_pool')
    || (selection.mode === 'actor_blind_pick_all_remaining'
      && draw.exhaust !== 'all_remaining_location_pools')
  ) malformed();

  const publication = record(candidate.publication);
  exactKeys(publication, [
    'privateHoldingLimit',
    'countScope',
    'mandatoryClueIds',
    'blockedActions',
  ]);

  const completion = record(candidate.completion);
  exactKeys(completion, ['mode', 'threshold', 'requires']);
  if (
    !Array.isArray(completion.requires)
    || completion.requires.length !== 2
    || completion.requires[0] !== 'search_scope_exhausted'
    || completion.requires[1] !== 'publication_obligations_cleared'
  ) malformed();

  const parsed: RotatingBlindDrawMechanismV2 = {
    kind: ROTATING_BLIND_DRAW_KIND,
    version: ROTATING_BLIND_DRAW_VERSION,
    cursor: {
      roleIds: uniqueIdentifiers(cursor.roleIds, 'role'),
      requireFullRoleAssignment: literal(cursor.requireFullRoleAssignment, true),
      carryAcrossStages: literal(cursor.carryAcrossStages, true),
      advanceAfter: literal(cursor.advanceAfter, 'successful_acquisition'),
    },
    exhaustedLocationScope: candidate.exhaustedLocationScope === 'stage'
      ? 'stage'
      : literal(candidate.exhaustedLocationScope, 'room_lifetime'),
    selection,
    candidateLocationIds,
    locationClueIds,
    draw: {
      mode: literal(draw.mode, 'blind_choice_without_replacement'),
      exhaust: draw.exhaust,
      perTurnAcquisitionLimit: literal(draw.perTurnAcquisitionLimit, 1),
      visibleBeforeAcquire: literal(draw.visibleBeforeAcquire, 'back_face_only'),
    },
    publication: {
      privateHoldingLimit: positiveInteger(publication.privateHoldingLimit),
      countScope: literal(publication.countScope, 'room_lifetime'),
      mandatoryClueIds: Array.isArray(publication.mandatoryClueIds)
        ? publication.mandatoryClueIds.map((id) => identifier(id, 'clue'))
        : malformed(),
      blockedActions: parseBlockedActions(publication.blockedActions),
    },
    roleRestrictions: parseRestrictions(candidate.roleRestrictions),
    completion: {
      mode: literal(completion.mode, 'member_consent'),
      threshold: positiveInteger(completion.threshold),
      requires: ['search_scope_exhausted', 'publication_obligations_cleared'],
    },
  };
  if (
    new Set(parsed.publication.mandatoryClueIds).size
      !== parsed.publication.mandatoryClueIds.length
    || parsed.publication.blockedActions.length !== 3
    || parsed.completion.threshold > parsed.cursor.roleIds.length
  ) malformed();
  return parsed;
}

export function isRotatingBlindDrawMechanism(
  value: unknown,
): value is RotatingBlindDrawMechanismV2 {
  try {
    parseRotatingBlindDrawMechanism(value);
    return true;
  } catch {
    return false;
  }
}

export function runtimeMechanismsRequireFullRoleAssignment(
  stageMechanisms: Readonly<Record<string, unknown>>,
) {
  return Object.values(stageMechanisms).some((mechanism) => (
    isRotatingBlindDrawMechanism(mechanism)
    && mechanism.cursor.requireFullRoleAssignment
  ));
}

export function parseRotatingBlindDrawConfig(value: unknown): RotatingBlindDrawConfigV2 {
  const candidate = record(value);
  if (own(candidate, 'kind') || own(candidate, 'version')) malformed();
  const parsed = parseRotatingBlindDrawMechanism({
    kind: ROTATING_BLIND_DRAW_KIND,
    version: ROTATING_BLIND_DRAW_VERSION,
    ...candidate,
  });
  return {
    cursor: parsed.cursor,
    exhaustedLocationScope: parsed.exhaustedLocationScope,
    selection: parsed.selection,
    candidateLocationIds: parsed.candidateLocationIds,
    locationClueIds: parsed.locationClueIds,
    draw: parsed.draw,
    publication: parsed.publication,
    roleRestrictions: parsed.roleRestrictions,
    completion: parsed.completion,
  };
}

function validateRuntimePolicyReferences(
  config: RotatingBlindDrawConfigV2,
  context: RuntimeMechanismValidationContext,
  reject: (code: RuntimePolicyErrorCode) => never,
) {
  const mechanism: RotatingBlindDrawMechanismV2 = {
    kind: ROTATING_BLIND_DRAW_KIND,
    version: ROTATING_BLIND_DRAW_VERSION,
    ...config,
  };
  const { bundle, stageId, stageLocationIds, stageClueIds } = context;
  const stage = bundle.stages[stageId];
  const roleIds = new Set(Object.keys(bundle.roles));
  const pooledClueIds = new Set(Object.values(config.locationClueIds).flat());
  if (
    !stage
    || config.cursor.roleIds.some((roleId) => !roleIds.has(roleId))
    || config.cursor.roleIds.length !== roleIds.size
  ) reject('RUNTIME_POLICY_REFERENCE_MISMATCH');
  if (!stage.allowedActions.includes('search') || !stage.allowedActions.includes('publish_clue')) {
    reject('RUNTIME_POLICY_CAPABILITY_WIDENING');
  }
  for (const locationId of config.candidateLocationIds) {
    const location = bundle.locations[locationId];
    if (!location) reject('RUNTIME_POLICY_REFERENCE_MISMATCH');
    if (
      !stageLocationIds.has(locationId)
      || location.searchPolicy.mode === 'host_dealt'
      || location.searchPolicy.mode === 'fixed_sequence'
    ) {
      reject('RUNTIME_POLICY_CAPABILITY_WIDENING');
    }
    const canonical = new Map(location.cluePool.map((entry) => [entry.clueId, entry]));
    for (const clueId of config.locationClueIds[locationId] ?? []) {
      const clue = bundle.clues[clueId];
      if (!clue) reject('RUNTIME_POLICY_REFERENCE_MISMATCH');
      const entry = canonical.get(clueId);
      if (
        !stageClueIds.has(clueId)
        || !entry
        || entry.copies !== 1
        || !clue.publication.allowed
      ) reject('RUNTIME_POLICY_CAPABILITY_WIDENING');
    }
  }
  if (config.publication.mandatoryClueIds.some((clueId) => !pooledClueIds.has(clueId))) {
    reject('RUNTIME_POLICY_CAPABILITY_WIDENING');
  }
  for (const restriction of config.roleRestrictions) {
    if (!roleIds.has(restriction.principalRoleId)) {
      reject('RUNTIME_POLICY_REFERENCE_MISMATCH');
    }
    if (
      restriction.restrictedLocationIds.some(
        (locationId) => !config.candidateLocationIds.includes(locationId),
      )
      || restriction.restrictedClueIds.some((clueId) => !pooledClueIds.has(clueId))
    ) reject('RUNTIME_POLICY_CAPABILITY_WIDENING');
  }
  try {
    crossValidateRotatingBlindDrawMechanism(mechanism, bundle, stageId);
  } catch {
    reject('RUNTIME_POLICY_REFERENCE_MISMATCH');
  }
}

export function createRotatingBlindDrawRuntimeMechanismSpec(
  reject: (code: RuntimePolicyErrorCode) => never,
): RuntimeMechanismSpec {
  return {
    kind: ROTATING_BLIND_DRAW_KIND,
    version: ROTATING_BLIND_DRAW_VERSION,
    configMode: 'required',
    parseConfig(value) {
      try {
        return parseRotatingBlindDrawConfig(value);
      } catch {
        reject('MALFORMED_RUNTIME_POLICY');
      }
    },
    validateReferences(config, context) {
      validateRuntimePolicyReferences(
        config as RotatingBlindDrawConfigV2,
        context,
        reject,
      );
    },
    toEffective(config) {
      return {
        kind: ROTATING_BLIND_DRAW_KIND,
        version: ROTATING_BLIND_DRAW_VERSION,
        ...(config as RotatingBlindDrawConfigV2),
      };
    },
  };
}

export function crossValidateRotatingBlindDrawMechanism(
  mechanism: RotatingBlindDrawMechanismV2,
  bundle: BlindBundle,
  stageId: string,
) {
  const stage = bundle.stages[stageId];
  if (
    !stage
    || !stage.allowedActions.includes('search')
    || !stage.allowedActions.includes('publish_clue')
  ) mismatch();
  const bundleRoleIds = new Set(Object.keys(bundle.roles));
  const candidateLocations = new Set(mechanism.candidateLocationIds);
  const pooledClues = new Set(Object.values(mechanism.locationClueIds).flat());
  if (
    mechanism.cursor.roleIds.some((roleId) => !bundleRoleIds.has(roleId))
    || new Set(mechanism.cursor.roleIds).size !== bundleRoleIds.size
    || [...bundleRoleIds].some((roleId) => !mechanism.cursor.roleIds.includes(roleId))
    || mechanism.candidateLocationIds.some((locationId) => (
      !stage.locationIds.includes(locationId) || !bundle.locations[locationId]
    ))
    || mechanism.publication.mandatoryClueIds.some((clueId) => !pooledClues.has(clueId))
  ) mismatch();
  for (const [locationId, clueIds] of Object.entries(mechanism.locationClueIds)) {
    const location = bundle.locations[locationId];
    if (
      !location
      || location.searchPolicy.mode === 'host_dealt'
      || location.searchPolicy.mode === 'fixed_sequence'
    ) mismatch();
    const canonicalEntries = new Map(location.cluePool.map((item) => [item.clueId, item]));
    if (clueIds.some((clueId) => {
      const entry = canonicalEntries.get(clueId);
      const clue = bundle.clues[clueId];
      return !entry
        || entry.copies !== 1
        || !clue
        || !clue.publication.allowed
        || !clue.faces.some((face) => face.side === 'back');
    })) mismatch();
  }
  for (const restriction of mechanism.roleRestrictions) {
    if (
      !bundleRoleIds.has(restriction.principalRoleId)
      || restriction.restrictedLocationIds.some((locationId) => !candidateLocations.has(locationId))
      || restriction.restrictedClueIds.some((clueId) => !pooledClues.has(clueId))
    ) mismatch();
  }
  return mechanism;
}

function applyFallbackRestriction(
  candidateIds: readonly string[],
  restrictedIds: readonly string[],
) {
  const restricted = new Set(restrictedIds);
  const unrestricted = candidateIds.filter((id) => !restricted.has(id));
  return unrestricted.length ? unrestricted : [...candidateIds];
}

function emptyCandidates(): RotatingBlindDrawCandidates {
  return {
    roomLocationIds: [],
    actorLocationIds: [],
    roomClueIdsByLocation: {},
    actorClueIdsByLocation: {},
    clueIdsByRoleId: {},
  };
}

export function deriveRotatingBlindDrawCandidates(
  bundle: BlindBundle,
  stageId: string,
  mechanism: RotatingBlindDrawMechanismV2,
  context: AuthorizationContext,
  viewers: readonly RotatingBlindDrawViewer[],
  exhaustedLocationIds: ReadonlySet<string>,
  roomSearchUsesByLocation: Readonly<Record<string, number>> = {},
): RotatingBlindDrawCandidates {
  if (!context.joined || !bundle.stages[stageId]) return emptyCandidates();
  const roomCluesByLocation = new Map<string, Set<string>>();
  const roomLocations = new Set<string>();
  const clueIdsByRoleId: Record<string, Record<string, string[]>> = {};

  for (const viewer of viewers) {
    const viewerContext: AuthorizationContext = {
      ...context,
      assignedRoleId: viewer.assignedRoleId,
      assignedRoleIds: new Set([viewer.assignedRoleId]),
      heldClueIds: viewer.heldClueIds,
    };
    const restriction = mechanism.roleRestrictions.find(
      (item) => item.principalRoleId === viewer.assignedRoleId,
    );
    const perLocation: Record<string, string[]> = {};
    const viewerLocations: string[] = [];

    for (const locationId of mechanism.candidateLocationIds) {
      const location = bundle.locations[locationId];
      const personalUses = viewer.searchUsesByLocation?.[locationId] ?? 0;
      const roomUses = roomSearchUsesByLocation[locationId] ?? 0;
      if (
        exhaustedLocationIds.has(locationId)
        || !location
        || location.searchPolicy.mode === 'host_dealt'
        || location.searchPolicy.mode === 'fixed_sequence'
        || (location.searchPolicy.perPlayerLimit !== null
          && personalUses >= location.searchPolicy.perPlayerLimit)
        || (location.searchPolicy.globalLimit !== null
          && roomUses >= location.searchPolicy.globalLimit)
        || !evaluateViewerCondition(location.availableWhen, viewerContext)
      ) continue;
      const configured = mechanism.locationClueIds[locationId] ?? [];
      const canonicalEntries = new Map(location.cluePool.map((entry) => [entry.clueId, entry]));
      const baseClueIds = configured.filter((clueId) => {
        const clue = bundle.clues[clueId];
        const entry = canonicalEntries.get(clueId);
        return Boolean(
          clue
          && entry
          && !context.roomHeldClueIds.has(clueId)
          && evaluateViewerCondition(entry.availableWhen, viewerContext)
          && evaluateViewerCondition(clue.acquisition.when, viewerContext),
        );
      });
      if (baseClueIds.length === 0) continue;
      const actorClueIds = applyFallbackRestriction(
        baseClueIds,
        restriction?.restrictedClueIds ?? [],
      );
      if (actorClueIds.length === 0) continue;
      perLocation[locationId] = actorClueIds;
      viewerLocations.push(locationId);
      const roomClues = roomCluesByLocation.get(locationId) ?? new Set<string>();
      baseClueIds.forEach((clueId) => roomClues.add(clueId));
      roomCluesByLocation.set(locationId, roomClues);
    }

    const actorLocations = applyFallbackRestriction(
      viewerLocations,
      restriction?.restrictedLocationIds ?? [],
    );
    const filtered: Record<string, string[]> = {};
    actorLocations.forEach((locationId) => { filtered[locationId] = perLocation[locationId]; });
    clueIdsByRoleId[viewer.assignedRoleId] = filtered;
    actorLocations.forEach((locationId) => roomLocations.add(locationId));
  }

  const roomClueIdsByLocation: Record<string, string[]> = {};
  for (const locationId of mechanism.candidateLocationIds) {
    const candidates = roomCluesByLocation.get(locationId);
    if (!candidates) continue;
    roomClueIdsByLocation[locationId] = mechanism.locationClueIds[locationId]
      .filter((clueId) => candidates.has(clueId));
  }
  const actorClueIdsByLocation = context.assignedRoleId
    ? clueIdsByRoleId[context.assignedRoleId] ?? {}
    : {};
  return {
    roomLocationIds: mechanism.candidateLocationIds.filter((id) => roomLocations.has(id)),
    actorLocationIds: mechanism.candidateLocationIds.filter(
      (id) => Boolean(actorClueIdsByLocation[id]),
    ),
    roomClueIdsByLocation,
    actorClueIdsByLocation,
    clueIdsByRoleId,
  };
}

function projectBackContent(
  bundle: BlindBundle,
  contentId: string,
  context: AuthorizationContext,
): ProjectedContent | null {
  const block = bundle.contentBlocks[contentId];
  if (!canReadContent(block, context)) return null;
  if (block.kind === 'text' && 'text' in block.payload) {
    return { kind: 'text', text: block.payload.text };
  }
  if (block.kind === 'image' && block.assetIds.length > 0 && block.trace.evidence.length > 0) {
    return { kind: 'image', contentId: block.contentId, parts: block.trace.evidence.length };
  }
  return null;
}

/**
 * The caller must pass only clue ids re-derived for the current actor and turn.
 * The projection deliberately selects back faces before reading any content id.
 */
export function projectBlindDrawBackOptions(
  bundle: BlindBundle,
  context: AuthorizationContext,
  clueIdsByLocation: Readonly<Record<string, readonly string[]>>,
): BlindDrawBackOption[] {
  const options: BlindDrawBackOption[] = [];
  for (const [locationId, clueIds] of Object.entries(clueIdsByLocation)) {
    for (const clueId of clueIds) {
      const clue = bundle.clues[clueId];
      const back = clue?.faces.find((face) => face.side === 'back');
      if (!back || !evaluateViewerCondition(back.revealWhen, context)) continue;
      const content = back.contentIds
        .map((contentId) => projectBackContent(bundle, contentId, context))
        .filter((item): item is ProjectedContent => item !== null);
      if (content.length === 0) continue;
      options.push({ clueId, locationId, faceId: back.faceId, content });
    }
  }
  return options;
}

export function canProjectBlindDrawBackImage(
  options: readonly BlindDrawBackOption[],
  contentId: string,
) {
  return options.some((option) => option.content.some(
    (content) => content.kind === 'image' && content.contentId === contentId,
  ));
}

/**
 * A canonical room-member grant may make a card back readable before acquisition,
 * but the rotating mechanism must still narrow that image to the current actor's
 * current draw options. Once the associated clue is held by this viewer or has
 * been published, the ordinary canonical projection remains authoritative.
 */
export function canProjectRotatingBlindDrawImage(
  bundle: BlindBundle,
  mechanism: RotatingBlindDrawMechanismV2,
  context: AuthorizationContext,
  options: readonly BlindDrawBackOption[],
  contentId: string,
  canonicalProjectionAllowed: boolean,
) {
  const pooledClueIds = new Set(Object.values(mechanism.locationClueIds).flat());
  const associatedClueIds = [...pooledClueIds].filter((clueId) => (
    bundle.clues[clueId]?.faces.some((face) => (
      face.side === 'back' && face.contentIds.includes(contentId)
    ))
  ));
  if (associatedClueIds.length === 0) return canonicalProjectionAllowed;
  if (associatedClueIds.some((clueId) => (
    context.heldClueIds.has(clueId) || context.publishedClueIds.has(clueId)
  ))) return canonicalProjectionAllowed;
  return canProjectBlindDrawBackImage(options, contentId);
}
