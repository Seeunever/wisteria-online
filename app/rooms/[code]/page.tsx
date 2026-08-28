import { getCurrentUser } from '@/lib/auth';
import { getRoomForMember } from '@/lib/rooms';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { listFrozenPackVersions, loadFrozenBundle } from '@/lib/packs';
import {
  evaluateStageFlowCondition,
  projectAssignedRole,
  projectAvailableLocations,
  projectLobby,
  projectVisibleClues,
  withEligibleHostReleases,
  type AuthorizationContext,
} from '@/lib/blind-runtime';
import { ProtectedContent } from './protected-content';

export const dynamic = 'force-dynamic';

type RoomPageProps = {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
};

export default async function RoomPage({ params, searchParams }: RoomPageProps) {
  const user = await getCurrentUser();
  if (!user) redirect('/#account');
  const [{ code }, query] = await Promise.all([params, searchParams]);
  const room = getRoomForMember(code, user.id);
  if (!room) notFound();
  const error = Array.isArray(query.error) ? query.error[0] : query.error;
  const errorMessage = error === 'start'
    ? '没有开场。普通开场需要所有席位锁定；少人开场需要房主完成二次确认。'
    : error === 'role'
      ? '席位没有锁定成功，可能已经被其他玩家选择。'
      : error === 'pack'
        ? '剧本版本没有锁定成功，请重新选择可用的冻结版本。'
        : error === 'advance'
          ? '当前阶段还不满足推进条件；少人测试时，缺席角色相关内容可能无法完成。'
          : error === 'delete'
            ? '房间没有删除成功。只有仍在房间内的玩家确认后才能删除。'
            : error === 'search'
              ? '没有取得这张线索。它可能刚被别人拿走，或本阶段的调查次数已经用完。'
          : null;
  const isOwner = room.ownerUserId === user.id;
  const packs = isOwner && !room.versionId ? listFrozenPackVersions() : [];
  const assignedRoleIds = new Set(
    room.members.map((member) => member.assignedRoleId).filter((id): id is string => id !== null),
  );
  const authorization: AuthorizationContext = {
    joined: true,
    assignedRoleId: room.assignedRoleId,
    assignedRoleIds,
    activeStageId: room.reachedStages.find((stage) => stage.completedAt === null)?.stageId ?? null,
    reachedStageIds: new Set(room.reachedStages.map((stage) => stage.stageId)),
    heldClueIds: new Set(room.clues.filter((clue) => clue.isHeld).map((clue) => clue.clueId)),
    roomHeldClueIds: new Set(room.roomHeldClueIds),
    publishedClueIds: new Set(
      room.clues.filter((clue) => clue.publishedAt !== null).map((clue) => clue.clueId),
    ),
    hostReleaseIds: new Set(room.hostReleaseIds),
    sessionCompleted: room.status === 'completed',
  };
  let lobby: ReturnType<typeof projectLobby> = null;
  let assignedRole: ReturnType<typeof projectAssignedRole> = null;
  let availableLocations: ReturnType<typeof projectAvailableLocations> = [];
  let visibleClues: ReturnType<typeof projectVisibleClues> = [];
  let packRoleCount = 0;
  let packLoadFailed = false;
  let canAdvance = false;
  if (room.versionId) {
    try {
      const bundle = loadFrozenBundle(room.versionId);
      packRoleCount = Object.keys(bundle.roles).length;
      lobby = room.status === 'lobby' ? projectLobby(bundle, authorization) : null;
      assignedRole = projectAssignedRole(bundle, authorization);
      availableLocations = projectAvailableLocations(bundle, authorization);
      visibleClues = projectVisibleClues(bundle, authorization);
      const activeStage = authorization.activeStageId
        ? bundle.stages[authorization.activeStageId]
        : null;
      if (isOwner && room.status === 'running' && activeStage) {
        const released = withEligibleHostReleases(bundle, authorization);
        const simulatedFlowRoles = room.incompleteStart
          ? new Set(Object.keys(bundle.roles))
          : undefined;
        const nextStage = Object.values(bundle.stages).find(
          (stage) => stage.sequence === activeStage.sequence + 1,
        );
        const currentComplete = evaluateStageFlowCondition(
          activeStage.completeWhen,
          nextStage ? released : { ...released, sessionCompleted: true },
          simulatedFlowRoles,
        );
        const nextCanEnter = !nextStage || evaluateStageFlowCondition(
          nextStage.enterWhen,
          {
            ...released,
            activeStageId: null,
            reachedStageIds: new Set([...released.reachedStageIds, activeStage.stageId]),
          },
          simulatedFlowRoles,
        );
        canAdvance = currentComplete && nextCanEnter;
      }
    } catch {
      // Protected storage failures use the same empty projection as unavailable objects.
      packLoadFailed = true;
    }
  }
  const roomProgress = room.status === 'lobby'
    ? room.assignedRoleId
      ? '角色已锁定，等待房主开场；个人剧本会在开场后解锁。'
      : '先选择角色；房主开场后，每位玩家只会看到自己的剧本。'
    : room.status === 'running'
      ? '游戏已经开始，当前阶段的个人剧本已按角色解锁。'
      : '本局已经结束，房间保留最终授权状态。';

  return (
    <main className="rooms-shell">
      <header className="room-header">
        <Link className="brand" href="/rooms"><span className="brand-mark" aria-hidden="true">暗</span><span><strong>暗格</strong><small>当前玩家：{user.displayName}</small></span></Link>
        <div className="room-toolbar">
          <span className="room-player">当前玩家：{user.displayName}</span>
          <Link className="room-refresh" href={`/rooms/${room.code}`}>刷新状态</Link>
          <span className="room-code">房间 {room.code}</span>
        </div>
      </header>
      <section className="live-room-hero">
        <div><p className="eyebrow">{room.status.toUpperCase()}</p><h1>{room.versionId ? (room.packLabel ?? '剧本版本已锁定') : '等待房主选择剧本'}</h1><p>{room.versionId ? roomProgress : '样本拆解完成并冻结后，房主可以在这里装载。'}</p></div>
        <div className="room-safety-card"><strong>权限版本 {room.authorizationVersion}</strong><p>每次角色、阶段或成员状态变化，旧的访问能力都会失效。</p></div>
      </section>
      {errorMessage ? <p className="room-alert" role="alert">{errorMessage}</p> : null}
      {room.versionId && packLoadFailed ? (
        <section className="members-section room-load-failure" role="alert">
          <p className="eyebrow">PACK UNAVAILABLE</p>
          <h2>剧本暂时无法读取</h2>
          <p className="empty-state">服务器没有成功读取这个冻结版本，选角色和开场已经暂停，请稍后刷新。</p>
        </section>
      ) : null}
      {isOwner && !room.versionId ? (
        <section className="members-section">
          <p className="eyebrow">IMMUTABLE PACK</p>
          <h2>装载已冻结剧本</h2>
          {packs.length ? (
            <form action={`/api/rooms/${room.code}/pack`} method="post">
              <label>
                剧本版本
                <select name="versionId" required defaultValue="">
                  <option value="" disabled>请选择</option>
                  {packs.map((pack) => (
                    <option key={pack.versionId} value={pack.versionId}>{pack.publicLabel}</option>
                  ))}
                </select>
              </label>
              <button type="submit">锁定到这个房间</button>
            </form>
          ) : <p className="empty-state">还没有通过校验并冻结的剧本版本。</p>}
        </section>
      ) : null}
      {lobby ? (
        <section className="members-section">
          <p className="eyebrow">ROLE LOCK</p>
          <h2>{lobby.title ?? '选择你的席位'}</h2>
          <div className="member-list">
            {lobby.roles.map((role) => {
              const taken = assignedRoleIds.has(role.roleId);
              return (
                <article className="role-choice-card" key={role.roleId}>
                  <span>{String(role.slot).padStart(2, '0')}</span>
                  <div className="role-choice-copy">
                    <strong>{role.displayName ?? `席位 ${role.slot}`}</strong>
                    {role.introduction.length ? role.introduction.map((content, index) => (
                      <ProtectedContent
                        key={`${role.roleId}-introduction-${index}`}
                        code={room.code}
                        content={content}
                      />
                    )) : (
                      <p>这个冻结版本尚未录入可在选角前公开的角色简介。</p>
                    )}
                  </div>
                  {taken ? <small>已被选择</small> : (
                    <form action={`/api/rooms/${room.code}/roles/claim`} method="post">
                      <input type="hidden" name="roleId" value={role.roleId} />
                      <button type="submit">选择这个角色</button>
                    </form>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
      {assignedRole ? (
        <section className="members-section role-book-section">
          <p className="eyebrow">YOUR ROLE</p>
          <h2>{assignedRole.displayName ?? '你的角色已锁定'}</h2>
          {assignedRole.sections.length ? assignedRole.sections.map((section) => (
            <article key={section.sectionId} className="empty-state">
              <strong className="role-section-label">个人剧本 · 已解锁部分</strong>
              {section.content.map((content, index) => (
                <ProtectedContent key={`${section.sectionId}-${index}`} code={room.code} content={content} />
              ))}
            </article>
          )) : room.status === 'lobby' ? (
            <p className="empty-state">角色已经选好。等待房主点击“开始游戏”后，第一阶段个人剧本会出现在这里。</p>
          ) : (
            <p className="room-alert" role="alert">游戏已经开始，但当前角色没有取得可阅读内容。请先刷新；仍为空时不要推进阶段。</p>
          )}
        </section>
      ) : null}
      {room.status === 'running' && !room.assignedRoleId ? (
        <section className="members-section" role="status">
          <p className="eyebrow">NO ROLE</p>
          <h2>本局开始时你没有锁定角色</h2>
          <p className="empty-state">少人开场后不能再补选角色，所以当前账号不会获得任何个人剧本。</p>
        </section>
      ) : null}
      {room.status === 'running' && availableLocations.length ? (
        <section className="members-section location-section">
          <p className="eyebrow">SEARCH</p>
          <h2>先选择调查地点</h2>
          <p className="section-guidance">展开地点后，再从尚未取走的线索背面中选择一张。打开前不会显示线索内容。</p>
          <div className="location-list">
            {availableLocations.map((location, index) => (
              <details className="location-card" key={location.locationId}>
                <summary>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong>{location.name ?? `地点 ${index + 1}`}</strong>
                  <small>{location.clueChoices.length ? `${location.clueChoices.length} 张可选` : '暂无可选线索'}</small>
                </summary>
                <div className="clue-choice-grid">
                  {location.clueChoices.length ? location.clueChoices.map((choice) => (
                    <form action={`/api/rooms/${room.code}/search`} method="post" key={choice.clueId}>
                      <input type="hidden" name="locationId" value={location.locationId} />
                      <input type="hidden" name="clueId" value={choice.clueId} />
                      <button type="submit" aria-label={`选择第 ${choice.number} 张线索`}>
                        <span aria-hidden="true">?</span>
                        <strong>线索 {String(choice.number).padStart(2, '0')}</strong>
                        <small>点击取得并打开</small>
                      </button>
                    </form>
                  )) : <p className="empty-state">这个地点当前没有可以取得的线索。</p>}
                </div>
              </details>
            ))}
          </div>
        </section>
      ) : null}
      {visibleClues.length ? (
        <section className="members-section clue-index-section">
          <p className="eyebrow">CLUES</p>
          <h2>已取得与已公开线索</h2>
          <p className="section-guidance">私藏线索只对持有者可见；公开后才会进入所有玩家的看板。</p>
          <div className="clue-index-list">
          {visibleClues.map((clue, clueIndex) => (
            <Link className="clue-index-card" key={clue.clueId} href={`/rooms/${room.code}/clues/${clue.clueId}`}>
              <span>{String(clueIndex + 1).padStart(2, '0')}</span>
              <strong>打开线索</strong>
              <small>{clue.isPublished ? '全房间已公开' : clue.isHeld ? '仅自己可见' : '房间公开线索'}</small>
            </Link>
          ))}
          </div>
        </section>
      ) : null}
      {isOwner && room.versionId && room.status === 'lobby' && packRoleCount > 0
        && assignedRoleIds.size === packRoleCount ? (
        <section className="members-section">
          <p className="eyebrow">START</p>
          <h2>所有席位都已锁定</h2>
          <form action={`/api/rooms/${room.code}/start`} method="post">
            <button type="submit">开始游戏</button>
          </form>
        </section>
      ) : null}
      {isOwner && room.versionId && room.status === 'lobby' && packRoleCount > 0
        && assignedRoleIds.size > 0 && assignedRoleIds.size < packRoleCount ? (
        <section className="members-section force-start-section">
          <p className="eyebrow">TEST OVERRIDE</p>
          <h2>还差 {packRoleCount - assignedRoleIds.size} 个席位</h2>
          <p className="empty-state">
            正常开场需要所有席位锁定。测试时可以少人开场，但空缺角色不会分配给任何人，
            开场后也不能补选；这只适合页面和权限功能测试，部分剧情流程可能无法继续。
          </p>
          <details className="force-start-confirmation">
            <summary>查看少人开场选项</summary>
            <div>
              <strong>这是第二次确认</strong>
              <p>只有当前已认领角色的玩家会获得对应内容；空缺角色内容仍保持不可见。</p>
              <form action={`/api/rooms/${room.code}/start`} method="post">
                <input type="hidden" name="forceStart" value="confirmed" />
                <label>
                  <input type="checkbox" name="confirmConsequences" value="yes" required />
                  我知道开场后不能补选空缺角色，且部分剧情流程可能无法继续。
                </label>
                <button type="submit">确认少人开场</button>
              </form>
            </div>
          </details>
        </section>
      ) : null}
      {isOwner && room.versionId && room.status === 'lobby' && packRoleCount > 0
        && assignedRoleIds.size === 0 ? (
        <section className="members-section">
          <p className="eyebrow">START</p>
          <h2>至少先锁定一个席位</h2>
          <p className="empty-state">你可以自己先选择一个角色，再使用少人开场进行测试。</p>
          <button type="button" disabled>选择角色后开始游戏</button>
        </section>
      ) : null}
      {!isOwner && room.versionId && room.status === 'lobby' && packRoleCount > 0 ? (
        <section className="members-section">
          <p className="eyebrow">WAITING FOR HOST</p>
          <h2>等待房主开始游戏</h2>
          <p className="empty-state">你可以先选择自己的角色；开场按钮只显示在房主页面。</p>
        </section>
      ) : null}
      {isOwner && canAdvance ? (
        <section className="members-section">
          <p className="eyebrow">STAGE CONTROL</p>
          <h2>本阶段已满足推进条件</h2>
          <form action={`/api/rooms/${room.code}/advance`} method="post">
          <button type="submit">推进当前阶段</button>
          </form>
        </section>
      ) : null}
      {room.status === 'completed' ? (
        <section className="members-section">
          <p className="eyebrow">COMPLETED</p>
          <h2>本局已经完成</h2>
          <p className="empty-state">房间保留在这个不可变剧本版本与最终授权状态上。</p>
        </section>
      ) : null}
      <section className="members-section"><p className="eyebrow">PLAYERS</p><h2>已到场</h2><div className="member-list">{room.members.map((member, index) => <div key={member.membershipId}><span>{String(index + 1).padStart(2, '0')}</span><strong>{member.displayName}</strong><small>{member.isOwner ? '房主' : member.assignedRoleId ? '已选角色' : '未选角色'}</small></div>)}</div></section>
      <section className="members-section room-danger-zone">
        <p className="eyebrow">ROOM MANAGEMENT</p>
        <h2>房间管理</h2>
        <p className="section-guidance">所有仍在房间内的玩家都可以刷新状态或删除房间。</p>
        <details>
          <summary>删除这个房间</summary>
          <div>
            <p>删除后，成员、选角、阶段和线索状态都会一并清除，无法恢复。</p>
            <form action={`/api/rooms/${room.code}/delete`} method="post">
              <label>
                <input type="checkbox" name="confirmDelete" value="yes" required />
                我确认删除这个房间及本局进度。
              </label>
              <button type="submit">确认删除房间</button>
            </form>
          </div>
        </details>
      </section>
    </main>
  );
}
