import { createHash } from 'node:crypto';
import type { BlindBundle, ContentBlock, EvidenceRegion } from './blind-runtime';

export const RENDER_MANIFEST_SCHEMA = 'wisteria-render-manifest/1.0' as const;
export const MAX_RENDER_OBJECT_BYTES = 128 * 1024 * 1024;
export const MAX_RENDER_OBJECT_DIMENSION = 16_383;

const VERSION_ID = /^ver_[0-9a-f]{8,64}$/;
const CONTENT_ID = /^cnt_[0-9a-f]{8,64}$/;
const ASSET_ID = /^asset_[0-9a-f]{8,64}$/;
const SOURCE_ID = /^src_[0-9a-f]{8,64}$/;
const PAGE_ID = /^page_[0-9a-f]{8,64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export type RenderManifestErrorCode =
  | 'MALFORMED_RENDER_MANIFEST'
  | 'RENDER_MANIFEST_BINDING_MISMATCH'
  | 'RENDER_MANIFEST_REFERENCE_MISMATCH'
  | 'RENDER_MANIFEST_HASH_MISMATCH'
  | 'RENDER_MANIFEST_NOT_CANONICAL';

export class RenderManifestError extends Error {
  readonly code: RenderManifestErrorCode;

  constructor(code: RenderManifestErrorCode) {
    super(code);
    this.name = 'RenderManifestError';
    this.code = code;
  }
}

export type RenderManifestObjectV1 = Readonly<{
  sourceId: string;
  pageId: string;
  mediaType: 'image/webp';
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
}>;

export type RenderManifestV1 = Readonly<{
  schemaVersion: typeof RENDER_MANIFEST_SCHEMA;
  versionId: string;
  canonicalPayloadHash: string;
  bundlePayloadHash: string;
  objects: readonly RenderManifestObjectV1[];
  renderManifestHash: string;
}>;

export type RenderManifestDraftV1 = Omit<RenderManifestV1, 'renderManifestHash'>;
export type RenderManifestBundleBytes = string | Uint8Array;

type UnknownRecord = Record<string, unknown>;

type ExpectedRenderObject = {
  sourceId: string;
  pageId: string;
  width: number;
  height: number;
  legacyMetadata: RenderManifestObjectV1[];
};

function reject(code: RenderManifestErrorCode): never {
  throw new RenderManifestError(code);
}

function malformed(): never {
  reject('MALFORMED_RENDER_MANIFEST');
}

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) malformed();
  return value as UnknownRecord;
}

function own(value: UnknownRecord, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
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

function boundedPositiveInteger(value: unknown, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    malformed();
  }
  return value as number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) malformed();
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

function sha256(value: string | Uint8Array) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function pairKey(sourceId: string, pageId: string) {
  return `${sourceId}\u0000${pageId}`;
}

function compareObjects(left: RenderManifestObjectV1, right: RenderManifestObjectV1) {
  if (left.sourceId !== right.sourceId) return left.sourceId < right.sourceId ? -1 : 1;
  if (left.pageId !== right.pageId) return left.pageId < right.pageId ? -1 : 1;
  return 0;
}

function parseObject(value: unknown): RenderManifestObjectV1 {
  const candidate = record(value);
  exactKeys(candidate, [
    'sourceId',
    'pageId',
    'mediaType',
    'sha256',
    'byteLength',
    'width',
    'height',
  ]);
  if (candidate.mediaType !== 'image/webp') malformed();
  return Object.freeze({
    sourceId: identifier(candidate.sourceId, SOURCE_ID),
    pageId: identifier(candidate.pageId, PAGE_ID),
    mediaType: 'image/webp' as const,
    sha256: hash(candidate.sha256),
    byteLength: boundedPositiveInteger(candidate.byteLength, MAX_RENDER_OBJECT_BYTES),
    width: boundedPositiveInteger(candidate.width, MAX_RENDER_OBJECT_DIMENSION),
    height: boundedPositiveInteger(candidate.height, MAX_RENDER_OBJECT_DIMENSION),
  });
}

function assertSortedUnique(objects: readonly RenderManifestObjectV1[]) {
  for (let index = 1; index < objects.length; index += 1) {
    if (compareObjects(objects[index - 1], objects[index]) >= 0) malformed();
  }
}

function normalizeSortedObjects(values: readonly unknown[]) {
  const objects = values.map(parseObject).sort(compareObjects);
  for (let index = 1; index < objects.length; index += 1) {
    if (compareObjects(objects[index - 1], objects[index]) === 0) malformed();
  }
  return Object.freeze(objects);
}

function parseDraftShape(value: unknown): RenderManifestDraftV1 {
  const candidate = record(value);
  exactKeys(candidate, [
    'schemaVersion',
    'versionId',
    'canonicalPayloadHash',
    'bundlePayloadHash',
    'objects',
  ]);
  if (candidate.schemaVersion !== RENDER_MANIFEST_SCHEMA || !Array.isArray(candidate.objects)) {
    malformed();
  }
  const objects = candidate.objects.map(parseObject);
  assertSortedUnique(objects);
  return Object.freeze({
    schemaVersion: RENDER_MANIFEST_SCHEMA,
    versionId: identifier(candidate.versionId, VERSION_ID),
    canonicalPayloadHash: hash(candidate.canonicalPayloadHash),
    bundlePayloadHash: hash(candidate.bundlePayloadHash),
    objects: Object.freeze(objects),
  });
}

function parseManifestShape(value: unknown): RenderManifestV1 {
  const candidate = record(value);
  exactKeys(candidate, [
    'schemaVersion',
    'versionId',
    'canonicalPayloadHash',
    'bundlePayloadHash',
    'objects',
    'renderManifestHash',
  ]);
  const draft = parseDraftShape({
    schemaVersion: candidate.schemaVersion,
    versionId: candidate.versionId,
    canonicalPayloadHash: candidate.canonicalPayloadHash,
    bundlePayloadHash: candidate.bundlePayloadHash,
    objects: candidate.objects,
  });
  const renderManifestHash = hash(candidate.renderManifestHash);
  const manifest = Object.freeze({ ...draft, renderManifestHash });
  if (renderManifestHash !== computeRenderManifestHash(draft)) {
    reject('RENDER_MANIFEST_HASH_MISMATCH');
  }
  return manifest;
}

function validBundleScript(bundle: BlindBundle) {
  const script = bundle?.script;
  return bundle?.schemaVersion === 'blind-script/1.0'
    && !!script
    && VERSION_ID.test(script.versionId)
    && SHA256.test(script.canonicalPayloadHash);
}

function validSourcePage(
  bundle: BlindBundle,
  evidence: Pick<EvidenceRegion, 'sourceId' | 'pageId'>,
) {
  if (!SOURCE_ID.test(evidence.sourceId) || !PAGE_ID.test(evidence.pageId)) return null;
  const source = bundle.sources?.[evidence.sourceId];
  if (!source || source.sourceId !== evidence.sourceId || !Array.isArray(source.pages)) return null;
  const matches = source.pages.filter((page) => page?.pageId === evidence.pageId);
  if (matches.length !== 1) return null;
  const page = matches[0];
  if (
    !PAGE_ID.test(page.pageId)
    || !Number.isSafeInteger(page.width)
    || page.width < 1
    || page.width > MAX_RENDER_OBJECT_DIMENSION
    || !Number.isSafeInteger(page.height)
    || page.height < 1
    || page.height > MAX_RENDER_OBJECT_DIMENSION
  ) return null;
  return page;
}

function imageEvidenceAssetMetadata(
  bundle: BlindBundle,
  block: ContentBlock,
  evidence: EvidenceRegion,
) {
  if (!Array.isArray(block.assetIds) || block.assetIds.length === 0) {
    reject('RENDER_MANIFEST_REFERENCE_MISMATCH');
  }
  const assets = block.assetIds.map((assetId) => {
    if (typeof assetId !== 'string' || !ASSET_ID.test(assetId)) {
      reject('RENDER_MANIFEST_REFERENCE_MISMATCH');
    }
    const asset = bundle.assets?.[assetId];
    if (
      !asset
      || asset.assetId !== assetId
      || !Array.isArray(asset.sourceIds)
      || asset.sourceIds.length === 0
      || asset.sourceIds.some((sourceId) => (
        typeof sourceId !== 'string'
        || !SOURCE_ID.test(sourceId)
        || !bundle.sources?.[sourceId]
      ))
    ) reject('RENDER_MANIFEST_REFERENCE_MISMATCH');
    return asset;
  });
  const authorized = assets.filter((asset) => asset.sourceIds.includes(evidence.sourceId));
  if (authorized.length === 0) reject('RENDER_MANIFEST_REFERENCE_MISMATCH');

  const matchingMetadata: RenderManifestObjectV1[] = [];
  for (const asset of authorized) {
    if (asset.pageObjects === undefined) continue;
    if (!Array.isArray(asset.pageObjects)) reject('RENDER_MANIFEST_REFERENCE_MISMATCH');
    const seen = new Set<string>();
    for (const rawObject of asset.pageObjects as readonly unknown[]) {
      let object: RenderManifestObjectV1;
      try {
        object = parseObject(rawObject);
      } catch {
        reject('RENDER_MANIFEST_REFERENCE_MISMATCH');
      }
      if (!asset.sourceIds.includes(object.sourceId)) {
        reject('RENDER_MANIFEST_REFERENCE_MISMATCH');
      }
      const key = pairKey(object.sourceId, object.pageId);
      if (seen.has(key)) reject('RENDER_MANIFEST_REFERENCE_MISMATCH');
      seen.add(key);
      if (!validSourcePage(bundle, object)) reject('RENDER_MANIFEST_REFERENCE_MISMATCH');
      if (object.sourceId === evidence.sourceId && object.pageId === evidence.pageId) {
        matchingMetadata.push(object);
      }
    }
  }
  return matchingMetadata;
}

function collectExpectedObjects(bundle: BlindBundle) {
  if (!validBundleScript(bundle) || !bundle.contentBlocks || !bundle.assets || !bundle.sources) {
    reject('RENDER_MANIFEST_BINDING_MISMATCH');
  }
  const expected = new Map<string, ExpectedRenderObject>();
  for (const [contentId, block] of Object.entries(bundle.contentBlocks)) {
    if (!block || block.kind !== 'image') continue;
    if (
      !CONTENT_ID.test(contentId)
      || block.contentId !== contentId
      || !block.trace
      || !Array.isArray(block.trace.evidence)
      || block.trace.evidence.length === 0
    ) reject('RENDER_MANIFEST_REFERENCE_MISMATCH');
    for (const evidence of block.trace.evidence) {
      if (!evidence || typeof evidence !== 'object') {
        reject('RENDER_MANIFEST_REFERENCE_MISMATCH');
      }
      const page = validSourcePage(bundle, evidence);
      if (!page) reject('RENDER_MANIFEST_REFERENCE_MISMATCH');
      const legacyMetadata = imageEvidenceAssetMetadata(bundle, block, evidence);
      const key = pairKey(evidence.sourceId, evidence.pageId);
      const prior = expected.get(key);
      if (prior) {
        prior.legacyMetadata.push(...legacyMetadata);
      } else {
        expected.set(key, {
          sourceId: evidence.sourceId,
          pageId: evidence.pageId,
          width: page.width,
          height: page.height,
          legacyMetadata: [...legacyMetadata],
        });
      }
    }
  }
  return expected;
}

function sameObjectMetadata(left: RenderManifestObjectV1, right: RenderManifestObjectV1) {
  return left.sourceId === right.sourceId
    && left.pageId === right.pageId
    && left.mediaType === right.mediaType
    && left.sha256 === right.sha256
    && left.byteLength === right.byteLength
    && left.width === right.width
    && left.height === right.height;
}

function validateReferences(manifest: RenderManifestV1, bundle: BlindBundle) {
  const expected = collectExpectedObjects(bundle);
  if (manifest.objects.length !== expected.size) {
    reject('RENDER_MANIFEST_REFERENCE_MISMATCH');
  }
  for (const object of manifest.objects) {
    const requirement = expected.get(pairKey(object.sourceId, object.pageId));
    if (
      !requirement
      || object.width !== requirement.width
      || object.height !== requirement.height
      || requirement.legacyMetadata.some((legacy) => !sameObjectMetadata(object, legacy))
    ) reject('RENDER_MANIFEST_REFERENCE_MISMATCH');
  }
}

function validateBindings(
  manifest: RenderManifestV1,
  bundle: BlindBundle,
  bundleBytes: RenderManifestBundleBytes,
) {
  if (
    !validBundleScript(bundle)
    || manifest.versionId !== bundle.script.versionId
    || manifest.canonicalPayloadHash !== bundle.script.canonicalPayloadHash
    || manifest.bundlePayloadHash !== sha256(bundleBytes)
  ) reject('RENDER_MANIFEST_BINDING_MISMATCH');
}

export function computeRenderManifestHash(value: RenderManifestDraftV1 | RenderManifestV1) {
  const candidate = record(value);
  const draft = own(candidate, 'renderManifestHash')
    ? parseDraftShape({
      schemaVersion: candidate.schemaVersion,
      versionId: candidate.versionId,
      canonicalPayloadHash: candidate.canonicalPayloadHash,
      bundlePayloadHash: candidate.bundlePayloadHash,
      objects: candidate.objects,
    })
    : parseDraftShape(candidate);
  return sha256(canonicalJson({ ...draft, renderManifestHash: null }));
}

export function createRenderManifest(
  bundle: BlindBundle,
  bundleBytes: RenderManifestBundleBytes,
  objects: readonly unknown[],
): RenderManifestV1 {
  if (!validBundleScript(bundle) || !Array.isArray(objects)) {
    reject('RENDER_MANIFEST_BINDING_MISMATCH');
  }
  const draft: RenderManifestDraftV1 = Object.freeze({
    schemaVersion: RENDER_MANIFEST_SCHEMA,
    versionId: bundle.script.versionId,
    canonicalPayloadHash: bundle.script.canonicalPayloadHash,
    bundlePayloadHash: sha256(bundleBytes),
    objects: normalizeSortedObjects(objects),
  });
  const manifest = Object.freeze({
    ...draft,
    renderManifestHash: computeRenderManifestHash(draft),
  });
  validateReferences(manifest, bundle);
  return manifest;
}

export function stringifyRenderManifest(value: RenderManifestV1) {
  const manifest = parseManifestShape(value);
  return `${canonicalJson(manifest)}\n`;
}

export function parseRenderManifestJson(
  raw: string,
  bundle: BlindBundle,
  bundleBytes: RenderManifestBundleBytes,
): RenderManifestV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    malformed();
  }
  const manifest = parseManifestShape(value);
  validateBindings(manifest, bundle, bundleBytes);
  validateReferences(manifest, bundle);
  if (raw !== `${canonicalJson(manifest)}\n`) reject('RENDER_MANIFEST_NOT_CANONICAL');
  return manifest;
}

function blockEvidence(
  bundle: BlindBundle,
  contentId: string,
  part: number,
): { block: ContentBlock; evidence: EvidenceRegion } | null {
  if (!CONTENT_ID.test(contentId) || !Number.isSafeInteger(part) || part < 0) return null;
  const block = bundle.contentBlocks?.[contentId];
  if (
    !block
    || block.contentId !== contentId
    || block.kind !== 'image'
    || !Array.isArray(block.trace?.evidence)
  ) return null;
  const evidence = block.trace.evidence[part];
  if (!evidence || !validSourcePage(bundle, evidence)) return null;
  try {
    imageEvidenceAssetMetadata(bundle, block, evidence);
  } catch {
    return null;
  }
  return { block, evidence };
}

export function resolveRenderManifestObject(
  manifest: RenderManifestV1,
  bundle: BlindBundle,
  contentId: string,
  part: number,
): RenderManifestObjectV1 | null {
  if (
    !validBundleScript(bundle)
    || manifest.versionId !== bundle.script.versionId
    || manifest.canonicalPayloadHash !== bundle.script.canonicalPayloadHash
  ) return null;
  const resolved = blockEvidence(bundle, contentId, part);
  if (!resolved) return null;
  const matches = manifest.objects.filter((object) => (
    object.sourceId === resolved.evidence.sourceId
    && object.pageId === resolved.evidence.pageId
  ));
  if (matches.length !== 1) return null;
  const page = validSourcePage(bundle, resolved.evidence);
  if (!page || matches[0].width !== page.width || matches[0].height !== page.height) return null;
  return matches[0];
}
