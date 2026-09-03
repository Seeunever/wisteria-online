import 'server-only';

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { getDatabase } from './db.ts';
import type { BlindBundle } from './blind-runtime';
import { validateStageSearchMechanisms } from './investigation/config.ts';
import {
  parseRuntimePolicyJson,
  resolveCanonicalRuntimePolicy,
  resolveLegacyEmbeddedRuntimePolicy,
  resolveSidecarRuntimePolicy,
  RUNTIME_POLICY_SCHEMA,
  type ResolvedRuntimePolicy,
} from './investigation/runtime-policy.ts';
import {
  MAX_RENDER_OBJECT_BYTES,
  parseRenderManifestJson,
  RENDER_MANIFEST_SCHEMA,
  resolveRenderManifestObject,
  type RenderManifestObjectV1,
  type RenderManifestV1,
} from './render-manifest.ts';

const VERSION_ID = /^ver_[0-9a-f]{8,64}$/;
const CONTENT_ID = /^cnt_[0-9a-f]{8,64}$/;
const SOURCE_ID = /^src_[0-9a-f]{8,64}$/;
const PAGE_ID = /^page_[0-9a-f]{8,64}$/;
const PAYLOAD_HASH = /^sha256:[0-9a-f]{64}$/;
const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
const MAX_RUNTIME_POLICY_BYTES = 1024 * 1024;
const MAX_RENDER_MANIFEST_BYTES = 16 * 1024 * 1024;

export class PackAccessError extends Error {
  constructor(readonly code: 'PACK_NOT_AVAILABLE' | 'PACK_STORAGE_REJECTED') {
    super(code);
    this.name = 'PackAccessError';
  }
}

function dataDirectory() {
  return path.resolve(
    /* turbopackIgnore: true */ process.env.WISTERIA_DATA_DIR
      ?? path.join(process.cwd(), '.data'),
  );
}

function resolvePrivateRegularFile(
  storedPath: string,
  maximumBytes: number,
  expectedPath?: string,
) {
  if (
    typeof storedPath !== 'string'
    || storedPath.includes('\\')
    || storedPath.includes('\0')
    || path.posix.isAbsolute(storedPath)
    || path.posix.normalize(storedPath) !== storedPath
    || storedPath.split('/').some((part) => !part || part === '.' || part === '..')
    || (expectedPath !== undefined && storedPath !== expectedPath)
  ) throw new PackAccessError('PACK_STORAGE_REJECTED');
  const unresolvedRoot = dataDirectory();
  const rootMetadata = lstatSync(unresolvedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  const root = realpathSync(/* turbopackIgnore: true */ unresolvedRoot);
  const pathParts = storedPath.split('/');
  const candidate = path.resolve(root, ...pathParts);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  let cursor = root;
  for (const part of pathParts) {
    cursor = path.join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new PackAccessError('PACK_STORAGE_REJECTED');
    }
  }
  const realCandidate = realpathSync(/* turbopackIgnore: true */ candidate);
  const realRelative = path.relative(root, realCandidate);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  const metadata = lstatSync(realCandidate);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximumBytes) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  return realCandidate;
}

function resolvePrivateDirectory(storedPath: string, expectedPath: string) {
  if (
    storedPath !== expectedPath
    || storedPath.includes('\\')
    || storedPath.includes('\0')
    || path.posix.normalize(storedPath) !== storedPath
    || storedPath.split('/').some((part) => !part || part === '.' || part === '..')
  ) throw new PackAccessError('PACK_STORAGE_REJECTED');
  const unresolvedRoot = dataDirectory();
  const rootMetadata = lstatSync(unresolvedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  const root = realpathSync(/* turbopackIgnore: true */ unresolvedRoot);
  let cursor = root;
  for (const part of storedPath.split('/')) {
    cursor = path.join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new PackAccessError('PACK_STORAGE_REJECTED');
    }
  }
  const resolved = realpathSync(/* turbopackIgnore: true */ cursor);
  const relative = path.relative(root, resolved);
  const metadata = lstatSync(resolved);
  if (
    !relative
    || relative.startsWith('..')
    || path.isAbsolute(relative)
    || !metadata.isDirectory()
    || metadata.isSymbolicLink()
  ) throw new PackAccessError('PACK_STORAGE_REJECTED');
  return resolved;
}

function parseBundle(raw: string, versionId: string, sourceHash: string): BlindBundle {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  if (!value || typeof value !== 'object') throw new PackAccessError('PACK_STORAGE_REJECTED');
  const bundle = value as Partial<BlindBundle> & {
    script?: Partial<BlindBundle['script']> & { canonicalPayloadHash?: unknown };
  };
  if (
    bundle.schemaVersion !== 'blind-script/1.0'
    || !VERSION_ID.test(versionId)
    || !PAYLOAD_HASH.test(sourceHash)
    || bundle.script?.versionId !== versionId
    || bundle.script.canonicalPayloadHash !== sourceHash
    || !bundle.contentBlocks
    || typeof bundle.contentBlocks !== 'object'
    || !bundle.roles
    || typeof bundle.roles !== 'object'
    || !bundle.stages
    || typeof bundle.stages !== 'object'
    || Array.isArray(bundle.stages)
  ) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  try {
    validateStageSearchMechanisms(bundle.stages);
  } catch {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  return bundle as BlindBundle;
}

type FrozenRuntimeRow = {
  payloadPath: string;
  sourceHash: string;
  profileMode: string | null;
  profileCanonicalPayloadHash: string | null;
  bundlePayloadHash: string | null;
  policySchema: string | null;
  policyPath: string | null;
  policyPayloadHash: string | null;
  runtimePolicyHash: string | null;
  renderProfileMode: string | null;
  renderCanonicalPayloadHash: string | null;
  renderBundlePayloadHash: string | null;
  manifestSchema: string | null;
  manifestPath: string | null;
  manifestPayloadHash: string | null;
  renderManifestHash: string | null;
};

function frozenRuntimeRow(versionId: string) {
  const row = getDatabase().prepare(`
    SELECT
      pack_versions.payload_path AS payloadPath,
      pack_versions.source_hash AS sourceHash,
      pack_runtime_profiles.mode AS profileMode,
      pack_runtime_profiles.canonical_payload_hash AS profileCanonicalPayloadHash,
      pack_runtime_profiles.bundle_payload_hash AS bundlePayloadHash,
      pack_runtime_profiles.policy_schema AS policySchema,
      pack_runtime_profiles.policy_path AS policyPath,
      pack_runtime_profiles.policy_payload_hash AS policyPayloadHash,
      pack_runtime_profiles.runtime_policy_hash AS runtimePolicyHash,
      pack_render_profiles.mode AS renderProfileMode,
      pack_render_profiles.canonical_payload_hash AS renderCanonicalPayloadHash,
      pack_render_profiles.bundle_payload_hash AS renderBundlePayloadHash,
      pack_render_profiles.manifest_schema AS manifestSchema,
      pack_render_profiles.manifest_path AS manifestPath,
      pack_render_profiles.manifest_payload_hash AS manifestPayloadHash,
      pack_render_profiles.render_manifest_hash AS renderManifestHash
    FROM pack_versions
    LEFT JOIN pack_runtime_profiles
      ON pack_runtime_profiles.version_id = pack_versions.id
    LEFT JOIN pack_render_profiles
      ON pack_render_profiles.version_id = pack_versions.id
    WHERE pack_versions.id = ? AND pack_versions.state = 'frozen'
  `).get(versionId) as FrozenRuntimeRow | undefined;
  if (!row) throw new PackAccessError('PACK_NOT_AVAILABLE');
  if (
    !row.profileMode
    || !row.renderProfileMode
    || !PAYLOAD_HASH.test(row.sourceHash)
    || row.profileCanonicalPayloadHash !== row.sourceHash
    || row.renderCanonicalPayloadHash !== row.sourceHash
  ) throw new PackAccessError('PACK_STORAGE_REJECTED');
  return row;
}

function loadBundleFromRuntimeRow(
  versionId: string,
  row: FrozenRuntimeRow,
) {
  const runtimeIsLegacy = row.profileMode === 'legacy_embedded';
  const renderIsLegacy = row.renderProfileMode === 'legacy_embedded';
  const isFullyLegacy = runtimeIsLegacy && renderIsLegacy;
  const expectedPayloadPath = `packs/${versionId}/bundle.internal.json`;
  if (!isFullyLegacy && row.payloadPath !== expectedPayloadPath) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  if (
    (!runtimeIsLegacy && (typeof row.bundlePayloadHash !== 'string'
      || !PAYLOAD_HASH.test(row.bundlePayloadHash)))
    || (row.bundlePayloadHash !== null && !PAYLOAD_HASH.test(row.bundlePayloadHash))
    || (
      row.renderProfileMode === 'manifest'
      && (typeof row.renderBundlePayloadHash !== 'string'
        || !PAYLOAD_HASH.test(row.renderBundlePayloadHash))
    )
    || (
      row.renderBundlePayloadHash !== null
      && !PAYLOAD_HASH.test(row.renderBundlePayloadHash)
    )
    || (
      row.bundlePayloadHash !== null
      && row.renderBundlePayloadHash !== null
      && row.bundlePayloadHash !== row.renderBundlePayloadHash
    )
  ) throw new PackAccessError('PACK_STORAGE_REJECTED');

  const payloadPath = resolvePrivateRegularFile(
    row.payloadPath,
    MAX_BUNDLE_BYTES,
    isFullyLegacy ? undefined : expectedPayloadPath,
  );
  const bytes = readFileSync(/* turbopackIgnore: true */ payloadPath);
  if (
    row.bundlePayloadHash !== null
    && `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== row.bundlePayloadHash
  ) throw new PackAccessError('PACK_STORAGE_REJECTED');
  if (
    row.renderBundlePayloadHash !== null
    && `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== row.renderBundlePayloadHash
  ) throw new PackAccessError('PACK_STORAGE_REJECTED');
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  return {
    bundle: parseBundle(raw, versionId, row.sourceHash),
    bytes,
    payloadPath,
  };
}

function hasEmbeddedInvestigationFlow(bundle: BlindBundle) {
  return Object.values(bundle.stages).some(
    (stage) => Object.prototype.hasOwnProperty.call(stage, 'investigationFlow'),
  );
}

function assertNoSidecarColumns(row: FrozenRuntimeRow) {
  if (
    row.policySchema !== null
    || row.policyPath !== null
    || row.policyPayloadHash !== null
    || row.runtimePolicyHash !== null
  ) throw new PackAccessError('PACK_STORAGE_REJECTED');
}

function resolveRuntimePolicyFromRow(
  versionId: string,
  row: FrozenRuntimeRow,
  bundle: BlindBundle,
): ResolvedRuntimePolicy {
  if (row.profileMode === 'legacy_embedded') {
    assertNoSidecarColumns(row);
    return resolveLegacyEmbeddedRuntimePolicy(bundle);
  }
  if (hasEmbeddedInvestigationFlow(bundle)) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  if (row.profileMode === 'canonical') {
    assertNoSidecarColumns(row);
    return resolveCanonicalRuntimePolicy(bundle);
  }
  if (row.profileMode !== 'sidecar') {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  if (
    row.policySchema !== RUNTIME_POLICY_SCHEMA
    || typeof row.policyPath !== 'string'
    || typeof row.policyPayloadHash !== 'string'
    || !PAYLOAD_HASH.test(row.policyPayloadHash)
    || typeof row.runtimePolicyHash !== 'string'
    || !PAYLOAD_HASH.test(row.runtimePolicyHash)
  ) throw new PackAccessError('PACK_STORAGE_REJECTED');
  const expectedPolicyPath = `packs/${versionId}/runtime-policy.internal.json`;
  const policyPath = resolvePrivateRegularFile(
    row.policyPath,
    MAX_RUNTIME_POLICY_BYTES,
    expectedPolicyPath,
  );
  const policyBytes = readFileSync(/* turbopackIgnore: true */ policyPath);
  const policyPayloadHash = `sha256:${createHash('sha256').update(policyBytes).digest('hex')}`;
  if (policyPayloadHash !== row.policyPayloadHash) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(policyBytes);
  } catch {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  const sidecar = parseRuntimePolicyJson(raw, bundle);
  if (sidecar.runtimePolicyHash !== row.runtimePolicyHash) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  return resolveSidecarRuntimePolicy(bundle, sidecar);
}

type ResolvedRenderProfile =
  | { mode: 'legacy_embedded'; manifest: null }
  | { mode: 'manifest'; manifest: RenderManifestV1 };

export function parseVerifiedWebpDimensions(bytes: Buffer) {
  if (
    bytes.length < 20
    || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP'
    || bytes.readUInt32LE(4) + 8 !== bytes.length
  ) return null;
  let offset = 12;
  let extendedDimensions: { width: number; height: number } | null = null;
  let imageDimensions: { width: number; height: number } | null = null;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length) return null;
    if (kind === 'VP8X') {
      if (size !== 10 || extendedDimensions !== null) return null;
      extendedDimensions = {
        width: 1 + bytes.readUIntLE(start + 4, 3),
        height: 1 + bytes.readUIntLE(start + 7, 3),
      };
    } else if (kind === 'VP8L' && size >= 5 && bytes[start] === 0x2f) {
      if (imageDimensions !== null) return null;
      const first = bytes[start + 1];
      const second = bytes[start + 2];
      const third = bytes[start + 3];
      const fourth = bytes[start + 4];
      imageDimensions = {
        width: 1 + first + ((second & 0x3f) << 8),
        height: 1 + (second >> 6) + (third << 2) + ((fourth & 0x0f) << 10),
      };
    } else if (
      kind === 'VP8 '
      && size >= 10
      && bytes[start + 3] === 0x9d
      && bytes[start + 4] === 0x01
      && bytes[start + 5] === 0x2a
    ) {
      if (imageDimensions !== null) return null;
      imageDimensions = {
        width: bytes.readUInt16LE(start + 6) & 0x3fff,
        height: bytes.readUInt16LE(start + 8) & 0x3fff,
      };
    }
    const nextOffset = end + (size & 1);
    if (nextOffset > bytes.length) return null;
    offset = nextOffset;
  }
  if (offset !== bytes.length || imageDimensions === null) return null;
  return extendedDimensions ?? imageDimensions;
}

function verifyRenderObject(
  objectsPath: string,
  object: RenderManifestObjectV1,
) {
  if (!SOURCE_ID.test(object.sourceId) || !PAGE_ID.test(object.pageId)) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  const expectedPath = `${objectsPath}/${object.sourceId}.${object.pageId}.webp`;
  const sourcePath = resolvePrivateRegularFile(
    expectedPath,
    MAX_RENDER_OBJECT_BYTES,
    expectedPath,
  );
  const bytes = readFileSync(/* turbopackIgnore: true */ sourcePath);
  const dimensions = parseVerifiedWebpDimensions(bytes);
  if (
    bytes.length !== object.byteLength
    || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== object.sha256
    || dimensions?.width !== object.width
    || dimensions?.height !== object.height
  ) throw new PackAccessError('PACK_STORAGE_REJECTED');
  return bytes;
}

function hasEmbeddedPageObjects(bundle: BlindBundle) {
  return Object.values(bundle.assets).some(
    (asset) => Object.prototype.hasOwnProperty.call(asset, 'pageObjects'),
  );
}

function assertNoManifestColumns(row: FrozenRuntimeRow) {
  if (
    row.manifestSchema !== null
    || row.manifestPath !== null
    || row.manifestPayloadHash !== null
    || row.renderManifestHash !== null
  ) throw new PackAccessError('PACK_STORAGE_REJECTED');
}

function resolveRenderProfileFromRow(
  versionId: string,
  row: FrozenRuntimeRow,
  bundle: BlindBundle,
  bundleBytes: Buffer,
  verifyEveryObject: boolean,
): ResolvedRenderProfile {
  if (row.renderProfileMode === 'legacy_embedded') {
    assertNoManifestColumns(row);
    return { mode: 'legacy_embedded', manifest: null };
  }
  if (
    row.renderProfileMode !== 'manifest'
    || hasEmbeddedPageObjects(bundle)
    || row.manifestSchema !== RENDER_MANIFEST_SCHEMA
    || typeof row.manifestPath !== 'string'
    || typeof row.manifestPayloadHash !== 'string'
    || !PAYLOAD_HASH.test(row.manifestPayloadHash)
    || typeof row.renderManifestHash !== 'string'
    || !PAYLOAD_HASH.test(row.renderManifestHash)
  ) throw new PackAccessError('PACK_STORAGE_REJECTED');
  const expectedManifestPath = `packs/${versionId}/render-manifest.internal.json`;
  const manifestPath = resolvePrivateRegularFile(
    row.manifestPath,
    MAX_RENDER_MANIFEST_BYTES,
    expectedManifestPath,
  );
  const manifestBytes = readFileSync(/* turbopackIgnore: true */ manifestPath);
  if (
    `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`
    !== row.manifestPayloadHash
  ) throw new PackAccessError('PACK_STORAGE_REJECTED');
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
  } catch {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  const manifest = parseRenderManifestJson(raw, bundle, bundleBytes);
  if (manifest.renderManifestHash !== row.renderManifestHash) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  const expectedObjectNames = new Set(
    manifest.objects.map((object) => `${object.sourceId}.${object.pageId}.webp`),
  );
  const expectedObjectsPath = `packs/${versionId}/objects`;
  const objectsDirectory = resolvePrivateDirectory(expectedObjectsPath, expectedObjectsPath);
  const entries = readdirSync(objectsDirectory, { withFileTypes: true });
  if (
    entries.length !== expectedObjectNames.size
    || entries.some((entry) => (
      !expectedObjectNames.has(entry.name)
      || !entry.isFile()
      || entry.isSymbolicLink()
    ))
  ) throw new PackAccessError('PACK_STORAGE_REJECTED');
  if (verifyEveryObject) {
    for (const object of manifest.objects) verifyRenderObject(expectedObjectsPath, object);
  }
  return { mode: 'manifest', manifest };
}

export function listFrozenPackVersions() {
  const candidates = getDatabase().prepare(`
    SELECT id AS versionId, public_label AS publicLabel
    FROM pack_versions
    WHERE state = 'frozen'
    ORDER BY frozen_at DESC, created_at DESC
  `).all() as Array<{ versionId: string; publicLabel: string }>;
  return candidates.filter((candidate) => {
    try {
      loadInstalledPackInternal(candidate.versionId, true);
      return true;
    } catch {
      return false;
    }
  });
}

export function loadFrozenBundle(versionId: string) {
  if (!VERSION_ID.test(versionId)) throw new PackAccessError('PACK_NOT_AVAILABLE');
  const row = frozenRuntimeRow(versionId);

  try {
    const loaded = loadBundleFromRuntimeRow(versionId, row);
    resolveRuntimePolicyFromRow(versionId, row, loaded.bundle);
    resolveRenderProfileFromRow(versionId, row, loaded.bundle, loaded.bytes, true);
    return loaded.bundle;
  } catch (error) {
    if (error instanceof PackAccessError) throw error;
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
}

export function loadFrozenRuntimePolicy(versionId: string) {
  if (!VERSION_ID.test(versionId)) throw new PackAccessError('PACK_NOT_AVAILABLE');
  const row = frozenRuntimeRow(versionId);
  try {
    const loaded = loadBundleFromRuntimeRow(versionId, row);
    const runtimePolicy = resolveRuntimePolicyFromRow(versionId, row, loaded.bundle);
    resolveRenderProfileFromRow(versionId, row, loaded.bundle, loaded.bytes, true);
    return runtimePolicy;
  } catch (error) {
    if (error instanceof PackAccessError) throw error;
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
}

function loadInstalledPackInternal(versionId: string, verifyEveryRenderObject: boolean) {
  if (!VERSION_ID.test(versionId)) throw new PackAccessError('PACK_NOT_AVAILABLE');
  const row = frozenRuntimeRow(versionId);
  try {
    const loaded = loadBundleFromRuntimeRow(versionId, row);
    const runtimePolicy = resolveRuntimePolicyFromRow(versionId, row, loaded.bundle);
    const renderProfile = resolveRenderProfileFromRow(
      versionId,
      row,
      loaded.bundle,
      loaded.bytes,
      verifyEveryRenderObject,
    );
    return { bundle: loaded.bundle, runtimePolicy, renderProfile };
  } catch (error) {
    if (error instanceof PackAccessError) throw error;
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
}

export function loadInstalledPack(versionId: string) {
  return loadInstalledPackInternal(versionId, false);
}

export function loadFrozenContentSource(versionId: string, contentId: string, part: number) {
  if (!VERSION_ID.test(versionId) || !CONTENT_ID.test(contentId) || !Number.isInteger(part) || part < 0) {
    throw new PackAccessError('PACK_NOT_AVAILABLE');
  }
  try {
    const row = frozenRuntimeRow(versionId);
    const loaded = loadBundleFromRuntimeRow(versionId, row);
    resolveRuntimePolicyFromRow(versionId, row, loaded.bundle);
    const renderProfile = resolveRenderProfileFromRow(
      versionId,
      row,
      loaded.bundle,
      loaded.bytes,
      false,
    );
    const block = loaded.bundle.contentBlocks[contentId];
    const evidence = block?.trace?.evidence?.[part];
    if (!block || block.kind !== 'image' || !evidence || !SOURCE_ID.test(evidence.sourceId)) {
      throw new PackAccessError('PACK_NOT_AVAILABLE');
    }
    const source = loaded.bundle.sources[evidence.sourceId];
    const page = source?.pages.find((item) => item.pageId === evidence.pageId);
    const matchingAssets = block.assetIds
      .map((assetId) => loaded.bundle.assets[assetId])
      .filter((asset) => asset?.sourceIds.includes(evidence.sourceId));
    if (!source || !page || matchingAssets.length === 0) {
      throw new PackAccessError('PACK_NOT_AVAILABLE');
    }

    let renderedPage: RenderManifestObjectV1 | undefined;
    if (renderProfile.mode === 'manifest') {
      renderedPage = resolveRenderManifestObject(
        renderProfile.manifest,
        loaded.bundle,
        contentId,
        part,
      ) ?? undefined;
    } else {
      const candidates = matchingAssets
        .flatMap((asset) => asset.pageObjects ?? [])
        .filter((item) => item.sourceId === evidence.sourceId && item.pageId === evidence.pageId);
      renderedPage = candidates[0];
      if (
        renderedPage
        && candidates.some((candidate) => (
          candidate.mediaType !== renderedPage?.mediaType
          || candidate.sha256 !== renderedPage?.sha256
          || candidate.byteLength !== renderedPage?.byteLength
          || candidate.width !== renderedPage?.width
          || candidate.height !== renderedPage?.height
        ))
      ) throw new Error('AMBIGUOUS_LEGACY_RENDER');
    }
    if (
      !renderedPage
      || renderedPage.mediaType !== 'image/webp'
      || !PAYLOAD_HASH.test(renderedPage.sha256)
      || renderedPage.width !== page.width
      || renderedPage.height !== page.height
    ) throw new Error('RENDERED_PAGE_REQUIRED');
    const payloadDirectory = path.posix.dirname(row.payloadPath);
    const legacyObjectsPath = payloadDirectory === '.'
      ? 'objects'
      : `${payloadDirectory}/objects`;
    const sourceBytes = verifyRenderObject(
      renderProfile.mode === 'manifest'
        ? `packs/${versionId}/objects`
        : legacyObjectsPath,
      renderedPage,
    );
    return {
      sourceBytes,
      mediaType: renderedPage.mediaType,
      inputPageIndex: 0,
      page,
      region: evidence.region,
    };
  } catch (error) {
    if (error instanceof PackAccessError) throw error;
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
}
