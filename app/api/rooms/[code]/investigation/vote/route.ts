import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth';
import {
  deriveInvestigationCandidates,
  type AuthorizationContext,
} from '@/lib/blind-runtime';
import { loadFrozenBundle } from '@/lib/packs';
import { getInvestigationState, getRoomForMember, voteInvestigationLocation } from '@/lib/rooms';
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
      throw new Error('VOTE_REJECTED');
    }
    const form = await request.formData();
    const locationId = form.get('locationId');
    const authorizationVersion = Number(form.get('authorizationVersion'));
    if (typeof locationId !== 'string' || authorizationVersion !== room.authorizationVersion) {
      throw new Error('VOTE_REJECTED');
    }
    const bundle = loadFrozenBundle(room.versionId);
    const stage = bundle.stages[activeStageId];
    const flow = stage?.investigationFlow;
    if (!flow || !stage.allowedActions.includes('search') || !stage.locationIds.includes(locationId)) {
      throw new Error('VOTE_REJECTED');
    }
    const authorization: AuthorizationContext = {
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
    const orderedMembershipIds = Object.values(bundle.roles)
      .sort((left, right) => left.slot - right.slot)
      .map((role) => room.members.find((member) => member.assignedRoleId === role.roleId)?.membershipId)
      .filter((id): id is string => Boolean(id));
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
    const candidates = deriveInvestigationCandidates(
      bundle,
      activeStageId,
      authorization,
      room.members.flatMap((member) => member.assignedRoleId ? [{
        assignedRoleId: member.assignedRoleId,
        heldClueIds: new Set(member.heldClueIds),
      }] : []),
      new Set(state.searchedLocationIds),
    );
    if (!voteInvestigationLocation({
      code: room.code,
      userId: user.id,
      versionId: room.versionId,
      authorizationVersion,
      stageId: activeStageId,
      locationId,
      eligibleLocationIds: candidates.roomLocationIds,
      actorEligibleLocationIds: candidates.actorLocationIds,
      orderedMembershipIds,
      scope: flow.locationSelection.scope,
      perPlayerStageLimit: flow.acquisitionLimit.perPlayer,
      maxPrivateCount: flow.publicationDuty.maxPrivateCount,
      mandatoryClueIds,
      blockForPublication: flow.publicationDuty.blockedActions.includes('vote_location'),
    })) throw new Error('VOTE_REJECTED');
    return NextResponse.redirect(new URL(`/rooms/${code}`, origin), 303);
  } catch {
    return NextResponse.redirect(new URL(`/rooms/${code}?error=vote`, origin), 303);
  }
}
