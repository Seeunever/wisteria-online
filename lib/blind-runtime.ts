import type {
  CollectiveVoteRoundRobinFlowV1,
  InvestigationFlow,
} from './investigation/config.ts';

export type {
  CollectiveVoteRoundRobinFlowV1,
  DirectPickMechanismV1,
  InvestigationFlow,
  LegacyCollectiveVoteRoundRobinFlow,
  NormalizedSearchMechanism,
} from './investigation/config.ts';

export type BlindCondition =
  | { op: 'always' | 'session_completed' }
  | { op: 'all' | 'any'; args: BlindCondition[] }
  | { op: 'not'; arg: BlindCondition }
  | { op: 'stage_active' | 'stage_reached'; stageId: string }
  | { op: 'investigation_complete' | 'completion_vote_satisfied'; stageId: string }
  | { op: 'role_assigned'; roleId: string }
  | { op: 'clue_held' | 'clue_published' | 'clue_acquired_in_room'; clueId: string }
  | { op: 'host_release'; releaseId: string };

type Principal = {
  kind: 'room_member' | 'role_assignee' | 'clue_holder' | 'room_after_event' | 'system_only';
  subjectId: string | null;
};

type Grant = {
  principal: Principal;
  when: BlindCondition;
};

export type EvidenceRegion = {
  sourceId: string;
  pageId: string;
  region: {
    unit: 'normalized';
    x: number;
    y: number;
    width: number;
    height: number;
  };
  side: string;
  readingOrder: number;
};

export type ContentBlock = {
  contentId: string;
  kind: 'text' | 'image';
  payload: { text: string; language?: string } | Record<string, never>;
  assetIds: string[];
  classification: {
    level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
    compartments: string[];
    taintSourceIds?: string[];
  };
  visibility: {
    default: 'deny';
    grants: Grant[];
  };
  trace: {
    evidence: EvidenceRegion[];
    ocrExtractionId: string | null;
    reviewStatus: string;
  };
};

export type BlindBundle = {
  schemaVersion: 'blind-script/1.0';
  script: {
    versionId: string;
    canonicalPayloadHash: string;
    titleContentId: string;
  };
  sources: Record<string, {
    sourceId: string;
    mediaType: string;
    sha256: string;
    byteLength: number;
    sourceClass?: { kind: string; subjectId: string | null };
    classification?: { status: string; method: string; confidence: number };
    pages: Array<{
      pageId: string;
      index: number;
      width: number;
      height: number;
      rotation: number;
      sha256: string;
    }>;
  }>;
  assets: Record<string, {
    assetId: string;
    sourceIds: string[];
    pageObjects?: Array<{
      sourceId: string;
      pageId: string;
      mediaType: 'image/webp';
      sha256: string;
      byteLength: number;
      width: number;
      height: number;
    }>;
  }>;
  contentBlocks: Record<string, ContentBlock>;
  stages: Record<string, {
    stageId: string;
    sequence: number;
    labelContentId: string;
    enterWhen: BlindCondition;
    completeWhen: BlindCondition;
    allowedActions: string[];
    locationIds: string[];
    investigationFlow?: InvestigationFlow;
  }>;
  locations: Record<string, {
    locationId: string;
    nameContentId: string;
    availableWhen: BlindCondition;
    searchPolicy: {
      mode: 'draw_without_replacement' | 'fixed_sequence' | 'all_visible' | 'host_dealt';
      perPlayerLimit: number | null;
      globalLimit: number | null;
      resetAtStageIds: string[];
    };
    cluePool: Array<{
      clueId: string;
      order: number;
      copies: number;
      availableWhen: BlindCondition;
    }>;
  }>;
  clues: Record<string, {
    clueId: string;
    kind: string;
    faces: Array<{
      faceId: string;
      side: 'front' | 'back' | 'single' | 'unknown';
      assetIds: string[];
      contentIds: string[];
      revealWhen: BlindCondition;
    }>;
    acquisition: { when: BlindCondition; initialAudience: 'holder' };
    publication: {
      allowed: boolean;
      publishWhen: BlindCondition;
      revealedFaceIds: string[];
      duty?: { mode: 'mandatory_on_acquire' };
    };
  }>;
  hostPack: {
    resolutionSections?: Array<{
      sectionId: string;
      contentIds: string[];
      releaseId: string | null;
    }>;
    releasePlan: Array<{
      releaseId: string;
      contentIds: string[];
      when: BlindCondition;
    }>;
  };
  roles: Record<string, {
    roleId: string;
    slot: number;
    displayNameContentId: string;
    sections: Array<{
      sectionId: string;
      kind: string;
      stageId: string;
      order: number;
      contentIds: string[];
      unlockWhen: BlindCondition;
    }>;
  }>;
};

export type AuthorizationContext = {
  joined: boolean;
  assignedRoleId: string | null;
  assignedRoleIds: ReadonlySet<string>;
  activeStageId: string | null;
  reachedStageIds: ReadonlySet<string>;
  heldClueIds: ReadonlySet<string>;
  roomHeldClueIds: ReadonlySet<string>;
  publishedClueIds: ReadonlySet<string>;
  hostReleaseIds: ReadonlySet<string>;
  sessionCompleted: boolean;
  investigationCompletedStageIds?: ReadonlySet<string>;
};

export type InvestigationViewerState = {
  assignedRoleId: string;
  heldClueIds: ReadonlySet<string>;
};

export type InvestigationCandidates = {
  roomLocationIds: string[];
  actorLocationIds: string[];
  roomClueIdsByLocation: Record<string, string[]>;
  actorClueIdsByLocation: Record<string, string[]>;
};

export type ProjectedContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; contentId: string; parts: number };

const MAX_CONDITION_DEPTH = 20;

export function evaluateCondition(
  condition: BlindCondition,
  context: AuthorizationContext,
  depth = 0,
): boolean {
  return evaluateConditionState(condition, context, depth) === true;
}

/**
 * Evaluate a stage gate while optionally simulating attendance. This returns only
 * a boolean so the simulated role set cannot be reused for protected projections.
 */
export function evaluateStageFlowCondition(
  condition: BlindCondition,
  context: AuthorizationContext,
  simulatedAssignedRoleIds?: ReadonlySet<string>,
) {
  return evaluateCondition(
    condition,
    simulatedAssignedRoleIds ? { ...context, assignedRoleIds: simulatedAssignedRoleIds } : context,
  );
}

/**
 * Evaluate a gate that applies to the current viewer. In viewer-scoped rules,
 * role_assigned means "this viewer has the role", not "someone in the room has it".
 * Room-wide stage and release gates must continue to use evaluateCondition.
 */
export function evaluateViewerCondition(
  condition: BlindCondition,
  context: AuthorizationContext,
) {
  return evaluateCondition(condition, {
    ...context,
    assignedRoleIds: context.assignedRoleId
      ? new Set([context.assignedRoleId])
      : new Set(),
  });
}

function evaluateConditionState(
  condition: BlindCondition,
  context: AuthorizationContext,
  depth: number,
): boolean | null {
  if (depth > MAX_CONDITION_DEPTH || !condition || typeof condition !== 'object') return null;

  switch (condition.op) {
    case 'always':
      return true;
    case 'session_completed':
      return context.sessionCompleted;
    case 'all':
      if (!Array.isArray(condition.args) || condition.args.length === 0) return null;
      {
        const results = condition.args.map((item) => evaluateConditionState(item, context, depth + 1));
        return results.includes(null) ? null : results.every((result) => result === true);
      }
    case 'any':
      if (!Array.isArray(condition.args) || condition.args.length === 0) return null;
      {
        const results = condition.args.map((item) => evaluateConditionState(item, context, depth + 1));
        return results.includes(null) ? null : results.some((result) => result === true);
      }
    case 'not':
      if (!condition.arg) return null;
      {
        const result = evaluateConditionState(condition.arg, context, depth + 1);
        return result === null ? null : !result;
      }
    case 'stage_active':
      return context.activeStageId === condition.stageId;
    case 'stage_reached':
      return context.reachedStageIds.has(condition.stageId);
    case 'investigation_complete':
    case 'completion_vote_satisfied':
      return context.investigationCompletedStageIds?.has(condition.stageId) ?? false;
    case 'role_assigned':
      return context.assignedRoleIds.has(condition.roleId);
    case 'clue_held':
      return context.heldClueIds.has(condition.clueId);
    case 'clue_acquired_in_room':
      return context.roomHeldClueIds.has(condition.clueId);
    case 'clue_published':
      return context.publishedClueIds.has(condition.clueId);
    case 'host_release':
      return context.hostReleaseIds.has(condition.releaseId);
    default:
      return null;
  }
}

export function applyFallbackRestriction(
  candidateIds: string[],
  restriction: { restrictedLocationIds?: string[]; restrictedClueIds?: string[] } | undefined,
  kind: 'location' | 'clue',
) {
  if (!restriction) return candidateIds;
  const restricted = new Set(
    kind === 'location' ? restriction.restrictedLocationIds : restriction.restrictedClueIds,
  );
  const preferred = candidateIds.filter((id) => !restricted.has(id));
  return preferred.length ? preferred : candidateIds;
}

function emptyInvestigationCandidates(): InvestigationCandidates {
  return {
    roomLocationIds: [],
    actorLocationIds: [],
    roomClueIdsByLocation: {},
    actorClueIdsByLocation: {},
  };
}

/**
 * Derive investigation choices from viewer-scoped authorization. Room-wide
 * candidates are the ordered union of every assigned viewer's choices; an
 * individual viewer never inherits another member's role or held clues.
 */
export function deriveInvestigationCandidates(
  bundle: BlindBundle,
  stageId: string,
  context: AuthorizationContext,
  viewers: InvestigationViewerState[],
  searchedLocationIds: ReadonlySet<string>,
  flowOverride?: CollectiveVoteRoundRobinFlowV1,
): InvestigationCandidates {
  const stage = bundle.stages[stageId];
  const flow = flowOverride ?? stage?.investigationFlow;
  if (!stage || !flow || !context.joined) return emptyInvestigationCandidates();

  const roomLocationIds = new Set<string>();
  const roomClueIdsByLocation = new Map<string, Set<string>>();
  let actorLocationIds: string[] = [];
  let actorClueIdsByLocation: Record<string, string[]> = {};

  for (const viewer of viewers) {
    const viewerContext: AuthorizationContext = {
      ...context,
      assignedRoleId: viewer.assignedRoleId,
      assignedRoleIds: new Set([viewer.assignedRoleId]),
      heldClueIds: viewer.heldClueIds,
    };
    const restriction = flow.roleRestrictions?.find(
      (item) => item.principalRoleId === viewer.assignedRoleId,
    );
    const viewerClueIdsByLocation: Record<string, string[]> = {};
    const viewerLocationIds: string[] = [];

    for (const locationId of stage.locationIds) {
      const location = bundle.locations[locationId];
      if (!location || !evaluateViewerCondition(location.availableWhen, viewerContext)) continue;

      const remainingClueIds = location.cluePool
        .filter((entry) => (
          !context.roomHeldClueIds.has(entry.clueId)
          && evaluateViewerCondition(entry.availableWhen, viewerContext)
          && Boolean(bundle.clues[entry.clueId])
          && evaluateViewerCondition(bundle.clues[entry.clueId].acquisition.when, viewerContext)
        ))
        .sort((left, right) => left.order - right.order)
        .map((entry) => entry.clueId);
      if (remainingClueIds.length === 0) continue;

      const roomClues = roomClueIdsByLocation.get(locationId) ?? new Set<string>();
      for (const clueId of remainingClueIds) roomClues.add(clueId);
      roomClueIdsByLocation.set(locationId, roomClues);

      const unrestrictedClueIds = applyFallbackRestriction(
        remainingClueIds,
        restriction,
        'clue',
      );
      viewerClueIdsByLocation[locationId] = location.searchPolicy.mode === 'fixed_sequence'
        ? unrestrictedClueIds.slice(0, 1)
        : unrestrictedClueIds;
      if (viewerClueIdsByLocation[locationId].length > 0
        && !searchedLocationIds.has(locationId)) {
        viewerLocationIds.push(locationId);
      }
    }

    const eligibleViewerLocationIds = applyFallbackRestriction(
      viewerLocationIds,
      restriction,
      'location',
    );
    for (const locationId of eligibleViewerLocationIds) roomLocationIds.add(locationId);
    if (viewer.assignedRoleId === context.assignedRoleId) {
      actorLocationIds = eligibleViewerLocationIds;
      actorClueIdsByLocation = viewerClueIdsByLocation;
    }
  }

  const orderedRoomClueIdsByLocation: Record<string, string[]> = {};
  for (const locationId of stage.locationIds) {
    const candidates = roomClueIdsByLocation.get(locationId);
    if (!candidates) continue;
    orderedRoomClueIdsByLocation[locationId] = bundle.locations[locationId].cluePool
      .filter((entry) => candidates.has(entry.clueId))
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.clueId);
  }

  return {
    roomLocationIds: stage.locationIds.filter((locationId) => roomLocationIds.has(locationId)),
    actorLocationIds,
    roomClueIdsByLocation: orderedRoomClueIdsByLocation,
    actorClueIdsByLocation,
  };
}

function principalMatches(principal: Principal, context: AuthorizationContext) {
  if (!context.joined) return false;
  switch (principal.kind) {
    case 'room_member':
    case 'room_after_event':
      return principal.subjectId === null;
    case 'role_assignee':
      return typeof principal.subjectId === 'string'
        && context.assignedRoleId === principal.subjectId;
    case 'clue_holder':
      return typeof principal.subjectId === 'string'
        && context.heldClueIds.has(principal.subjectId);
    case 'system_only':
    default:
      return false;
  }
}

function compartmentsMatch(compartments: string[], context: AuthorizationContext) {
  return compartments.every((compartment) => {
    const separator = compartment.indexOf(':');
    if (separator < 1) return false;
    const kind = compartment.slice(0, separator);
    const subjectId = compartment.slice(separator + 1);
    if (!subjectId) return false;
    if (kind === 'role') return context.assignedRoleId === subjectId;
    if (kind === 'clue') {
      return context.heldClueIds.has(subjectId) || context.publishedClueIds.has(subjectId);
    }
    if (kind === 'stage') return context.reachedStageIds.has(subjectId);
    return false;
  });
}

export function canReadContent(block: ContentBlock | undefined, context: AuthorizationContext) {
  if (!block || !['text', 'image'].includes(block.kind) || block.visibility.default !== 'deny') {
    return false;
  }
  if (!context.joined || block.classification.level === 'L3' || block.classification.level === 'L4') {
    return false;
  }
  if (!compartmentsMatch(block.classification.compartments, context)) return false;

  return block.visibility.grants.some((grant) => (
    principalMatches(grant.principal, context)
    && evaluateCondition(grant.when, context)
  ));
}

function readableText(bundle: BlindBundle, contentId: string, context: AuthorizationContext) {
  const block = bundle.contentBlocks[contentId];
  if (!canReadContent(block, context) || block.kind !== 'text' || !('text' in block.payload)) {
    return null;
  }
  return block.payload.text;
}

function readableContent(
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

export function projectLobby(bundle: BlindBundle, context: AuthorizationContext) {
  if (!context.joined || context.assignedRoleId !== null) return null;
  const title = readableText(bundle, bundle.script.titleContentId, context);
  const roles = Object.values(bundle.roles)
    .sort((left, right) => left.slot - right.slot)
    .map((role) => {
      // A lobby introduction is exposed only when the existing bundle grants the
      // unassigned room member access. Role-compartment text therefore stays denied.
      const introduction = role.sections
        .filter((section) => (
          ['introduction', 'profile', 'lobby_profile'].includes(section.kind)
          && evaluateCondition(section.unlockWhen, context)
        ))
        .sort((left, right) => left.order - right.order)
        .flatMap((section) => section.contentIds)
        .map((contentId) => readableContent(bundle, contentId, context))
        .filter((content): content is ProjectedContent => content !== null);
      return {
        roleId: role.roleId,
        slot: role.slot,
        displayName: readableText(bundle, role.displayNameContentId, context),
        introduction,
      };
    });
  return { versionId: bundle.script.versionId, title, roles };
}

export function projectAssignedRole(bundle: BlindBundle, context: AuthorizationContext) {
  if (!context.joined || !context.assignedRoleId) return null;
  const role = bundle.roles[context.assignedRoleId];
  if (!role) return null;

  const displayName = readableText(bundle, role.displayNameContentId, context);
  const sections = role.sections
    .filter((section) => evaluateCondition(section.unlockWhen, context))
    .sort((left, right) => left.order - right.order)
    .map((section) => ({
      sectionId: section.sectionId,
      kind: section.kind,
      stageId: section.stageId,
      content: section.contentIds
        .map((contentId) => readableContent(bundle, contentId, context))
        .filter((content): content is ProjectedContent => content !== null),
    }))
    .filter((section) => section.content.length > 0);

  return {
    versionId: bundle.script.versionId,
    roleId: role.roleId,
    displayName,
    sections,
  };
}

export function projectPlayerGuide(bundle: BlindBundle, context: AuthorizationContext) {
  if (!context.joined) return [];
  return Object.values(bundle.contentBlocks)
    .filter((block) => {
      const sourceIds = block.classification.taintSourceIds;
      return block.classification.level === 'L1'
        && Array.isArray(sourceIds)
        && sourceIds.length > 0
        && sourceIds.every((sourceId) => {
          const source = bundle.sources[sourceId];
          return source?.sourceClass?.kind === 'player_rules'
            && source.classification?.status === 'verified';
        });
    })
    .sort((left, right) => {
      const leftEvidence = left.trace.evidence[0];
      const rightEvidence = right.trace.evidence[0];
      const leftPage = leftEvidence
        ? bundle.sources[leftEvidence.sourceId]?.pages.find((page) => page.pageId === leftEvidence.pageId)
        : undefined;
      const rightPage = rightEvidence
        ? bundle.sources[rightEvidence.sourceId]?.pages.find((page) => page.pageId === rightEvidence.pageId)
        : undefined;
      return (leftPage?.index ?? Number.MAX_SAFE_INTEGER) - (rightPage?.index ?? Number.MAX_SAFE_INTEGER)
        || (leftEvidence?.readingOrder ?? Number.MAX_SAFE_INTEGER)
          - (rightEvidence?.readingOrder ?? Number.MAX_SAFE_INTEGER);
    })
    .map((block) => readableContent(bundle, block.contentId, context))
    .filter((content): content is ProjectedContent => content !== null);
}

function releasedResolutionContent(
  bundle: BlindBundle,
  contentId: string,
): ProjectedContent | null {
  const block = bundle.contentBlocks[contentId];
  if (
    !block
    || block.classification.level !== 'L3'
    || block.visibility.default !== 'deny'
    || block.visibility.grants.length === 0
    || block.visibility.grants.some((grant) => grant.principal.kind !== 'system_only')
    || !Array.isArray(block.classification.taintSourceIds)
    || block.classification.taintSourceIds.length === 0
    || block.classification.taintSourceIds.some(
      (sourceId) => bundle.sources[sourceId]?.sourceClass?.kind !== 'solution',
    )
  ) return null;
  if (block.kind === 'text' && 'text' in block.payload) {
    return { kind: 'text', text: block.payload.text };
  }
  if (block.kind === 'image' && block.assetIds.length > 0 && block.trace.evidence.length > 0) {
    return { kind: 'image', contentId: block.contentId, parts: block.trace.evidence.length };
  }
  return null;
}

export function projectReleasedResolution(bundle: BlindBundle, context: AuthorizationContext) {
  if (!context.joined || !context.sessionCompleted) return [];
  const eligible = withEligibleHostReleases(bundle, context);
  const releases = new Map(
    bundle.hostPack.releasePlan.map((release) => [release.releaseId, release]),
  );
  return (bundle.hostPack.resolutionSections ?? [])
    .filter((section) => (
      typeof section.releaseId === 'string'
      && eligible.hostReleaseIds.has(section.releaseId)
      && releases.has(section.releaseId)
      && section.contentIds.every(
        (contentId) => releases.get(section.releaseId as string)?.contentIds.includes(contentId),
      )
    ))
    .map((section) => ({
      sectionId: section.sectionId,
      content: section.contentIds
        .map((contentId) => releasedResolutionContent(bundle, contentId))
        .filter((content): content is ProjectedContent => content !== null),
    }))
    .filter((section) => section.content.length > 0);
}

export function projectAvailableLocations(
  bundle: BlindBundle,
  context: AuthorizationContext,
  options?: { clueIdsByLocation?: Readonly<Record<string, readonly string[]>> },
) {
  if (!context.joined || !context.assignedRoleId || !context.activeStageId) return [];
  const activeStage = bundle.stages[context.activeStageId];
  if (!activeStage?.allowedActions.includes('search')) return [];
  return activeStage.locationIds
    .map((locationId) => bundle.locations[locationId])
    .filter((location): location is BlindBundle['locations'][string] => Boolean(
      location && evaluateViewerCondition(location.availableWhen, context),
    ))
    .map((location) => {
      const availableClues = location.cluePool
        .filter((entry) => (
          !context.roomHeldClueIds.has(entry.clueId)
          && evaluateViewerCondition(entry.availableWhen, context)
          && Boolean(bundle.clues[entry.clueId])
          && evaluateViewerCondition(bundle.clues[entry.clueId].acquisition.when, context)
        ))
        .sort((left, right) => left.order - right.order)
        .map((entry, index) => ({
          clueId: entry.clueId,
          number: Number.isInteger(entry.order) && entry.order > 0 ? entry.order : index + 1,
        }));
      const projectedClueIds = options?.clueIdsByLocation
        ? options.clueIdsByLocation[location.locationId] ?? []
        : null;
      const clueChoices = projectedClueIds
        ? projectedClueIds
          .map((clueId) => availableClues.find((choice) => choice.clueId === clueId))
          .filter((choice): choice is { clueId: string; number: number } => Boolean(choice))
        : location.searchPolicy.mode === 'fixed_sequence'
          ? availableClues.slice(0, 1)
          : availableClues;
      return {
        locationId: location.locationId,
        name: readableText(bundle, location.nameContentId, context),
        searchMode: location.searchPolicy.mode,
        clueChoices,
      };
    });
}

export function projectVisibleClues(bundle: BlindBundle, context: AuthorizationContext) {
  if (!context.joined) return [];
  return Object.values(bundle.clues)
    .filter((clue) => (
      context.heldClueIds.has(clue.clueId) || context.publishedClueIds.has(clue.clueId)
    ))
    .map((clue) => ({
      clueId: clue.clueId,
      isHeld: context.heldClueIds.has(clue.clueId),
      isPublished: context.publishedClueIds.has(clue.clueId),
      canPublish: clue.publication.allowed
        && context.heldClueIds.has(clue.clueId)
        && !context.publishedClueIds.has(clue.clueId)
        && evaluateViewerCondition(clue.publication.publishWhen, context),
      publicationRequired: clue.publication.duty?.mode === 'mandatory_on_acquire'
        && context.heldClueIds.has(clue.clueId)
        && !context.publishedClueIds.has(clue.clueId),
      faces: clue.faces
        .filter((face) => (
          evaluateViewerCondition(face.revealWhen, context)
          || (
            context.publishedClueIds.has(clue.clueId)
            && clue.publication.revealedFaceIds.includes(face.faceId)
          )
        ))
        .map((face) => ({
          faceId: face.faceId,
          side: face.side,
          content: face.contentIds
            .map((contentId) => readableContent(bundle, contentId, context))
            .filter((content): content is ProjectedContent => content !== null),
        }))
        .filter((face) => face.content.length > 0),
    }))
    .filter((clue) => clue.faces.length > 0);
}

function projectionContainsImage(
  content: readonly ProjectedContent[],
  contentId: string,
) {
  return content.some((item) => item.kind === 'image' && item.contentId === contentId);
}

/**
 * Image bytes are served only when the same content id is present in a current,
 * authorized UI projection. A readable grant alone cannot reveal an unrevealed
 * clue face through the direct content endpoint.
 */
export function canProjectImageContent(
  bundle: BlindBundle,
  contentId: string,
  context: AuthorizationContext,
) {
  if (bundle.contentBlocks[contentId]?.kind !== 'image') return false;

  const lobby = projectLobby(bundle, context);
  if (lobby?.roles.some((role) => projectionContainsImage(role.introduction, contentId))) {
    return true;
  }
  const assignedRole = projectAssignedRole(bundle, context);
  if (assignedRole?.sections.some(
    (section) => projectionContainsImage(section.content, contentId),
  )) return true;
  if (projectionContainsImage(projectPlayerGuide(bundle, context), contentId)) return true;
  if (projectReleasedResolution(bundle, context).some(
    (section) => projectionContainsImage(section.content, contentId),
  )) return true;
  return projectVisibleClues(bundle, context).some((clue) => clue.faces.some(
    (face) => projectionContainsImage(face.content, contentId),
  ));
}

export function withEligibleHostReleases(bundle: BlindBundle, context: AuthorizationContext) {
  const releaseIds = new Set(context.hostReleaseIds);
  for (let pass = 0; pass < bundle.hostPack.releasePlan.length; pass += 1) {
    let changed = false;
    for (const release of bundle.hostPack.releasePlan) {
      if (releaseIds.has(release.releaseId)) continue;
      const candidateContext = { ...context, hostReleaseIds: releaseIds };
      if (evaluateCondition(release.when, candidateContext)) {
        releaseIds.add(release.releaseId);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { ...context, hostReleaseIds: releaseIds };
}
