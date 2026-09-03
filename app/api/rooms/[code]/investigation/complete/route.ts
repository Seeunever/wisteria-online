import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth';
import {
  deriveInvestigationCandidates,
  type AuthorizationContext,
  type CollectiveVoteRoundRobinFlowV1,
} from '@/lib/blind-runtime';
import { voteRotatingBlindDrawCompletion } from '@/lib/investigation/rotating-blind-draw-room';
import { isRotatingBlindDrawMechanism } from '@/lib/investigation/rotating-blind-draw';
import { loadInstalledPack } from '@/lib/packs';
import {
  getInvestigationState,
  getRoomForMember,
  voteInvestigationCompletion,
} from '@/lib/rooms';
import { assertSameOrigin } from '@/lib/security';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  let origin = new URL(request.url).origin;
  const { code } = await params;
  try {
    origin = assertSameOrigin(request);
    const user = getRequestUser(request);
    if (!user) return NextResponse.redirect(new URL('/#account', origin), 303);
    const room = getRoomForMember(code, user.id);
    const activeStageId = room?.reachedStages.find((stage) => stage.completedAt === null)?.stageId;
    if (!room?.versionId || !room.assignedRoleId || room.status !== 'running' || !activeStageId) {
      throw new Error('COMPLETION_REJECTED');
    }
    const form = await request.formData();
    const authorizationVersion = Number(form.get('authorizationVersion'));
    if (authorizationVersion !== room.authorizationVersion) throw new Error('COMPLETION_REJECTED');
    const { bundle, runtimePolicy } = loadInstalledPack(room.versionId);
    const stage = bundle.stages[activeStageId];
    const mechanism = runtimePolicy.stageMechanisms[activeStageId];
    if (!stage || !mechanism) throw new Error('COMPLETION_REJECTED');
    if (isRotatingBlindDrawMechanism(mechanism)) {
      if (!voteRotatingBlindDrawCompletion({
        code: room.code,
        userId: user.id,
        versionId: room.versionId,
        authorizationVersion,
        stageId: activeStageId,
        bundle,
        mechanism,
      })) throw new Error('COMPLETION_REJECTED');
      return NextResponse.redirect(new URL(`/rooms/${code}`, origin), 303);
    }
    const flow = mechanism.kind === 'collective_vote_round_robin' && mechanism.version === 1
      ? mechanism as CollectiveVoteRoundRobinFlowV1
      : null;
    if (!flow?.completion || flow.completion.exhaustive !== 'per_player_quota') {
      throw new Error('COMPLETION_REJECTED');
    }
    const mandatoryClueIds = Object.values(bundle.clues)
      .filter((clue) => clue.publication.duty?.mode === 'mandatory_on_acquire')
      .map((clue) => clue.clueId);
    const state = getInvestigationState({
      roomId: room.id,
      membershipId: room.membershipId,
      stageId: activeStageId,
      scope: flow.locationSelection.scope,
      perPlayerStageLimit: flow.acquisitionLimit.perPlayer,
      maxPrivateCount: flow.publicationDuty.maxPrivateCount,
      mandatoryClueIds,
    });
    if (state.selectedLocationId || state.stageCompleted) throw new Error('COMPLETION_REJECTED');
    const context: AuthorizationContext = {
      joined: true,
      assignedRoleId: room.assignedRoleId,
      assignedRoleIds: new Set(
        room.members.map((member) => member.assignedRoleId).filter((id): id is string => id !== null),
      ),
      activeStageId,
      reachedStageIds: new Set(room.reachedStages.map((item) => item.stageId)),
      heldClueIds: new Set(room.clues.filter((clue) => clue.isHeld).map((clue) => clue.clueId)),
      roomHeldClueIds: new Set(room.roomHeldClueIds),
      publishedClueIds: new Set(
        room.clues.filter((clue) => clue.publishedAt !== null).map((clue) => clue.clueId),
      ),
      hostReleaseIds: new Set(room.hostReleaseIds),
      sessionCompleted: false,
      investigationCompletedStageIds: new Set(room.investigationCompletedStageIds),
    };
    const candidates = deriveInvestigationCandidates(
      bundle,
      activeStageId,
      context,
      room.members.flatMap((member) => member.assignedRoleId ? [{
        assignedRoleId: member.assignedRoleId,
        heldClueIds: new Set(member.heldClueIds),
      }] : []),
      new Set(state.searchedLocationIds),
      flow,
    );
    const orderedMembershipIds = Object.values(bundle.roles)
      .sort((left, right) => left.slot - right.slot)
      .map((role) => room.members.find((member) => member.assignedRoleId === role.roleId)?.membershipId)
      .filter((id): id is string => Boolean(id));
    if (!voteInvestigationCompletion({
      code: room.code,
      userId: user.id,
      versionId: room.versionId,
      authorizationVersion,
      stageId: activeStageId,
      orderedMembershipIds,
      remainingLocationIds: state.roomQuotaReached ? [] : candidates.roomLocationIds,
      maxPrivateCount: flow.publicationDuty.maxPrivateCount,
      mandatoryClueIds,
    })) throw new Error('COMPLETION_REJECTED');
    return NextResponse.redirect(new URL(`/rooms/${code}`, origin), 303);
  } catch {
    return NextResponse.redirect(new URL(`/rooms/${code}?error=completion`, origin), 303);
  }
}
