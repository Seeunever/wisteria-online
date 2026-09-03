import { getCurrentUser } from '@/lib/auth';
import { getInvestigationState, getRoomForMember } from '@/lib/rooms';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { listFrozenPackVersions, loadInstalledPack } from '@/lib/packs';
import {
  deriveInvestigationCandidates,
  evaluateStageFlowCondition,
  projectAssignedRole,
  projectAvailableLocations,
  projectLobby,
  projectPlayerGuide,
  projectReleasedResolution,
  projectVisibleClues,
  withEligibleHostReleases,
  type AuthorizationContext,
  type CollectiveVoteRoundRobinFlowV1,
  type InvestigationCandidates,
} from '@/lib/blind-runtime';
import {
  getRotatingBlindDrawRoomView,
  type RotatingBlindDrawRoomView,
} from '@/lib/investigation/rotating-blind-draw-room';
import {
  isRotatingBlindDrawMechanism,
  runtimeMechanismsRequireFullRoleAssignment,
} from '@/lib/investigation/rotating-blind-draw';
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
            : error === 'vote'
              ? '投票没有提交成功。房间状态可能刚刚变化，请刷新后再选。'
            : error === 'completion'
              ? '阶段确认没有提交成功。请先完成剩余调查和必须公开的线索，再刷新重试。'
            : error === 'tie-break'
              ? '地点裁定没有提交成功。房间状态可能刚刚变化，请刷新后再选。'
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
    investigationCompletedStageIds: new Set(room.investigationCompletedStageIds),
  };
  let lobby: ReturnType<typeof projectLobby> = null;
  let assignedRole: ReturnType<typeof projectAssignedRole> = null;
  let availableLocations: ReturnType<typeof projectAvailableLocations> = [];
  let visibleClues: ReturnType<typeof projectVisibleClues> = [];
  let playerGuide: ReturnType<typeof projectPlayerGuide> = [];
  let releasedResolution: ReturnType<typeof projectReleasedResolution> = [];
  let investigationState: ReturnType<typeof getInvestigationState> | null = null;
  let investigationCandidates: InvestigationCandidates | null = null;
  let investigationFlow: NonNullable<
    CollectiveVoteRoundRobinFlowV1
  > | null = null;
  let rotatingInvestigation: RotatingBlindDrawRoomView | null = null;
  let packRoleCount = 0;
  let fullRoleAssignmentRequired = false;
  let packLoadFailed = false;
  let canAdvance = false;
  if (room.versionId) {
    try {
      const { bundle, runtimePolicy } = loadInstalledPack(room.versionId);
      packRoleCount = Object.keys(bundle.roles).length;
      fullRoleAssignmentRequired = runtimeMechanismsRequireFullRoleAssignment(
        runtimePolicy.stageMechanisms,
      );
      lobby = room.status === 'lobby' ? projectLobby(bundle, authorization) : null;
      assignedRole = projectAssignedRole(bundle, authorization);
      visibleClues = projectVisibleClues(bundle, authorization);
      playerGuide = projectPlayerGuide(bundle, authorization);
      releasedResolution = projectReleasedResolution(bundle, authorization);
      const activeStage = authorization.activeStageId
        ? bundle.stages[authorization.activeStageId]
        : null;
      const mechanism = activeStage
        ? runtimePolicy.stageMechanisms[activeStage.stageId]
        : null;
      if (activeStage?.allowedActions.includes('search') && !mechanism) {
        throw new Error('RUNTIME_POLICY_REJECTED');
      }
      investigationFlow = mechanism?.kind === 'collective_vote_round_robin'
        && mechanism.version === 1
        ? mechanism as CollectiveVoteRoundRobinFlowV1
        : null;
      if (activeStage && mechanism && isRotatingBlindDrawMechanism(mechanism)) {
        rotatingInvestigation = getRotatingBlindDrawRoomView({
          code: room.code,
          userId: user.id,
          versionId: room.versionId,
          stageId: activeStage.stageId,
          bundle,
          mechanism,
        });
        if (!rotatingInvestigation) throw new Error('INVESTIGATION_VIEW_REJECTED');
        availableLocations = projectAvailableLocations(bundle, authorization);
      } else if (activeStage && investigationFlow) {
        const mandatoryClueIds = Object.values(bundle.clues)
          .filter((clue) => clue.publication.duty?.mode === 'mandatory_on_acquire')
          .map((clue) => clue.clueId);
        investigationState = getInvestigationState({
          roomId: room.id,
          membershipId: room.membershipId,
          stageId: activeStage.stageId,
          scope: investigationFlow.locationSelection.scope,
          perPlayerStageLimit: investigationFlow.acquisitionLimit.perPlayer,
          maxPrivateCount: investigationFlow.publicationDuty.maxPrivateCount,
          mandatoryClueIds,
        });
        investigationCandidates = deriveInvestigationCandidates(
          bundle,
          activeStage.stageId,
          authorization,
          room.members.flatMap((member) => member.assignedRoleId ? [{
            assignedRoleId: member.assignedRoleId,
            heldClueIds: new Set(member.heldClueIds),
          }] : []),
          new Set(investigationState.searchedLocationIds),
          investigationFlow,
        );
        availableLocations = projectAvailableLocations(bundle, authorization, {
          clueIdsByLocation: investigationCandidates.actorClueIdsByLocation,
        });
      } else {
        availableLocations = projectAvailableLocations(bundle, authorization);
      }
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
        canAdvance = currentComplete
          && nextCanEnter
          && (!rotatingInvestigation || rotatingInvestigation.stageCompleted);
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
  const privateClues = visibleClues.filter((clue) => clue.isHeld && !clue.isPublished);
  const publishedClues = visibleClues.filter((clue) => clue.isPublished);
  const investigationLocationIds = investigationFlow && investigationState
    ? investigationState.acquisitionsThisStage < investigationFlow.acquisitionLimit.perPlayer
      ? investigationState.selectedLocationId
        ? [investigationState.selectedLocationId]
        : investigationCandidates?.actorLocationIds ?? []
      : []
    : availableLocations.map((location) => location.locationId);
  const investigationLocations = availableLocations.filter(
    (location) => investigationLocationIds.includes(location.locationId),
  );
  const voteBlockedForPublication = Boolean(
    investigationState?.hasPublicationObligation
    && investigationFlow?.publicationDuty.blockedActions.includes('vote_location'),
  );
  const searchBlockedForPublication = Boolean(
    investigationState?.hasPublicationObligation
    && investigationFlow?.publicationDuty.blockedActions.includes('search'),
  );
  const publicationBlockMessage = voteBlockedForPublication && searchBlockedForPublication
    ? '完成后才能继续投票或搜索。'
    : voteBlockedForPublication
      ? '完成后才能继续投票。'
      : searchBlockedForPublication
        ? '完成后才能继续搜索。'
        : '请按游戏说明及时完成公开。';
  const currentTurnMember = investigationState?.currentTurnMembershipId
    ? room.members.find((member) => member.membershipId === investigationState?.currentTurnMembershipId)
    : null;
  const myVote = investigationState?.votes.find((vote) => vote.membershipId === room.membershipId);
  const rotatingLocationIds = rotatingInvestigation?.phase === 'tie_break'
    ? rotatingInvestigation.tiedLocationIds
    : rotatingInvestigation?.locationIds ?? [];
  const rotatingLocations = availableLocations.filter(
    (location) => rotatingLocationIds.includes(location.locationId),
  );
  const rotatingCurrentTurnMember = rotatingInvestigation?.currentTurnMembershipId
    ? room.members.find(
      (member) => member.membershipId === rotatingInvestigation.currentTurnMembershipId,
    )
    : null;
  const availableLocationById = new Map(
    availableLocations.map((location) => [location.locationId, location]),
  );

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
      {room.versionId && !packLoadFailed ? (
        <nav className="room-quick-dock" aria-label="房间快捷入口">
          {playerGuide.length ? <Link href="#game-guide">游戏说明</Link> : null}
          {room.status !== 'lobby' ? <Link href="#public-clue-board">公开线索</Link> : null}
          {releasedResolution.length ? <Link href="#final-resolution">真相</Link> : null}
        </nav>
      ) : null}
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
      {playerGuide.length ? (
        <section className="members-section player-guide-section" id="game-guide">
          <p className="eyebrow">GAME GUIDE</p>
          <h2>游戏说明</h2>
          <p className="section-guidance">这是当前剧本版本已验证的公开玩法说明，房间内所有玩家都可以随时查看。</p>
          <div className="player-guide-content">
            {playerGuide.map((content, index) => (
              <ProtectedContent key={`player-guide-${index}`} code={room.code} content={content} />
            ))}
          </div>
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
          <div className="member-list role-choice-grid">
            {lobby.roles.map((role) => {
              const taken = assignedRoleIds.has(role.roleId);
              return (
                <article className="role-choice-card" key={role.roleId}>
                  <span className="role-choice-index">{String(role.slot).padStart(2, '0')}</span>
                  <div className="role-choice-copy">
                    <strong>{role.displayName ?? `席位 ${role.slot}`}</strong>
                    <div className="role-choice-media">
                      {role.introduction.length ? role.introduction.map((content, index) => (
                        <ProtectedContent
                          key={`${role.roleId}-introduction-${index}`}
                          code={room.code}
                          content={content}
                        />
                      )) : (
                        <p>这个冻结版本尚未录入可在选角前公开的角色封面。</p>
                      )}
                    </div>
                  </div>
                  <div className="role-choice-action">
                    {taken ? <small>已被选择</small> : (
                      <form action={`/api/rooms/${room.code}/roles/claim`} method="post">
                        <input type="hidden" name="roleId" value={role.roleId} />
                        <button type="submit">选择这个角色</button>
                      </form>
                    )}
                  </div>
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
      {room.status === 'running' && rotatingInvestigation
        && (rotatingInvestigation.hasPublicationObligation
          || rotatingInvestigation.roomActionBlockedForPublication) ? (
        <section className="members-section investigation-obligation" role="alert">
          <p className="eyebrow">PUBLICATION REQUIRED</p>
          <h2>{rotatingInvestigation.hasPublicationObligation
            ? '请先处理你的公开义务'
            : '等待必须公开的线索处理完成'}</h2>
          <p className="section-guidance">当前调查状态已锁定；公开完成并刷新后即可继续。</p>
        </section>
      ) : null}
      {room.status === 'running' && rotatingInvestigation ? (
        <section className="members-section location-section rotating-investigation">
          <p className="eyebrow">SEARCH</p>
          <h2>{rotatingInvestigation.phase === 'location_ballot'
            ? '投票选择本轮调查地点'
            : rotatingInvestigation.phase === 'tie_break'
              ? '从并列地点中作出裁定'
              : rotatingInvestigation.phase === 'blind_draw'
                ? '轮流从背面选择线索'
                : rotatingInvestigation.phase === 'completion_ballot'
                  ? '确认本阶段调查完成'
                  : '本阶段调查已完成'}</h2>
          <p className="section-guidance">
            {rotatingInvestigation.phase === 'location_ballot'
              ? `当前已提交 ${rotatingInvestigation.voteCount}/${rotatingInvestigation.eligibleVoterCount} 票。`
              : rotatingInvestigation.phase === 'tie_break'
                ? rotatingInvestigation.tieBreakMembershipId === room.membershipId
                  ? '本轮由你从并列地点中选择一个。'
                  : '正在等待当前裁定玩家选择地点。'
                : rotatingInvestigation.phase === 'blind_draw'
                  ? rotatingInvestigation.currentTurnMembershipId === room.membershipId
                    ? '轮到你了。页面只显示当前允许选择的线索背面。'
                    : `正在等待${rotatingCurrentTurnMember ? ` ${rotatingCurrentTurnMember.displayName}` : '当前玩家'}选择线索。`
                  : rotatingInvestigation.phase === 'completion_ballot'
                    ? `当前已确认 ${rotatingInvestigation.completionVoteMembershipIds.length}/${rotatingInvestigation.completionThreshold}。`
                    : '房主可以在满足阶段条件后继续推进。'}
          </p>
          {rotatingInvestigation.phase === 'location_ballot'
            || rotatingInvestigation.phase === 'tie_break' ? (
            <div className="investigation-vote-grid">
              {rotatingLocations.map((location, index) => {
                const selectable = rotatingInvestigation.voteCandidateLocationIds.includes(
                  location.locationId,
                );
                return (
                  <form
                    action={rotatingInvestigation.phase === 'tie_break'
                      ? `/api/rooms/${room.code}/investigation/tie-break`
                      : `/api/rooms/${room.code}/investigation/vote`}
                    method="post"
                    key={location.locationId}
                  >
                    <input type="hidden" name="locationId" value={location.locationId} />
                    <input
                      type="hidden"
                      name="authorizationVersion"
                      value={room.authorizationVersion}
                    />
                    <button
                      className={rotatingInvestigation.ownVoteLocationId === location.locationId
                        ? 'is-selected'
                        : ''}
                      type="submit"
                      disabled={!selectable}
                    >
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      <strong>{location.name ?? `地点 ${index + 1}`}</strong>
                      <small>{rotatingInvestigation.phase === 'tie_break'
                        ? selectable ? '选择这个地点' : '等待裁定'
                        : rotatingInvestigation.ownVoteLocationId === location.locationId
                          ? '你已选择，可在结算前改票'
                          : selectable ? '投票选择此地点' : '当前不可选择'}</small>
                    </button>
                  </form>
                );
              })}
            </div>
          ) : null}
          {rotatingInvestigation.phase === 'blind_draw' ? (
            rotatingInvestigation.drawOptions.length ? (
              <div className="blind-draw-grid">
                {rotatingInvestigation.drawOptions.map((option, index) => (
                  <article className="blind-draw-card" key={option.clueId}>
                    <header>
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      <strong>{availableLocationById.get(option.locationId)?.name ?? '调查地点'}</strong>
                    </header>
                    <div className="blind-draw-back">
                      {option.content.map((content, contentIndex) => (
                        <ProtectedContent
                          key={`${option.faceId}-${contentIndex}`}
                          code={room.code}
                          content={content}
                        />
                      ))}
                    </div>
                    <form action={`/api/rooms/${room.code}/search`} method="post">
                      <input type="hidden" name="locationId" value={option.locationId} />
                      <input type="hidden" name="clueId" value={option.clueId} />
                      <input
                        type="hidden"
                        name="authorizationVersion"
                        value={room.authorizationVersion}
                      />
                      <button type="submit">取得这张线索</button>
                    </form>
                  </article>
                ))}
              </div>
            ) : <p className="empty-state">等待当前玩家完成选择后刷新状态。</p>
          ) : null}
          {rotatingInvestigation.phase === 'completion_ballot' ? (
            <form action={`/api/rooms/${room.code}/investigation/complete`} method="post">
              <input
                type="hidden"
                name="authorizationVersion"
                value={room.authorizationVersion}
              />
              <button
                type="submit"
                disabled={rotatingInvestigation.hasPublicationObligation
                  || rotatingInvestigation.roomActionBlockedForPublication
                  || rotatingInvestigation.completionVoteMembershipIds.includes(room.membershipId)}
              >
                {rotatingInvestigation.completionVoteMembershipIds.includes(room.membershipId)
                  ? '已确认，等待达到人数'
                  : '确认本阶段调查完成'}
              </button>
            </form>
          ) : null}
        </section>
      ) : null}
      {room.status === 'running' && investigationFlow && investigationState?.hasPublicationObligation ? (
        <section className="members-section investigation-obligation" role="alert">
          <p className="eyebrow">PUBLICATION REQUIRED</p>
          <h2>先处理本轮公开义务</h2>
          <p className="section-guidance">按照游戏说明，你需要从自己的未公开线索中公开一张，{publicationBlockMessage}</p>
        </section>
      ) : null}
      {room.status === 'running' && !rotatingInvestigation && investigationLocations.length ? (
        <section className="members-section location-section">
          <p className="eyebrow">SEARCH</p>
          <h2>{investigationFlow
            ? investigationState?.selectedLocationId
              ? '按席位轮流取得线索'
              : '全员投票选择调查地点'
            : '先选择调查地点'}</h2>
          <p className="section-guidance">{investigationFlow
            ? investigationState?.selectedLocationId
              ? `第 ${investigationState.roundNumber} 轮地点已经确定。${currentTurnMember ? `当前轮到 ${currentTurnMember.displayName}。` : ''}每次只取得一张；每人本阶段最多 ${investigationFlow.acquisitionLimit.perPlayer} 张。`
              : `第 ${investigationState?.roundNumber ?? 1} 轮：每位已选角色的玩家投一票；全部投完后自动结算，已经调查过的地点不会再次出现。当前已投 ${investigationState?.votes.length ?? 0}/${room.members.filter((member) => member.assignedRoleId).length} 票。`
            : '展开地点后，再从尚未取走的线索背面中选择一张。打开前不会显示线索内容。'}</p>
          {investigationFlow && !investigationState?.selectedLocationId ? (
            <div className="investigation-vote-grid">
              {investigationLocations.map((location, index) => (
                <form action={`/api/rooms/${room.code}/investigation/vote`} method="post" key={location.locationId}>
                  <input type="hidden" name="locationId" value={location.locationId} />
                  <input type="hidden" name="authorizationVersion" value={room.authorizationVersion} />
                  <button
                    className={myVote?.locationId === location.locationId ? 'is-selected' : ''}
                    type="submit"
                    disabled={voteBlockedForPublication}
                  >
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <strong>{location.name ?? `地点 ${index + 1}`}</strong>
                    <small>{myVote?.locationId === location.locationId ? '你已投给这里，可改票' : '投票选择此地点'}</small>
                  </button>
                </form>
              ))}
            </div>
          ) : (
          <div className="location-list">
            {investigationLocations.map((location, index) => (
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
                      <input type="hidden" name="authorizationVersion" value={room.authorizationVersion} />
                      <button
                        type="submit"
                        aria-label={`选择第 ${choice.number} 张线索`}
                        disabled={Boolean(investigationFlow && (
                          investigationState?.currentTurnMembershipId !== room.membershipId
                          || searchBlockedForPublication
                        ))}
                      >
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
          )}
        </section>
      ) : null}
      {room.status === 'running' && investigationFlow?.completion
        && investigationState && !investigationState.selectedLocationId
        && (investigationState.roomQuotaReached
          || (investigationCandidates?.roomLocationIds.length ?? 0) === 0) ? (
        <section className="members-section investigation-completion">
          <p className="eyebrow">INVESTIGATION COMPLETE</p>
          <h2>{investigationState.stageCompleted ? '本阶段调查已确认完成' : '全员确认结束本阶段调查'}</h2>
          <p className="section-guidance">
            {investigationState.stageCompleted
              ? '所有调查地点已经处理完毕，房主现在可以按阶段条件继续推进。'
              : `剩余地点已经全部调查。当前已确认 ${investigationState.completionVoteMembershipIds.length}/${room.members.filter((member) => member.assignedRoleId).length} 人。`}
          </p>
          {!investigationState.stageCompleted ? (
            <form action={`/api/rooms/${room.code}/investigation/complete`} method="post">
              <input type="hidden" name="authorizationVersion" value={room.authorizationVersion} />
              <button
                type="submit"
                disabled={investigationState.hasPublicationObligation
                  || investigationState.completionVoteMembershipIds.includes(room.membershipId)}
              >
                {investigationState.completionVoteMembershipIds.includes(room.membershipId)
                  ? '已确认，等待其他玩家'
                  : '确认本阶段调查完成'}
              </button>
            </form>
          ) : null}
        </section>
      ) : null}
      {privateClues.length ? (
        <section className="members-section clue-index-section">
          <p className="eyebrow">PRIVATE CLUES</p>
          <h2>我的未公开线索</h2>
          <p className="section-guidance">这些线索只对你可见。打开后可以选择继续隐藏，或公开到全房间看板。</p>
          <div className="clue-index-list">
          {privateClues.map((clue, clueIndex) => (
            <Link className="clue-index-card" key={clue.clueId} href={`/rooms/${room.code}/clues/${clue.clueId}`}>
              <span>{String(clueIndex + 1).padStart(2, '0')}</span>
              <strong>打开线索</strong>
              <small>仅自己可见</small>
            </Link>
          ))}
          </div>
        </section>
      ) : null}
      {room.status !== 'lobby' ? (
        <section className="members-section public-clue-board" id="public-clue-board">
          <p className="eyebrow">PUBLIC CLUE BOARD</p>
          <h2>公开线索板</h2>
          <p className="section-guidance">所有已公开线索会直接留在这里，房间内每位玩家都能查看，不需要再次翻开。</p>
          {publishedClues.length ? (
            <div className="public-clue-list">
              {publishedClues.map((clue, clueIndex) => (
                <article className="public-clue-card" key={clue.clueId}>
                  <header>
                    <span>{String(clueIndex + 1).padStart(2, '0')}</span>
                    <strong>公开线索</strong>
                  </header>
                  {clue.faces.flatMap((face) => face.content).map((content, contentIndex) => (
                    <ProtectedContent
                      key={`${clue.clueId}-public-${contentIndex}`}
                      code={room.code}
                      content={content}
                    />
                  ))}
                </article>
              ))}
            </div>
          ) : <p className="empty-state">目前还没有公开线索。玩家公开线索后，它会自动出现在这里。</p>}
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
        fullRoleAssignmentRequired ? (
          <section className="members-section force-start-section">
            <p className="eyebrow">ALL ROLES REQUIRED</p>
            <h2>还差 {packRoleCount - assignedRoleIds.size} 个席位</h2>
            <p className="empty-state">本局机制要求所有席位锁定后才能开场，少人开场不可用。</p>
            <button type="button" disabled>等待全部席位锁定</button>
          </section>
        ) : (
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
        )
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
      {releasedResolution.length ? (
        <section className="members-section resolution-section" id="final-resolution">
          <p className="eyebrow">FINAL RESOLUTION</p>
          <h2>真相</h2>
          <p className="section-guidance">本局已经结束，结束内容现在对房间成员开放。</p>
          <div className="player-guide-content">
            {releasedResolution.flatMap((section) => section.content).map((content, index) => (
              <ProtectedContent key={`resolution-${index}`} code={room.code} content={content} />
            ))}
          </div>
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
