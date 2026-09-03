import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import {
  parseRuntimePolicyJson,
  RUNTIME_POLICY_SCHEMA,
} from '../lib/investigation/runtime-policy.ts';
import {
  createRenderManifest,
  MAX_RENDER_OBJECT_BYTES,
  MAX_RENDER_OBJECT_DIMENSION,
  RENDER_MANIFEST_SCHEMA,
  stringifyRenderManifest,
} from '../lib/render-manifest.ts';

const VERSION_ID = /^ver_[0-9a-f]{8,64}$/;
const SOURCE_ID = /^src_[0-9a-f]{8,64}$/;
const PAGE_ID = /^page_[0-9a-f]{8,64}$/;
const PAYLOAD_HASH = /^sha256:[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const MARKER_SCHEMA = 'blind-player-run-root/1.0';
const REPORT_SCHEMA = 'blind-validation-safe/1.0';
const CANONICAL_RECEIPT_SCHEMA = 'blind-canonical-bundle-validation/1.0';
const ATTESTATION_SCHEMA = 'wisteria-runtime-policy-validation/4.0';
const CANONICAL_VERIFIER_ACK = Buffer.from(
  '{"code":"CANONICAL_BUNDLE_VERIFIED","status":"private"}\n',
  'utf8',
);

function fail(phase) {
  const safePhase = [
    'arguments',
    'run-inputs',
    'canonical-validator',
    'runtime-policy',
    'render-manifest',
    'bundle-copy',
    'policy-copy',
    'render-manifest-copy',
    'source-verification',
    'render-object-copy',
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
    if (
      ![
        '--run-root',
        '--data-dir',
        '--label',
        '--canonical-validator-python',
        '--canonical-validator-script',
      ].includes(key)
      || typeof value !== 'string'
      || !value
    ) {
      throw new Error('ARGUMENT_ERROR');
    }
    if (values.has(key)) throw new Error('ARGUMENT_ERROR');
    values.set(key, value);
  }
  if (values.size !== 5) throw new Error('ARGUMENT_ERROR');
  return {
    runRoot: values.get('--run-root'),
    dataDirectory: values.get('--data-dir'),
    label: values.get('--label'),
    validatorPython: values.get('--canonical-validator-python'),
    validatorScript: values.get('--canonical-validator-script'),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('NON_JSON_VALUE');
  return serialized;
}

function decodeJson(bytes, requireCanonical) {
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('UTF8_REJECTED');
  }
  const value = JSON.parse(raw);
  if (requireCanonical && raw !== `${canonicalJson(value)}\n`) {
    throw new Error('NON_CANONICAL_JSON');
  }
  return { raw, value };
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OBJECT_REJECTED');
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error('KEY_SET_REJECTED');
  }
}

function regularFile(filePath, maximumBytes) {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximumBytes) {
    throw new Error('UNSAFE_FILE');
  }
}

function fixedDirectory(root, name) {
  const candidate = path.join(root, name);
  const metadata = lstatSync(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('UNSAFE_DIRECTORY');
  const resolved = realpathSync(candidate);
  if (path.dirname(resolved) !== root || path.basename(resolved) !== name) {
    throw new Error('UNSAFE_DIRECTORY');
  }
  return resolved;
}

function fixedRegularFile(root, relativePath, maximumBytes) {
  let cursor = root;
  for (const part of relativePath.split('/')) {
    cursor = path.join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('UNSAFE_FILE');
  }
  const resolved = realpathSync(cursor);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('UNSAFE_FILE');
  }
  regularFile(resolved, maximumBytes);
  return resolved;
}

function trustedExternalFile(candidate, excludedRoots, maximumBytes) {
  if (!path.isAbsolute(candidate)) throw new Error('VALIDATOR_PATH_REJECTED');
  const unresolved = path.resolve(candidate);
  const unresolvedMetadata = lstatSync(unresolved);
  if (!unresolvedMetadata.isFile() || unresolvedMetadata.isSymbolicLink()) {
    throw new Error('VALIDATOR_PATH_REJECTED');
  }
  const resolved = realpathSync(unresolved);
  const samePath = process.platform === 'win32'
    ? resolved.toLowerCase() === unresolved.toLowerCase()
    : resolved === unresolved;
  if (!samePath) throw new Error('VALIDATOR_PATH_REJECTED');
  const metadata = lstatSync(resolved);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size < 2
    || metadata.size > maximumBytes
  ) throw new Error('VALIDATOR_PATH_REJECTED');
  const comparableResolved = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  for (const root of excludedRoots) {
    const comparableRoot = process.platform === 'win32' ? root.toLowerCase() : root;
    if (
      comparableResolved === comparableRoot
      || comparableResolved.startsWith(`${comparableRoot}${path.sep}`)
    ) throw new Error('VALIDATOR_PATH_REJECTED');
  }
  return resolved;
}

function runCanonicalVerifier(validatorPython, validatorScript, runRoot) {
  const scriptBytes = readFileSync(validatorScript);
  const result = spawnSync(
    validatorPython,
    [validatorScript, '--verify-existing', '--run-root', runRoot],
    {
      encoding: null,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  if (
    result.error
    || result.signal !== null
    || result.status !== 0
    || !Buffer.isBuffer(result.stdout)
    || !result.stdout.equals(CANONICAL_VERIFIER_ACK)
    || !Buffer.isBuffer(result.stderr)
    || result.stderr.length !== 0
    || !readFileSync(validatorScript).equals(scriptBytes)
  ) throw new Error('CANONICAL_VERIFIER_REJECTED');
  return sha256Bytes(scriptBytes);
}

function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function parseMarker(bytes) {
  const { value } = decodeJson(bytes, true);
  exactKeys(value, ['nonce', 'schema']);
  if (value.schema !== MARKER_SCHEMA || typeof value.nonce !== 'string' || !NONCE.test(value.nonce)) {
    throw new Error('MARKER_REJECTED');
  }
  return value.nonce;
}

function parseValidationReport(bytes, nonce) {
  const { value: report } = decodeJson(bytes, true);
  exactKeys(report, [
    'report_schema',
    'run_id',
    'status',
    'counts',
    'quality',
    'issues',
    'freeze_ready',
    'published',
  ]);
  exactKeys(report.counts, [
    'sources',
    'pages',
    'assets',
    'content_blocks',
    'role_slots',
    'stages',
    'locations',
    'clues',
    'quarantined',
  ]);
  exactKeys(report.quality, [
    'ocr_needs_review',
    'pairing_needs_review',
    'blocking_issues',
    'warnings',
  ]);
  if (
    report.report_schema !== REPORT_SCHEMA
    || report.run_id !== `run_${nonce}`
    || report.status !== 'validated'
    || report.freeze_ready !== true
    || report.published !== false
    || report.quality.blocking_issues !== 0
    || !Array.isArray(report.issues)
    || report.issues.length !== 0
    || Object.values(report.counts).some((count) => !Number.isSafeInteger(count) || count < 0)
    || Object.values(report.quality).some((count) => !Number.isSafeInteger(count) || count < 0)
  ) throw new Error('REPORT_REJECTED');
  return report;
}

function parseAttestation(bytes, expected) {
  const { value: attestation } = decodeJson(bytes, true);
  exactKeys(attestation, [
    'bundlePayloadHash',
    'canonicalBundleValidation',
    'canonicalValidationReceiptHash',
    'canonicalValidatorScriptHash',
    'canonicalPayloadHash',
    'policyPayloadHash',
    'policySchema',
    'runId',
    'runtimePolicyHash',
    'schemaVersion',
    'scope',
    'status',
    'validationReportHash',
    'versionId',
  ]);
  if (
    attestation.schemaVersion !== ATTESTATION_SCHEMA
    || attestation.status !== 'validated'
    || attestation.scope !== 'runtime_policy_bound_to_validated_bundle'
    || attestation.canonicalBundleValidation !== 'validated_receipt_bound'
    || Object.entries(expected).some(([key, value]) => attestation[key] !== value)
  ) throw new Error('ATTESTATION_REJECTED');
}

function parseCanonicalValidationReceipt(bytes, expected) {
  const { value: receipt } = decodeJson(bytes, true);
  exactKeys(receipt, [
    'schemaVersion',
    'status',
    'scope',
    'runId',
    'versionId',
    'canonicalPayloadHash',
    'bundlePayloadHash',
    'validationReportHash',
  ]);
  if (
    receipt.schemaVersion !== CANONICAL_RECEIPT_SCHEMA
    || receipt.status !== 'validated'
    || receipt.scope !== 'canonical_bundle_exact_bytes'
    || Object.entries(expected).some(([key, value]) => receipt[key] !== value)
  ) throw new Error('CANONICAL_RECEIPT_REJECTED');
}

function assertReportCounts(report, bundle) {
  const expected = {
    sources: Object.keys(bundle.sources).length,
    pages: Object.values(bundle.sources).reduce((sum, source) => sum + source.pages.length, 0),
    assets: Object.keys(bundle.assets ?? {}).length,
    content_blocks: Object.keys(bundle.contentBlocks ?? {}).length,
    role_slots: Object.keys(bundle.roles ?? {}).length,
    stages: Object.keys(bundle.stages ?? {}).length,
    locations: Object.keys(bundle.locations ?? {}).length,
    clues: Object.keys(bundle.clues ?? {}).length,
  };
  if (Object.entries(expected).some(([key, count]) => report.counts[key] !== count)) {
    throw new Error('REPORT_BINDING_REJECTED');
  }
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

function normalizedDigest(value) {
  if (typeof value !== 'string') return null;
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}

function requiredRenderPairs(bundle) {
  const pairs = new Map();
  for (const block of Object.values(bundle.contentBlocks)) {
    if (!block || block.kind !== 'image') continue;
    if (!block.trace || !Array.isArray(block.trace.evidence) || block.trace.evidence.length === 0) {
      throw new Error('RENDER_SET_REJECTED');
    }
    for (const evidence of block.trace.evidence) {
      const sourceId = evidence?.sourceId;
      const pageId = evidence?.pageId;
      if (!SOURCE_ID.test(sourceId) || !PAGE_ID.test(pageId)) {
        throw new Error('RENDER_SET_REJECTED');
      }
      const source = bundle.sources[sourceId];
      const pages = source?.pages?.filter((page) => page?.pageId === pageId);
      if (!source || !Array.isArray(pages) || pages.length !== 1) {
        throw new Error('RENDER_SET_REJECTED');
      }
      pairs.set(`${sourceId}.${pageId}.webp`, {
        sourceId,
        pageId,
        width: pages[0].width,
        height: pages[0].height,
      });
    }
  }
  return pairs;
}

function assertExactRenderedEntries(renderedRoot, requiredNames) {
  const entries = readdirSync(renderedRoot, { withFileTypes: true });
  if (
    entries.length !== requiredNames.size
    || entries.some((entry) => (
      !requiredNames.has(entry.name)
      || !entry.isFile()
      || entry.isSymbolicLink()
    ))
  ) throw new Error('RENDER_SET_REJECTED');
}

async function inspectWebp(bytes, expectedWidth, expectedHeight) {
  if (bytes.length < 2 || bytes.length > MAX_RENDER_OBJECT_BYTES) {
    throw new Error('RENDER_OBJECT_REJECTED');
  }
  const metadata = await sharp(bytes, {
    failOn: 'error',
    limitInputPixels: MAX_RENDER_OBJECT_DIMENSION * MAX_RENDER_OBJECT_DIMENSION,
  }).metadata();
  if (
    metadata.format !== 'webp'
    || metadata.width !== expectedWidth
    || metadata.height !== expectedHeight
    || (metadata.pages !== undefined && metadata.pages !== 1)
  ) throw new Error('RENDER_OBJECT_REJECTED');
}

const INSTALL_RECOVERY_SCHEMA = 'wisteria-pack-install-recovery/1.0';
const INSTALL_RECOVERY_SUFFIX = '.recovery.json';

function initializeRegistry(database) {
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

    CREATE TABLE IF NOT EXISTS pack_runtime_profiles (
      version_id TEXT PRIMARY KEY REFERENCES pack_versions(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('canonical', 'sidecar', 'legacy_embedded')),
      canonical_payload_hash TEXT NOT NULL,
      bundle_payload_hash TEXT,
      policy_schema TEXT,
      policy_path TEXT UNIQUE,
      policy_payload_hash TEXT,
      runtime_policy_hash TEXT,
      created_at INTEGER NOT NULL,
      CHECK (
        (
          mode = 'sidecar'
          AND bundle_payload_hash IS NOT NULL
          AND policy_schema = 'wisteria-runtime-policy/1.0'
          AND policy_path IS NOT NULL
          AND policy_payload_hash IS NOT NULL
          AND runtime_policy_hash IS NOT NULL
        )
        OR
        (
          mode = 'canonical'
          AND bundle_payload_hash IS NOT NULL
          AND policy_schema IS NULL
          AND policy_path IS NULL
          AND policy_payload_hash IS NULL
          AND runtime_policy_hash IS NULL
        )
        OR
        (
          mode = 'legacy_embedded'
          AND policy_schema IS NULL
          AND policy_path IS NULL
          AND policy_payload_hash IS NULL
          AND runtime_policy_hash IS NULL
        )
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS pack_render_profiles (
      version_id TEXT PRIMARY KEY REFERENCES pack_versions(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('manifest', 'legacy_embedded')),
      canonical_payload_hash TEXT NOT NULL,
      bundle_payload_hash TEXT,
      manifest_schema TEXT,
      manifest_path TEXT UNIQUE,
      manifest_payload_hash TEXT,
      render_manifest_hash TEXT,
      created_at INTEGER NOT NULL,
      CHECK (
        (
          mode = 'manifest'
          AND bundle_payload_hash IS NOT NULL
          AND manifest_schema = 'wisteria-render-manifest/1.0'
          AND manifest_path IS NOT NULL
          AND manifest_payload_hash IS NOT NULL
          AND render_manifest_hash IS NOT NULL
        )
        OR
        (
          mode = 'legacy_embedded'
          AND manifest_schema IS NULL
          AND manifest_path IS NULL
          AND manifest_payload_hash IS NULL
          AND render_manifest_hash IS NULL
        )
      )
    ) STRICT;
  `);
  const runtimeProfileColumns = database.prepare(
    'PRAGMA table_info(pack_runtime_profiles)',
  ).all();
  if (!runtimeProfileColumns.some((column) => column.name === 'bundle_payload_hash')) {
    database.exec('ALTER TABLE pack_runtime_profiles ADD COLUMN bundle_payload_hash TEXT');
  }
}

function recoveryMarker(versionId, stageName, hashes) {
  return `${canonicalJson({
    bundlePayloadHash: hashes.bundlePayloadHash,
    manifestPayloadHash: hashes.manifestPayloadHash,
    policyPayloadHash: hashes.policyPayloadHash,
    schemaVersion: INSTALL_RECOVERY_SCHEMA,
    stageName,
    versionId,
  })}\n`;
}

function validatedRecoveryJournal(packsDirectory, journalName, versionId) {
  const journalPattern = new RegExp(
    `^(\\.install-${versionId}-[0-9a-f]{32})\\.recovery\\.json$`,
  );
  const match = journalName.match(journalPattern);
  if (!match) throw new Error('RECOVERY_JOURNAL_REJECTED');
  const journalPath = fixedRegularFile(packsDirectory, journalName, 4096);
  const { value: marker } = decodeJson(readFileSync(journalPath), true);
  exactKeys(marker, [
    'bundlePayloadHash',
    'manifestPayloadHash',
    'policyPayloadHash',
    'schemaVersion',
    'stageName',
    'versionId',
  ]);
  if (
    marker.schemaVersion !== INSTALL_RECOVERY_SCHEMA
    || marker.versionId !== versionId
    || marker.stageName !== match[1]
    || !PAYLOAD_HASH.test(marker.bundlePayloadHash)
    || !PAYLOAD_HASH.test(marker.manifestPayloadHash)
    || !PAYLOAD_HASH.test(marker.policyPayloadHash)
  ) throw new Error('RECOVERY_MARKER_REJECTED');
  return { journalPath, marker };
}

function pathEntryExists(candidate) {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function validateRecoveryPayload(directory, marker) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const expectedFiles = new Set([
    'bundle.internal.json',
    'render-manifest.internal.json',
    'runtime-policy.internal.json',
  ]);
  if (
    entries.length !== expectedFiles.size + 1
    || entries.some((entry) => (
      entry.name === 'objects'
        ? !entry.isDirectory() || entry.isSymbolicLink()
        : !expectedFiles.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()
    ))
  ) throw new Error('RECOVERY_PAYLOAD_REJECTED');
  const objectsDirectory = fixedDirectory(directory, 'objects');
  if (readdirSync(objectsDirectory, { withFileTypes: true }).some(
    (entry) => !entry.isFile() || entry.isSymbolicLink(),
  )) throw new Error('RECOVERY_PAYLOAD_REJECTED');
  if (
    sha256Bytes(readFileSync(fixedRegularFile(
      directory,
      'bundle.internal.json',
      128 * 1024 * 1024,
    ))) !== marker.bundlePayloadHash
    || sha256Bytes(readFileSync(fixedRegularFile(
      directory,
      'runtime-policy.internal.json',
      1024 * 1024,
    ))) !== marker.policyPayloadHash
    || sha256Bytes(readFileSync(fixedRegularFile(
      directory,
      'render-manifest.internal.json',
      1024 * 1024,
    ))) !== marker.manifestPayloadHash
  ) throw new Error('RECOVERY_PAYLOAD_REJECTED');
}

function reconcileTargetOrphans(database, packsDirectory, versionId) {
  const registered = database.prepare(
    'SELECT 1 FROM pack_versions WHERE id = ?',
  ).get(versionId);
  if (registered) throw new Error('VERSION_ALREADY_REGISTERED');

  const journalPattern = new RegExp(
    `^\\.install-${versionId}-[0-9a-f]{32}\\.recovery\\.json$`,
  );
  const recoveries = [];
  for (const entry of readdirSync(packsDirectory, { withFileTypes: true })) {
    if (!journalPattern.test(entry.name)) continue;
    try {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      recoveries.push(validatedRecoveryJournal(packsDirectory, entry.name, versionId));
    } catch {
      // Invalid reserved entries are never deleted automatically.
    }
  }

  const finalRecoveries = [];
  for (const recovery of recoveries) {
    const stagePath = path.join(packsDirectory, recovery.marker.stageName);
    if (!pathEntryExists(stagePath)) {
      finalRecoveries.push(recovery);
      continue;
    }
    const stageDirectory = fixedDirectory(packsDirectory, recovery.marker.stageName);
    rmSync(stageDirectory, { recursive: true, force: false });
    unlinkSync(recovery.journalPath);
  }

  const finalPath = path.join(packsDirectory, versionId);
  if (pathEntryExists(finalPath)) {
    const finalDirectory = fixedDirectory(packsDirectory, versionId);
    const matchingRecoveries = finalRecoveries.filter((recovery) => {
      try {
        validateRecoveryPayload(finalDirectory, recovery.marker);
        return true;
      } catch {
        return false;
      }
    });
    if (matchingRecoveries.length !== 1) throw new Error('FINAL_RECOVERY_REJECTED');
    rmSync(finalDirectory, { recursive: true, force: false });
    unlinkSync(matchingRecoveries[0].journalPath);
    finalRecoveries.splice(finalRecoveries.indexOf(matchingRecoveries[0]), 1);
  }

  for (const recovery of finalRecoveries) {
    unlinkSync(recovery.journalPath);
  }
}

function testCrash(point) {
  if (
    process.env.NODE_ENV === 'test'
    && process.env.WISTERIA_TEST_INSTALL_CRASH_POINT === point
  ) process.exit(86);
}

let ownedInstallDirectory = null;
let ownedRecoveryJournal = null;
let database = null;
let transactionStarted = false;
let phase = 'arguments';
try {
  const args = argumentsFrom(process.argv.slice(2));
  const label = args.label.normalize('NFKC').trim();
  if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new Error('LABEL_REJECTED');
  }

  phase = 'run-inputs';
  const unresolvedRunRoot = path.resolve(args.runRoot);
  const unresolvedRunMetadata = lstatSync(unresolvedRunRoot);
  if (!unresolvedRunMetadata.isDirectory() || unresolvedRunMetadata.isSymbolicLink()) {
    throw new Error('RUN_ROOT_REJECTED');
  }
  const runRoot = realpathSync(unresolvedRunRoot);
  const sameRunRoot = process.platform === 'win32'
    ? runRoot.toLowerCase() === unresolvedRunRoot.toLowerCase()
    : runRoot === unresolvedRunRoot;
  if (!sameRunRoot) throw new Error('RUN_ROOT_REJECTED');
  const vaultDirectory = fixedDirectory(runRoot, 'vault');
  fixedDirectory(runRoot, 'safe');
  fixedDirectory(runRoot, 'private');

  const unresolvedDataDirectory = path.resolve(args.dataDirectory);
  const unresolvedDataMetadata = lstatSync(unresolvedDataDirectory);
  if (!unresolvedDataMetadata.isDirectory() || unresolvedDataMetadata.isSymbolicLink()) {
    throw new Error('DATA_ROOT_REJECTED');
  }
  const dataDirectory = realpathSync(unresolvedDataDirectory);
  const sameDataDirectory = process.platform === 'win32'
    ? dataDirectory.toLowerCase() === unresolvedDataDirectory.toLowerCase()
    : dataDirectory === unresolvedDataDirectory;
  if (!sameDataDirectory) throw new Error('DATA_ROOT_REJECTED');
  const dataMetadata = lstatSync(dataDirectory);
  if (
    typeof process.getuid === 'function'
    && typeof process.getgid === 'function'
    && (process.getuid() !== dataMetadata.uid || process.getgid() !== dataMetadata.gid)
  ) throw new Error('DATA_OWNER_MISMATCH');
  const comparableRunRoot = process.platform === 'win32' ? runRoot.toLowerCase() : runRoot;
  const comparableDataDirectory = process.platform === 'win32'
    ? dataDirectory.toLowerCase()
    : dataDirectory;
  if (
    comparableRunRoot === comparableDataDirectory
    || comparableRunRoot.startsWith(`${comparableDataDirectory}${path.sep}`)
    || comparableDataDirectory.startsWith(`${comparableRunRoot}${path.sep}`)
  ) {
    throw new Error('ROOT_OVERLAP');
  }

  phase = 'canonical-validator';
  const markerPath = fixedRegularFile(runRoot, '.blind-player-run-root', 1024);
  const reportPath = fixedRegularFile(runRoot, 'safe/validation.json', 1024 * 1024);
  const bundlePath = fixedRegularFile(runRoot, 'vault/bundle.json', 128 * 1024 * 1024);
  const canonicalReceiptPath = fixedRegularFile(
    runRoot,
    'private/canonical-bundle-validation.json',
    4096,
  );
  const markerBytes = readFileSync(markerPath);
  const reportBytes = readFileSync(reportPath);
  const bundleBytes = readFileSync(bundlePath);
  const canonicalReceiptBytes = readFileSync(canonicalReceiptPath);
  const validatorPython = trustedExternalFile(
    args.validatorPython,
    [runRoot, dataDirectory],
    256 * 1024 * 1024,
  );
  const validatorScript = trustedExternalFile(
    args.validatorScript,
    [runRoot, dataDirectory],
    16 * 1024 * 1024,
  );
  const canonicalValidatorScriptHash = runCanonicalVerifier(
    validatorPython,
    validatorScript,
    runRoot,
  );
  if (
    !readFileSync(markerPath).equals(markerBytes)
    || !readFileSync(reportPath).equals(reportBytes)
    || !readFileSync(bundlePath).equals(bundleBytes)
    || !readFileSync(canonicalReceiptPath).equals(canonicalReceiptBytes)
  ) throw new Error('CANONICAL_INPUT_REPLACED');

  const policyPath = fixedRegularFile(runRoot, 'vault/runtime-policy.json', 1024 * 1024);
  const attestationPath = fixedRegularFile(
    runRoot,
    'private/runtime-policy-validation.json',
    1024 * 1024,
  );
  const inventoryPath = fixedRegularFile(
    runRoot,
    'private/source-inventory.json',
    32 * 1024 * 1024,
  );
  const policyBytes = readFileSync(policyPath);
  const attestationBytes = readFileSync(attestationPath);
  const nonce = parseMarker(markerBytes);
  const report = parseValidationReport(reportBytes, nonce);
  const { value: bundle } = decodeJson(bundleBytes, false);
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const versionId = bundle?.script?.versionId;
  const canonicalPayloadHash = bundle?.script?.canonicalPayloadHash;
  if (
    bundle?.schemaVersion !== 'blind-script/1.0'
    || !VERSION_ID.test(versionId)
    || !PAYLOAD_HASH.test(canonicalPayloadHash)
    || !bundle.sources
    || typeof bundle.sources !== 'object'
    || !bundle.assets
    || typeof bundle.assets !== 'object'
    || !bundle.contentBlocks
    || typeof bundle.contentBlocks !== 'object'
    || !bundle.roles
    || typeof bundle.roles !== 'object'
    || !bundle.stages
    || typeof bundle.stages !== 'object'
    || !bundle.locations
    || typeof bundle.locations !== 'object'
    || !bundle.clues
    || typeof bundle.clues !== 'object'
    || Object.values(bundle.assets).some((asset) => (
      !asset
      || typeof asset !== 'object'
      || Object.prototype.hasOwnProperty.call(asset, 'pageObjects')
    ))
    || Object.values(bundle.stages).some(
      (stage) => Object.prototype.hasOwnProperty.call(stage, 'investigationFlow'),
    )
    || !Array.isArray(inventory.sources)
  ) throw new Error('BUNDLE_REJECTED');
  assertReportCounts(report, bundle);

  phase = 'runtime-policy';
  let policyRaw;
  try {
    policyRaw = new TextDecoder('utf-8', { fatal: true }).decode(policyBytes);
  } catch {
    throw new Error('UTF8_REJECTED');
  }
  const policy = parseRuntimePolicyJson(policyRaw, bundle);
  const bundlePayloadHash = sha256Bytes(bundleBytes);
  const policyPayloadHash = sha256Bytes(policyBytes);
  const validationReportHash = sha256Bytes(reportBytes);
  parseCanonicalValidationReceipt(canonicalReceiptBytes, {
    runId: report.run_id,
    versionId,
    canonicalPayloadHash,
    bundlePayloadHash,
    validationReportHash,
  });
  parseAttestation(attestationBytes, {
    bundlePayloadHash,
    canonicalPayloadHash,
    canonicalValidationReceiptHash: sha256Bytes(canonicalReceiptBytes),
    canonicalValidatorScriptHash,
    policyPayloadHash,
    policySchema: RUNTIME_POLICY_SCHEMA,
    runId: report.run_id,
    runtimePolicyHash: policy.runtimePolicyHash,
    validationReportHash,
    versionId,
  });

  phase = 'render-manifest';
  const renderedRoot = fixedDirectory(vaultDirectory, 'rendered');
  const requiredPairs = requiredRenderPairs(bundle);
  const requiredNames = new Set(requiredPairs.keys());
  assertExactRenderedEntries(renderedRoot, requiredNames);
  const renderInputs = [];
  for (const [name, requirement] of [...requiredPairs.entries()].sort()) {
    const sourcePath = fixedRegularFile(renderedRoot, name, MAX_RENDER_OBJECT_BYTES);
    const bytes = readFileSync(sourcePath);
    await inspectWebp(bytes, requirement.width, requirement.height);
    renderInputs.push({
      sourcePath,
      object: {
        sourceId: requirement.sourceId,
        pageId: requirement.pageId,
        mediaType: 'image/webp',
        sha256: sha256Bytes(bytes),
        byteLength: bytes.length,
        width: requirement.width,
        height: requirement.height,
      },
    });
  }
  const renderManifest = createRenderManifest(
    bundle,
    bundleBytes,
    renderInputs.map((input) => input.object),
  );
  const renderManifestRaw = stringifyRenderManifest(renderManifest);
  const renderManifestBytes = Buffer.from(renderManifestRaw, 'utf8');
  const renderManifestPayloadHash = sha256Bytes(renderManifestBytes);

  phase = 'bundle-copy';
  mkdirSync(path.join(dataDirectory, 'packs'), { recursive: true, mode: 0o700 });
  const packsDirectory = fixedDirectory(dataDirectory, 'packs');
  database = new DatabaseSync(path.join(dataDirectory, 'wisteria.sqlite3'), {
    enableForeignKeyConstraints: true,
    allowExtension: false,
  });
  initializeRegistry(database);
  database.exec('BEGIN IMMEDIATE');
  transactionStarted = true;
  reconcileTargetOrphans(database, packsDirectory, versionId);
  const stageName = `.install-${versionId}-${randomBytes(16).toString('hex')}`;
  const recoveryJournalPath = path.join(
    packsDirectory,
    `${stageName}${INSTALL_RECOVERY_SUFFIX}`,
  );
  writeFileSync(
    recoveryJournalPath,
    recoveryMarker(versionId, stageName, {
      bundlePayloadHash,
      manifestPayloadHash: renderManifestPayloadHash,
      policyPayloadHash,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  ownedRecoveryJournal = recoveryJournalPath;
  fixedRegularFile(
    packsDirectory,
    `${stageName}${INSTALL_RECOVERY_SUFFIX}`,
    4096,
  );
  mkdirSync(path.join(packsDirectory, stageName), { recursive: false, mode: 0o700 });
  const versionDirectory = fixedDirectory(packsDirectory, stageName);
  ownedInstallDirectory = versionDirectory;
  const finalVersionDirectory = path.join(packsDirectory, versionId);
  const bundleDestination = path.join(versionDirectory, 'bundle.internal.json');
  copyFileSync(bundlePath, bundleDestination, constants.COPYFILE_EXCL);
  chmodSync(bundleDestination, 0o600);
  if (sha256Bytes(readFileSync(bundleDestination)) !== bundlePayloadHash) {
    throw new Error('COPY_MISMATCH');
  }

  phase = 'policy-copy';
  const policyDestination = path.join(versionDirectory, 'runtime-policy.internal.json');
  copyFileSync(policyPath, policyDestination, constants.COPYFILE_EXCL);
  chmodSync(policyDestination, 0o600);
  if (sha256Bytes(readFileSync(policyDestination)) !== policyPayloadHash) {
    throw new Error('COPY_MISMATCH');
  }

  phase = 'render-manifest-copy';
  const renderManifestDestination = path.join(
    versionDirectory,
    'render-manifest.internal.json',
  );
  writeFileSync(renderManifestDestination, renderManifestBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  if (sha256Bytes(readFileSync(renderManifestDestination)) !== renderManifestPayloadHash) {
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
    if (sha256File(sourcePath) !== normalizedDigest(source.sha256)) {
      throw new Error('SOURCE_REJECTED');
    }
  }

  phase = 'render-object-copy';
  const objectDestinations = [];
  for (const input of renderInputs) {
    const objectPath = path.join(
      objectsDirectory,
      `${input.object.sourceId}.${input.object.pageId}.webp`,
    );
    copyFileSync(input.sourcePath, objectPath, constants.COPYFILE_EXCL);
    chmodSync(objectPath, 0o600);
    const copiedBytes = readFileSync(objectPath);
    if (
      copiedBytes.length !== input.object.byteLength
      || sha256Bytes(copiedBytes) !== input.object.sha256
    ) throw new Error('COPY_MISMATCH');
    await inspectWebp(copiedBytes, input.object.width, input.object.height);
    objectDestinations.push({ ...input, objectPath });
  }

  phase = 'registry';
  if (
    !readFileSync(markerPath).equals(markerBytes)
    || !readFileSync(reportPath).equals(reportBytes)
    || !readFileSync(bundlePath).equals(bundleBytes)
    || !readFileSync(policyPath).equals(policyBytes)
    || !readFileSync(attestationPath).equals(attestationBytes)
    || !readFileSync(canonicalReceiptPath).equals(canonicalReceiptBytes)
    || sha256Bytes(readFileSync(bundleDestination)) !== bundlePayloadHash
    || sha256Bytes(readFileSync(policyDestination)) !== policyPayloadHash
    || sha256Bytes(readFileSync(renderManifestDestination)) !== renderManifestPayloadHash
    || objectDestinations.some((input) => (
      sha256Bytes(readFileSync(input.sourcePath)) !== input.object.sha256
      || sha256Bytes(readFileSync(input.objectPath)) !== input.object.sha256
    ))
  ) throw new Error('INPUT_REPLACED');
  assertExactRenderedEntries(renderedRoot, requiredNames);
  validatedRecoveryJournal(
    packsDirectory,
    `${stageName}${INSTALL_RECOVERY_SUFFIX}`,
    versionId,
  );
  validateRecoveryPayload(versionDirectory, {
    bundlePayloadHash,
    manifestPayloadHash: renderManifestPayloadHash,
    policyPayloadHash,
  });
  testCrash('after-staging-ready');
  if (
    database.prepare('SELECT 1 FROM pack_versions WHERE id = ?').get(versionId)
    || pathEntryExists(finalVersionDirectory)
  ) throw new Error('VERSION_FINALIZATION_REJECTED');
  renameSync(versionDirectory, finalVersionDirectory);
  ownedInstallDirectory = finalVersionDirectory;
  testCrash('after-final-rename');
  const now = Date.now();
  database.prepare(`
    INSERT INTO pack_versions
      (id, public_label, payload_path, source_hash, state, created_at, frozen_at)
    VALUES (?, ?, ?, ?, 'frozen', ?, ?)
  `).run(
    versionId,
    label,
    `packs/${versionId}/bundle.internal.json`,
    canonicalPayloadHash,
    now,
    now,
  );
  database.prepare(`
    INSERT INTO pack_runtime_profiles
      (
        version_id, mode, canonical_payload_hash, bundle_payload_hash,
        policy_schema, policy_path, policy_payload_hash, runtime_policy_hash, created_at
      )
    VALUES (?, 'sidecar', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    versionId,
    canonicalPayloadHash,
    bundlePayloadHash,
    RUNTIME_POLICY_SCHEMA,
    `packs/${versionId}/runtime-policy.internal.json`,
    policyPayloadHash,
    policy.runtimePolicyHash,
    now,
  );
  database.prepare(`
    INSERT INTO pack_render_profiles
      (
        version_id, mode, canonical_payload_hash, bundle_payload_hash,
        manifest_schema, manifest_path, manifest_payload_hash,
        render_manifest_hash, created_at
      )
    VALUES (?, 'manifest', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    versionId,
    canonicalPayloadHash,
    bundlePayloadHash,
    RENDER_MANIFEST_SCHEMA,
    `packs/${versionId}/render-manifest.internal.json`,
    renderManifestPayloadHash,
    renderManifest.renderManifestHash,
    now,
  );
  database.exec('COMMIT');
  transactionStarted = false;
  ownedInstallDirectory = null;
  const committedRecoveryJournal = ownedRecoveryJournal;
  ownedRecoveryJournal = null;
  try {
    unlinkSync(committedRecoveryJournal);
  } catch {
    // The journal lives beside the committed pack and is not runtime-visible.
  }
  database.close();
  database = null;
  process.stdout.write('{"code":"PACK_INSTALLED","status":"private"}\n');
} catch {
  if (transactionStarted && database) {
    try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    transactionStarted = false;
  }
  if (ownedInstallDirectory) {
    try { rmSync(ownedInstallDirectory, { recursive: true, force: false }); } catch { /* best effort */ }
    ownedInstallDirectory = null;
  }
  if (ownedRecoveryJournal) {
    try { unlinkSync(ownedRecoveryJournal); } catch { /* best effort */ }
    ownedRecoveryJournal = null;
  }
  try { database?.close(); } catch { /* best effort */ }
  database = null;
  fail(phase);
}
