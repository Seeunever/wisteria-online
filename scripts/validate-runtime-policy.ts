import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { BlindBundle } from '../lib/blind-runtime';
import {
  parseRuntimePolicyJson,
  RUNTIME_POLICY_SCHEMA,
} from '../lib/investigation/runtime-policy.ts';

const VERSION_ID = /^ver_[0-9a-f]{8,64}$/;
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

function fail(phase: string) {
  const safePhase = [
    'arguments',
    'run-root',
    'validation-report',
    'canonical-validator',
    'bundle',
    'policy',
    'attestation',
  ].includes(phase) ? phase : 'unknown';
  process.stderr.write(`${JSON.stringify({
    code: 'RUNTIME_POLICY_VALIDATION_REJECTED',
    status: 'blocked',
    phase: safePhase,
  })}\n`);
  process.exitCode = 2;
}

function argumentsFrom(tokens: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (
      !['--run-root', '--canonical-validator-python', '--canonical-validator-script'].includes(key)
      || typeof value !== 'string'
      || !value
      || values.has(key)
    ) {
      throw new Error('ARGUMENT_ERROR');
    }
    values.set(key, value);
  }
  if (values.size !== 3) throw new Error('ARGUMENT_ERROR');
  return {
    runRoot: values.get('--run-root')!,
    validatorPython: values.get('--canonical-validator-python')!,
    validatorScript: values.get('--canonical-validator-script')!,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('NON_JSON_VALUE');
  return serialized;
}

function decodeJson(bytes: Buffer, requireCanonical: boolean): unknown {
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('UTF8_REJECTED');
  }
  const value = JSON.parse(raw) as unknown;
  if (requireCanonical && raw !== `${canonicalJson(value)}\n`) {
    throw new Error('NON_CANONICAL_JSON');
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error('KEY_SET_REJECTED');
  }
}

function fixedDirectory(root: string, name: string) {
  const candidate = path.join(root, name);
  const metadata = lstatSync(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('DIRECTORY_REJECTED');
  }
  const resolved = realpathSync(candidate);
  if (path.dirname(resolved) !== root || path.basename(resolved) !== name) {
    throw new Error('DIRECTORY_REJECTED');
  }
  return resolved;
}

function fixedRegularFile(root: string, relativePath: string, maximumBytes: number) {
  const parts = relativePath.split('/');
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) throw new Error('SYMLINK_REJECTED');
  }
  const resolved = realpathSync(cursor);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('PATH_REJECTED');
  }
  const metadata = lstatSync(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximumBytes) {
    throw new Error('FILE_REJECTED');
  }
  return resolved;
}

function trustedExternalFile(candidate: string, excludedRoots: string[], maximumBytes: number) {
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

function runCanonicalVerifier(
  validatorPython: string,
  validatorScript: string,
  runRoot: string,
) {
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
  return sha256(scriptBytes);
}

function rejectGitWorktree(root: string) {
  let cursor = root;
  for (;;) {
    try {
      lstatSync(path.join(cursor, '.git'));
      throw new Error('GIT_WORKTREE_REJECTED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

type SafeValidationReport = {
  report_schema: string;
  run_id: string;
  status: string;
  counts: Record<string, number>;
  quality: Record<string, number>;
  issues: unknown[];
  freeze_ready: boolean;
  published: boolean;
};

type CanonicalValidationReceipt = {
  schemaVersion: typeof CANONICAL_RECEIPT_SCHEMA;
  status: 'validated';
  scope: 'canonical_bundle_exact_bytes';
  runId: string;
  versionId: string;
  canonicalPayloadHash: string;
  bundlePayloadHash: string;
  validationReportHash: string;
};

function parseMarker(bytes: Buffer) {
  const value = decodeJson(bytes, true);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MARKER_REJECTED');
  }
  const marker = value as Record<string, unknown>;
  exactKeys(marker, ['nonce', 'schema']);
  if (marker.schema !== MARKER_SCHEMA || typeof marker.nonce !== 'string' || !NONCE.test(marker.nonce)) {
    throw new Error('MARKER_REJECTED');
  }
  return marker.nonce;
}

function parseValidationReport(bytes: Buffer, nonce: string): SafeValidationReport {
  const value = decodeJson(bytes, true);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('REPORT_REJECTED');
  }
  const report = value as unknown as SafeValidationReport;
  exactKeys(report as unknown as Record<string, unknown>, [
    'report_schema',
    'run_id',
    'status',
    'counts',
    'quality',
    'issues',
    'freeze_ready',
    'published',
  ]);
  if (!report.counts || typeof report.counts !== 'object' || Array.isArray(report.counts)) {
    throw new Error('REPORT_REJECTED');
  }
  if (!report.quality || typeof report.quality !== 'object' || Array.isArray(report.quality)) {
    throw new Error('REPORT_REJECTED');
  }
  exactKeys(report.counts as unknown as Record<string, unknown>, [
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
  exactKeys(report.quality as unknown as Record<string, unknown>, [
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

function parseBundle(raw: string): BlindBundle {
  const bundle = JSON.parse(raw) as Partial<BlindBundle>;
  if (
    bundle.schemaVersion !== 'blind-script/1.0'
    || !bundle.script
    || !VERSION_ID.test(bundle.script.versionId)
    || !PAYLOAD_HASH.test(bundle.script.canonicalPayloadHash)
    || !bundle.sources
    || !bundle.assets
    || !bundle.contentBlocks
    || !bundle.roles
    || !bundle.stages
    || !bundle.locations
    || !bundle.clues
    || Object.values(bundle.stages).some(
      (stage) => Object.prototype.hasOwnProperty.call(stage, 'investigationFlow'),
    )
  ) throw new Error('BUNDLE_REJECTED');
  return bundle as BlindBundle;
}

function assertReportCounts(report: SafeValidationReport, bundle: BlindBundle) {
  const expected = {
    sources: Object.keys(bundle.sources).length,
    pages: Object.values(bundle.sources).reduce((sum, source) => sum + source.pages.length, 0),
    assets: Object.keys(bundle.assets).length,
    content_blocks: Object.keys(bundle.contentBlocks).length,
    role_slots: Object.keys(bundle.roles).length,
    stages: Object.keys(bundle.stages).length,
    locations: Object.keys(bundle.locations).length,
    clues: Object.keys(bundle.clues).length,
  } as const;
  for (const [key, count] of Object.entries(expected)) {
    if (report.counts[key] !== count) throw new Error('REPORT_BINDING_REJECTED');
  }
}

function sha256(bytes: Buffer) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function parseCanonicalValidationReceipt(
  bytes: Buffer,
  expected: Omit<CanonicalValidationReceipt, 'schemaVersion' | 'status' | 'scope'>,
) {
  const value = decodeJson(bytes, true);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CANONICAL_RECEIPT_REJECTED');
  }
  const receipt = value as Record<string, unknown>;
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
    || Object.entries(expected).some(([key, expectedValue]) => receipt[key] !== expectedValue)
  ) throw new Error('CANONICAL_RECEIPT_REJECTED');
  return receipt as unknown as CanonicalValidationReceipt;
}

let phase = 'arguments';
try {
  const args = argumentsFrom(process.argv.slice(2));
  phase = 'run-root';
  const unresolvedRoot = path.resolve(args.runRoot);
  const unresolvedMetadata = lstatSync(unresolvedRoot);
  if (!unresolvedMetadata.isDirectory() || unresolvedMetadata.isSymbolicLink()) {
    throw new Error('RUN_ROOT_REJECTED');
  }
  const runRoot = realpathSync(unresolvedRoot);
  const sameRoot = process.platform === 'win32'
    ? runRoot.toLowerCase() === unresolvedRoot.toLowerCase()
    : runRoot === unresolvedRoot;
  if (!sameRoot) throw new Error('RUN_ROOT_REJECTED');
  rejectGitWorktree(runRoot);
  fixedDirectory(runRoot, 'vault');
  fixedDirectory(runRoot, 'safe');
  const privateDirectory = fixedDirectory(runRoot, 'private');
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
    [runRoot],
    256 * 1024 * 1024,
  );
  const validatorScript = trustedExternalFile(
    args.validatorScript,
    [runRoot],
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
  const nonce = parseMarker(markerBytes);

  phase = 'validation-report';
  const report = parseValidationReport(reportBytes, nonce);

  phase = 'bundle';
  let bundleRaw: string;
  try {
    bundleRaw = new TextDecoder('utf-8', { fatal: true }).decode(bundleBytes);
  } catch {
    throw new Error('UTF8_REJECTED');
  }
  const bundle = parseBundle(bundleRaw);
  assertReportCounts(report, bundle);
  parseCanonicalValidationReceipt(canonicalReceiptBytes, {
    runId: report.run_id,
    versionId: bundle.script.versionId,
    canonicalPayloadHash: bundle.script.canonicalPayloadHash,
    bundlePayloadHash: sha256(bundleBytes),
    validationReportHash: sha256(reportBytes),
  });

  phase = 'policy';
  const policyPath = fixedRegularFile(runRoot, 'vault/runtime-policy.json', 1024 * 1024);
  const policyBytes = readFileSync(policyPath);
  let policyRaw: string;
  try {
    policyRaw = new TextDecoder('utf-8', { fatal: true }).decode(policyBytes);
  } catch {
    throw new Error('UTF8_REJECTED');
  }
  const policy = parseRuntimePolicyJson(policyRaw, bundle);

  phase = 'attestation';
  if (
    !readFileSync(markerPath).equals(markerBytes)
    || !readFileSync(reportPath).equals(reportBytes)
    || !readFileSync(bundlePath).equals(bundleBytes)
    || !readFileSync(policyPath).equals(policyBytes)
    || !readFileSync(canonicalReceiptPath).equals(canonicalReceiptBytes)
  ) throw new Error('INPUT_REPLACED');
  const attestation = {
    bundlePayloadHash: sha256(bundleBytes),
    canonicalBundleValidation: 'validated_receipt_bound',
    canonicalValidationReceiptHash: sha256(canonicalReceiptBytes),
    canonicalValidatorScriptHash,
    canonicalPayloadHash: policy.canonicalPayloadHash,
    policyPayloadHash: sha256(policyBytes),
    policySchema: RUNTIME_POLICY_SCHEMA,
    runId: report.run_id,
    runtimePolicyHash: policy.runtimePolicyHash,
    schemaVersion: ATTESTATION_SCHEMA,
    scope: 'runtime_policy_bound_to_validated_bundle',
    status: 'validated',
    validationReportHash: sha256(reportBytes),
    versionId: policy.versionId,
  } as const;
  const attestationPath = path.join(privateDirectory, 'runtime-policy-validation.json');
  const descriptor = openSync(
    attestationPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${canonicalJson(attestation)}\n`, { encoding: 'utf8' });
  } finally {
    closeSync(descriptor);
  }
  process.stdout.write('{"code":"RUNTIME_POLICY_VALIDATED","status":"private"}\n');
} catch {
  fail(phase);
}
