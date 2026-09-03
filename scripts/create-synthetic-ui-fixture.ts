import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { BlindBundle, ContentBlock, EvidenceRegion } from '../lib/blind-runtime.ts';
import {
  finalizeRuntimePolicy,
  serializeRuntimePolicy,
  type RuntimePolicyDraft,
} from '../lib/investigation/runtime-policy.ts';
import {
  createRenderManifest,
  stringifyRenderManifest,
  type RenderManifestObjectV1,
} from '../lib/render-manifest.ts';

const PREFIX = 'wisteria-ui-smoke-';
const WIDTH = 320;
const HEIGHT = 480;

function sha256(value: string | Uint8Array) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SYNTHETIC_FIXTURE_NUMBER_REJECTED');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('SYNTHETIC_FIXTURE_VALUE_REJECTED');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function safeCleanup(requested: string) {
  const resolved = realpathSync(requested);
  const temporaryRoot = realpathSync(os.tmpdir());
  if (!resolved.startsWith(`${temporaryRoot}${path.sep}`) || !path.basename(resolved).startsWith(PREFIX)) {
    throw new Error('UNSAFE_QA_CLEANUP_TARGET');
  }
  rmSync(resolved, { recursive: true, force: false });
}

if (process.argv[2] === '--cleanup') {
  const requested = process.argv[3];
  if (!requested) throw new Error('MISSING_QA_CLEANUP_TARGET');
  safeCleanup(requested);
  process.stdout.write(JSON.stringify({ code: 'SYNTHETIC_QA_CLEANED', status: 'ok' }));
  process.exit(0);
}

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), PREFIX)));
process.env.WISTERIA_DATA_DIR = root;
const ids = {
  version: 'ver_11111111', roomCode: 'Q2A3B7', stage: 'stage_11111111',
  roles: ['role_11111111', 'role_22222222'],
  locations: ['loc_11111111', 'loc_22222222', 'loc_33333333'],
  clues: ['clue_11111111', 'clue_22222222', 'clue_33333333', 'clue_44444444'],
} as const;
const always = { op: 'always' } as const;
const memberGrant: ContentBlock['visibility']['grants'] = [{
  principal: { kind: 'room_member', subjectId: null }, when: always,
}];

function textBlock(contentId: string, text: string): ContentBlock {
  return {
    contentId, kind: 'text', payload: { text }, assetIds: [],
    classification: { level: 'L1', compartments: [] },
    visibility: { default: 'deny', grants: memberGrant },
    trace: { evidence: [], ocrExtractionId: null, reviewStatus: 'verified' },
  };
}

type SyntheticClue = {
  clueId: string; locationId: string; sourceId: string; assetId: string;
  backPageId: string; frontPageId: string; backContentId: string; frontContentId: string;
  backColor: string; frontColor: string;
};
const clueDefinitions: SyntheticClue[] = [
  { clueId: ids.clues[0], locationId: ids.locations[0], sourceId: 'src_11111111', assetId: 'asset_11111111', backPageId: 'page_11111111', frontPageId: 'page_a1111111', backContentId: 'cnt_11111111', frontContentId: 'cnt_a1111111', backColor: '#2e2358', frontColor: '#e7c16e' },
  { clueId: ids.clues[1], locationId: ids.locations[0], sourceId: 'src_22222222', assetId: 'asset_22222222', backPageId: 'page_22222222', frontPageId: 'page_a2222222', backContentId: 'cnt_22222222', frontContentId: 'cnt_a2222222', backColor: '#16495c', frontColor: '#d68258' },
  { clueId: ids.clues[2], locationId: ids.locations[1], sourceId: 'src_33333333', assetId: 'asset_33333333', backPageId: 'page_33333333', frontPageId: 'page_a3333333', backContentId: 'cnt_33333333', frontContentId: 'cnt_a3333333', backColor: '#354c2c', frontColor: '#d6b04b' },
  { clueId: ids.clues[3], locationId: ids.locations[2], sourceId: 'src_44444444', assetId: 'asset_44444444', backPageId: 'page_44444444', frontPageId: 'page_a4444444', backContentId: 'cnt_44444444', frontContentId: 'cnt_a4444444', backColor: '#5c2634', frontColor: '#a9d5d8' },
];

function evidence(sourceId: string, pageId: string, side: 'back' | 'front'): EvidenceRegion {
  return { sourceId, pageId, region: { unit: 'normalized', x: 0, y: 0, width: 1, height: 1 }, side, readingOrder: 1 };
}

function imageBlock(input: { contentId: string; clueId: string; sourceId: string; assetId: string; pageId: string; side: 'back' | 'front' }): ContentBlock {
  const isBack = input.side === 'back';
  return {
    contentId: input.contentId, kind: 'image', payload: {}, assetIds: [input.assetId],
    classification: isBack
      ? { level: 'L1', compartments: [], taintSourceIds: [input.sourceId] }
      : { level: 'L2', compartments: [`clue:${input.clueId}`], taintSourceIds: [input.sourceId] },
    visibility: isBack ? { default: 'deny', grants: memberGrant } : {
      default: 'deny',
      grants: [
        { principal: { kind: 'clue_holder', subjectId: input.clueId }, when: { op: 'clue_held', clueId: input.clueId } },
        { principal: { kind: 'room_after_event', subjectId: null }, when: { op: 'clue_published', clueId: input.clueId } },
      ],
    },
    trace: { evidence: [evidence(input.sourceId, input.pageId, input.side)], ocrExtractionId: null, reviewStatus: 'verified' },
  };
}

const contentBlocks: BlindBundle['contentBlocks'] = {
  cnt_99999999: textBlock('cnt_99999999', 'Synthetic two-player online QA'),
  cnt_88888888: textBlock('cnt_88888888', 'Alpha'), cnt_77777777: textBlock('cnt_77777777', 'Beta'),
  cnt_66666666: textBlock('cnt_66666666', 'Synthetic role cover A'), cnt_55555555: textBlock('cnt_55555555', 'Synthetic role cover B'),
  cnt_12121212: textBlock('cnt_12121212', 'Synthetic location A'), cnt_23232323: textBlock('cnt_23232323', 'Synthetic location B'), cnt_34343434: textBlock('cnt_34343434', 'Synthetic location C'),
};
for (const clue of clueDefinitions) {
  contentBlocks[clue.backContentId] = imageBlock({ contentId: clue.backContentId, clueId: clue.clueId, sourceId: clue.sourceId, assetId: clue.assetId, pageId: clue.backPageId, side: 'back' });
  contentBlocks[clue.frontContentId] = imageBlock({ contentId: clue.frontContentId, clueId: clue.clueId, sourceId: clue.sourceId, assetId: clue.assetId, pageId: clue.frontPageId, side: 'front' });
}

const provisionalBundle = {
  schemaVersion: 'blind-script/1.0',
  script: { versionId: ids.version, canonicalPayloadHash: '', titleContentId: 'cnt_99999999' },
  sources: Object.fromEntries(clueDefinitions.map((clue) => [clue.sourceId, {
    sourceId: clue.sourceId, mediaType: 'image/webp', sha256: '', byteLength: 0,
    sourceClass: { kind: 'clue_face', subjectId: clue.clueId }, classification: { status: 'verified', method: 'review', confidence: 1 },
    pages: [
      { pageId: clue.backPageId, index: 0, width: WIDTH, height: HEIGHT, rotation: 0, sha256: '' },
      { pageId: clue.frontPageId, index: 1, width: WIDTH, height: HEIGHT, rotation: 0, sha256: '' },
    ],
  }])),
  assets: Object.fromEntries(clueDefinitions.map((clue) => [clue.assetId, { assetId: clue.assetId, sourceIds: [clue.sourceId] }])),
  contentBlocks,
  stages: { [ids.stage]: { stageId: ids.stage, sequence: 1, labelContentId: 'cnt_99999999', enterWhen: always, completeWhen: always, allowedActions: ['search', 'publish_clue'], locationIds: ids.locations } },
  locations: Object.fromEntries(ids.locations.map((locationId, locationIndex) => [locationId, {
    locationId, nameContentId: ['cnt_12121212', 'cnt_23232323', 'cnt_34343434'][locationIndex], availableWhen: always,
    searchPolicy: { mode: 'draw_without_replacement', perPlayerLimit: 9, globalLimit: 9, resetAtStageIds: [] },
    cluePool: clueDefinitions.filter((clue) => clue.locationId === locationId).map((clue, index) => ({ clueId: clue.clueId, order: index + 1, copies: 1, availableWhen: always })),
  }])),
  clues: Object.fromEntries(clueDefinitions.map((clue) => [clue.clueId, {
    clueId: clue.clueId, kind: 'synthetic_card',
    faces: [
      { faceId: `face_b${clue.clueId.slice(5)}`, side: 'back', assetIds: [clue.assetId], contentIds: [clue.backContentId], revealWhen: always },
      { faceId: `face_f${clue.clueId.slice(5)}`, side: 'front', assetIds: [clue.assetId], contentIds: [clue.frontContentId], revealWhen: { op: 'clue_held', clueId: clue.clueId } },
    ],
    acquisition: { when: always, initialAudience: 'holder' },
    publication: { allowed: true, publishWhen: { op: 'clue_held', clueId: clue.clueId }, revealedFaceIds: [] },
  }])),
  hostPack: { releasePlan: [] },
  roles: {
    [ids.roles[0]]: { roleId: ids.roles[0], slot: 1, displayNameContentId: 'cnt_88888888', sections: [{ sectionId: 'section_11111111', kind: 'lobby_profile', stageId: ids.stage, order: 1, contentIds: ['cnt_66666666'], unlockWhen: always }] },
    [ids.roles[1]]: { roleId: ids.roles[1], slot: 2, displayNameContentId: 'cnt_77777777', sections: [{ sectionId: 'section_22222222', kind: 'lobby_profile', stageId: ids.stage, order: 1, contentIds: ['cnt_55555555'], unlockWhen: always }] },
  },
} as unknown as BlindBundle;

const packDirectory = path.join(root, 'packs', ids.version);
const objectsDirectory = path.join(packDirectory, 'objects');
mkdirSync(objectsDirectory, { recursive: true, mode: 0o700 });
const renderedObjects: RenderManifestObjectV1[] = [];
for (const clue of clueDefinitions) {
  for (const page of [{ pageId: clue.backPageId, color: clue.backColor }, { pageId: clue.frontPageId, color: clue.frontColor }]) {
    const bytes = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: page.color } }).webp({ quality: 88 }).toBuffer();
    const object: RenderManifestObjectV1 = { sourceId: clue.sourceId, pageId: page.pageId, mediaType: 'image/webp', sha256: sha256(bytes), byteLength: bytes.length, width: WIDTH, height: HEIGHT };
    writeFileSync(path.join(objectsDirectory, `${object.sourceId}.${object.pageId}.webp`), bytes, { mode: 0o600, flag: 'wx' });
    renderedObjects.push(object);
  }
}
for (const clue of clueDefinitions) {
  const source = provisionalBundle.sources[clue.sourceId];
  const backObject = renderedObjects.find((object) => object.sourceId === clue.sourceId && object.pageId === clue.backPageId);
  const frontObject = renderedObjects.find((object) => object.sourceId === clue.sourceId && object.pageId === clue.frontPageId);
  if (!source || !backObject || !frontObject) throw new Error('SYNTHETIC_RENDER_OBJECT_MISSING');
  source.sha256 = sha256(`${backObject.sha256}:${frontObject.sha256}`);
  source.byteLength = backObject.byteLength + frontObject.byteLength;
  source.pages[0].sha256 = backObject.sha256;
  source.pages[1].sha256 = frontObject.sha256;
}
const canonicalPayloadHash = sha256(canonicalJson({ ...provisionalBundle, script: { ...provisionalBundle.script, canonicalPayloadHash: null } }));
provisionalBundle.script.canonicalPayloadHash = canonicalPayloadHash;
const bundle = provisionalBundle as BlindBundle;
const bundleBytes = Buffer.from(`${canonicalJson(bundle)}\n`, 'utf8');
writeFileSync(path.join(packDirectory, 'bundle.internal.json'), bundleBytes, { mode: 0o600, flag: 'wx' });

const policyDraft: RuntimePolicyDraft = {
  schemaVersion: 'wisteria-runtime-policy/1.0', versionId: ids.version, canonicalPayloadHash, capabilityMode: 'canonical_upper_bound',
  stageMechanisms: { [ids.stage]: {
    kind: 'collective_vote_rotating_blind_draw', version: 2,
    config: {
      cursor: { roleIds: [...ids.roles], requireFullRoleAssignment: true, carryAcrossStages: true, advanceAfter: 'successful_acquisition' },
      exhaustedLocationScope: 'stage',
      selection: { mode: 'collective_location_vote', ballotCompletion: 'all_active_assigned_members', resolution: 'plurality', tieBreak: 'current_cursor_choice', locationsToExhaust: 1 },
      candidateLocationIds: [...ids.locations],
      locationClueIds: Object.fromEntries(ids.locations.map((locationId) => [locationId, clueDefinitions.filter((clue) => clue.locationId === locationId).map((clue) => clue.clueId)])),
      draw: { mode: 'blind_choice_without_replacement', exhaust: 'selected_location_pool', perTurnAcquisitionLimit: 1, visibleBeforeAcquire: 'back_face_only' },
      publication: { privateHoldingLimit: 9, countScope: 'room_lifetime', mandatoryClueIds: [], blockedActions: ['location_ballot', 'blind_draw', 'completion_ballot'] },
      roleRestrictions: [],
      completion: { mode: 'member_consent', threshold: 1, requires: ['search_scope_exhausted', 'publication_obligations_cleared'] },
    },
    evidence: [evidence(clueDefinitions[0].sourceId, clueDefinitions[0].backPageId, 'back')],
  } },
};
const policy = finalizeRuntimePolicy(policyDraft, bundle);
const policyBytes = Buffer.from(serializeRuntimePolicy(policy), 'utf8');
writeFileSync(path.join(packDirectory, 'runtime-policy.internal.json'), policyBytes, { mode: 0o600, flag: 'wx' });
const renderManifest = createRenderManifest(bundle, bundleBytes, renderedObjects);
const renderManifestBytes = Buffer.from(stringifyRenderManifest(renderManifest), 'utf8');
writeFileSync(path.join(packDirectory, 'render-manifest.internal.json'), renderManifestBytes, { mode: 0o600, flag: 'wx' });

const { getDatabase } = await import('../lib/db.ts');
const database = getDatabase();
const now = Date.now();
const users = [
  { id: randomUUID(), username: 'browser-alpha', displayName: 'Alpha', deviceToken: randomBytes(32).toString('base64url') },
  { id: randomUUID(), username: 'browser-beta', displayName: 'Beta', deviceToken: randomBytes(32).toString('base64url') },
];
const roomId = randomUUID();
const memberships = [randomUUID(), randomUUID()];
try {
  database.exec('BEGIN IMMEDIATE');
  for (const user of users) {
    database.prepare(`INSERT INTO users (id, username_key, display_name, password_salt, password_hash, created_at) VALUES (?, ?, ?, '', '', ?)`).run(user.id, user.username, user.displayName, now);
    database.prepare(`INSERT INTO device_credentials (user_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?)`).run(user.id, createHash('sha256').update(user.deviceToken, 'ascii').digest('hex'), now, now);
  }
  database.prepare(`INSERT INTO pack_versions (id, public_label, payload_path, source_hash, state, created_at, frozen_at) VALUES (?, 'Synthetic browser QA', ?, ?, 'frozen', ?, ?)`).run(ids.version, `packs/${ids.version}/bundle.internal.json`, canonicalPayloadHash, now, now);
  database.prepare(`INSERT INTO pack_runtime_profiles (version_id, mode, canonical_payload_hash, bundle_payload_hash, policy_schema, policy_path, policy_payload_hash, runtime_policy_hash, created_at) VALUES (?, 'sidecar', ?, ?, 'wisteria-runtime-policy/1.0', ?, ?, ?, ?)`).run(ids.version, canonicalPayloadHash, sha256(bundleBytes), `packs/${ids.version}/runtime-policy.internal.json`, sha256(policyBytes), policy.runtimePolicyHash, now);
  database.prepare(`INSERT INTO pack_render_profiles (version_id, mode, canonical_payload_hash, bundle_payload_hash, manifest_schema, manifest_path, manifest_payload_hash, render_manifest_hash, created_at) VALUES (?, 'manifest', ?, ?, 'wisteria-render-manifest/1.0', ?, ?, ?, ?)`).run(ids.version, canonicalPayloadHash, sha256(bundleBytes), `packs/${ids.version}/render-manifest.internal.json`, sha256(renderManifestBytes), renderManifest.renderManifestHash, now);
  database.prepare(`INSERT INTO rooms (id, code, owner_user_id, version_id, status, authorization_version, created_at) VALUES (?, ?, ?, ?, 'running', 1, ?)`).run(roomId, ids.roomCode, users[0].id, ids.version, now);
  for (let index = 0; index < users.length; index += 1) {
    database.prepare(`INSERT INTO memberships (id, room_id, user_id, joined_at) VALUES (?, ?, ?, ?)`).run(memberships[index], roomId, users[index].id, now + index);
    database.prepare(`INSERT INTO role_assignments (room_id, role_id, membership_id, assigned_at) VALUES (?, ?, ?, ?)`).run(roomId, ids.roles[index], memberships[index], now + index);
  }
  database.prepare(`INSERT INTO room_stages (room_id, stage_id, sequence, entered_at) VALUES (?, ?, 1, ?)`).run(roomId, ids.stage, now);
  database.exec('COMMIT');
} catch (error) {
  try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
  throw error;
} finally {
  database.close();
}

const selfCheckCode = [
  `process.env.WISTERIA_DATA_DIR=${JSON.stringify(root)};`,
  `const packs=await import(${JSON.stringify(new URL('../lib/packs.ts', import.meta.url).href)});`,
  `const loaded=packs.loadInstalledPack(${JSON.stringify(ids.version)});`,
  `const source=packs.loadFrozenContentSource(${JSON.stringify(ids.version)},${JSON.stringify(clueDefinitions[0].backContentId)},0);`,
  `if(loaded.runtimePolicy.stageMechanisms[${JSON.stringify(ids.stage)}]?.kind!=='collective_vote_rotating_blind_draw'||!source.sourceBytes?.length)process.exit(2);`,
  "process.stdout.write('ok');",
].join('');
const selfCheck = spawnSync(process.execPath, ['--experimental-loader', './scripts/server-only-test-loader.mjs', '--experimental-transform-types', '--input-type=module', '--eval', selfCheckCode], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, WISTERIA_DATA_DIR: root } });
if (selfCheck.status !== 0 || selfCheck.stdout !== 'ok') throw new Error('SYNTHETIC_PACK_SELF_CHECK_REJECTED');

process.stdout.write(`${JSON.stringify({
  code: 'SYNTHETIC_BROWSER_FIXTURE_READY', root, roomCode: ids.roomCode, authorizationVersion: 1,
  deviceTokens: { alpha: users[0].deviceToken, beta: users[1].deviceToken },
  ids: { versionId: ids.version, stageId: ids.stage, roleIds: ids.roles, locationIds: ids.locations, clueIds: ids.clues, backContentId: clueDefinitions[0].backContentId, frontContentId: clueDefinitions[0].frontContentId },
})}\n`);
