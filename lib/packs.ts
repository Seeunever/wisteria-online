import 'server-only';

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { getDatabase } from './db';
import type { BlindBundle } from './blind-runtime';

const VERSION_ID = /^ver_[0-9a-f]{8,64}$/;
const CONTENT_ID = /^cnt_[0-9a-f]{8,64}$/;
const SOURCE_ID = /^src_[0-9a-f]{8,64}$/;
const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;

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

function resolvePrivatePayload(payloadPath: string) {
  const root = realpathSync(/* turbopackIgnore: true */ dataDirectory());
  const candidate = path.resolve(root, payloadPath);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  const realCandidate = realpathSync(/* turbopackIgnore: true */ candidate);
  const realRelative = path.relative(root, realCandidate);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  const metadata = lstatSync(realCandidate);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_BUNDLE_BYTES) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  return realCandidate;
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
    || bundle.script?.versionId !== versionId
    || bundle.script.canonicalPayloadHash !== sourceHash
    || !bundle.contentBlocks
    || typeof bundle.contentBlocks !== 'object'
    || !bundle.roles
    || typeof bundle.roles !== 'object'
  ) {
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
  return bundle as BlindBundle;
}

function frozenRow(versionId: string) {
  const row = getDatabase().prepare(`
    SELECT payload_path AS payloadPath, source_hash AS sourceHash
    FROM pack_versions
    WHERE id = ? AND state = 'frozen'
  `).get(versionId) as { payloadPath: string; sourceHash: string } | undefined;
  if (!row) throw new PackAccessError('PACK_NOT_AVAILABLE');
  return row;
}

export function listFrozenPackVersions() {
  return getDatabase().prepare(`
    SELECT id AS versionId, public_label AS publicLabel
    FROM pack_versions
    WHERE state = 'frozen'
    ORDER BY frozen_at DESC, created_at DESC
  `).all() as Array<{ versionId: string; publicLabel: string }>;
}

export function loadFrozenBundle(versionId: string) {
  if (!VERSION_ID.test(versionId)) throw new PackAccessError('PACK_NOT_AVAILABLE');
  const row = frozenRow(versionId);

  try {
    const payloadPath = resolvePrivatePayload(row.payloadPath);
    const raw = readFileSync(/* turbopackIgnore: true */ payloadPath, { encoding: 'utf8' });
    return parseBundle(raw, versionId, row.sourceHash);
  } catch (error) {
    if (error instanceof PackAccessError) throw error;
    throw new PackAccessError('PACK_STORAGE_REJECTED');
  }
}

export function loadFrozenContentSource(versionId: string, contentId: string, part: number) {
  if (!VERSION_ID.test(versionId) || !CONTENT_ID.test(contentId) || !Number.isInteger(part) || part < 0) {
    throw new PackAccessError('PACK_NOT_AVAILABLE');
  }
  const row = frozenRow(versionId);
  const bundle = loadFrozenBundle(versionId);
  const block = bundle.contentBlocks[contentId];
  const evidence = block?.trace?.evidence?.[part];
  if (!block || block.kind !== 'image' || !evidence || !SOURCE_ID.test(evidence.sourceId)) {
    throw new PackAccessError('PACK_NOT_AVAILABLE');
  }
  const source = bundle.sources[evidence.sourceId];
  const page = source?.pages.find((item) => item.pageId === evidence.pageId);
  const matchingAssets = block.assetIds
    .map((assetId) => bundle.assets[assetId])
    .filter((asset) => asset?.sourceIds.includes(evidence.sourceId));
  const assetAllowsSource = matchingAssets.length > 0;
  if (!source || !page || !assetAllowsSource) throw new PackAccessError('PACK_NOT_AVAILABLE');

  try {
    const payloadPath = resolvePrivatePayload(row.payloadPath);
    const versionDirectory = path.dirname(payloadPath);
    const renderedPage = matchingAssets
      .flatMap((asset) => asset.pageObjects ?? [])
      .find((item) => item.sourceId === evidence.sourceId && item.pageId === evidence.pageId);
    if (!renderedPage) {
      throw new Error('RENDERED_PAGE_REQUIRED');
    }
    const candidate = path.join(
      versionDirectory,
      'objects',
      `${evidence.sourceId}.${evidence.pageId}.webp`,
    );
    const resolved = realpathSync(/* turbopackIgnore: true */ candidate);
    const relative = path.relative(versionDirectory, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('OUTSIDE_PACK');
    const metadata = lstatSync(resolved);
    const expectedByteLength = renderedPage.byteLength;
    const expectedHash = renderedPage.sha256;
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== expectedByteLength) {
      throw new Error('SOURCE_REJECTED');
    }
    const digest = createHash('sha256').update(readFileSync(resolved)).digest('hex');
    if (`sha256:${digest}` !== expectedHash) throw new Error('SOURCE_REJECTED');
    return {
      sourcePath: resolved,
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
