export type CollectiveVoteRoundRobinFlowFields = {
  locationSelection: {
    mode: 'vote';
    scope: 'room_scoped' | 'stage_scoped';
    resolution: 'plurality_all_cast';
    tieBreak: 'seat_cursor_choice';
  };
  turnOrder: { mode: 'seat_order' };
  clueDeal: {
    mode: 'verified_pool_order';
    commit: 'one_per_turn';
  };
  acquisitionLimit: {
    scope: 'stage';
    perPlayer: number;
  };
  publicationDuty: {
    predicate: 'round_scoped_private_holding_count';
    maxPrivateCount: number;
    action: 'publish_one_held';
    blockedActions: Array<'vote_location' | 'search'>;
  };
  roleRestrictions?: Array<{
    principalRoleId: string;
    restrictedLocationIds: string[];
    restrictedClueIds: string[];
    mode: 'deny_unless_only_remaining_eligible';
  }>;
  completion?: {
    mode: 'consent_vote';
    exhaustive: 'per_player_quota';
  };
};

/** Historical blind-script/1.0 bundles did not tag their investigation flow. */
export type LegacyCollectiveVoteRoundRobinFlow = CollectiveVoteRoundRobinFlowFields & {
  kind?: never;
  version?: never;
};

export type CollectiveVoteRoundRobinFlowV1 = CollectiveVoteRoundRobinFlowFields & {
  kind: 'collective_vote_round_robin';
  version: 1;
};

export type InvestigationFlow =
  | LegacyCollectiveVoteRoundRobinFlow
  | CollectiveVoteRoundRobinFlowV1;

export type DirectPickMechanismV1 = {
  kind: 'direct_pick';
  version: 1;
};

export type NormalizedSearchMechanism =
  | DirectPickMechanismV1
  | CollectiveVoteRoundRobinFlowV1;

export type InvestigationConfigErrorCode =
  | 'MALFORMED_INVESTIGATION_FLOW'
  | 'UNSUPPORTED_INVESTIGATION_KIND'
  | 'UNSUPPORTED_INVESTIGATION_VERSION';

export class InvestigationConfigError extends Error {
  readonly code: InvestigationConfigErrorCode;

  constructor(code: InvestigationConfigErrorCode) {
    super(code);
    this.name = 'InvestigationConfigError';
    this.code = code;
  }
}

type UnknownRecord = Record<string, unknown>;

const own = (value: UnknownRecord, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function malformed(): never {
  throw new InvestigationConfigError('MALFORMED_INVESTIGATION_FLOW');
}

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) malformed();
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []) {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !own(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) malformed();
}

function literal<T extends string>(value: unknown, expected: T): T {
  if (value !== expected) malformed();
  return expected;
}

function stringValue(value: unknown) {
  if (typeof value !== 'string' || value.length === 0) malformed();
  return value;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) malformed();
  const result = value.map(stringValue);
  if (new Set(result).size !== result.length) malformed();
  return result;
}

function nonNegativeInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) malformed();
  return value as number;
}

function positiveInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) malformed();
  return value as number;
}

function locationSelection(value: unknown): CollectiveVoteRoundRobinFlowFields['locationSelection'] {
  const candidate = record(value);
  exactKeys(candidate, ['mode', 'scope', 'resolution', 'tieBreak']);
  if (candidate.scope !== 'room_scoped' && candidate.scope !== 'stage_scoped') malformed();
  return {
    mode: literal(candidate.mode, 'vote'),
    scope: candidate.scope,
    resolution: literal(candidate.resolution, 'plurality_all_cast'),
    tieBreak: literal(candidate.tieBreak, 'seat_cursor_choice'),
  };
}

function turnOrder(value: unknown): CollectiveVoteRoundRobinFlowFields['turnOrder'] {
  const candidate = record(value);
  exactKeys(candidate, ['mode']);
  return { mode: literal(candidate.mode, 'seat_order') };
}

function clueDeal(value: unknown): CollectiveVoteRoundRobinFlowFields['clueDeal'] {
  const candidate = record(value);
  exactKeys(candidate, ['mode', 'commit']);
  return {
    mode: literal(candidate.mode, 'verified_pool_order'),
    commit: literal(candidate.commit, 'one_per_turn'),
  };
}

function acquisitionLimit(value: unknown): CollectiveVoteRoundRobinFlowFields['acquisitionLimit'] {
  const candidate = record(value);
  exactKeys(candidate, ['scope', 'perPlayer']);
  return {
    scope: literal(candidate.scope, 'stage'),
    perPlayer: positiveInteger(candidate.perPlayer),
  };
}

function publicationDuty(value: unknown): CollectiveVoteRoundRobinFlowFields['publicationDuty'] {
  const candidate = record(value);
  exactKeys(candidate, ['predicate', 'maxPrivateCount', 'action', 'blockedActions']);
  if (!Array.isArray(candidate.blockedActions)) malformed();
  const blockedActions = candidate.blockedActions.map((action) => {
    if (action !== 'vote_location' && action !== 'search') malformed();
    return action;
  });
  if (new Set(blockedActions).size !== blockedActions.length) malformed();
  return {
    predicate: literal(candidate.predicate, 'round_scoped_private_holding_count'),
    maxPrivateCount: nonNegativeInteger(candidate.maxPrivateCount),
    action: literal(candidate.action, 'publish_one_held'),
    blockedActions,
  };
}

function roleRestrictions(
  value: unknown,
): NonNullable<CollectiveVoteRoundRobinFlowFields['roleRestrictions']> {
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
      principalRoleId: stringValue(candidate.principalRoleId),
      restrictedLocationIds: stringArray(candidate.restrictedLocationIds),
      restrictedClueIds: stringArray(candidate.restrictedClueIds),
      mode: literal(candidate.mode, 'deny_unless_only_remaining_eligible'),
    };
  });
  if (new Set(result.map((entry) => entry.principalRoleId)).size !== result.length) malformed();
  return result;
}

function completion(value: unknown): NonNullable<CollectiveVoteRoundRobinFlowFields['completion']> {
  const candidate = record(value);
  exactKeys(candidate, ['mode', 'exhaustive']);
  return {
    mode: literal(candidate.mode, 'consent_vote'),
    exhaustive: literal(candidate.exhaustive, 'per_player_quota'),
  };
}

function collectiveFields(
  value: UnknownRecord,
  tagged: boolean,
): CollectiveVoteRoundRobinFlowFields {
  exactKeys(
    value,
    [
      ...(tagged ? ['kind', 'version'] : []),
      'locationSelection',
      'turnOrder',
      'clueDeal',
      'acquisitionLimit',
      'publicationDuty',
    ],
    ['roleRestrictions', 'completion'],
  );
  return {
    locationSelection: locationSelection(value.locationSelection),
    turnOrder: turnOrder(value.turnOrder),
    clueDeal: clueDeal(value.clueDeal),
    acquisitionLimit: acquisitionLimit(value.acquisitionLimit),
    publicationDuty: publicationDuty(value.publicationDuty),
    ...(own(value, 'roleRestrictions')
      ? { roleRestrictions: roleRestrictions(value.roleRestrictions) }
      : {}),
    ...(own(value, 'completion') ? { completion: completion(value.completion) } : {}),
  };
}

/**
 * Parse only the configuration body used by a versioned runtime-policy
 * handler. This intentionally accepts neither kind nor version: those are
 * authenticated by the outer runtime-policy dispatcher.
 */
export function normalizeCollectiveVoteRoundRobinConfig(
  value: unknown,
): CollectiveVoteRoundRobinFlowFields {
  return collectiveFields(record(value), false);
}

/**
 * Resolve the persisted flow into a tagged runtime mechanism without changing
 * the source object. An omitted flow is the historical direct-pick behavior.
 */
export function normalizeSearchMechanism(value: unknown): NormalizedSearchMechanism {
  if (value === undefined) return { kind: 'direct_pick', version: 1 };

  const candidate = record(value);
  const hasKind = own(candidate, 'kind');
  const hasVersion = own(candidate, 'version');
  if (hasKind !== hasVersion) malformed();

  if (!hasKind) {
    return {
      kind: 'collective_vote_round_robin',
      version: 1,
      ...collectiveFields(candidate, false),
    };
  }
  if (candidate.kind !== 'collective_vote_round_robin') {
    throw new InvestigationConfigError('UNSUPPORTED_INVESTIGATION_KIND');
  }
  if (candidate.version !== 1) {
    throw new InvestigationConfigError('UNSUPPORTED_INVESTIGATION_VERSION');
  }
  return {
    kind: 'collective_vote_round_robin',
    version: 1,
    ...collectiveFields(candidate, true),
  };
}

/** Validate every stage flow in a parsed bundle while preserving its payload. */
export function validateStageSearchMechanisms(stages: unknown) {
  const candidateStages = record(stages);
  for (const stage of Object.values(candidateStages)) {
    const candidateStage = record(stage);
    normalizeSearchMechanism(own(candidateStage, 'investigationFlow')
      ? candidateStage.investigationFlow
      : undefined);
  }
}
