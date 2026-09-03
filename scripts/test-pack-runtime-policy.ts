import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getDatabase } from '../lib/db.ts';
import {
  loadFrozenBundle,
  loadFrozenRuntimePolicy,
  loadInstalledPack,
  listFrozenPackVersions,
  PackAccessError,
} from '../lib/packs.ts';
import {
  computeRuntimePolicyHash,
  finalizeRuntimePolicy,
  RUNTIME_POLICY_SCHEMA,
  serializeRuntimePolicy,
  type RuntimePolicyDocument,
} from '../lib/investigation/runtime-policy.ts';
import {
  syntheticBundle,
  syntheticPolicyDraft,
} from './runtime-policy-test-fixture.ts';

function payloadHash(raw: string | Buffer) {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function assertPackError(code: PackAccessError['code'], action: () => unknown) {
  assert.throws(action, (error) => error instanceof PackAccessError && error.code === code);
}

function cleanup(root: string) {
  const resolved = realpathSync(root);
  const expectedPrefix = `${realpathSync(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(expectedPrefix) || !path.basename(resolved).startsWith('wisteria-pack-policy-')) {
    throw new Error('UNSAFE_TEST_CLEANUP_TARGET');
  }
  rmSync(resolved, { recursive: true, force: false });
}

test('installed-pack loader requires an explicit bound profile and validates private sidecars', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wisteria-pack-policy-')));
  process.env.WISTERIA_DATA_DIR = root;
  const database = getDatabase();
  const now = Date.now();
  const installBundle = (
    bundle: ReturnType<typeof syntheticBundle>,
    renderMode: 'legacy_embedded' | 'none' = 'legacy_embedded',
  ) => {
    const directory = path.join(root, 'packs', bundle.script.versionId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bundlePath = path.join(directory, 'bundle.internal.json');
    const bundleRaw = `${JSON.stringify(bundle)}\n`;
    writeFileSync(bundlePath, bundleRaw, { encoding: 'utf8', mode: 0o600 });
    database.prepare(`
      INSERT INTO pack_versions
        (id, public_label, payload_path, source_hash, state, created_at, frozen_at)
      VALUES (?, ?, ?, ?, 'frozen', ?, ?)
    `).run(
      bundle.script.versionId,
      'Synthetic pack',
      `packs/${bundle.script.versionId}/bundle.internal.json`,
      bundle.script.canonicalPayloadHash,
      now,
      now,
    );
    if (renderMode === 'legacy_embedded') {
      database.prepare(`
        INSERT INTO pack_render_profiles
          (version_id, mode, canonical_payload_hash, created_at)
        VALUES (?, 'legacy_embedded', ?, ?)
      `).run(
        bundle.script.versionId,
        bundle.script.canonicalPayloadHash,
        now,
      );
    }
    return { directory, bundlePath, bundleRaw, bundlePayloadHash: payloadHash(bundleRaw) };
  };
  try {
    const canonicalBundle = syntheticBundle({
      versionId: 'ver_11111111',
      canonicalPayloadHash: `sha256:${'1'.repeat(64)}`,
    });
    const canonicalFiles = installBundle(canonicalBundle);
    database.prepare(`
      INSERT INTO pack_runtime_profiles
        (version_id, mode, canonical_payload_hash, bundle_payload_hash, created_at)
      VALUES (?, 'canonical', ?, ?, ?)
    `).run(
      canonicalBundle.script.versionId,
      canonicalBundle.script.canonicalPayloadHash,
      canonicalFiles.bundlePayloadHash,
      now,
    );
    const canonical = loadInstalledPack(canonicalBundle.script.versionId);
    assert.equal(canonical.runtimePolicy.profileMode, 'canonical');
    assert.equal(
      loadFrozenRuntimePolicy(canonicalBundle.script.versionId).stageMechanisms.stage_aaaaaaaa.kind,
      'canonical_search_policy',
    );
    writeFileSync(canonicalFiles.bundlePath, `${canonicalFiles.bundleRaw} `, {
      encoding: 'utf8',
      mode: 0o600,
    });
    assertPackError(
      'PACK_STORAGE_REJECTED',
      () => loadInstalledPack(canonicalBundle.script.versionId),
    );
    writeFileSync(canonicalFiles.bundlePath, canonicalFiles.bundleRaw, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const alternateBundlePath = path.join(canonicalFiles.directory, 'alternate.internal.json');
    writeFileSync(alternateBundlePath, canonicalFiles.bundleRaw, { encoding: 'utf8', mode: 0o600 });
    database.prepare('UPDATE pack_versions SET payload_path = ? WHERE id = ?').run(
      `packs/${canonicalBundle.script.versionId}/alternate.internal.json`,
      canonicalBundle.script.versionId,
    );
    assertPackError(
      'PACK_STORAGE_REJECTED',
      () => loadInstalledPack(canonicalBundle.script.versionId),
    );
    database.prepare('UPDATE pack_versions SET payload_path = ? WHERE id = ?').run(
      `packs/${canonicalBundle.script.versionId}/bundle.internal.json`,
      canonicalBundle.script.versionId,
    );

    const sidecarBundle = syntheticBundle({
      versionId: 'ver_22222222',
      canonicalPayloadHash: `sha256:${'2'.repeat(64)}`,
    });
    const sidecarFiles = installBundle(sidecarBundle);
    const sidecar = finalizeRuntimePolicy(
      syntheticPolicyDraft(sidecarBundle, 'canonical_search_policy'),
      sidecarBundle,
    );
    const sidecarRaw = serializeRuntimePolicy(sidecar);
    const sidecarPath = path.join(sidecarFiles.directory, 'runtime-policy.internal.json');
    writeFileSync(sidecarPath, sidecarRaw, { encoding: 'utf8', mode: 0o600 });
    database.prepare(`
      INSERT INTO pack_runtime_profiles
        (
          version_id, mode, canonical_payload_hash, policy_schema, policy_path,
          policy_payload_hash, runtime_policy_hash, bundle_payload_hash, created_at
        )
      VALUES (?, 'sidecar', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sidecarBundle.script.versionId,
      sidecarBundle.script.canonicalPayloadHash,
      RUNTIME_POLICY_SCHEMA,
      `packs/${sidecarBundle.script.versionId}/runtime-policy.internal.json`,
      payloadHash(sidecarRaw),
      sidecar.runtimePolicyHash,
      sidecarFiles.bundlePayloadHash,
      now,
    );
    const loadedSidecar = loadInstalledPack(sidecarBundle.script.versionId);
    assert.equal(loadedSidecar.runtimePolicy.profileMode, 'sidecar');
    assert.equal(
      loadedSidecar.runtimePolicy.stageMechanisms.stage_aaaaaaaa.kind,
      'canonical_search_policy',
    );
    assert.equal(loadedSidecar.runtimePolicy.sidecar?.runtimePolicyHash, sidecar.runtimePolicyHash);

    const legacyBundle = syntheticBundle({
      versionId: 'ver_33333333',
      canonicalPayloadHash: `sha256:${'3'.repeat(64)}`,
      embeddedFlow: true,
    });
    installBundle(legacyBundle);
    database.prepare(`
      INSERT INTO pack_runtime_profiles
        (version_id, mode, canonical_payload_hash, created_at)
      VALUES (?, 'legacy_embedded', ?, ?)
    `).run(
      legacyBundle.script.versionId,
      legacyBundle.script.canonicalPayloadHash,
      now,
    );
    assert.equal(
      loadInstalledPack(legacyBundle.script.versionId).runtimePolicy.profileMode,
      'legacy_embedded',
    );

    const missingProfileBundle = syntheticBundle({
      versionId: 'ver_44444444',
      canonicalPayloadHash: `sha256:${'4'.repeat(64)}`,
    });
    installBundle(missingProfileBundle);
    assertPackError(
      'PACK_STORAGE_REJECTED',
      () => loadFrozenBundle(missingProfileBundle.script.versionId),
    );
    assertPackError(
      'PACK_STORAGE_REJECTED',
      () => loadFrozenRuntimePolicy(missingProfileBundle.script.versionId),
    );
    assert.equal(
      listFrozenPackVersions().some(
        (item) => item.versionId === missingProfileBundle.script.versionId,
      ),
      false,
    );

    const missingRenderBundle = syntheticBundle({
      versionId: 'ver_66666666',
      canonicalPayloadHash: `sha256:${'6'.repeat(64)}`,
    });
    const missingRenderFiles = installBundle(missingRenderBundle, 'none');
    database.prepare(`
      INSERT INTO pack_runtime_profiles
        (version_id, mode, canonical_payload_hash, bundle_payload_hash, created_at)
      VALUES (?, 'canonical', ?, ?, ?)
    `).run(
      missingRenderBundle.script.versionId,
      missingRenderBundle.script.canonicalPayloadHash,
      missingRenderFiles.bundlePayloadHash,
      now,
    );
    assertPackError(
      'PACK_STORAGE_REJECTED',
      () => loadInstalledPack(missingRenderBundle.script.versionId),
    );
    assert.equal(
      listFrozenPackVersions().some(
        (item) => item.versionId === missingRenderBundle.script.versionId,
      ),
      false,
    );

    const embeddedCanonicalBundle = syntheticBundle({
      versionId: 'ver_55555555',
      canonicalPayloadHash: `sha256:${'5'.repeat(64)}`,
      embeddedFlow: true,
    });
    const embeddedCanonicalFiles = installBundle(embeddedCanonicalBundle);
    database.prepare(`
      INSERT INTO pack_runtime_profiles
        (version_id, mode, canonical_payload_hash, bundle_payload_hash, created_at)
      VALUES (?, 'canonical', ?, ?, ?)
    `).run(
      embeddedCanonicalBundle.script.versionId,
      embeddedCanonicalBundle.script.canonicalPayloadHash,
      embeddedCanonicalFiles.bundlePayloadHash,
      now,
    );
    assertPackError(
      'PACK_STORAGE_REJECTED',
      () => loadInstalledPack(embeddedCanonicalBundle.script.versionId),
    );

    database.prepare(`
      UPDATE pack_runtime_profiles SET policy_payload_hash = ? WHERE version_id = ?
    `).run(`sha256:${'f'.repeat(64)}`, sidecarBundle.script.versionId);
    assertPackError(
      'PACK_STORAGE_REJECTED',
      () => loadFrozenRuntimePolicy(sidecarBundle.script.versionId),
    );
    database.prepare(`
      UPDATE pack_runtime_profiles SET policy_payload_hash = ? WHERE version_id = ?
    `).run(payloadHash(sidecarRaw), sidecarBundle.script.versionId);

    database.prepare(`
      UPDATE pack_runtime_profiles SET runtime_policy_hash = ? WHERE version_id = ?
    `).run(`sha256:${'f'.repeat(64)}`, sidecarBundle.script.versionId);
    assertPackError(
      'PACK_STORAGE_REJECTED',
      () => loadFrozenRuntimePolicy(sidecarBundle.script.versionId),
    );
    database.prepare(`
      UPDATE pack_runtime_profiles SET runtime_policy_hash = ? WHERE version_id = ?
    `).run(sidecar.runtimePolicyHash, sidecarBundle.script.versionId);

    const mismatchDraft = {
      ...syntheticPolicyDraft(sidecarBundle, 'canonical_search_policy'),
      versionId: 'ver_66666666',
    };
    const mismatchDocument = {
      ...mismatchDraft,
      runtimePolicyHash: computeRuntimePolicyHash(mismatchDraft),
    } as RuntimePolicyDocument;
    const mismatchRaw = serializeRuntimePolicy(mismatchDocument);
    writeFileSync(sidecarPath, mismatchRaw, { encoding: 'utf8', mode: 0o600 });
    database.prepare(`
      UPDATE pack_runtime_profiles
      SET policy_payload_hash = ?, runtime_policy_hash = ?
      WHERE version_id = ?
    `).run(
      payloadHash(mismatchRaw),
      mismatchDocument.runtimePolicyHash,
      sidecarBundle.script.versionId,
    );
    assertPackError(
      'PACK_STORAGE_REJECTED',
      () => loadFrozenRuntimePolicy(sidecarBundle.script.versionId),
    );

    writeFileSync(sidecarPath, sidecarRaw, { encoding: 'utf8', mode: 0o600 });
    database.prepare(`
      UPDATE pack_runtime_profiles
      SET policy_payload_hash = ?, runtime_policy_hash = ?, policy_path = ?
      WHERE version_id = ?
    `).run(
      payloadHash(sidecarRaw),
      sidecar.runtimePolicyHash,
      '../runtime-policy.internal.json',
      sidecarBundle.script.versionId,
    );
    assertPackError(
      'PACK_STORAGE_REJECTED',
      () => loadFrozenRuntimePolicy(sidecarBundle.script.versionId),
    );
    database.prepare(`
      UPDATE pack_runtime_profiles SET policy_path = ? WHERE version_id = ?
    `).run(
      `packs/${sidecarBundle.script.versionId}/runtime-policy.internal.json`,
      sidecarBundle.script.versionId,
    );

    const heldAside = path.join(sidecarFiles.directory, 'runtime-policy.held-aside.json');
    renameSync(sidecarPath, heldAside);
    assertPackError(
      'PACK_STORAGE_REJECTED',
      () => loadFrozenRuntimePolicy(sidecarBundle.script.versionId),
    );
    renameSync(heldAside, sidecarPath);
    assert.equal(readFileSync(sidecarPath, 'utf8'), sidecarRaw);

    const symlinkTarget = path.join(sidecarFiles.directory, 'runtime-policy.symlink-target.json');
    renameSync(sidecarPath, symlinkTarget);
    let symlinkCreated = false;
    try {
      symlinkSync(symlinkTarget, sidecarPath, 'file');
      symlinkCreated = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTSUP') throw error;
      t.diagnostic(`symlink assertion skipped on this host: ${code}`);
    }
    if (symlinkCreated) {
      assertPackError(
        'PACK_STORAGE_REJECTED',
        () => loadFrozenRuntimePolicy(sidecarBundle.script.versionId),
      );
      unlinkSync(sidecarPath);
    }
    renameSync(symlinkTarget, sidecarPath);

    database.prepare(`
      UPDATE pack_runtime_profiles SET canonical_payload_hash = ? WHERE version_id = ?
    `).run(`sha256:${'f'.repeat(64)}`, canonicalBundle.script.versionId);
    assertPackError(
      'PACK_STORAGE_REJECTED',
      () => loadInstalledPack(canonicalBundle.script.versionId),
    );
    assertPackError('PACK_NOT_AVAILABLE', () => loadInstalledPack('ver_ffffffff'));
  } finally {
    database.close();
    delete process.env.WISTERIA_DATA_DIR;
    cleanup(root);
  }
});
