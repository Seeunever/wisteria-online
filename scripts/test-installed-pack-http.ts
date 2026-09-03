import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type {
  AuthorizationContext,
  BlindBundle,
  ProjectedContent,
} from '../lib/blind-runtime.ts';

type RuntimeModule = typeof import('../lib/blind-runtime.ts');
type Clue = BlindBundle['clues'][string];
type ProjectedClue = ReturnType<RuntimeModule['projectVisibleClues']>[number];

let phase = 'setup';

function blocked(): never {
  process.stdout.write(JSON.stringify({
    code: 'BLOCKED_SPOILER_SAFETY',
    status: 'blocked',
    phase,
  }) + '\n');
  process.exit(2);
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) blocked();
  return value;
}

try {
  phase = 'setup-environment';
  const root = realpathSync(requiredEnvironment('QA_ROOT'));
  const release = realpathSync(requiredEnvironment('QA_RELEASE'));
  const base = requiredEnvironment('QA_BASE');
  const logPath = requiredEnvironment('QA_LOG');
  const runtime = await import(
    pathToFileURL(path.join(release, 'lib/blind-runtime.ts')).href
  ) as RuntimeModule;
  phase = 'setup-database';
  const databaseModule = await import(
    pathToFileURL(path.join(release, 'lib/db.ts')).href
  ) as typeof import('../lib/db.ts');
  databaseModule.getDatabase();
  const database = new DatabaseSync(path.join(root, 'wisteria.sqlite3'));
  const packRow = database.prepare(`
    SELECT id AS versionId, payload_path AS payloadPath
    FROM pack_versions
    WHERE state = 'frozen'
    ORDER BY frozen_at DESC, created_at DESC
    LIMIT 1
  `).get() as { versionId: string; payloadPath: string } | undefined;
  if (!packRow) blocked();
  phase = 'setup-bundle';
  const bundle = JSON.parse(
    readFileSync(realpathSync(path.resolve(root, packRow.payloadPath)), 'utf8'),
  ) as BlindBundle;
  const roles = Object.values(bundle.roles).sort((left, right) => left.slot - right.slot);
  const stages = Object.values(bundle.stages).sort(
    (left, right) => left.sequence - right.sequence,
  );
  if (roles.length < 2 || stages.length < 1) blocked();

  phase = 'setup-users';
  const now = Date.now();
  const users = roles.map((_, index) => ({
    id: randomUUID(),
    membershipId: randomUUID(),
    runningMembershipId: randomUUID(),
    token: randomBytes(32).toString('base64url'),
    index,
  }));
  const tokenHash = (token: string) => createHash('sha256').update(token, 'ascii').digest('hex');
  const insertUser = database.prepare(`
    INSERT INTO users
      (id, username_key, display_name, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, '', '', ?)
  `);
  const insertSession = database.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const user of users) {
    insertUser.run(
      user.id,
      `qa-${user.index}-${user.id.slice(0, 8)}`,
      `QA Player ${user.index + 1}`,
      now,
    );
    insertSession.run(tokenHash(user.token), user.id, now, now + 3_600_000);
  }

  phase = 'setup-rooms';
  const lobbyRoom = { id: randomUUID(), code: 'Q2A3B4' };
  const runningRoom = { id: randomUUID(), code: 'Q2A3B5' };
  const deleteRoom = { id: randomUUID(), code: 'Q2A3B6' };
  const insertRoom = database.prepare(`
    INSERT INTO rooms
      (id, code, owner_user_id, version_id, status, authorization_version, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `);
  insertRoom.run(lobbyRoom.id, lobbyRoom.code, users[0].id, packRow.versionId, 'lobby', now);
  insertRoom.run(runningRoom.id, runningRoom.code, users[0].id, packRow.versionId, 'running', now);
  insertRoom.run(deleteRoom.id, deleteRoom.code, users[0].id, packRow.versionId, 'lobby', now);
  const insertMembership = database.prepare(`
    INSERT INTO memberships (id, room_id, user_id, joined_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const user of users) {
    insertMembership.run(user.membershipId, lobbyRoom.id, user.id, now);
    insertMembership.run(user.runningMembershipId, runningRoom.id, user.id, now);
    database.prepare(`
      INSERT INTO role_assignments (room_id, role_id, membership_id, assigned_at)
      VALUES (?, ?, ?, ?)
    `).run(runningRoom.id, roles[user.index].roleId, user.runningMembershipId, now);
  }
  phase = 'setup-stage';
  const deleteOwnerMembership = randomUUID();
  const deleteGuestMembership = randomUUID();
  insertMembership.run(deleteOwnerMembership, deleteRoom.id, users[0].id, now);
  insertMembership.run(deleteGuestMembership, deleteRoom.id, users[1].id, now);
  database.prepare(`
    INSERT INTO room_stages (room_id, stage_id, sequence, entered_at)
    VALUES (?, ?, ?, ?)
  `).run(runningRoom.id, stages[0].stageId, stages[0].sequence, now);

  const cookie = (user: typeof users[number]) => ({ cookie: `wisteria_session=${user.token}` });
  const get = (url: string, user: typeof users[number]) => fetch(base + url, {
    headers: cookie(user),
    redirect: 'manual',
    signal: AbortSignal.timeout(5_000),
  });
  const post = (url: string, user: typeof users[number], values: Record<string, string>) => fetch(
    base + url,
    {
      method: 'POST',
      headers: {
        ...cookie(user),
        origin: base,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(values),
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    },
  );
  const escaped = (text: string) => text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const markerVisible = (content: ProjectedContent, html: string) => content.kind === 'image'
    ? html.includes(`/content/${content.contentId}`)
    : html.includes(escaped(content.text));

  const empty = new Set<string>();
  const lobbyContext = {
    joined: true,
    assignedRoleId: null,
    assignedRoleIds: empty,
    activeStageId: null,
    reachedStageIds: empty,
    heldClueIds: empty,
    roomHeldClueIds: empty,
    publishedClueIds: empty,
    hostReleaseIds: empty,
    sessionCompleted: false,
  };
  phase = 'lobby';
  const lobbyProjection = runtime.projectLobby(bundle, lobbyContext);
  const lobbyResponse = await get(`/rooms/${lobbyRoom.code}`, users[1]);
  const lobbyHtml = await lobbyResponse.text();
  if (
    lobbyResponse.status !== 200
    || !lobbyProjection
    || lobbyProjection.roles.some((role) => (
      !role.introduction.some((content) => markerVisible(content, lobbyHtml))
    ))
  ) blocked();
  const lobbyRoleCoverIds = lobbyProjection.roles.map((role) => (
    role.introduction.find((content) => content.kind === 'image')?.contentId
  ));
  if (
    lobbyRoleCoverIds.some((contentId) => !contentId)
    || new Set(lobbyRoleCoverIds).size !== lobbyProjection.roles.length
    || lobbyRoleCoverIds.some((contentId) => !lobbyHtml.includes(`/content/${contentId}`))
  ) {
    phase = 'lobby-role-covers';
    blocked();
  }
  for (const block of Object.values(bundle.contentBlocks)) {
    if (
      block.kind === 'image'
      && ['L2', 'L3', 'L4'].includes(block.classification.level)
      && lobbyHtml.includes(`/content/${block.contentId}`)
    ) blocked();
  }

  const allRoleIds = new Set<string>(roles.map((role) => role.roleId));
  const firstContext: AuthorizationContext = {
    ...lobbyContext,
    assignedRoleId: roles[0].roleId,
    assignedRoleIds: allRoleIds,
    activeStageId: stages[0].stageId,
    reachedStageIds: new Set<string>([stages[0].stageId]),
  };
  phase = 'role';
  const roleProjection = runtime.projectAssignedRole(bundle, firstContext);
  const roleResponse = await get(`/rooms/${runningRoom.code}`, users[0]);
  const roleHtml = await roleResponse.text();
  if (roleResponse.status !== 200) {
    phase = 'role-page';
    blocked();
  }
  if (!roleProjection) {
    phase = 'role-projection';
    blocked();
  }
  if (!roleProjection.sections.some((section) => (
    section.content.some((content) => markerVisible(content, roleHtml))
  ))) {
    phase = 'role-content-marker';
    blocked();
  }
  const imageContent = roleProjection.sections
    .flatMap((section) => section.content)
    .find((content) => content.kind === 'image');
  if (!imageContent) {
    phase = 'role-image-projection';
    blocked();
  }
  const imageResponse = await get(
    `/api/rooms/${runningRoom.code}/content/${imageContent.contentId}?part=0`,
    users[0],
  );
  if (imageResponse.status !== 200) {
    phase = 'role-image-status';
    blocked();
  }
  if (!String(imageResponse.headers.get('content-type')).startsWith('image/webp')) {
    phase = 'role-image-content-type';
    blocked();
  }
  if (imageResponse.headers.get('cache-control') !== 'private, no-store') {
    phase = 'role-image-cache-control';
    blocked();
  }
  await imageResponse.arrayBuffer();
  const deniedId = Object.values(bundle.contentBlocks).find((block) => (
    block.kind === 'image' && !runtime.canReadContent(block, firstContext)
  ))?.contentId;
  phase = 'authorization';
  if (!deniedId) blocked();
  const deniedResponse = await get(
    `/api/rooms/${runningRoom.code}/content/${deniedId}?part=0`,
    users[0],
  );
  const missingResponse = await get(
    `/api/rooms/${runningRoom.code}/content/cnt_ffffffffffffffff?part=0`,
    users[0],
  );
  if (
    deniedResponse.status !== 404
    || missingResponse.status !== 404
    || deniedResponse.headers.get('cache-control') !== 'private, no-store'
    || missingResponse.headers.get('cache-control') !== 'private, no-store'
  ) blocked();

  const allReleaseIds = new Set<string>(
    (bundle.hostPack?.releasePlan ?? []).map((item) => item.releaseId),
  );
  phase = 'resolution-map';
  const resolutionSections = bundle.hostPack.resolutionSections ?? [];
  const resolutionContentIds = resolutionSections.flatMap((section) => section.contentIds);
  const resolutionImageId = resolutionContentIds.find(
    (contentId) => bundle.contentBlocks[contentId]?.kind === 'image',
  );
  if (!resolutionImageId) blocked();
  const prematureResolution = runtime.projectReleasedResolution(bundle, firstContext);
  if (
    prematureResolution.length !== 0
    || roleHtml.includes(`/content/${resolutionImageId}`)
  ) blocked();
  const prematureResolutionResponse = await get(
    `/api/rooms/${runningRoom.code}/content/${resolutionImageId}?part=0`,
    users[0],
  );
  if (
    prematureResolutionResponse.status !== 404
    || prematureResolutionResponse.headers.get('cache-control') !== 'private, no-store'
  ) blocked();

  let clueCase: {
    stageIndex: number;
    clue: Clue;
    projected: ProjectedClue;
  } | null = null;
  phase = 'clue';
  for (let stageIndex = 0; stageIndex < stages.length && !clueCase; stageIndex += 1) {
    const reached = new Set<string>(
      stages.slice(0, stageIndex + 1).map((stage) => stage.stageId),
    );
    for (const clue of Object.values(bundle.clues)) {
      const held: AuthorizationContext = {
        ...firstContext,
        activeStageId: stages[stageIndex].stageId,
        reachedStageIds: reached,
        heldClueIds: new Set<string>([clue.clueId]),
        roomHeldClueIds: new Set<string>([clue.clueId]),
        hostReleaseIds: allReleaseIds,
      };
      const projected = runtime.projectVisibleClues(bundle, held)
        .find((item) => item.clueId === clue.clueId);
      if (projected?.faces.some((face) => face.content.length)) {
        clueCase = { stageIndex, clue, projected };
        break;
      }
    }
  }
  if (!clueCase) blocked();
  database.prepare('DELETE FROM room_stages WHERE room_id = ?').run(runningRoom.id);
  for (let stageIndex = 0; stageIndex <= clueCase.stageIndex; stageIndex += 1) {
    database.prepare(`
      INSERT INTO room_stages
        (room_id, stage_id, sequence, entered_at, completed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      runningRoom.id,
      stages[stageIndex].stageId,
      stages[stageIndex].sequence,
      now,
      stageIndex === clueCase.stageIndex ? null : now,
    );
  }
  for (const releaseId of allReleaseIds) {
    database.prepare(`
      INSERT OR IGNORE INTO room_host_releases (room_id, release_id, released_at)
      VALUES (?, ?, ?)
    `).run(runningRoom.id, releaseId, now);
  }
  database.prepare(`
    INSERT INTO clue_holdings (room_id, clue_id, holder_membership_id, acquired_at)
    VALUES (?, ?, ?, ?)
  `).run(runningRoom.id, clueCase.clue.clueId, users[0].runningMembershipId, now);
  const holderResponse = await get(
    `/rooms/${runningRoom.code}/clues/${clueCase.clue.clueId}`,
    users[0],
  );
  const otherResponse = await get(
    `/rooms/${runningRoom.code}/clues/${clueCase.clue.clueId}`,
    users[1],
  );
  const holderHtml = await holderResponse.text();
  const otherHtml = await otherResponse.text();
  const clueContents = clueCase.projected.faces.flatMap((face) => face.content);
  if (
    holderResponse.status !== 200
    || otherResponse.status !== 404
    || !clueContents.some((content) => markerVisible(content, holderHtml))
    || clueContents.some((content) => markerVisible(content, otherHtml))
  ) blocked();
  if (clueCase.projected.canPublish) {
    const publishResponse = await post(
      `/api/rooms/${runningRoom.code}/clues/publish`,
      users[0],
      { clueId: clueCase.clue.clueId },
    );
    if (publishResponse.status !== 303) blocked();
    const published = database.prepare(`
      SELECT published_at AS value
      FROM clue_holdings
      WHERE room_id = ? AND clue_id = ?
    `).get(runningRoom.id, clueCase.clue.clueId) as { value: number | null } | undefined;
    if (published?.value == null) blocked();
    const publishedResponse = await get(
      `/rooms/${runningRoom.code}/clues/${clueCase.clue.clueId}`,
      users[1],
    );
    const publishedHtml = await publishedResponse.text();
    const publicBoardResponse = await get(`/rooms/${runningRoom.code}`, users[1]);
    const publicBoardHtml = await publicBoardResponse.text();
    if (
      publishedResponse.status !== 200
      || publicBoardResponse.status !== 200
      || !clueContents.some((content) => markerVisible(content, publishedHtml))
      || !clueContents.some((content) => markerVisible(content, publicBoardHtml))
    ) blocked();
  }

  phase = 'resolution-release';
  database.prepare("UPDATE rooms SET status = 'completed', authorization_version = authorization_version + 1 WHERE id = ?")
    .run(runningRoom.id);
  const completedContext: AuthorizationContext = { ...firstContext, sessionCompleted: true };
  const releasedResolution = runtime.projectReleasedResolution(bundle, completedContext);
  const completedResponse = await get(`/rooms/${runningRoom.code}`, users[1]);
  const completedHtml = await completedResponse.text();
  if (
    completedResponse.status !== 200
    || !releasedResolution.some((section) => section.content.some(
      (content) => markerVisible(content, completedHtml),
    ))
  ) blocked();
  const resolutionImageResponse = await get(
    `/api/rooms/${runningRoom.code}/content/${resolutionImageId}?part=0`,
    users[1],
  );
  if (
    resolutionImageResponse.status !== 200
    || !String(resolutionImageResponse.headers.get('content-type')).startsWith('image/webp')
    || resolutionImageResponse.headers.get('cache-control') !== 'private, no-store'
  ) blocked();
  await resolutionImageResponse.arrayBuffer();

  const deleteResponse = await post(
    `/api/rooms/${deleteRoom.code}/delete`,
    users[1],
    { confirmDelete: 'yes' },
  );
  phase = 'room-delete-http';
  if (deleteResponse.status !== 303) blocked();
  phase = 'room-delete-database';
  if (database.prepare('SELECT id FROM rooms WHERE id = ?').get(deleteRoom.id)) blocked();
  const orphans = database.prepare(`
    SELECT COUNT(*) AS count FROM memberships WHERE room_id = ?
  `).get(deleteRoom.id) as { count: number };
  phase = 'room-delete-cascade';
  if (orphans.count !== 0) blocked();

  phase = 'log-read';
  const privateLog = readFileSync(logPath, 'utf8');
  phase = 'log-scan';
  for (const block of Object.values(bundle.contentBlocks)) {
    if (
      block.kind === 'text'
      && 'text' in block.payload
      && block.payload.text.length >= 12
      && privateLog.includes(block.payload.text)
    ) blocked();
  }
  database.close();
  process.stdout.write('{"code":"PRIVATE_HTTP_SMOKE_PASSED","status":"private"}\n');
} catch {
  blocked();
}
