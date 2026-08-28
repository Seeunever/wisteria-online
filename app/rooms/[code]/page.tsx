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
  type ProjectedContent,
} from '@/lib/blind-runtime';

export const dynamic = 'force-dynamic';

function ProtectedContent({
  code,
  content,
}: {
  code: string;
  content: ProjectedContent;
}) {
  if (content.kind === 'text') return <p>{content.text}</p>;
  return Array.from({ length: content.parts }, (_, part) => (
    // The protected route re-derives current room authorization on every request.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="protected-scan"
      key={`${content.contentId}-${part}`}
      src={`/api/rooms/${code}/content/${content.contentId}?part=${part}`}
      alt="已授权的剧本内容"
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  ));
}

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
    }
  }

  return (
    <main className="rooms-shell">
      <header className="room-header">
        <Link className="brand" href="/rooms"><span className="brand-mark" aria-hidden="true">暗</span><span><strong>暗格</strong><small>返回房间大厅</small></span></Link>
        <span className="room-code">房间 {room.code}</span>
      </header>
      <section className="live-room-hero">
        <div><p className="eyebrow">{room.status.toUpperCase()}</p><h1>{room.versionId ? (room.packLabel ?? '剧本版本已锁定') : '等待房主选择剧本'}</h1><p>{room.versionId ? '当前房间只会读取这个不可变版本。' : '样本拆解完成并冻结后，房主可以在这里装载。'}</p></div>
        <div className="room-safety-card"><strong>权限版本 {room.authorizationVersion}</strong><p>每次角色、阶段或成员状态变化，旧的访问能力都会失效。</p></div>
      </section>
      {errorMessage ? <p className="room-alert" role="alert">{errorMessage}</p> : null}
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
                <div key={role.roleId}>
                  <span>{String(role.slot).padStart(2, '0')}</span>
                  <strong>{role.displayName ?? `席位 ${role.slot}`}</strong>
                  {taken ? <small>已锁定</small> : (
                    <form action={`/api/rooms/${room.code}/roles/claim`} method="post">
                      <input type="hidden" name="roleId" value={role.roleId} />
                      <button type="submit">选择</button>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      {assignedRole ? (
        <section className="members-section">
          <p className="eyebrow">YOUR ROLE</p>
          <h2>{assignedRole.displayName ?? '你的角色已锁定'}</h2>
          {assignedRole.sections.length ? assignedRole.sections.map((section) => (
            <article key={section.sectionId} className="empty-state">
              {section.content.map((content, index) => (
                <ProtectedContent key={`${section.sectionId}-${index}`} code={room.code} content={content} />
              ))}
            </article>
          )) : <p className="empty-state">等待房主开局后，第一阶段内容才会解锁。</p>}
        </section>
      ) : null}
      {room.status === 'running' && availableLocations.length ? (
        <section className="members-section">
          <p className="eyebrow">SEARCH</p>
          <h2>当前可调查地点</h2>
          <div className="member-list">
            {availableLocations.map((location, index) => (
              <div key={location.locationId}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{location.name ?? `地点 ${index + 1}`}</strong>
                {['draw_without_replacement', 'fixed_sequence'].includes(location.searchMode) ? (
                  <form action={`/api/rooms/${room.code}/search`} method="post">
                    <input type="hidden" name="locationId" value={location.locationId} />
                    <button type="submit">调查</button>
                  </form>
                ) : location.searchMode === 'host_dealt' && isOwner ? (
                  <div className="deal-controls">
                    {room.members.filter((member) => member.assignedRoleId).map((member) => (
                      <form action={`/api/rooms/${room.code}/clues/deal`} method="post" key={member.membershipId}>
                        <input type="hidden" name="locationId" value={location.locationId} />
                        <input type="hidden" name="targetMembershipId" value={member.membershipId} />
                        <button type="submit">发给 {member.displayName}</button>
                      </form>
                    ))}
                  </div>
                ) : <small>本阶段自动处理</small>}
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {visibleClues.length ? (
        <section className="members-section">
          <p className="eyebrow">CLUES</p>
          <h2>你现在可以查看的线索</h2>
          {visibleClues.map((clue, clueIndex) => (
            <article key={clue.clueId} className="empty-state">
              <strong>线索 {String(clueIndex + 1).padStart(2, '0')}</strong>
              {clue.faces.map((face) => (
                <div key={face.faceId}>
                  {face.content.map((content, index) => (
                    <ProtectedContent key={`${face.faceId}-${index}`} code={room.code} content={content} />
                  ))}
                </div>
              ))}
              {clue.canPublish ? (
                <form action={`/api/rooms/${room.code}/clues/publish`} method="post">
                  <input type="hidden" name="clueId" value={clue.clueId} />
                  <button type="submit">向全房间公开</button>
                </form>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
      {isOwner && room.versionId && room.status === 'lobby' && packRoleCount > 0
        && assignedRoleIds.size === packRoleCount ? (
        <section className="members-section">
          <p className="eyebrow">START</p>
          <h2>所有席位都已锁定</h2>
          <form action={`/api/rooms/${room.code}/start`} method="post">
            <button type="submit">开始第一阶段</button>
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
      <section className="members-section"><p className="eyebrow">PLAYERS</p><h2>已到场</h2><div className="member-list">{room.members.map((member, index) => <div key={`${member.displayName}-${member.joinedAt}`}><span>{String(index + 1).padStart(2, '0')}</span><strong>{member.displayName}</strong></div>)}</div></section>
    </main>
  );
}
