import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  computeRuntimePolicyHash,
  finalizeRuntimePolicy,
  parseRuntimePolicyJson,
  resolveCanonicalRuntimePolicy,
  resolveLegacyEmbeddedRuntimePolicy,
  resolveSidecarRuntimePolicy,
  RuntimePolicyError,
  serializeRuntimePolicy,
  validateRuntimePolicy,
  type RuntimePolicyDocument,
  type RuntimePolicyDraft,
} from '../lib/investigation/runtime-policy.ts';
import {
  syntheticBundle,
  syntheticPolicyDraft,
} from './runtime-policy-test-fixture.ts';
import {
  createTestTempDirectory,
  removeTestTempDirectory,
} from './test-temp-directory.ts';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeValidationReport(bundle: ReturnType<typeof syntheticBundle>, nonce: string) {
  return {
    counts: {
      assets: Object.keys(bundle.assets).length,
      clues: Object.keys(bundle.clues).length,
      content_blocks: Object.keys(bundle.contentBlocks).length,
      locations: Object.keys(bundle.locations).length,
      pages: Object.values(bundle.sources).reduce((sum, source) => sum + source.pages.length, 0),
      quarantined: 0,
      role_slots: Object.keys(bundle.roles).length,
      sources: Object.keys(bundle.sources).length,
      stages: Object.keys(bundle.stages).length,
    },
    freeze_ready: true,
    issues: [],
    published: false,
    quality: {
      blocking_issues: 0,
      ocr_needs_review: 0,
      pairing_needs_review: 0,
      warnings: 0,
    },
    report_schema: 'blind-validation-safe/1.0',
    run_id: `run_${nonce}`,
    status: 'validated',
  };
}

function sha256(value: string | Buffer) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalValidationReceipt(
  bundle: ReturnType<typeof syntheticBundle>,
  bundleRaw: string,
  reportRaw: string,
  nonce: string,
) {
  return `${canonicalJson({
    bundlePayloadHash: sha256(bundleRaw),
    canonicalPayloadHash: bundle.script.canonicalPayloadHash,
    runId: `run_${nonce}`,
    schemaVersion: 'blind-canonical-bundle-validation/1.0',
    scope: 'canonical_bundle_exact_bytes',
    status: 'validated',
    validationReportHash: sha256(reportRaw),
    versionId: bundle.script.versionId,
  })}\n`;
}

function writeSyntheticCanonicalVerifier(
  directory: string,
  mode: 'accept' | 'wrong-stdout' | 'stderr' | 'mutate-script' = 'accept',
) {
  const verifierPath = path.join(directory, `synthetic-canonical-verifier-${mode}.cjs`);
  writeFileSync(verifierPath, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const mode = ${JSON.stringify(mode)};`,
    "const args = process.argv.slice(2);",
    "if (args.length !== 3 || args[0] !== '--verify-existing' || args[1] !== '--run-root' || !path.isAbsolute(args[2])) process.exit(11);",
    "const bundle = JSON.parse(fs.readFileSync(path.join(args[2], 'vault', 'bundle.json'), 'utf8'));",
    "if (bundle?.script?.canonicalVerifierTestReject === true) process.exit(12);",
    "if (mode === 'mutate-script') fs.appendFileSync(__filename, '// changed during verification\\n');",
    "if (mode === 'wrong-stdout') process.stdout.write('{\"code\":\"WRONG\",\"status\":\"private\"}\\n');",
    "else process.stdout.write('{\"code\":\"CANONICAL_BUNDLE_VERIFIED\",\"status\":\"private\"}\\n');",
    "if (mode === 'stderr') process.stderr.write('synthetic verifier diagnostic\\n');",
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  return realpathSync(verifierPath);
}

function canonicalVerifierArgs(verifierScript: string) {
  return [
    '--canonical-validator-python',
    realpathSync(process.execPath),
    '--canonical-validator-script',
    verifierScript,
  ];
}

function assertPolicyError(code: RuntimePolicyError['code'], action: () => unknown) {
  assert.throws(action, (error) => (
    error instanceof RuntimePolicyError && error.code === code
  ));
}

function cleanup(root: string, prefix: string) {
  removeTestTempDirectory(root, prefix);
}

test('runtime policy is normalized without mutation and has a deterministic binding hash', () => {
  const bundle = syntheticBundle();
  const draft = syntheticPolicyDraft(bundle, 'canonical_search_policy');
  const before = JSON.stringify(draft);
  const policy = finalizeRuntimePolicy(draft, bundle);
  assert.equal(JSON.stringify(draft), before);
  assert.equal(policy.runtimePolicyHash, computeRuntimePolicyHash(draft));
  const raw = serializeRuntimePolicy(policy);
  assert.deepEqual(parseRuntimePolicyJson(raw, bundle), policy);
  assert.equal(serializeRuntimePolicy(parseRuntimePolicyJson(raw, bundle)), raw);
});

test('runtime policy rejects unknown kinds, versions, extra fields, and non-canonical JSON', () => {
  const bundle = syntheticBundle();
  const valid = finalizeRuntimePolicy(syntheticPolicyDraft(bundle), bundle);
  const unknownKind = clone(valid) as unknown as {
    stageMechanisms: Record<string, Record<string, unknown>>;
  };
  unknownKind.stageMechanisms.stage_aaaaaaaa.kind = 'external_url_executor';
  assertPolicyError('UNSUPPORTED_RUNTIME_POLICY_KIND', () => validateRuntimePolicy(unknownKind, bundle));

  const unknownVersion = clone(valid) as unknown as {
    stageMechanisms: Record<string, Record<string, unknown>>;
  };
  unknownVersion.stageMechanisms.stage_aaaaaaaa.version = 2;
  assertPolicyError(
    'UNSUPPORTED_RUNTIME_POLICY_VERSION',
    () => validateRuntimePolicy(unknownVersion, bundle),
  );

  const extra = clone(valid) as RuntimePolicyDocument & { command?: string };
  extra.command = 'forbidden';
  assertPolicyError('MALFORMED_RUNTIME_POLICY', () => validateRuntimePolicy(extra, bundle));
  assertPolicyError(
    'RUNTIME_POLICY_NOT_CANONICAL',
    () => parseRuntimePolicyJson(JSON.stringify(valid), bundle),
  );
  const duplicateKey = serializeRuntimePolicy(valid).replace(
    '"version":1',
    '"version":1,"version":1',
  );
  assertPolicyError(
    'RUNTIME_POLICY_NOT_CANONICAL',
    () => parseRuntimePolicyJson(duplicateKey, bundle),
  );
});

test('runtime policy rejects hash, bundle binding, stage-set, and evidence mismatches', () => {
  const bundle = syntheticBundle();
  const valid = finalizeRuntimePolicy(syntheticPolicyDraft(bundle), bundle);
  const wrongHash = clone(valid);
  wrongHash.runtimePolicyHash = `sha256:${'f'.repeat(64)}`;
  assertPolicyError('RUNTIME_POLICY_HASH_MISMATCH', () => validateRuntimePolicy(wrongHash, bundle));

  const wrongBinding = clone(valid);
  wrongBinding.versionId = 'ver_bbbbbbbb';
  assertPolicyError('RUNTIME_POLICY_BINDING_MISMATCH', () => validateRuntimePolicy(wrongBinding, bundle));

  const noStages: RuntimePolicyDraft = {
    ...syntheticPolicyDraft(bundle),
    stageMechanisms: {},
  };
  const noStagesWithHash = {
    ...noStages,
    runtimePolicyHash: computeRuntimePolicyHash(noStages),
  };
  assertPolicyError(
    'RUNTIME_POLICY_REFERENCE_MISMATCH',
    () => validateRuntimePolicy(noStagesWithHash, bundle),
  );

  const unverifiedBundle = syntheticBundle({ verifiedEvidence: false });
  const unverifiedDraft = syntheticPolicyDraft(unverifiedBundle);
  const unverified = {
    ...unverifiedDraft,
    runtimePolicyHash: computeRuntimePolicyHash(unverifiedDraft),
  };
  assertPolicyError(
    'RUNTIME_POLICY_REFERENCE_MISMATCH',
    () => validateRuntimePolicy(unverified, unverifiedBundle),
  );
});

test('legacy collective policy is rejected from sidecars without affecting canonical policy', () => {
  const bundle = syntheticBundle();
  const collectiveDraft = syntheticPolicyDraft(bundle, 'collective_vote_round_robin');
  const collectivePolicy = {
    ...collectiveDraft,
    runtimePolicyHash: computeRuntimePolicyHash(collectiveDraft),
  };
  assertPolicyError(
    'UNSUPPORTED_RUNTIME_POLICY_KIND',
    () => validateRuntimePolicy(collectivePolicy, bundle),
  );
  const hostDealt = syntheticBundle({ hostDealt: true });
  assert.doesNotThrow(() => finalizeRuntimePolicy(
    syntheticPolicyDraft(hostDealt, 'canonical_search_policy'),
    hostDealt,
  ));
});

test('canonical, sidecar, and explicitly legacy profiles resolve without silent fallback', () => {
  const canonicalBundle = syntheticBundle();
  const canonical = resolveCanonicalRuntimePolicy(canonicalBundle);
  assert.equal(canonical.profileMode, 'canonical');
  assert.equal(canonical.stageMechanisms.stage_aaaaaaaa.kind, 'canonical_search_policy');

  const sidecarDocument = finalizeRuntimePolicy(
    syntheticPolicyDraft(canonicalBundle, 'canonical_search_policy'),
    canonicalBundle,
  );
  const sidecar = resolveSidecarRuntimePolicy(canonicalBundle, sidecarDocument);
  assert.equal(sidecar.profileMode, 'sidecar');
  assert.equal(sidecar.stageMechanisms.stage_aaaaaaaa.kind, 'canonical_search_policy');

  const legacy = resolveLegacyEmbeddedRuntimePolicy(syntheticBundle({ embeddedFlow: true }));
  assert.equal(legacy.profileMode, 'legacy_embedded');
  assert.equal(legacy.stageMechanisms.stage_aaaaaaaa.kind, 'collective_vote_round_robin');
  const oldDirect = resolveLegacyEmbeddedRuntimePolicy(syntheticBundle());
  assert.equal(oldDirect.stageMechanisms.stage_aaaaaaaa.kind, 'direct_pick');
});

test('project-local validator emits only a private, scope-limited deterministic attestation', () => {
  const root = createTestTempDirectory('wisteria-policy-cli-', true);
  const verifierRoot = createTestTempDirectory('wisteria-policy-verifier-');
  try {
    const vault = path.join(root, 'vault');
    const safe = path.join(root, 'safe');
    const privateDirectory = path.join(root, 'private');
    mkdirSync(vault, { mode: 0o700 });
    mkdirSync(safe, { mode: 0o700 });
    mkdirSync(privateDirectory, { mode: 0o700 });
    const nonce = '0123456789abcdef0123456789abcdef';
    const verifierScript = writeSyntheticCanonicalVerifier(verifierRoot);
    const verifierArguments = canonicalVerifierArgs(verifierScript);
    const rejectedMissingVerifier = spawnSync(
      process.execPath,
      [path.join(process.cwd(), 'scripts', 'validate-runtime-policy.ts'), '--run-root', root],
      { encoding: 'utf8' },
    );
    assert.equal(rejectedMissingVerifier.status, 2);
    assert.equal(rejectedMissingVerifier.stdout, '');
    assert.equal(
      rejectedMissingVerifier.stderr,
      '{"code":"RUNTIME_POLICY_VALIDATION_REJECTED","status":"blocked","phase":"arguments"}\n',
    );
    writeFileSync(
      path.join(root, '.blind-player-run-root'),
      `${canonicalJson({ nonce, schema: 'blind-player-run-root/1.0' })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const bundle = syntheticBundle();
    const policy = finalizeRuntimePolicy(syntheticPolicyDraft(bundle), bundle);
    const bundlePath = path.join(vault, 'bundle.json');
    const bundleRaw = `${JSON.stringify(bundle)}\n`;
    writeFileSync(bundlePath, bundleRaw, { mode: 0o600 });
    writeFileSync(path.join(vault, 'runtime-policy.json'), serializeRuntimePolicy(policy), {
      mode: 0o600,
    });
    const report = safeValidationReport(bundle, nonce);
    const reportPath = path.join(safe, 'validation.json');
    writeFileSync(
      reportPath,
      `${canonicalJson({ ...report, run_id: `run_${'f'.repeat(32)}` })}\n`,
      { mode: 0o600 },
    );
    const rejectedBinding = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts', 'validate-runtime-policy.ts'),
        '--run-root',
        root,
        ...verifierArguments,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(rejectedBinding.status, 2);
    assert.equal(rejectedBinding.stdout, '');
    assert.equal(
      rejectedBinding.stderr,
      '{"code":"RUNTIME_POLICY_VALIDATION_REJECTED","status":"blocked","phase":"canonical-validator"}\n',
    );
    const reportRaw = `${canonicalJson(report)}\n`;
    writeFileSync(reportPath, reportRaw, { mode: 0o600 });
    writeFileSync(
      path.join(privateDirectory, 'canonical-bundle-validation.json'),
      canonicalValidationReceipt(bundle, bundleRaw, reportRaw, nonce),
      { mode: 0o600 },
    );

    const gitMarker = path.join(root, '.git');
    mkdirSync(gitMarker, { mode: 0o700 });
    const rejectedGitRoot = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts', 'validate-runtime-policy.ts'),
        '--run-root',
        root,
        ...verifierArguments,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(rejectedGitRoot.status, 2);
    assert.equal(rejectedGitRoot.stdout, '');
    assert.equal(
      rejectedGitRoot.stderr,
      '{"code":"RUNTIME_POLICY_VALIDATION_REJECTED","status":"blocked","phase":"run-root"}\n',
    );
    rmdirSync(gitMarker);

    const tamperedBundle = clone(bundle);
    tamperedBundle.locations.loc_aaaaaaaa.nameContentId = 'cnt_bbbbbbbb';
    writeFileSync(bundlePath, `${JSON.stringify(tamperedBundle)}\n`, { mode: 0o600 });
    const rejectedPostValidationMutation = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts', 'validate-runtime-policy.ts'),
        '--run-root',
        root,
        ...verifierArguments,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(rejectedPostValidationMutation.status, 2);
    assert.equal(rejectedPostValidationMutation.stdout, '');
    assert.equal(
      rejectedPostValidationMutation.stderr,
      '{"code":"RUNTIME_POLICY_VALIDATION_REJECTED","status":"blocked","phase":"bundle"}\n',
    );
    writeFileSync(bundlePath, bundleRaw, { mode: 0o600 });

    const forgedInvalidBundle = clone(bundle) as ReturnType<typeof syntheticBundle> & {
      script: ReturnType<typeof syntheticBundle>['script'] & {
        canonicalVerifierTestReject: boolean;
      };
    };
    forgedInvalidBundle.script.canonicalVerifierTestReject = true;
    const forgedInvalidBundleRaw = `${JSON.stringify(forgedInvalidBundle)}\n`;
    writeFileSync(bundlePath, forgedInvalidBundleRaw, { mode: 0o600 });
    writeFileSync(
      path.join(privateDirectory, 'canonical-bundle-validation.json'),
      canonicalValidationReceipt(forgedInvalidBundle, forgedInvalidBundleRaw, reportRaw, nonce),
      { mode: 0o600 },
    );
    const rejectedForgedReceipt = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts', 'validate-runtime-policy.ts'),
        '--run-root',
        root,
        ...verifierArguments,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(rejectedForgedReceipt.status, 2);
    assert.equal(rejectedForgedReceipt.stdout, '');
    assert.equal(
      rejectedForgedReceipt.stderr,
      '{"code":"RUNTIME_POLICY_VALIDATION_REJECTED","status":"blocked","phase":"canonical-validator"}\n',
    );
    writeFileSync(bundlePath, bundleRaw, { mode: 0o600 });
    writeFileSync(
      path.join(privateDirectory, 'canonical-bundle-validation.json'),
      canonicalValidationReceipt(bundle, bundleRaw, reportRaw, nonce),
      { mode: 0o600 },
    );

    const inRootVerifier = path.join(root, 'synthetic-verifier.cjs');
    writeFileSync(inRootVerifier, readFileSync(verifierScript), { mode: 0o600 });
    const rejectedInRootVerifier = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts', 'validate-runtime-policy.ts'),
        '--run-root',
        root,
        ...canonicalVerifierArgs(inRootVerifier),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(rejectedInRootVerifier.status, 2);
    assert.equal(
      rejectedInRootVerifier.stderr,
      '{"code":"RUNTIME_POLICY_VALIDATION_REJECTED","status":"blocked","phase":"canonical-validator"}\n',
    );

    for (const anomalousMode of ['wrong-stdout', 'stderr', 'mutate-script'] as const) {
      const anomalousVerifier = writeSyntheticCanonicalVerifier(verifierRoot, anomalousMode);
      const anomalousResult = spawnSync(
        process.execPath,
        [
          path.join(process.cwd(), 'scripts', 'validate-runtime-policy.ts'),
          '--run-root',
          root,
          ...canonicalVerifierArgs(anomalousVerifier),
        ],
        { encoding: 'utf8' },
      );
      assert.equal(anomalousResult.status, 2);
      assert.equal(anomalousResult.stdout, '');
      assert.equal(
        anomalousResult.stderr,
        '{"code":"RUNTIME_POLICY_VALIDATION_REJECTED","status":"blocked","phase":"canonical-validator"}\n',
      );
    }

    const result = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts', 'validate-runtime-policy.ts'),
        '--run-root',
        root,
        ...verifierArguments,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '{"code":"RUNTIME_POLICY_VALIDATED","status":"private"}\n');
    assert.equal(result.stderr, '');
    const attestation = JSON.parse(readFileSync(
      path.join(root, 'private', 'runtime-policy-validation.json'),
      'utf8',
    )) as Record<string, unknown>;
    assert.equal(attestation.schemaVersion, 'wisteria-runtime-policy-validation/4.0');
    assert.equal(attestation.scope, 'runtime_policy_bound_to_validated_bundle');
    assert.equal(attestation.canonicalBundleValidation, 'validated_receipt_bound');
    assert.match(String(attestation.canonicalValidationReceiptHash), /^sha256:[0-9a-f]{64}$/);
    assert.equal(attestation.canonicalValidatorScriptHash, sha256(readFileSync(verifierScript)));
    assert.equal('canonicalValidatorPython' in attestation, false);
    assert.equal('canonicalValidatorScript' in attestation, false);
    assert.equal(attestation.runId, `run_${nonce}`);
    assert.equal(attestation.runtimePolicyHash, policy.runtimePolicyHash);
    assert.match(String(attestation.bundlePayloadHash), /^sha256:[0-9a-f]{64}$/);
    assert.match(String(attestation.validationReportHash), /^sha256:[0-9a-f]{64}$/);
    assert.equal('issues' in attestation, false);
    assert.equal('freeze_ready' in attestation, false);
  } finally {
    cleanup(root, 'wisteria-policy-cli-');
    cleanup(verifierRoot, 'wisteria-policy-verifier-');
  }
});

test('database migration backfills only versions that predate the runtime-profile registry', async () => {
  const root = createTestTempDirectory('wisteria-policy-db-');
  process.env.WISTERIA_DATA_DIR = root;
  let applicationDatabase: DatabaseSync | undefined;
  try {
    const databasePath = path.join(root, 'wisteria.sqlite3');
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
      CREATE TABLE pack_versions (
        id TEXT PRIMARY KEY,
        public_label TEXT NOT NULL,
        payload_path TEXT NOT NULL UNIQUE,
        source_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('validated', 'frozen', 'retired')),
        created_at INTEGER NOT NULL,
        frozen_at INTEGER
      ) STRICT;
    `);
    legacyDatabase.prepare(`
      INSERT INTO pack_versions
        (id, public_label, payload_path, source_hash, state, created_at, frozen_at)
      VALUES (?, ?, ?, ?, 'frozen', ?, ?)
    `).run(
      'ver_aaaaaaaa',
      'Synthetic legacy pack',
      'packs/ver_aaaaaaaa/bundle.internal.json',
      `sha256:${'a'.repeat(64)}`,
      1,
      1,
    );
    legacyDatabase.close();

    const { getDatabase } = await import('../lib/db.ts');
    applicationDatabase = getDatabase();
    const backfilled = applicationDatabase.prepare(`
      SELECT mode, canonical_payload_hash AS canonicalPayloadHash
      FROM pack_runtime_profiles WHERE version_id = ?
    `).get('ver_aaaaaaaa') as { mode: string; canonicalPayloadHash: string };
    assert.equal(backfilled.mode, 'legacy_embedded');
    assert.equal(backfilled.canonicalPayloadHash, `sha256:${'a'.repeat(64)}`);
    const renderBackfilled = applicationDatabase.prepare(`
      SELECT mode, canonical_payload_hash AS canonicalPayloadHash
      FROM pack_render_profiles WHERE version_id = ?
    `).get('ver_aaaaaaaa') as { mode: string; canonicalPayloadHash: string };
    assert.equal(renderBackfilled.mode, 'legacy_embedded');
    assert.equal(renderBackfilled.canonicalPayloadHash, `sha256:${'a'.repeat(64)}`);

    applicationDatabase.prepare(`
      INSERT INTO pack_versions
        (id, public_label, payload_path, source_hash, state, created_at, frozen_at)
      VALUES (?, ?, ?, ?, 'frozen', ?, ?)
    `).run(
      'ver_bbbbbbbb',
      'Synthetic new pack',
      'packs/ver_bbbbbbbb/bundle.internal.json',
      `sha256:${'b'.repeat(64)}`,
      2,
      2,
    );
    const newProfile = applicationDatabase.prepare(
      'SELECT mode FROM pack_runtime_profiles WHERE version_id = ?',
    ).get('ver_bbbbbbbb');
    assert.equal(newProfile, undefined);
    const newRenderProfile = applicationDatabase.prepare(
      'SELECT mode FROM pack_render_profiles WHERE version_id = ?',
    ).get('ver_bbbbbbbb');
    assert.equal(newRenderProfile, undefined);
    assert.equal(
      (applicationDatabase.prepare(`
        SELECT COUNT(*) AS count FROM app_schema_migrations
        WHERE id = '2026-09-03-pack-runtime-profile-registry'
      `).get() as { count: number }).count,
      1,
    );
    assert.equal(
      (applicationDatabase.prepare(`
        SELECT COUNT(*) AS count FROM app_schema_migrations
        WHERE id = '2026-09-03-pack-render-profile-registry'
      `).get() as { count: number }).count,
      1,
    );
  } finally {
    applicationDatabase?.close();
    delete process.env.WISTERIA_DATA_DIR;
    cleanup(root, 'wisteria-policy-db-');
  }
});
