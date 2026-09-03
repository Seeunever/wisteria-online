import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const VERSION_ID = /^ver_[0-9a-f]{8,64}$/;
const SOURCE_ID = /^src_[0-9a-f]{8,64}$/;
const PAGE_ID = /^page_[0-9a-f]{8,64}$/;
const PAYLOAD_HASH = /^sha256:[0-9a-f]{64}$/;

function fail(phase) {
  const safePhase = [
    'arguments',
    'run-inputs',
    'bundle-copy',
    'source-verification',
    'page-object-copy',
    'registry',
  ].includes(phase) ? phase : 'unknown';
  process.stderr.write(JSON.stringify({
    code: 'PACK_INSTALL_REJECTED',
    status: 'blocked',
    phase: safePhase,
  }) + '\n');
  process.exitCode = 2;
}

function argumentsFrom(tokens) {
  const values = new Map();
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!['--run-root', '--data-dir', '--label'].includes(key) || typeof value !== 'string') {
      throw new Error('ARGUMENT_ERROR');
    }
    if (values.has(key)) throw new Error('ARGUMENT_ERROR');
    values.set(key, value);
  }
  if (values.size !== 3) throw new Error('ARGUMENT_ERROR');
  return {
    runRoot: values.get('--run-root'),
    dataDirectory: values.get('--data-dir'),
    label: values.get('--label'),
  };
}

function regularFile(filePath, maximumBytes) {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximumBytes) {
    throw new Error('UNSAFE_FILE');
  }
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function privateVaultBlob(runRoot, reference) {
  if (typeof reference !== 'string' || !reference.startsWith('vault:')) {
    throw new Error('SOURCE_REJECTED');
  }
  const vaultRoot = realpathSync(path.join(runRoot, 'vault'));
  const candidate = path.resolve(vaultRoot, reference.slice('vault:'.length));
  const relative = path.relative(vaultRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('SOURCE_REJECTED');
  }
  const resolved = realpathSync(candidate);
  const realRelative = path.relative(vaultRoot, resolved);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error('SOURCE_REJECTED');
  }
  regularFile(resolved, 128 * 1024 * 1024);
  return resolved;
}

function privateRenderedObject(runRoot, sourceId, pageId) {
  if (!SOURCE_ID.test(sourceId) || !PAGE_ID.test(pageId)) throw new Error('RENDER_REJECTED');
  const renderedRoot = realpathSync(path.join(runRoot, 'vault', 'rendered'));
  const candidate = path.join(renderedRoot, `${sourceId}.${pageId}.webp`);
  const resolved = realpathSync(candidate);
  const relative = path.relative(renderedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('RENDER_REJECTED');
  }
  regularFile(resolved, 512 * 1024 * 1024);
  return resolved;
}

function normalizedDigest(value) {
  if (typeof value !== 'string') return null;
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}

let ownedVersionDirectory = null;
let phase = 'arguments';
try {
  const args = argumentsFrom(process.argv.slice(2));
  const label = args.label.normalize('NFKC').trim();
  if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/u.test(label)) throw new Error('LABEL_REJECTED');

  phase = 'run-inputs';
  const runRoot = realpathSync(path.resolve(args.runRoot));
  const dataDirectory = realpathSync(path.resolve(args.dataDirectory));
  const dataMetadata = lstatSync(dataDirectory);
  if (!dataMetadata.isDirectory() || dataMetadata.isSymbolicLink()) throw new Error('DATA_ROOT_REJECTED');
  if (
    typeof process.getuid === 'function'
    && typeof process.getgid === 'function'
    && (process.getuid() !== dataMetadata.uid || process.getgid() !== dataMetadata.gid)
  ) throw new Error('DATA_OWNER_MISMATCH');
  if (runRoot === dataDirectory || runRoot.startsWith(`${dataDirectory}${path.sep}`)) {
    throw new Error('ROOT_OVERLAP');
  }
  regularFile(path.join(runRoot, '.blind-player-run-root'), 1024);
  const reportPath = path.join(runRoot, 'safe', 'validation.json');
  const bundlePath = path.join(runRoot, 'vault', 'bundle.json');
  const inventoryPath = path.join(runRoot, 'private', 'source-inventory.json');
  regularFile(reportPath, 1024 * 1024);
  regularFile(bundlePath, 128 * 1024 * 1024);
  regularFile(inventoryPath, 32 * 1024 * 1024);

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (
    report?.report_schema !== 'blind-validation-safe/1.0'
    || report.status !== 'validated'
    || report.freeze_ready !== true
    || report.published !== false
    || report.quality?.blocking_issues !== 0
    || !Array.isArray(report.issues)
    || report.issues.length !== 0
  ) throw new Error('REPORT_REJECTED');

  const sourceDigestBefore = sha256(bundlePath);
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const versionId = bundle?.script?.versionId;
  const canonicalPayloadHash = bundle?.script?.canonicalPayloadHash;
  if (
    bundle?.schemaVersion !== 'blind-script/1.0'
    || !VERSION_ID.test(versionId)
    || !PAYLOAD_HASH.test(canonicalPayloadHash)
    || !bundle.sources
    || typeof bundle.sources !== 'object'
    || !Array.isArray(inventory.sources)
  ) throw new Error('BUNDLE_REJECTED');

  phase = 'bundle-copy';
  const packsDirectory = path.join(dataDirectory, 'packs');
  mkdirSync(packsDirectory, { recursive: true, mode: 0o700 });
  const versionDirectory = path.join(packsDirectory, versionId);
  mkdirSync(versionDirectory, { recursive: false, mode: 0o700 });
  ownedVersionDirectory = versionDirectory;
  const destination = path.join(versionDirectory, 'bundle.internal.json');
  copyFileSync(bundlePath, destination, constants.COPYFILE_EXCL);
  chmodSync(destination, 0o600);
  if (sha256(bundlePath) !== sourceDigestBefore || sha256(destination) !== sourceDigestBefore) {
    throw new Error('COPY_MISMATCH');
  }

  phase = 'source-verification';
  const inventoryByPathRef = new Map(inventory.sources.map((source) => [source.path_ref, source]));
  const objectsDirectory = path.join(versionDirectory, 'objects');
  mkdirSync(objectsDirectory, { recursive: false, mode: 0o700 });
  for (const [sourceId, source] of Object.entries(bundle.sources)) {
    if (!SOURCE_ID.test(sourceId) || source?.sourceId !== sourceId) {
      throw new Error('SOURCE_REJECTED');
    }
    const inventoried = inventoryByPathRef.get(source.originalPathRef);
    if (
      !inventoried
      || inventoried.source_id !== sourceId
      || inventoried.byte_length !== source.byteLength
      || inventoried.media_type !== source.mediaType
      || normalizedDigest(inventoried.sha256) !== normalizedDigest(source.sha256)
    ) throw new Error('SOURCE_REJECTED');
    const sourcePath = privateVaultBlob(runRoot, inventoried.vault_blob_ref);
    if (sha256(sourcePath) !== normalizedDigest(source.sha256)) throw new Error('SOURCE_REJECTED');
  }
  phase = 'page-object-copy';
  const copiedRenderedPages = new Set();
  for (const asset of Object.values(bundle.assets ?? {})) {
    if (!asset || !Array.isArray(asset.sourceIds)) throw new Error('ASSET_REJECTED');
    const pageObjects = asset.pageObjects ?? [];
    if (!Array.isArray(pageObjects)) throw new Error('ASSET_REJECTED');
    for (const pageObject of pageObjects) {
      const sourceId = pageObject?.sourceId;
      const pageId = pageObject?.pageId;
      const key = `${sourceId}.${pageId}`;
      const source = bundle.sources[sourceId];
      const page = source?.pages?.find((item) => item?.pageId === pageId);
      if (
        !SOURCE_ID.test(sourceId)
        || !PAGE_ID.test(pageId)
        || copiedRenderedPages.has(key)
        || !asset.sourceIds.includes(sourceId)
        || pageObject.mediaType !== 'image/webp'
        || pageObject.width !== page?.width
        || pageObject.height !== page?.height
      ) throw new Error('RENDER_REJECTED');
      const renderedPath = privateRenderedObject(runRoot, sourceId, pageId);
      const renderedMetadata = lstatSync(renderedPath);
      if (
        renderedMetadata.size !== pageObject.byteLength
        || sha256(renderedPath) !== normalizedDigest(pageObject.sha256)
      ) throw new Error('RENDER_REJECTED');
      const objectPath = path.join(objectsDirectory, `${key}.webp`);
      copyFileSync(renderedPath, objectPath, constants.COPYFILE_EXCL);
      chmodSync(objectPath, 0o600);
      if (sha256(objectPath) !== normalizedDigest(pageObject.sha256)) {
        throw new Error('COPY_MISMATCH');
      }
      copiedRenderedPages.add(key);
    }
  }

  phase = 'registry';
  const database = new DatabaseSync(path.join(dataDirectory, 'wisteria.sqlite3'), {
    enableForeignKeyConstraints: true,
    allowExtension: false,
  });
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS pack_versions (
        id TEXT PRIMARY KEY,
        public_label TEXT NOT NULL,
        payload_path TEXT NOT NULL UNIQUE,
        source_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('validated', 'frozen', 'retired')),
        created_at INTEGER NOT NULL,
        frozen_at INTEGER
      ) STRICT;
    `);
    const now = Date.now();
    database.exec('BEGIN IMMEDIATE');
    database.prepare(`
      INSERT INTO pack_versions
        (id, public_label, payload_path, source_hash, state, created_at, frozen_at)
      VALUES (?, ?, ?, ?, 'frozen', ?, ?)
    `).run(
      versionId,
      label,
      path.relative(dataDirectory, destination).split(path.sep).join('/'),
      canonicalPayloadHash,
      now,
      now,
    );
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    throw error;
  } finally {
    database.close();
  }
  ownedVersionDirectory = null;
  process.stdout.write('{"code":"PACK_INSTALLED","status":"private"}\n');
} catch {
  if (ownedVersionDirectory) {
    try { rmSync(ownedVersionDirectory, { recursive: true, force: false }); } catch { /* best effort */ }
  }
  fail(phase);
}
