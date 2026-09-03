import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import sharp from 'sharp';
import {
  finalizeRuntimePolicy,
  serializeRuntimePolicy,
} from '../lib/investigation/runtime-policy.ts';
import {
  createRenderManifest,
  stringifyRenderManifest,
} from '../lib/render-manifest.ts';
import {
  syntheticBundle,
  syntheticPolicyDraft,
} from './runtime-policy-test-fixture.ts';
import {
  createTestTempDirectory,
  removeTestTempDirectory,
} from './test-temp-directory.ts';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
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

function sha256(bytes: string | Buffer) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
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
  mode: 'accept' | 'wrong-stdout' | 'stderr' = 'accept',
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
    "if (mode === 'wrong-stdout') process.stdout.write('{\"code\":\"WRONG\",\"status\":\"private\"}\\n');",
    "else process.stdout.write('{\"code\":\"CANONICAL_BUNDLE_VERIFIED\",\"status\":\"private\"}\\n');",
    "if (mode === 'stderr') process.stderr.write('synthetic verifier diagnostic\\n');",
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  return realpathSync(verifierPath);
}

function runtimePolicyAttestation({
  bundle,
  bundleRaw,
  canonicalReceiptRaw,
  nonce,
  policy,
  policyRaw,
  reportRaw,
  verifierScript,
}: {
  bundle: ReturnType<typeof syntheticBundle>;
  bundleRaw: string;
  canonicalReceiptRaw: string;
  nonce: string;
  policy: ReturnType<typeof finalizeRuntimePolicy>;
  policyRaw: string;
  reportRaw: string;
  verifierScript: string;
}) {
  return `${canonicalJson({
    bundlePayloadHash: sha256(bundleRaw),
    canonicalBundleValidation: 'validated_receipt_bound',
    canonicalPayloadHash: bundle.script.canonicalPayloadHash,
    canonicalValidationReceiptHash: sha256(canonicalReceiptRaw),
    canonicalValidatorScriptHash: sha256(readFileSync(verifierScript)),
    policyPayloadHash: sha256(policyRaw),
    policySchema: 'wisteria-runtime-policy/1.0',
    runId: `run_${nonce}`,
    runtimePolicyHash: policy.runtimePolicyHash,
    schemaVersion: 'wisteria-runtime-policy-validation/4.0',
    scope: 'runtime_policy_bound_to_validated_bundle',
    status: 'validated',
    validationReportHash: sha256(reportRaw),
    versionId: bundle.script.versionId,
  })}\n`;
}

function safeCleanup(root: string, prefix: string) {
  removeTestTempDirectory(root, prefix);
}

test('installer atomically registers and serves an attested sidecar and render manifest', async (t) => {
  const runRoot = createTestTempDirectory('wisteria-install-run-', true);
  const dataRoot = createTestTempDirectory('wisteria-install-data-');
  const auxiliaryRoot = createTestTempDirectory('wisteria-install-aux-');
  try {
    const vault = path.join(runRoot, 'vault');
    const safe = path.join(runRoot, 'safe');
    const privateDirectory = path.join(runRoot, 'private');
    mkdirSync(vault, { mode: 0o700 });
    mkdirSync(safe, { mode: 0o700 });
    mkdirSync(privateDirectory, { mode: 0o700 });
    const renderedDirectory = path.join(vault, 'rendered');
    mkdirSync(renderedDirectory, { mode: 0o700 });

    const nonce = 'abcdef0123456789abcdef0123456789';
    const verifierScript = writeSyntheticCanonicalVerifier(auxiliaryRoot);
    const markerRaw = `${canonicalJson({
      nonce,
      schema: 'blind-player-run-root/1.0',
    })}\n`;
    writeFileSync(path.join(runRoot, '.blind-player-run-root'), markerRaw, { mode: 0o600 });

    const sourceBytes = Buffer.from([0x01, 0x02]);
    const bundle = syntheticBundle({
      versionId: 'ver_77777777',
      canonicalPayloadHash: `sha256:${'7'.repeat(64)}`,
    });
    const source = bundle.sources.src_aaaaaaaa as typeof bundle.sources.src_aaaaaaaa & {
      originalPathRef: string;
    };
    source.originalPathRef = 'source.synthetic';
    source.sha256 = sha256(sourceBytes);
    bundle.assets.asset_aaaaaaaa = {
      assetId: 'asset_aaaaaaaa',
      sourceIds: ['src_aaaaaaaa'],
    };
    bundle.contentBlocks.cnt_aaaaaaaa = {
      contentId: 'cnt_aaaaaaaa',
      kind: 'image',
      payload: {},
      assetIds: ['asset_aaaaaaaa'],
      classification: {
        level: 'L1',
        compartments: [],
        taintSourceIds: ['src_aaaaaaaa'],
      },
      visibility: { default: 'deny', grants: [] },
      trace: {
        evidence: [{
          sourceId: 'src_aaaaaaaa',
          pageId: 'page_aaaaaaaa',
          region: { unit: 'normalized', x: 0, y: 0, width: 1, height: 1 },
          side: 'single',
          readingOrder: 1,
        }],
        ocrExtractionId: null,
        reviewStatus: 'verified',
      },
    };
    const renderedPath = path.join(
      renderedDirectory,
      'src_aaaaaaaa.page_aaaaaaaa.webp',
    );
    const renderedBytes = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 1, g: 2, b: 3, alpha: 1 },
      },
    }).webp({ lossless: true }).toBuffer();
    const wrongDimensionBytes = await sharp({
      create: {
        width: 2,
        height: 1,
        channels: 4,
        background: { r: 1, g: 2, b: 3, alpha: 1 },
      },
    }).webp({ lossless: true }).toBuffer();
    const bundleRaw = `${JSON.stringify(bundle)}\n`;
    const bundlePath = path.join(vault, 'bundle.json');
    writeFileSync(bundlePath, bundleRaw, { mode: 0o600 });
    writeFileSync(path.join(vault, 'source.bin'), sourceBytes, { mode: 0o600 });

    const policy = finalizeRuntimePolicy(syntheticPolicyDraft(bundle), bundle);
    const policyRaw = serializeRuntimePolicy(policy);
    const policyPath = path.join(vault, 'runtime-policy.json');
    writeFileSync(policyPath, policyRaw, { mode: 0o600 });

    const reportRaw = `${canonicalJson(safeValidationReport(bundle, nonce))}\n`;
    writeFileSync(path.join(safe, 'validation.json'), reportRaw, { mode: 0o600 });
    writeFileSync(
      path.join(privateDirectory, 'canonical-bundle-validation.json'),
      canonicalValidationReceipt(bundle, bundleRaw, reportRaw, nonce),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(privateDirectory, 'source-inventory.json'),
      JSON.stringify({
        sources: [{
          byte_length: source.byteLength,
          media_type: source.mediaType,
          path_ref: source.originalPathRef,
          sha256: source.sha256,
          source_id: source.sourceId,
          vault_blob_ref: 'vault:source.bin',
        }],
      }),
      { mode: 0o600 },
    );

    const runInstaller = ({
      selectedRunRoot = runRoot,
      selectedDataRoot = dataRoot,
      selectedValidatorScript = verifierScript,
      environment = {},
    }: {
      selectedRunRoot?: string;
      selectedDataRoot?: string;
      selectedValidatorScript?: string;
      environment?: Record<string, string>;
    } = {}) => spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts', 'install-validated-pack.mjs'),
        '--run-root',
        selectedRunRoot,
        '--data-dir',
        selectedDataRoot,
        '--label',
        'Synthetic pack',
        '--canonical-validator-python',
        realpathSync(process.execPath),
        '--canonical-validator-script',
        selectedValidatorScript,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, ...environment },
      },
    );

    const rejectedMissingVerifier = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts', 'install-validated-pack.mjs'),
        '--run-root',
        runRoot,
        '--data-dir',
        dataRoot,
        '--label',
        'Synthetic pack',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(rejectedMissingVerifier.status, 2);
    assert.equal(rejectedMissingVerifier.stdout, '');
    assert.equal(
      rejectedMissingVerifier.stderr,
      '{"code":"PACK_INSTALL_REJECTED","status":"blocked","phase":"arguments"}\n',
    );

    const validator = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts', 'validate-runtime-policy.ts'),
        '--run-root',
        runRoot,
        '--canonical-validator-python',
        realpathSync(process.execPath),
        '--canonical-validator-script',
        verifierScript,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(validator.status, 0, validator.stderr);
    assert.equal(validator.stdout, '{"code":"RUNTIME_POLICY_VALIDATED","status":"private"}\n');
    assert.equal(validator.stderr, '');
    const attestationPath = path.join(privateDirectory, 'runtime-policy-validation.json');
    const validAttestationRaw = readFileSync(attestationPath, 'utf8');

    const forgedInvalidBundle = JSON.parse(bundleRaw) as typeof bundle & {
      script: typeof bundle.script & { canonicalVerifierTestReject: boolean };
    };
    forgedInvalidBundle.script.canonicalVerifierTestReject = true;
    const forgedInvalidBundleRaw = `${JSON.stringify(forgedInvalidBundle)}\n`;
    const forgedReceiptRaw = canonicalValidationReceipt(
      forgedInvalidBundle,
      forgedInvalidBundleRaw,
      reportRaw,
      nonce,
    );
    writeFileSync(bundlePath, forgedInvalidBundleRaw, { mode: 0o600 });
    writeFileSync(
      path.join(privateDirectory, 'canonical-bundle-validation.json'),
      forgedReceiptRaw,
      { mode: 0o600 },
    );
    writeFileSync(
      attestationPath,
      runtimePolicyAttestation({
        bundle: forgedInvalidBundle,
        bundleRaw: forgedInvalidBundleRaw,
        canonicalReceiptRaw: forgedReceiptRaw,
        nonce,
        policy,
        policyRaw,
        reportRaw,
        verifierScript,
      }),
      { mode: 0o600 },
    );
    const rejectedForgedChain = runInstaller();
    assert.equal(rejectedForgedChain.status, 2);
    assert.equal(rejectedForgedChain.stdout, '');
    assert.equal(
      rejectedForgedChain.stderr,
      '{"code":"PACK_INSTALL_REJECTED","status":"blocked","phase":"canonical-validator"}\n',
    );
    writeFileSync(bundlePath, bundleRaw, { mode: 0o600 });
    const validReceiptRaw = canonicalValidationReceipt(bundle, bundleRaw, reportRaw, nonce);
    writeFileSync(
      path.join(privateDirectory, 'canonical-bundle-validation.json'),
      validReceiptRaw,
      { mode: 0o600 },
    );
    writeFileSync(attestationPath, validAttestationRaw, { mode: 0o600 });

    const verifierInsideDataRoot = path.join(dataRoot, 'synthetic-canonical-verifier.cjs');
    writeFileSync(verifierInsideDataRoot, readFileSync(verifierScript), { mode: 0o600 });
    const rejectedVerifierInsideDataRoot = runInstaller({
      selectedValidatorScript: verifierInsideDataRoot,
    });
    assert.equal(rejectedVerifierInsideDataRoot.status, 2);
    assert.equal(
      rejectedVerifierInsideDataRoot.stderr,
      '{"code":"PACK_INSTALL_REJECTED","status":"blocked","phase":"canonical-validator"}\n',
    );

    const anomalousVerifier = writeSyntheticCanonicalVerifier(auxiliaryRoot, 'wrong-stdout');
    const rejectedVerifierOutput = runInstaller({ selectedValidatorScript: anomalousVerifier });
    assert.equal(rejectedVerifierOutput.status, 2);
    assert.equal(rejectedVerifierOutput.stdout, '');
    assert.equal(
      rejectedVerifierOutput.stderr,
      '{"code":"PACK_INSTALL_REJECTED","status":"blocked","phase":"canonical-validator"}\n',
    );

    const tamperedBundle = JSON.parse(bundleRaw) as typeof bundle;
    tamperedBundle.locations.loc_aaaaaaaa.nameContentId = 'cnt_bbbbbbbb';
    writeFileSync(bundlePath, `${JSON.stringify(tamperedBundle)}\n`, { mode: 0o600 });
    const rejectedPostValidationMutation = runInstaller();
    assert.equal(rejectedPostValidationMutation.status, 2);
    assert.equal(rejectedPostValidationMutation.stdout, '');
    assert.equal(
      rejectedPostValidationMutation.stderr,
      '{"code":"PACK_INSTALL_REJECTED","status":"blocked","phase":"runtime-policy"}\n',
    );
    writeFileSync(bundlePath, bundleRaw, { mode: 0o600 });

    const assertRunInputsRejected = (result: ReturnType<typeof spawnSync>) => {
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.equal(
        result.stderr,
        '{"code":"PACK_INSTALL_REJECTED","status":"blocked","phase":"run-inputs"}\n',
      );
    };

    assertRunInputsRejected(runInstaller({
      selectedDataRoot: path.join(auxiliaryRoot, 'missing-data-root'),
    }));

    const nestedDataRoot = path.join(runRoot, 'nested-data-root');
    mkdirSync(nestedDataRoot, { mode: 0o700 });
    try {
      assertRunInputsRejected(runInstaller({ selectedDataRoot: nestedDataRoot }));
    } finally {
      rmdirSync(nestedDataRoot);
    }

    const nestedRunRoot = path.join(auxiliaryRoot, 'nested-run-root');
    mkdirSync(nestedRunRoot, { mode: 0o700 });
    mkdirSync(path.join(nestedRunRoot, 'vault'), { mode: 0o700 });
    mkdirSync(path.join(nestedRunRoot, 'safe'), { mode: 0o700 });
    mkdirSync(path.join(nestedRunRoot, 'private'), { mode: 0o700 });
    assertRunInputsRejected(runInstaller({
      selectedRunRoot: nestedRunRoot,
      selectedDataRoot: auxiliaryRoot,
    }));

    const dataLink = path.join(auxiliaryRoot, 'data-link');
    let dataLinkCreated = false;
    try {
      symlinkSync(dataRoot, dataLink, process.platform === 'win32' ? 'junction' : 'dir');
      dataLinkCreated = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EACCES', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(code ?? '')) throw error;
      t.diagnostic(`data-dir symlink test skipped: ${code}`);
    }
    if (dataLinkCreated) {
      try {
        assertRunInputsRejected(runInstaller({ selectedDataRoot: dataLink }));
      } finally {
        unlinkSync(dataLink);
      }
    }

    writeFileSync(policyPath, `${policyRaw} `, { mode: 0o600 });
    const rejected = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts', 'install-validated-pack.mjs'),
        '--run-root',
        runRoot,
        '--data-dir',
        dataRoot,
        '--label',
        'Synthetic pack',
        '--canonical-validator-python',
        realpathSync(process.execPath),
        '--canonical-validator-script',
        verifierScript,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(rejected.status, 2);
    assert.equal(rejected.stdout, '');
    assert.equal(
      rejected.stderr,
      '{"code":"PACK_INSTALL_REJECTED","status":"blocked","phase":"runtime-policy"}\n',
    );
    assert.equal(existsSync(path.join(dataRoot, 'packs', bundle.script.versionId)), false);

    writeFileSync(policyPath, policyRaw, { mode: 0o600 });
    const missingRendered = runInstaller();
    assert.equal(missingRendered.status, 2);
    assert.equal(missingRendered.stdout, '');
    assert.equal(
      missingRendered.stderr,
      '{"code":"PACK_INSTALL_REJECTED","status":"blocked","phase":"render-manifest"}\n',
    );
    assert.equal(existsSync(path.join(dataRoot, 'packs', bundle.script.versionId)), false);

    writeFileSync(renderedPath, wrongDimensionBytes, { mode: 0o600 });
    const wrongDimensions = runInstaller();
    assert.equal(wrongDimensions.status, 2);
    assert.equal(wrongDimensions.stdout, '');
    assert.equal(
      wrongDimensions.stderr,
      '{"code":"PACK_INSTALL_REJECTED","status":"blocked","phase":"render-manifest"}\n',
    );

    writeFileSync(renderedPath, Buffer.from('not-webp'), { mode: 0o600 });
    const tamperedRendered = runInstaller();
    assert.equal(tamperedRendered.status, 2);
    assert.equal(tamperedRendered.stdout, '');
    assert.equal(
      tamperedRendered.stderr,
      '{"code":"PACK_INSTALL_REJECTED","status":"blocked","phase":"render-manifest"}\n',
    );

    writeFileSync(renderedPath, renderedBytes, { mode: 0o600 });
    const extraRenderedPath = path.join(
      renderedDirectory,
      'src_bbbbbbbb.page_bbbbbbbb.webp',
    );
    writeFileSync(extraRenderedPath, renderedBytes, { mode: 0o600 });
    const extraRendered = runInstaller();
    assert.equal(extraRendered.status, 2);
    assert.equal(extraRendered.stdout, '');
    assert.equal(
      extraRendered.stderr,
      '{"code":"PACK_INSTALL_REJECTED","status":"blocked","phase":"render-manifest"}\n',
    );
    unlinkSync(extraRenderedPath);

    const packsDirectory = path.join(dataRoot, 'packs');
    const stagePattern = new RegExp(`^\\.install-${bundle.script.versionId}-[0-9a-f]{32}$`);
    const journalPattern = new RegExp(
      `^\\.install-${bundle.script.versionId}-[0-9a-f]{32}\\.recovery\\.json$`,
    );
    const recoveryEntryCounts = () => {
      const entries = readdirSync(packsDirectory, { withFileTypes: true });
      return {
        journals: entries.filter((entry) => entry.isFile() && journalPattern.test(entry.name)).length,
        stages: entries.filter((entry) => entry.isDirectory() && stagePattern.test(entry.name)).length,
      };
    };
    writeFileSync(path.join(vault, 'source.bin'), Buffer.from([0x01, 0x03]), { mode: 0o600 });
    const copyRejected = runInstaller();
    assert.equal(copyRejected.status, 2);
    assert.equal(copyRejected.stdout, '');
    assert.equal(
      copyRejected.stderr,
      '{"code":"PACK_INSTALL_REJECTED","status":"blocked","phase":"source-verification"}\n',
    );
    assert.equal(existsSync(path.join(dataRoot, 'packs', bundle.script.versionId)), false);
    assert.deepEqual(recoveryEntryCounts(), { journals: 0, stages: 0 });

    writeFileSync(path.join(vault, 'source.bin'), sourceBytes, { mode: 0o600 });
    const stagedCrash = runInstaller({
      environment: {
        NODE_ENV: 'test',
        WISTERIA_TEST_INSTALL_CRASH_POINT: 'after-staging-ready',
      },
    });
    assert.equal(stagedCrash.status, 86);
    assert.equal(stagedCrash.stdout, '');
    assert.equal(stagedCrash.stderr, '');
    assert.equal(existsSync(path.join(packsDirectory, bundle.script.versionId)), false);
    assert.deepEqual(recoveryEntryCounts(), { journals: 1, stages: 1 });

    const renamedCrash = runInstaller({
      environment: {
        NODE_ENV: 'test',
        WISTERIA_TEST_INSTALL_CRASH_POINT: 'after-final-rename',
      },
    });
    assert.equal(renamedCrash.status, 86);
    assert.equal(renamedCrash.stdout, '');
    assert.equal(renamedCrash.stderr, '');
    assert.equal(existsSync(path.join(packsDirectory, bundle.script.versionId)), true);
    assert.deepEqual(recoveryEntryCounts(), { journals: 1, stages: 0 });
    const crashDatabase = new DatabaseSync(path.join(dataRoot, 'wisteria.sqlite3'));
    try {
      const registration = crashDatabase.prepare(
        'SELECT COUNT(*) AS count FROM pack_versions WHERE id = ?',
      ).get(bundle.script.versionId) as { count: number };
      assert.equal(registration.count, 0);
    } finally {
      crashDatabase.close();
    }

    const installed = runInstaller();
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(installed.stdout, '{"code":"PACK_INSTALLED","status":"private"}\n');
    assert.equal(installed.stderr, '');
    assert.deepEqual(recoveryEntryCounts(), { journals: 0, stages: 0 });

    const duplicateInstall = runInstaller();
    assert.equal(duplicateInstall.status, 2);
    assert.equal(duplicateInstall.stdout, '');
    assert.equal(
      duplicateInstall.stderr,
      '{"code":"PACK_INSTALL_REJECTED","status":"blocked","phase":"bundle-copy"}\n',
    );
    assert.equal(existsSync(path.join(packsDirectory, bundle.script.versionId)), true);

    let installedManifest!: {
      renderManifestHash: string;
      objects: Array<{
        sourceId: string;
        pageId: string;
        mediaType: 'image/webp';
        sha256: string;
        byteLength: number;
        width: number;
        height: number;
      }>;
    };
    const database = new DatabaseSync(path.join(dataRoot, 'wisteria.sqlite3'));
    try {
      const row = database.prepare(`
        SELECT
          pack_versions.payload_path AS bundlePath,
          pack_runtime_profiles.mode AS runtimeMode,
          pack_runtime_profiles.bundle_payload_hash AS bundlePayloadHash,
          pack_runtime_profiles.policy_path AS policyPath,
          pack_runtime_profiles.policy_payload_hash AS policyPayloadHash,
          pack_runtime_profiles.runtime_policy_hash AS runtimePolicyHash,
          pack_render_profiles.mode AS renderMode,
          pack_render_profiles.manifest_path AS manifestPath,
          pack_render_profiles.manifest_payload_hash AS manifestPayloadHash,
          pack_render_profiles.render_manifest_hash AS renderManifestHash
        FROM pack_versions
        JOIN pack_runtime_profiles
          ON pack_runtime_profiles.version_id = pack_versions.id
        JOIN pack_render_profiles
          ON pack_render_profiles.version_id = pack_versions.id
        WHERE pack_versions.id = ?
      `).get(bundle.script.versionId) as {
        bundlePath: string;
        runtimeMode: string;
        bundlePayloadHash: string;
        policyPath: string;
        policyPayloadHash: string;
        runtimePolicyHash: string;
        renderMode: string;
        manifestPath: string;
        manifestPayloadHash: string;
        renderManifestHash: string;
      };
      const installedManifestRaw = readFileSync(
        path.join(
          dataRoot,
          'packs',
          bundle.script.versionId,
          'render-manifest.internal.json',
        ),
        'utf8',
      );
      installedManifest = JSON.parse(installedManifestRaw) as typeof installedManifest;
      assert.deepEqual({ ...row }, {
        bundlePath: `packs/${bundle.script.versionId}/bundle.internal.json`,
        runtimeMode: 'sidecar',
        bundlePayloadHash: sha256(bundleRaw),
        policyPath: `packs/${bundle.script.versionId}/runtime-policy.internal.json`,
        policyPayloadHash: sha256(policyRaw),
        runtimePolicyHash: policy.runtimePolicyHash,
        renderMode: 'manifest',
        manifestPath: `packs/${bundle.script.versionId}/render-manifest.internal.json`,
        manifestPayloadHash: sha256(installedManifestRaw),
        renderManifestHash: installedManifest.renderManifestHash,
      });
    } finally {
      database.close();
    }
    assert.equal(
      readFileSync(
        path.join(dataRoot, 'packs', bundle.script.versionId, 'bundle.internal.json'),
        'utf8',
      ),
      bundleRaw,
    );
    assert.equal(
      readFileSync(
        path.join(dataRoot, 'packs', bundle.script.versionId, 'runtime-policy.internal.json'),
        'utf8',
      ),
      policyRaw,
    );
    const installedDirectory = path.join(dataRoot, 'packs', bundle.script.versionId);
    const installedManifestPath = path.join(
      installedDirectory,
      'render-manifest.internal.json',
    );
    const installedObjectPath = path.join(
      installedDirectory,
      'objects',
      'src_aaaaaaaa.page_aaaaaaaa.webp',
    );
    assert.deepEqual(readFileSync(installedObjectPath), renderedBytes);

    process.env.WISTERIA_DATA_DIR = dataRoot;
    const [{ getDatabase }, {
      loadFrozenBundle,
      loadFrozenContentSource,
      loadInstalledPack,
      PackAccessError,
    }] = await Promise.all([
      import('../lib/db.ts'),
      import('../lib/packs.ts'),
    ]);
    const applicationDatabase = getDatabase();
    const assertStorageRejected = (action: () => unknown) => {
      assert.throws(
        action,
        (error) => error instanceof PackAccessError && error.code === 'PACK_STORAGE_REJECTED',
      );
    };
    try {
      const loaded = loadInstalledPack(bundle.script.versionId);
      assert.equal(loaded.renderProfile.mode, 'manifest');
      const sourceResult = loadFrozenContentSource(
        bundle.script.versionId,
        'cnt_aaaaaaaa',
        0,
      );
      assert.deepEqual(sourceResult.sourceBytes, renderedBytes);

      applicationDatabase.prepare(`
        UPDATE pack_render_profiles SET manifest_path = ? WHERE version_id = ?
      `).run(
        `packs/${bundle.script.versionId}/alternate-render-manifest.internal.json`,
        bundle.script.versionId,
      );
      assertStorageRejected(() => loadInstalledPack(bundle.script.versionId));
      applicationDatabase.prepare(`
        UPDATE pack_render_profiles SET manifest_path = ? WHERE version_id = ?
      `).run(
        `packs/${bundle.script.versionId}/render-manifest.internal.json`,
        bundle.script.versionId,
      );

      applicationDatabase.prepare(`
        UPDATE pack_render_profiles SET manifest_payload_hash = ? WHERE version_id = ?
      `).run(`sha256:${'f'.repeat(64)}`, bundle.script.versionId);
      assertStorageRejected(() => loadInstalledPack(bundle.script.versionId));
      applicationDatabase.prepare(`
        UPDATE pack_render_profiles SET manifest_payload_hash = ? WHERE version_id = ?
      `).run(sha256(readFileSync(installedManifestPath)), bundle.script.versionId);

      applicationDatabase.prepare(`
        UPDATE pack_render_profiles SET render_manifest_hash = ? WHERE version_id = ?
      `).run(`sha256:${'e'.repeat(64)}`, bundle.script.versionId);
      assertStorageRejected(() => loadInstalledPack(bundle.script.versionId));
      applicationDatabase.prepare(`
        UPDATE pack_render_profiles SET render_manifest_hash = ? WHERE version_id = ?
      `).run(installedManifest.renderManifestHash, bundle.script.versionId);

      const installedManifestRaw = readFileSync(installedManifestPath, 'utf8');
      writeFileSync(installedManifestPath, `${installedManifestRaw} `, { mode: 0o600 });
      assertStorageRejected(() => loadInstalledPack(bundle.script.versionId));
      writeFileSync(installedManifestPath, installedManifestRaw, { mode: 0o600 });

      const extraInstalledObject = path.join(
        installedDirectory,
        'objects',
        'src_bbbbbbbb.page_bbbbbbbb.webp',
      );
      writeFileSync(extraInstalledObject, renderedBytes, { mode: 0o600 });
      assertStorageRejected(() => loadInstalledPack(bundle.script.versionId));
      unlinkSync(extraInstalledObject);

      const heldObject = path.join(installedDirectory, 'object.held-aside');
      renameSync(installedObjectPath, heldObject);
      assertStorageRejected(() => loadInstalledPack(bundle.script.versionId));
      renameSync(heldObject, installedObjectPath);

      writeFileSync(installedObjectPath, Buffer.from('tampered'), { mode: 0o600 });
      assertStorageRejected(() => loadFrozenBundle(bundle.script.versionId));
      assertStorageRejected(() => loadFrozenContentSource(
        bundle.script.versionId,
        'cnt_aaaaaaaa',
        0,
      ));
      writeFileSync(installedObjectPath, renderedBytes, { mode: 0o600 });

      const wrongDimensionManifest = createRenderManifest(
        bundle,
        Buffer.from(bundleRaw),
        [{
          ...installedManifest.objects[0],
          sha256: sha256(wrongDimensionBytes),
          byteLength: wrongDimensionBytes.length,
        }],
      );
      const wrongDimensionManifestRaw = stringifyRenderManifest(wrongDimensionManifest);
      writeFileSync(installedManifestPath, wrongDimensionManifestRaw, { mode: 0o600 });
      writeFileSync(installedObjectPath, wrongDimensionBytes, { mode: 0o600 });
      applicationDatabase.prepare(`
        UPDATE pack_render_profiles
        SET manifest_payload_hash = ?, render_manifest_hash = ?
        WHERE version_id = ?
      `).run(
        sha256(wrongDimensionManifestRaw),
        wrongDimensionManifest.renderManifestHash,
        bundle.script.versionId,
      );
      assertStorageRejected(() => loadFrozenBundle(bundle.script.versionId));
      assertStorageRejected(() => loadFrozenContentSource(
        bundle.script.versionId,
        'cnt_aaaaaaaa',
        0,
      ));

      writeFileSync(installedManifestPath, installedManifestRaw, { mode: 0o600 });
      writeFileSync(installedObjectPath, renderedBytes, { mode: 0o600 });
      applicationDatabase.prepare(`
        UPDATE pack_render_profiles
        SET manifest_payload_hash = ?, render_manifest_hash = ?
        WHERE version_id = ?
      `).run(
        sha256(installedManifestRaw),
        installedManifest.renderManifestHash,
        bundle.script.versionId,
      );
      assert.equal(loadInstalledPack(bundle.script.versionId).renderProfile.mode, 'manifest');
    } finally {
      applicationDatabase.close();
      delete process.env.WISTERIA_DATA_DIR;
    }
  } finally {
    safeCleanup(runRoot, 'wisteria-install-run-');
    safeCleanup(dataRoot, 'wisteria-install-data-');
    safeCleanup(auxiliaryRoot, 'wisteria-install-aux-');
  }
});
