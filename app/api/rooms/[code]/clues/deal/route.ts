import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth';
import { evaluateViewerCondition, type AuthorizationContext } from '@/lib/blind-runtime';
import { loadInstalledPack } from '@/lib/packs';
import { dealLocationClue, getRoomForMember } from '@/lib/rooms';
import { canonicalUsageWindowStageIds } from '@/lib/search-policy-window';
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
    if (
      !room?.versionId
      || room.ownerUserId !== user.id
      || room.status !== 'running'
      || !activeStageId
    ) throw new Error('DEAL_REJECTED');
    const form = await request.formData();
    const locationId = form.get('locationId');
    const targetMembershipId = form.get('targetMembershipId');
    if (typeof locationId !== 'string' || typeof targetMembershipId !== 'string') {
      throw new Error('DEAL_REJECTED');
    }
    const { bundle, runtimePolicy } = loadInstalledPack(room.versionId);
    const stage = bundle.stages[activeStageId];
    const mechanism = runtimePolicy.stageMechanisms[activeStageId];
    const location = bundle.locations[locationId];
    if (
      !stage?.allowedActions.includes('search')
      || !mechanism
      || !['canonical_search_policy', 'direct_pick'].includes(mechanism.kind)
      || !location
      || location.searchPolicy.mode !== 'host_dealt'
      || !stage.locationIds.includes(locationId)
    ) throw new Error('DEAL_REJECTED');
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
      investigationCompletedStageIds: new Set(room.investigationCompletedStageIds),
      hostReleaseIds: new Set(room.hostReleaseIds),
      sessionCompleted: false,
    };
    if (!evaluateViewerCondition(location.availableWhen, context)) throw new Error('DEAL_REJECTED');
    const eligibleClueIds = location.cluePool
      .filter((entry) => (
        evaluateViewerCondition(entry.availableWhen, context)
        && Boolean(bundle.clues[entry.clueId])
        && evaluateViewerCondition(bundle.clues[entry.clueId].acquisition.when, context)
      ))
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.clueId);
    if (!dealLocationClue({
      code: room.code,
      ownerUserId: user.id,
      versionId: room.versionId,
      authorizationVersion: room.authorizationVersion,
      locationId,
      stageId: activeStageId,
      usageStageIds: canonicalUsageWindowStageIds(bundle, activeStageId, locationId),
      targetMembershipId,
      eligibleClueIds,
      perPlayerLimit: location.searchPolicy.perPlayerLimit,
      globalLimit: location.searchPolicy.globalLimit,
    })) throw new Error('DEAL_REJECTED');
    return NextResponse.redirect(new URL(`/rooms/${code}`, origin), 303);
  } catch {
    return NextResponse.redirect(new URL(`/rooms/${code}?error=deal`, origin), 303);
  }
}
