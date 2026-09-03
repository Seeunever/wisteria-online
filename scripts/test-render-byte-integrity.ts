import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { getDatabase } from '../lib/db.ts';
import {
  loadFrozenBundle,
  loadFrozenContentSource,
  loadInstalledPack,
  PackAccessError,
  parseVerifiedWebpDimensions,
} from '../lib/packs.ts';
import {
  createRenderManifest,
  stringifyRenderManifest,
} from '../lib/render-manifest.ts';
import { syntheticBundle } from './runtime-policy-test-fixture.ts';

function payloadHash(value: string | Uint8Array) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function cleanup(root: string) {
  const resolved = realpathSync(root);
  const prefix = `${realpathSync(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(prefix) || !path.basename(resolved).startsWith('wisteria-render-bytes-')) {
    throw new Error('UNSAFE_TEST_CLEANUP_TARGET');
  }
  rmSync(resolved, { recursive: true, force: false });
}

function riff(chunks: Array<{ kind: string; bytes: Uint8Array }>) {
  const body = Buffer.concat([
    Buffer.from('WEBP'),
    ...chunks.flatMap(({ kind, bytes }) => {
      const header = Buffer.alloc(8);
      header.write(kind, 0, 4, 'ascii');
      header.writeUInt32LE(bytes.length, 4);
      return bytes.length % 2 === 0
        ? [header, Buffer.from(bytes)]
        : [header, Buffer.from(bytes), Buffer.from([0])];
    }),
  ]);
  const file = Buffer.alloc(8);
  file.write('RIFF', 0, 4, 'ascii');
  file.writeUInt32LE(body.length, 4);
  return Buffer.concat([file, body]);
}

test('content bytes are verified before return and WebP headers fail closed', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wisteria-render-bytes-')));
  process.env.WISTERIA_DATA_DIR = root;
  const database = getDatabase();
  try {
    const bundle = syntheticBundle({
      versionId: 'ver_eeeeeeee',
      canonicalPayloadHash: `sha256:${'e'.repeat(64)}`,
    });
    bundle.assets.asset_aaaaaaaa = {
      assetId: 'asset_aaaaaaaa',
      sourceIds: ['src_aaaaaaaa'],
    };
    bundle.contentBlocks.cnt_aaaaaaaa = {
      contentId: 'cnt_aaaaaaaa',
      kind: 'image',
      payload: {},
      assetIds: ['asset_aaaaaaaa'],
      classification: { level: 'L1', compartments: [], taintSourceIds: ['src_aaaaaaaa'] },
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
    const renderedBytes = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 1, g: 2, b: 3, alpha: 1 },
      },
    }).webp({ lossless: true }).toBuffer();
    assert.deepEqual(parseVerifiedWebpDimensions(renderedBytes), { width: 1, height: 1 });
    assert.equal(parseVerifiedWebpDimensions(Buffer.from('not-riff')), null);
    assert.equal(parseVerifiedWebpDimensions(riff([{
      kind: 'VP8X',
      bytes: Buffer.alloc(10),
    }])), null);
    assert.equal(
      parseVerifiedWebpDimensions(Buffer.concat([renderedBytes, Buffer.from([0])])),
      null,
    );

    const bundleRaw = `${JSON.stringify(bundle)}\n`;
    const manifest = createRenderManifest(bundle, Buffer.from(bundleRaw), [{
      sourceId: 'src_aaaaaaaa',
      pageId: 'page_aaaaaaaa',
      mediaType: 'image/webp',
      sha256: payloadHash(renderedBytes),
      byteLength: renderedBytes.length,
      width: 1,
      height: 1,
    }]);
    const manifestRaw = stringifyRenderManifest(manifest);
    const versionDirectory = path.join(root, 'packs', bundle.script.versionId);
    const objectsDirectory = path.join(versionDirectory, 'objects');
    mkdirSync(objectsDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(versionDirectory, 'bundle.internal.json'), bundleRaw, { mode: 0o600 });
    writeFileSync(path.join(versionDirectory, 'render-manifest.internal.json'), manifestRaw, { mode: 0o600 });
    const objectPath = path.join(objectsDirectory, 'src_aaaaaaaa.page_aaaaaaaa.webp');
    writeFileSync(objectPath, renderedBytes, { mode: 0o600 });

    const now = Date.now();
    database.prepare(`
      INSERT INTO pack_versions
        (id, public_label, payload_path, source_hash, state, created_at, frozen_at)
      VALUES (?, ?, ?, ?, 'frozen', ?, ?)
    `).run(
      bundle.script.versionId,
      'Synthetic render bytes',
      `packs/${bundle.script.versionId}/bundle.internal.json`,
      bundle.script.canonicalPayloadHash,
      now,
      now,
    );
    database.prepare(`
      INSERT INTO pack_runtime_profiles
        (version_id, mode, canonical_payload_hash, bundle_payload_hash, created_at)
      VALUES (?, 'canonical', ?, ?, ?)
    `).run(
      bundle.script.versionId,
      bundle.script.canonicalPayloadHash,
      payloadHash(bundleRaw),
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
      bundle.script.versionId,
      bundle.script.canonicalPayloadHash,
      payloadHash(bundleRaw),
      'wisteria-render-manifest/1.0',
      `packs/${bundle.script.versionId}/render-manifest.internal.json`,
      payloadHash(manifestRaw),
      manifest.renderManifestHash,
      now,
    );

    assert.doesNotThrow(() => loadInstalledPack(bundle.script.versionId));
    const content = loadFrozenContentSource(bundle.script.versionId, 'cnt_aaaaaaaa', 0);
    writeFileSync(objectPath, Buffer.from('replacement'), { mode: 0o600 });
    assert.deepEqual(content.sourceBytes, renderedBytes);
    assert.deepEqual(await sharp(content.sourceBytes).metadata(), await sharp(renderedBytes).metadata());
    assert.doesNotThrow(() => loadInstalledPack(bundle.script.versionId));
    assert.throws(
      () => loadFrozenContentSource(bundle.script.versionId, 'cnt_aaaaaaaa', 0),
      (error) => error instanceof PackAccessError && error.code === 'PACK_STORAGE_REJECTED',
    );
    assert.throws(
      () => loadFrozenBundle(bundle.script.versionId),
      (error) => error instanceof PackAccessError && error.code === 'PACK_STORAGE_REJECTED',
    );
    writeFileSync(objectPath, renderedBytes, { mode: 0o600 });
    const extraObjectPath = path.join(objectsDirectory, 'src_bbbbbbbb.page_bbbbbbbb.webp');
    writeFileSync(extraObjectPath, renderedBytes, { mode: 0o600 });
    assert.throws(
      () => loadInstalledPack(bundle.script.versionId),
      (error) => error instanceof PackAccessError && error.code === 'PACK_STORAGE_REJECTED',
    );
    unlinkSync(extraObjectPath);
    unlinkSync(objectPath);
    assert.throws(
      () => loadInstalledPack(bundle.script.versionId),
      (error) => error instanceof PackAccessError && error.code === 'PACK_STORAGE_REJECTED',
    );
  } finally {
    database.close();
    delete process.env.WISTERIA_DATA_DIR;
    cleanup(root);
  }
});
