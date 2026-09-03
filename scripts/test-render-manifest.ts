import assert from 'node:assert/strict';
import test from 'node:test';
import type { BlindBundle } from '../lib/blind-runtime';
import {
  computeRenderManifestHash,
  createRenderManifest,
  MAX_RENDER_OBJECT_BYTES,
  MAX_RENDER_OBJECT_DIMENSION,
  parseRenderManifestJson,
  RenderManifestError,
  resolveRenderManifestObject,
  stringifyRenderManifest,
  type RenderManifestObjectV1,
  type RenderManifestV1,
} from '../lib/render-manifest.ts';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;
const HASH_D = `sha256:${'d'.repeat(64)}`;
const HASH_E = `sha256:${'e'.repeat(64)}`;
const HASH_F = `sha256:${'f'.repeat(64)}`;

const OBJECT_A: RenderManifestObjectV1 = {
  sourceId: 'src_aaaaaaaa',
  pageId: 'page_aaaaaaaa',
  mediaType: 'image/webp',
  sha256: HASH_D,
  byteLength: 123,
  width: 640,
  height: 960,
};

const OBJECT_B: RenderManifestObjectV1 = {
  sourceId: 'src_bbbbbbbb',
  pageId: 'page_bbbbbbbb',
  mediaType: 'image/webp',
  sha256: HASH_E,
  byteLength: 456,
  width: 800,
  height: 600,
};

const TEXT_ONLY_OBJECT: RenderManifestObjectV1 = {
  sourceId: 'src_aaaaaaaa',
  pageId: 'page_cccccccc',
  mediaType: 'image/webp',
  sha256: HASH_F,
  byteLength: 789,
  width: 320,
  height: 200,
};

function evidence(sourceId: string, pageId: string, readingOrder: number) {
  return {
    sourceId,
    pageId,
    region: { unit: 'normalized' as const, x: 0, y: 0, width: 1, height: 1 },
    side: 'single',
    readingOrder,
  };
}

function syntheticBundle(): BlindBundle {
  return {
    schemaVersion: 'blind-script/1.0',
    script: {
      versionId: 'ver_aaaaaaaa',
      canonicalPayloadHash: HASH_A,
      titleContentId: 'cnt_cccccccc',
    },
    sources: {
      src_aaaaaaaa: {
        sourceId: 'src_aaaaaaaa',
        mediaType: 'image/png',
        sha256: HASH_B,
        byteLength: 1000,
        pages: [
          {
            pageId: 'page_aaaaaaaa', index: 0, width: 640, height: 960, rotation: 0, sha256: HASH_B,
          },
          {
            pageId: 'page_cccccccc', index: 1, width: 320, height: 200, rotation: 0, sha256: HASH_C,
          },
        ],
      },
      src_bbbbbbbb: {
        sourceId: 'src_bbbbbbbb',
        mediaType: 'application/pdf',
        sha256: HASH_C,
        byteLength: 2000,
        pages: [{
          pageId: 'page_bbbbbbbb', index: 0, width: 800, height: 600, rotation: 0, sha256: HASH_C,
        }],
      },
    },
    assets: {
      asset_aaaaaaaa: {
        assetId: 'asset_aaaaaaaa',
        sourceIds: ['src_aaaaaaaa'],
        pageObjects: [OBJECT_A, TEXT_ONLY_OBJECT],
      },
      asset_bbbbbbbb: {
        assetId: 'asset_bbbbbbbb',
        sourceIds: ['src_bbbbbbbb'],
        pageObjects: [OBJECT_B],
      },
      asset_cccccccc: {
        assetId: 'asset_cccccccc',
        sourceIds: ['src_aaaaaaaa'],
        pageObjects: [TEXT_ONLY_OBJECT],
      },
    },
    contentBlocks: {
      cnt_aaaaaaaa: {
        contentId: 'cnt_aaaaaaaa',
        kind: 'image',
        payload: {},
        assetIds: ['asset_aaaaaaaa'],
        classification: { level: 'L1', compartments: [], taintSourceIds: ['src_aaaaaaaa'] },
        visibility: { default: 'deny', grants: [] },
        trace: {
          evidence: [evidence('src_aaaaaaaa', 'page_aaaaaaaa', 1)],
          ocrExtractionId: null,
          reviewStatus: 'verified',
        },
      },
      cnt_bbbbbbbb: {
        contentId: 'cnt_bbbbbbbb',
        kind: 'image',
        payload: {},
        assetIds: ['asset_bbbbbbbb'],
        classification: { level: 'L2', compartments: [], taintSourceIds: ['src_bbbbbbbb'] },
        visibility: { default: 'deny', grants: [] },
        trace: {
          evidence: [evidence('src_bbbbbbbb', 'page_bbbbbbbb', 1)],
          ocrExtractionId: null,
          reviewStatus: 'verified',
        },
      },
      cnt_cccccccc: {
        contentId: 'cnt_cccccccc',
        kind: 'text',
        payload: { text: 'synthetic' },
        assetIds: ['asset_cccccccc'],
        classification: { level: 'L0', compartments: [], taintSourceIds: ['src_aaaaaaaa'] },
        visibility: { default: 'deny', grants: [] },
        trace: {
          evidence: [evidence('src_aaaaaaaa', 'page_cccccccc', 1)],
          ocrExtractionId: null,
          reviewStatus: 'verified',
        },
      },
    },
    stages: {},
    locations: {},
    clues: {},
    hostPack: { releasePlan: [] },
    roles: {},
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    return `{${Object.keys(candidate).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(candidate[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rehash(value: RenderManifestV1) {
  const draft = {
    schemaVersion: value.schemaVersion,
    versionId: value.versionId,
    canonicalPayloadHash: value.canonicalPayloadHash,
    bundlePayloadHash: value.bundlePayloadHash,
    objects: value.objects,
  };
  return { ...draft, renderManifestHash: computeRenderManifestHash(draft) };
}

function raw(value: unknown) {
  return `${canonicalJson(value)}\n`;
}

function assertManifestError(code: RenderManifestError['code'], action: () => unknown) {
  assert.throws(action, (error) => error instanceof RenderManifestError && error.code === code);
}

test('render manifest creation is deterministic, sorted, bound, and resolvable by image part', () => {
  const bundle = syntheticBundle();
  const bundleRaw = JSON.stringify(bundle);
  const input = [clone(OBJECT_B), clone(OBJECT_A)];
  const before = JSON.stringify(input);
  const manifest = createRenderManifest(bundle, bundleRaw, input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(manifest.objects, [OBJECT_A, OBJECT_B]);
  const serialized = stringifyRenderManifest(manifest);
  assert.deepEqual(parseRenderManifestJson(serialized, bundle, bundleRaw), manifest);
  assert.deepEqual(resolveRenderManifestObject(manifest, bundle, 'cnt_aaaaaaaa', 0), OBJECT_A);
  assert.deepEqual(resolveRenderManifestObject(manifest, bundle, 'cnt_bbbbbbbb', 0), OBJECT_B);
  assert.equal(resolveRenderManifestObject(manifest, bundle, 'cnt_cccccccc', 0), null);
  assert.equal(resolveRenderManifestObject(manifest, bundle, 'cnt_aaaaaaaa', 1), null);
});

test('missing, extra, duplicate, and unsorted object sets fail closed', () => {
  const bundle = syntheticBundle();
  const bundleRaw = JSON.stringify(bundle);
  const manifest = createRenderManifest(bundle, bundleRaw, [OBJECT_A, OBJECT_B]);

  const missing = clone(manifest) as RenderManifestV1;
  (missing as unknown as { objects: RenderManifestObjectV1[] }).objects = [OBJECT_A];
  assertManifestError(
    'RENDER_MANIFEST_REFERENCE_MISMATCH',
    () => parseRenderManifestJson(raw(rehash(missing)), bundle, bundleRaw),
  );

  const extra = clone(manifest) as RenderManifestV1;
  (extra as unknown as { objects: RenderManifestObjectV1[] }).objects = [
    OBJECT_A,
    TEXT_ONLY_OBJECT,
    OBJECT_B,
  ];
  assertManifestError(
    'RENDER_MANIFEST_REFERENCE_MISMATCH',
    () => parseRenderManifestJson(raw(rehash(extra)), bundle, bundleRaw),
  );

  const duplicate = clone(manifest) as RenderManifestV1;
  (duplicate as unknown as { objects: RenderManifestObjectV1[] }).objects = [
    OBJECT_A,
    OBJECT_A,
    OBJECT_B,
  ];
  assertManifestError(
    'MALFORMED_RENDER_MANIFEST',
    () => parseRenderManifestJson(raw(duplicate), bundle, bundleRaw),
  );

  const unsorted = clone(manifest) as RenderManifestV1;
  (unsorted as unknown as { objects: RenderManifestObjectV1[] }).objects = [OBJECT_B, OBJECT_A];
  assertManifestError(
    'MALFORMED_RENDER_MANIFEST',
    () => parseRenderManifestJson(raw(unsorted), bundle, bundleRaw),
  );
});

test('metadata and bundle binding mismatches fail closed', () => {
  const bundle = syntheticBundle();
  const bundleRaw = JSON.stringify(bundle);
  const manifest = createRenderManifest(bundle, bundleRaw, [OBJECT_A, OBJECT_B]);

  const dimensions = clone(manifest) as RenderManifestV1;
  (dimensions.objects[0] as { width: number }).width = 641;
  assertManifestError(
    'RENDER_MANIFEST_REFERENCE_MISMATCH',
    () => parseRenderManifestJson(raw(rehash(dimensions)), bundle, bundleRaw),
  );

  const objectHash = clone(manifest) as RenderManifestV1;
  (objectHash.objects[0] as { sha256: string }).sha256 = HASH_F;
  assertManifestError(
    'RENDER_MANIFEST_REFERENCE_MISMATCH',
    () => parseRenderManifestJson(raw(rehash(objectHash)), bundle, bundleRaw),
  );

  for (const changed of [
    { ...clone(manifest), versionId: 'ver_bbbbbbbb' },
    { ...clone(manifest), canonicalPayloadHash: HASH_B },
    { ...clone(manifest), bundlePayloadHash: HASH_C },
  ]) {
    const rebound = rehash(changed as RenderManifestV1);
    assertManifestError(
      'RENDER_MANIFEST_BINDING_MISMATCH',
      () => parseRenderManifestJson(raw(rebound), bundle, bundleRaw),
    );
  }
});

test('only image evidence requires objects and every image evidence source needs asset authority', () => {
  const bundle = syntheticBundle();
  const bundleRaw = JSON.stringify(bundle);
  assert.doesNotThrow(() => createRenderManifest(bundle, bundleRaw, [OBJECT_A, OBJECT_B]));
  assertManifestError(
    'RENDER_MANIFEST_REFERENCE_MISMATCH',
    () => createRenderManifest(bundle, bundleRaw, [OBJECT_A, TEXT_ONLY_OBJECT, OBJECT_B]),
  );

  const unauthorized = syntheticBundle();
  unauthorized.contentBlocks.cnt_aaaaaaaa.assetIds = ['asset_bbbbbbbb'];
  assertManifestError(
    'RENDER_MANIFEST_REFERENCE_MISMATCH',
    () => createRenderManifest(unauthorized, JSON.stringify(unauthorized), [OBJECT_A, OBJECT_B]),
  );

  const missingPage = syntheticBundle();
  missingPage.contentBlocks.cnt_aaaaaaaa.trace.evidence[0].pageId = 'page_dddddddd';
  assertManifestError(
    'RENDER_MANIFEST_REFERENCE_MISMATCH',
    () => createRenderManifest(missingPage, JSON.stringify(missingPage), [OBJECT_A, OBJECT_B]),
  );
});

test('unknown fields, invalid bounds, and non-canonical JSON are rejected', () => {
  const bundle = syntheticBundle();
  const bundleRaw = JSON.stringify(bundle);
  const manifest = createRenderManifest(bundle, bundleRaw, [OBJECT_A, OBJECT_B]);

  assertManifestError(
    'MALFORMED_RENDER_MANIFEST',
    () => parseRenderManifestJson(raw({ ...manifest, command: 'synthetic' }), bundle, bundleRaw),
  );
  const objectExtra = clone(manifest) as RenderManifestV1;
  (objectExtra.objects[0] as unknown as Record<string, unknown>).command = 'synthetic';
  assertManifestError(
    'MALFORMED_RENDER_MANIFEST',
    () => parseRenderManifestJson(raw(objectExtra), bundle, bundleRaw),
  );
  for (const invalid of [
    { ...OBJECT_A, byteLength: 0 },
    { ...OBJECT_A, byteLength: MAX_RENDER_OBJECT_BYTES + 1 },
    { ...OBJECT_A, width: 0 },
    { ...OBJECT_A, height: MAX_RENDER_OBJECT_DIMENSION + 1 },
    { ...OBJECT_A, mediaType: 'image/png' },
    { ...OBJECT_A, sha256: 'invalid' },
  ]) {
    assertManifestError(
      'MALFORMED_RENDER_MANIFEST',
      () => createRenderManifest(bundle, bundleRaw, [invalid, OBJECT_B]),
    );
  }
  assertManifestError(
    'RENDER_MANIFEST_NOT_CANONICAL',
    () => parseRenderManifestJson(JSON.stringify(manifest), bundle, bundleRaw),
  );
});

test('tampered render manifest hash is rejected', () => {
  const bundle = syntheticBundle();
  const bundleRaw = JSON.stringify(bundle);
  const manifest = createRenderManifest(bundle, bundleRaw, [OBJECT_A, OBJECT_B]);
  assertManifestError(
    'RENDER_MANIFEST_HASH_MISMATCH',
    () => parseRenderManifestJson(raw({ ...manifest, renderManifestHash: HASH_F }), bundle, bundleRaw),
  );
});
