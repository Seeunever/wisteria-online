import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BlindBundle, ContentBlock } from '../lib/blind-runtime.ts';

if (process.argv[2] === '--cleanup') {
  const requested = process.argv[3];
  if (!requested) throw new Error('MISSING_QA_CLEANUP_TARGET');
  const resolved = realpathSync(requested);
  const temporaryRoot = realpathSync(os.tmpdir());
  if (
    !resolved.startsWith(`${temporaryRoot}${path.sep}`)
    || !path.basename(resolved).startsWith('wisteria-ui-smoke-')
  ) throw new Error('UNSAFE_QA_CLEANUP_TARGET');
  rmSync(resolved, { recursive: true, force: false });
  process.stdout.write('SYNTHETIC_QA_CLEANED');
  process.exit(0);
}

const root = mkdtempSync(path.join(os.tmpdir(), 'wisteria-ui-smoke-'));
process.env.WISTERIA_DATA_DIR = root;
const { getDatabase } = await import('../lib/db.ts');
const database = getDatabase();
const now = Date.now();
const versionId = 'ver_11111111';
const roleId = 'role_11111111';
const stageId = 'stage_11111111';
const locationIds = ['loc_11111111', 'loc_22222222', 'loc_33333333'];
const clueIds = ['clue_11111111', 'clue_22222222', 'clue_33333333', 'clue_44444444'];
const playerGuideSourceId = 'src_11111111';
const hash = `sha256:${'1'.repeat(64)}`;

function content(
  contentId: string,
  text: string,
  level: 'L1' | 'L2',
  compartments: string[],
  grants: ContentBlock['visibility']['grants'],
): ContentBlock {
  return {
    contentId,
    kind: 'text',
    payload: { text },
    assetIds: [],
    classification: { level, compartments },
    visibility: { default: 'deny', grants },
    trace: { evidence: [], ocrExtractionId: null, reviewStatus: 'verified' },
  };
}

const memberGrant = [{
  principal: { kind: 'room_member' as const, subjectId: null },
  when: { op: 'always' as const },
}];
const contentBlocks: BlindBundle['contentBlocks'] = {
  cnt_11111111: content('cnt_11111111', '手机布局测试剧本', 'L1', [], memberGrant),
  cnt_22222222: content('cnt_22222222', '测试玩家', 'L1', [], memberGrant),
  cnt_33333333: content('cnt_33333333', '仅用于布局验证的角色说明。', 'L1', [], memberGrant),
  cnt_12121212: {
    ...content('cnt_12121212', '合成游戏说明：先确认阶段，再选择允许调查的地点。', 'L1', [], memberGrant),
    classification: {
      level: 'L1', compartments: [], taintSourceIds: [playerGuideSourceId],
    },
    trace: {
      evidence: [{
        sourceId: playerGuideSourceId,
        pageId: 'page_11111111',
        region: { unit: 'normalized', x: 0, y: 0, width: 1, height: 1 },
        side: 'single',
        readingOrder: 1,
      }],
      ocrExtractionId: null,
      reviewStatus: 'verified',
    },
  },
};
for (const index of locationIds.keys()) {
  const contentId = `cnt_${String(index + 4).repeat(8)}`;
  contentBlocks[contentId] = content(contentId, `测试地点 ${index + 1}`, 'L1', [], memberGrant);
}
for (const [index, clueId] of clueIds.entries()) {
  const contentId = `cnt_${String(index + 7).repeat(8)}`;
  contentBlocks[contentId] = content(contentId, `这是第 ${index + 1} 张合成线索，仅用于检查阅读布局。`, 'L2', [`clue:${clueId}`], [{
    principal: { kind: 'clue_holder', subjectId: clueId },
    when: { op: 'clue_held', clueId },
  }, {
    principal: { kind: 'room_after_event', subjectId: null },
    when: { op: 'clue_published', clueId },
  }]);
}

const bundle = {
  schemaVersion: 'blind-script/1.0',
  script: { versionId, titleContentId: 'cnt_11111111', canonicalPayloadHash: hash },
  sources: {
    [playerGuideSourceId]: {
      sourceId: playerGuideSourceId,
      mediaType: 'application/pdf',
      sha256: hash,
      byteLength: 1,
      sourceClass: { kind: 'player_rules', subjectId: null },
      classification: { status: 'verified', method: 'review', confidence: 1 },
      pages: [{
        pageId: 'page_11111111', index: 0, width: 1, height: 1, rotation: 0,
        sha256: `sha256:${'1'.repeat(64)}`,
      }],
    },
  },
  assets: {},
  contentBlocks,
  stages: {
    [stageId]: {
      stageId,
      sequence: 1,
      labelContentId: 'cnt_11111111',
      enterWhen: { op: 'always' },
      completeWhen: { op: 'always' },
      allowedActions: ['search'],
      locationIds,
      investigationFlow: {
        locationSelection: {
          mode: 'vote', scope: 'room_scoped', resolution: 'plurality_all_cast',
          tieBreak: 'seat_cursor_choice',
        },
        turnOrder: { mode: 'seat_order' },
        clueDeal: { mode: 'verified_pool_order', commit: 'one_per_turn' },
        acquisitionLimit: { scope: 'stage', perPlayer: 1 },
        publicationDuty: {
          predicate: 'round_scoped_private_holding_count',
          maxPrivateCount: 99,
          action: 'publish_one_held',
          blockedActions: ['vote_location', 'search'],
        },
      },
    },
  },
  locations: Object.fromEntries(locationIds.map((locationId, index) => ({
    locationId,
    nameContentId: `cnt_${String(index + 4).repeat(8)}`,
    availableWhen: { op: 'stage_active', stageId },
    searchPolicy: {
      mode: 'draw_without_replacement', perPlayerLimit: 8, globalLimit: 8, resetAtStageIds: [],
    },
    cluePool: clueIds.map((clueId, order) => ({
      clueId, order: order + 1, copies: 1, availableWhen: { op: 'always' },
    })),
  })).map((location) => [location.locationId, location])),
  clues: Object.fromEntries(clueIds.map((clueId, index) => [clueId, {
    clueId,
    kind: 'card',
    faces: [{
      faceId: `face_${String(index + 1).repeat(8)}`,
      side: 'single',
      assetIds: [],
      contentIds: [`cnt_${String(index + 7).repeat(8)}`],
      revealWhen: { op: 'clue_held', clueId },
    }],
    acquisition: { when: { op: 'always' }, initialAudience: 'holder' },
    publication: {
      allowed: true,
      publishWhen: { op: 'clue_held', clueId },
      revealedFaceIds: [`face_${String(index + 1).repeat(8)}`],
    },
  }])),
  hostPack: { releasePlan: [] },
  roles: {
    [roleId]: {
      roleId,
      slot: 1,
      displayNameContentId: 'cnt_22222222',
      sections: [{
        sectionId: 'section_11111111',
        kind: 'lobby_profile',
        stageId,
        order: 1,
        contentIds: ['cnt_33333333'],
        unlockWhen: { op: 'always' },
      }],
    },
  },
} as unknown as BlindBundle;

const packDirectory = path.join(root, 'packs', versionId);
mkdirSync(packDirectory, { recursive: true, mode: 0o700 });
writeFileSync(path.join(packDirectory, 'bundle.internal.json'), JSON.stringify(bundle), { mode: 0o600 });

const userId = randomUUID();
const membershipId = randomUUID();
const roomId = randomUUID();
const deviceToken = randomBytes(32).toString('base64url');
database.prepare(`
  INSERT INTO users (id, username_key, display_name, password_salt, password_hash, created_at)
  VALUES (?, 'ui-player', '手机测试玩家', '', '', ?)
`).run(userId, now);
database.prepare(`
  INSERT INTO device_credentials (user_id, token_hash, created_at, last_used_at)
  VALUES (?, ?, ?, ?)
`).run(userId, createHash('sha256').update(deviceToken, 'ascii').digest('hex'), now, now);
database.prepare(`
  INSERT INTO pack_versions (id, public_label, payload_path, source_hash, state, created_at, frozen_at)
  VALUES (?, '合成布局测试', ?, ?, 'frozen', ?, ?)
`).run(versionId, `packs/${versionId}/bundle.internal.json`, hash, now, now);
database.prepare(`
  INSERT INTO rooms (id, code, owner_user_id, version_id, status, authorization_version, created_at)
  VALUES (?, 'Q2A3B7', ?, ?, 'running', 1, ?)
`).run(roomId, userId, versionId, now);
database.prepare(`
  INSERT INTO memberships (id, room_id, user_id, joined_at) VALUES (?, ?, ?, ?)
`).run(membershipId, roomId, userId, now);
database.prepare(`
  INSERT INTO role_assignments (room_id, role_id, membership_id, assigned_at) VALUES (?, ?, ?, ?)
`).run(roomId, roleId, membershipId, now);
database.prepare(`
  INSERT INTO room_stages (room_id, stage_id, sequence, entered_at) VALUES (?, ?, 1, ?)
`).run(roomId, stageId, now);
database.close();

process.stdout.write(JSON.stringify({ root, deviceToken, roomCode: 'Q2A3B7' }));
