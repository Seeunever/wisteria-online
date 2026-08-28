export type BlindCondition =
  | { op: 'always' | 'session_completed' }
  | { op: 'all' | 'any'; args: BlindCondition[] }
  | { op: 'not'; arg: BlindCondition }
  | { op: 'stage_active' | 'stage_reached'; stageId: string }
  | { op: 'role_assigned'; roleId: string }
  | { op: 'clue_held' | 'clue_published'; clueId: string }
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
    titleContentId: string;
  };
  sources: Record<string, {
    sourceId: string;
    mediaType: string;
    sha256: string;
    byteLength: number;
    pages: Array<{
      pageId: string;
      index: number;
      width: number;
      height: number;
      rotation: number;
    }>;
  }>;
  assets: Record<string, { assetId: string; sourceIds: string[] }>;
  contentBlocks: Record<string, ContentBlock>;
  stages: Record<string, {
    stageId: string;
    sequence: number;
    labelContentId: string;
    enterWhen: BlindCondition;
    completeWhen: BlindCondition;
    allowedActions: string[];
    locationIds: string[];
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
    };
  }>;
  hostPack: {
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
    case 'role_assigned':
      return context.assignedRoleIds.has(condition.roleId);
    case 'clue_held':
      return context.roomHeldClueIds.has(condition.clueId);
    case 'clue_published':
      return context.publishedClueIds.has(condition.clueId);
    case 'host_release':
      return context.hostReleaseIds.has(condition.releaseId);
    default:
      return null;
  }
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
    .map((role) => ({
      roleId: role.roleId,
      slot: role.slot,
      displayName: readableText(bundle, role.displayNameContentId, context),
    }));
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

export function projectAvailableLocations(bundle: BlindBundle, context: AuthorizationContext) {
  if (!context.joined || !context.assignedRoleId) return [];
  return Object.values(bundle.locations)
    .filter((location) => evaluateCondition(location.availableWhen, context))
    .map((location) => ({
      locationId: location.locationId,
      name: readableText(bundle, location.nameContentId, context),
      searchMode: location.searchPolicy.mode,
    }));
}

export function projectVisibleClues(bundle: BlindBundle, context: AuthorizationContext) {
  if (!context.joined || !context.assignedRoleId) return [];
  return Object.values(bundle.clues)
    .filter((clue) => (
      context.heldClueIds.has(clue.clueId) || context.publishedClueIds.has(clue.clueId)
    ))
    .map((clue) => ({
      clueId: clue.clueId,
      canPublish: clue.publication.allowed
        && context.heldClueIds.has(clue.clueId)
        && evaluateCondition(clue.publication.publishWhen, context),
      faces: clue.faces
        .filter((face) => evaluateCondition(face.revealWhen, context))
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
