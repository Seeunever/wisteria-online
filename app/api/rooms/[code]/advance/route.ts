import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth';
import {
  evaluateStageFlowCondition,
  withEligibleHostReleases,
  type AuthorizationContext,
} from '@/lib/blind-runtime';
import { loadFrozenBundle } from '@/lib/packs';
import { advanceRoom, getRoomForMember } from '@/lib/rooms';
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
    const active = room?.reachedStages.find((stage) => stage.completedAt === null);
    if (
      !room?.versionId || !active || room.ownerUserId !== user.id || room.status !== 'running'
    ) throw new Error('ADVANCE_REJECTED');
    const bundle = loadFrozenBundle(room.versionId);
    const currentStage = bundle.stages[active.stageId];
    if (!currentStage) throw new Error('ADVANCE_REJECTED');
    const context: AuthorizationContext = {
      joined: true,
      assignedRoleId: room.assignedRoleId,
      assignedRoleIds: new Set(
        room.members.map((member) => member.assignedRoleId).filter((id): id is string => id !== null),
      ),
      activeStageId: active.stageId,
      reachedStageIds: new Set(room.reachedStages.map((stage) => stage.stageId)),
      heldClueIds: new Set(room.clues.filter((clue) => clue.isHeld).map((clue) => clue.clueId)),
      roomHeldClueIds: new Set(room.roomHeldClueIds),
      publishedClueIds: new Set(
        room.clues.filter((clue) => clue.publishedAt !== null).map((clue) => clue.clueId),
      ),
      hostReleaseIds: new Set(room.hostReleaseIds),
      sessionCompleted: false,
      investigationCompletedStageIds: new Set(room.investigationCompletedStageIds),
    };
    const releasedContext = withEligibleHostReleases(bundle, context);
    const simulatedFlowRoles = room.incompleteStart
      ? new Set(Object.keys(bundle.roles))
      : undefined;
    const nextStage = Object.values(bundle.stages).find(
      (stage) => stage.sequence === currentStage.sequence + 1,
    ) ?? null;
    const completionContext = nextStage
      ? releasedContext
      : { ...releasedContext, sessionCompleted: true };
    if (!evaluateStageFlowCondition(
      currentStage.completeWhen,
      completionContext,
      simulatedFlowRoles,
    )) {
      throw new Error('ADVANCE_REJECTED');
    }
    const entryContext = {
      ...releasedContext,
      activeStageId: null,
      reachedStageIds: new Set([...releasedContext.reachedStageIds, currentStage.stageId]),
    };
    if (nextStage && !evaluateStageFlowCondition(
      nextStage.enterWhen,
      entryContext,
      simulatedFlowRoles,
    )) {
      throw new Error('ADVANCE_REJECTED');
    }
    if (!advanceRoom({
      code: room.code,
      ownerUserId: user.id,
      versionId: room.versionId,
      authorizationVersion: room.authorizationVersion,
      currentStageId: currentStage.stageId,
      releaseIds: [...releasedContext.hostReleaseIds],
      nextStage: nextStage ? { stageId: nextStage.stageId, sequence: nextStage.sequence } : null,
    })) throw new Error('ADVANCE_REJECTED');
    return NextResponse.redirect(new URL(`/rooms/${code}`, origin), 303);
  } catch {
    return NextResponse.redirect(new URL(`/rooms/${code}?error=advance`, origin), 303);
  }
}
