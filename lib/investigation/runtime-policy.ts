import { createHash } from 'node:crypto';
import type { BlindBundle, EvidenceRegion } from '../blind-runtime';
import {
  normalizeSearchMechanism,
  type NormalizedSearchMechanism,
} from './config.ts';
import { createRotatingBlindDrawRuntimeMechanismSpec } from './rotating-blind-draw.ts';

export const RUNTIME_POLICY_SCHEMA = 'wisteria-runtime-policy/1.0' as const;
export const RUNTIME_POLICY_CAPABILITY_MODE = 'canonical_upper_bound' as const;

const VERSION_ID = /^ver_[0-9a-f]{8,64}$/;
const STAGE_ID = /^stage_[0-9a-f]{8,64}$/;
const LOCATION_ID = /^loc_[0-9a-f]{8,64}$/;
const CLUE_ID = /^clue_[0-9a-f]{8,64}$/;
const SOURCE_ID = /^src_[0-9a-f]{8,64}$/;
const PAGE_ID = /^page_[0-9a-f]{8,64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const EVIDENCE_SIDES = new Set(['front', 'back', 'single', 'unknown']);
const VERIFIED_SOURCE_METHODS = new Set(['manifest', 'review']);

export type RuntimePolicyErrorCode =
  | 'MALFORMED_RUNTIME_POLICY'
  | 'UNSUPPORTED_RUNTIME_POLICY_KIND'
  | 'UNSUPPORTED_RUNTIME_POLICY_VERSION'
  | 'RUNTIME_POLICY_BINDING_MISMATCH'
  | 'RUNTIME_POLICY_REFERENCE_MISMATCH'
  | 'RUNTIME_POLICY_HASH_MISMATCH'
  | 'RUNTIME_POLICY_NOT_CANONICAL'
  | 'RUNTIME_POLICY_CAPABILITY_WIDENING';

export class RuntimePolicyError extends Error {
  readonly code: RuntimePolicyErrorCode;

  constructor(code: RuntimePolicyErrorCode) {
    super(code);
    this.name = 'RuntimePolicyError';
    this.code = code;
  }
}

export type CanonicalSearchPolicyMechanismV1 = {
  kind: 'canonical_search_policy';
  version: 1;
  evidence: EvidenceRegion[];
};

export type RuntimeStageMechanism =
  | CanonicalSearchPolicyMechanismV1
  | {
    kind: string;
    version: number;
    config?: unknown;
    evidence: EvidenceRegion[];
  };

export type EffectiveRuntimeStageMechanism = {
  kind: string;
  version: number;
};

export type RuntimePolicyDocument = {
  schemaVersion: typeof RUNTIME_POLICY_SCHEMA;
  versionId: string;
  canonicalPayloadHash: string;
  runtimePolicyHash: string;
  capabilityMode: typeof RUNTIME_POLICY_CAPABILITY_MODE;
  stageMechanisms: Record<string, RuntimeStageMechanism>;
};

export type RuntimePolicyDraft = Omit<RuntimePolicyDocument, 'runtimePolicyHash'>;

export type RuntimeProfileMode = 'canonical' | 'sidecar' | 'legacy_embedded';

export type ResolvedRuntimePolicy = {
  profileMode: RuntimeProfileMode;
  versionId: string;
  canonicalPayloadHash: string;
  runtimePolicyHash: string | null;
  stageMechanisms: Record<string, EffectiveRuntimeStageMechanism>;
  sidecar: RuntimePolicyDocument | null;
};

type UnknownRecord = Record<string, unknown>;

export type RuntimeMechanismValidationContext = {
  bundle: BlindBundle;
  stageId: string;
  stageLocationIds: ReadonlySet<string>;
  stageClueIds: ReadonlySet<string>;
};

/**
 * A mechanism implementation owns its complete exact-key parser and its
 * canonical-reference checks. Adding a kind requires an explicit entry in the
 * immutable registry below; unregistered inputs always fail closed.
 */
export type RuntimeMechanismSpec = {
  readonly kind: string;
  readonly version: number;
  readonly configMode: 'none' | 'required';
  readonly parseConfig: (value: unknown) => unknown;
  readonly validateReferences: (
    config: unknown,
    context: RuntimeMechanismValidationContext,
  ) => void;
  readonly toEffective: (config: unknown) => EffectiveRuntimeStageMechanism;
};

const own = (value: UnknownRecord, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function reject(code: RuntimePolicyErrorCode): never {
  throw new RuntimePolicyError(code);
}

function malformed(): never {
  reject('MALFORMED_RUNTIME_POLICY');
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

function identifier(value: unknown, pattern: RegExp) {
  if (typeof value !== 'string' || !pattern.test(value)) malformed();
  return value;
}

function hash(value: unknown) {
  if (typeof value !== 'string' || !SHA256.test(value)) malformed();
  return value;
}

function positiveInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) malformed();
  return value as number;
}

function normalizedCoordinate(value: unknown, positive = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) malformed();
  const scaled = Math.round(value * 1_000_000);
  if (scaled / 1_000_000 !== value || (positive && scaled === 0)) malformed();
  return scaled / 1_000_000;
}

function parseEvidence(value: unknown, bundle: BlindBundle): EvidenceRegion[] {
  if (!Array.isArray(value) || value.length === 0) malformed();
  const evidence = value.map((entry) => {
    const candidate = record(entry);
    exactKeys(candidate, ['sourceId', 'pageId', 'region', 'side', 'readingOrder']);
    const sourceId = identifier(candidate.sourceId, SOURCE_ID);
    const pageId = identifier(candidate.pageId, PAGE_ID);
    const region = record(candidate.region);
    exactKeys(region, ['unit', 'x', 'y', 'width', 'height']);
    if (region.unit !== 'normalized') malformed();
    const x = normalizedCoordinate(region.x);
    const y = normalizedCoordinate(region.y);
    const width = normalizedCoordinate(region.width, true);
    const height = normalizedCoordinate(region.height, true);
    const scaledX = Math.round(x * 1_000_000);
    const scaledY = Math.round(y * 1_000_000);
    const scaledWidth = Math.round(width * 1_000_000);
    const scaledHeight = Math.round(height * 1_000_000);
    if (scaledX + scaledWidth > 1_000_000 || scaledY + scaledHeight > 1_000_000) malformed();
    if (typeof candidate.side !== 'string' || !EVIDENCE_SIDES.has(candidate.side)) malformed();
    const source = bundle.sources[sourceId];
    if (
      !source
      || source.sourceId !== sourceId
      || !source.sourceClass
      || source.sourceClass.kind === 'unknown'
      || source.classification?.status !== 'verified'
      || !VERIFIED_SOURCE_METHODS.has(source.classification.method)
      || !source.pages.some((page) => page.pageId === pageId)
    ) reject('RUNTIME_POLICY_REFERENCE_MISMATCH');
    return {
      sourceId,
      pageId,
      region: { unit: 'normalized' as const, x, y, width, height },
      side: candidate.side,
      readingOrder: positiveInteger(candidate.readingOrder),
    };
  });
  evidence.sort((left, right) => (
    left.sourceId.localeCompare(right.sourceId)
    || left.pageId.localeCompare(right.pageId)
    || left.readingOrder - right.readingOrder
    || left.side.localeCompare(right.side)
    || left.region.y - right.region.y
    || left.region.x - right.region.x
    || left.region.height - right.region.height
    || left.region.width - right.region.width
  ));
  const fingerprints = evidence.map((entry) => canonicalJson(entry));
  if (new Set(fingerprints).size !== evidence.length) malformed();
  return evidence;
}

function noConfig(value: unknown) {
  if (value !== undefined) malformed();
  return null;
}

function validateCanonicalReferences() {
  // Canonical behavior adds no capability or references of its own.
}

const RUNTIME_MECHANISM_SPECS = [
  {
    kind: 'canonical_search_policy',
    version: 1,
    configMode: 'none',
    parseConfig: noConfig,
    validateReferences: validateCanonicalReferences,
    toEffective: () => ({ kind: 'canonical_search_policy', version: 1 }),
  },
  createRotatingBlindDrawRuntimeMechanismSpec(reject),
] as const satisfies readonly RuntimeMechanismSpec[];

function mechanismSpec(kind: unknown, version: unknown): RuntimeMechanismSpec {
  if (typeof kind !== 'string' || !Number.isSafeInteger(version) || (version as number) < 1) {
    malformed();
  }
  const kindSpecs = RUNTIME_MECHANISM_SPECS.filter((spec) => spec.kind === kind);
  if (kindSpecs.length === 0) reject('UNSUPPORTED_RUNTIME_POLICY_KIND');
  const spec = kindSpecs.find((candidate) => candidate.version === version);
  if (!spec) reject('UNSUPPORTED_RUNTIME_POLICY_VERSION');
  return spec;
}

function validateCanonicalSearchSurface(bundle: BlindBundle) {
  const searchStages = new Map<string, {
    locationIds: Set<string>;
    clueIds: Set<string>;
  }>();
  for (const [stageKey, stage] of Object.entries(bundle.stages)) {
    if (!STAGE_ID.test(stageKey) || stage.stageId !== stageKey) {
      reject('RUNTIME_POLICY_REFERENCE_MISMATCH');
    }
    if (!Array.isArray(stage.allowedActions) || !Array.isArray(stage.locationIds)) malformed();
    if (!stage.allowedActions.includes('search')) continue;
    const locationIds = new Set<string>();
    const clueIds = new Set<string>();
    for (const locationId of stage.locationIds) {
      if (!LOCATION_ID.test(locationId) || locationIds.has(locationId)) malformed();
      const location = bundle.locations[locationId];
      if (!location || location.locationId !== locationId) {
        reject('RUNTIME_POLICY_REFERENCE_MISMATCH');
      }
      const searchPolicy = location.searchPolicy;
      if (
        !searchPolicy
        || !['draw_without_replacement', 'fixed_sequence', 'all_visible', 'host_dealt']
          .includes(searchPolicy.mode)
        || (searchPolicy.perPlayerLimit !== null
          && (!Number.isSafeInteger(searchPolicy.perPlayerLimit) || searchPolicy.perPlayerLimit < 1))
        || (searchPolicy.globalLimit !== null
          && (!Number.isSafeInteger(searchPolicy.globalLimit) || searchPolicy.globalLimit < 1))
        || !Array.isArray(searchPolicy.resetAtStageIds)
      ) malformed();
      for (const resetStageId of searchPolicy.resetAtStageIds) {
        if (!STAGE_ID.test(resetStageId) || !bundle.stages[resetStageId]) {
          reject('RUNTIME_POLICY_REFERENCE_MISMATCH');
        }
      }
      if (!Array.isArray(location.cluePool)) malformed();
      const orders = new Set<number>();
      for (const entry of location.cluePool) {
        if (
          !entry
          || !CLUE_ID.test(entry.clueId)
          || !Number.isSafeInteger(entry.order)
          || entry.order < 1
          || !Number.isSafeInteger(entry.copies)
          || entry.copies < 1
          || orders.has(entry.order)
        ) malformed();
        if (!bundle.clues[entry.clueId] || bundle.clues[entry.clueId].clueId !== entry.clueId) {
          reject('RUNTIME_POLICY_REFERENCE_MISMATCH');
        }
        orders.add(entry.order);
        clueIds.add(entry.clueId);
      }
      locationIds.add(locationId);
    }
    searchStages.set(stageKey, { locationIds, clueIds });
  }
  return searchStages;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) && Math.abs(value) > 1) malformed();
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const candidate = record(value);
  const entries = Object.keys(candidate).sort().map((key) => {
    const item = candidate[key];
    if (item === undefined) malformed();
    return `${JSON.stringify(key)}:${canonicalJson(item)}`;
  });
  return `{${entries.join(',')}}`;
}

function sha256Canonical(value: unknown) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function parseDocument(value: unknown, bundle: BlindBundle): RuntimePolicyDocument {
  const candidate = record(value);
  exactKeys(candidate, [
    'schemaVersion',
    'versionId',
    'canonicalPayloadHash',
    'runtimePolicyHash',
    'capabilityMode',
    'stageMechanisms',
  ]);
  if (candidate.schemaVersion !== RUNTIME_POLICY_SCHEMA) {
    reject('UNSUPPORTED_RUNTIME_POLICY_VERSION');
  }
  if (candidate.capabilityMode !== RUNTIME_POLICY_CAPABILITY_MODE) {
    reject('RUNTIME_POLICY_CAPABILITY_WIDENING');
  }
  const versionId = identifier(candidate.versionId, VERSION_ID);
  const canonicalPayloadHash = hash(candidate.canonicalPayloadHash);
  const runtimePolicyHash = hash(candidate.runtimePolicyHash);
  if (
    versionId !== bundle.script.versionId
    || canonicalPayloadHash !== bundle.script.canonicalPayloadHash
  ) reject('RUNTIME_POLICY_BINDING_MISMATCH');

  const searchStages = validateCanonicalSearchSurface(bundle);
  const stageMechanismCandidates = record(candidate.stageMechanisms);
  const stageMechanisms: Record<string, RuntimeStageMechanism> = {};
  const policyStageIds = Object.keys(stageMechanismCandidates);
  if (
    policyStageIds.length !== searchStages.size
    || policyStageIds.some((stageId) => !searchStages.has(stageId))
  ) reject('RUNTIME_POLICY_REFERENCE_MISMATCH');
  for (const [stageId, rawMechanism] of Object.entries(stageMechanismCandidates)) {
    if (!STAGE_ID.test(stageId)) malformed();
    const mechanismCandidate = record(rawMechanism);
    const spec = mechanismSpec(mechanismCandidate.kind, mechanismCandidate.version);
    exactKeys(
      mechanismCandidate,
      spec.configMode === 'required'
        ? ['kind', 'version', 'config', 'evidence']
        : ['kind', 'version', 'evidence'],
    );
    const config = spec.parseConfig(
      spec.configMode === 'required' ? mechanismCandidate.config : undefined,
    );
    const evidence = parseEvidence(mechanismCandidate.evidence, bundle);
    const surface = searchStages.get(stageId);
    if (!surface) reject('RUNTIME_POLICY_REFERENCE_MISMATCH');
    spec.validateReferences(config, {
      bundle,
      stageId,
      stageLocationIds: surface.locationIds,
      stageClueIds: surface.clueIds,
    });
    stageMechanisms[stageId] = spec.configMode === 'required'
      ? {
        kind: spec.kind,
        version: spec.version,
        config,
        evidence,
      }
      : {
        kind: spec.kind,
        version: spec.version,
        evidence,
      };
  }
  const document: RuntimePolicyDocument = {
    schemaVersion: RUNTIME_POLICY_SCHEMA,
    versionId,
    canonicalPayloadHash,
    runtimePolicyHash,
    capabilityMode: RUNTIME_POLICY_CAPABILITY_MODE,
    stageMechanisms,
  };
  const expectedHash = computeRuntimePolicyHash({
    schemaVersion: document.schemaVersion,
    versionId: document.versionId,
    canonicalPayloadHash: document.canonicalPayloadHash,
    capabilityMode: document.capabilityMode,
    stageMechanisms: document.stageMechanisms,
  });
  if (runtimePolicyHash !== expectedHash) reject('RUNTIME_POLICY_HASH_MISMATCH');
  return document;
}

export function computeRuntimePolicyHash(value: RuntimePolicyDraft) {
  return sha256Canonical({ ...value, runtimePolicyHash: null });
}

export function serializeRuntimePolicy(value: RuntimePolicyDocument) {
  return `${canonicalJson(value)}\n`;
}

export function validateRuntimePolicy(value: unknown, bundle: BlindBundle) {
  return parseDocument(value, bundle);
}

export function parseRuntimePolicyJson(raw: string, bundle: BlindBundle) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    malformed();
  }
  const policy = parseDocument(value, bundle);
  if (raw !== serializeRuntimePolicy(policy)) reject('RUNTIME_POLICY_NOT_CANONICAL');
  return policy;
}

export function finalizeRuntimePolicy(value: RuntimePolicyDraft, bundle: BlindBundle) {
  const candidate = record(value);
  exactKeys(candidate, [
    'schemaVersion',
    'versionId',
    'canonicalPayloadHash',
    'capabilityMode',
    'stageMechanisms',
  ]);
  return validateRuntimePolicy({
    ...candidate,
    runtimePolicyHash: computeRuntimePolicyHash(value),
  }, bundle);
}

function canonicalMechanismMap(bundle: BlindBundle) {
  const stages = validateCanonicalSearchSurface(bundle);
  return Object.fromEntries([...stages.keys()].map((stageId) => [stageId, {
    kind: 'canonical_search_policy' as const,
    version: 1 as const,
  }]));
}

export function resolveCanonicalRuntimePolicy(bundle: BlindBundle): ResolvedRuntimePolicy {
  return {
    profileMode: 'canonical',
    versionId: bundle.script.versionId,
    canonicalPayloadHash: bundle.script.canonicalPayloadHash,
    runtimePolicyHash: null,
    stageMechanisms: canonicalMechanismMap(bundle),
    sidecar: null,
  };
}

export function resolveSidecarRuntimePolicy(
  bundle: BlindBundle,
  sidecar: RuntimePolicyDocument,
): ResolvedRuntimePolicy {
  const stageMechanisms = Object.fromEntries(
    Object.entries(sidecar.stageMechanisms).map(([stageId, mechanism]) => {
      const spec = mechanismSpec(mechanism.kind, mechanism.version);
      const config = 'config' in mechanism ? mechanism.config : undefined;
      return [stageId, spec.toEffective(config)];
    }),
  );
  return {
    profileMode: 'sidecar',
    versionId: bundle.script.versionId,
    canonicalPayloadHash: bundle.script.canonicalPayloadHash,
    runtimePolicyHash: sidecar.runtimePolicyHash,
    stageMechanisms,
    sidecar,
  };
}

export function resolveLegacyEmbeddedRuntimePolicy(bundle: BlindBundle): ResolvedRuntimePolicy {
  const stageMechanisms: Record<string, NormalizedSearchMechanism> = {};
  for (const [stageId, stage] of Object.entries(bundle.stages)) {
    if (!stage.allowedActions.includes('search')) continue;
    stageMechanisms[stageId] = normalizeSearchMechanism(stage.investigationFlow);
  }
  return {
    profileMode: 'legacy_embedded',
    versionId: bundle.script.versionId,
    canonicalPayloadHash: bundle.script.canonicalPayloadHash,
    runtimePolicyHash: null,
    stageMechanisms,
    sidecar: null,
  };
}
