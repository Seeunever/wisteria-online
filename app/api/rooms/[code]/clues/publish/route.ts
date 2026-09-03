import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth';
import { evaluateViewerCondition, type AuthorizationContext } from '@/lib/blind-runtime';
import { loadFrozenBundle } from '@/lib/packs';
import { getRoomForMember, publishHeldClue } from '@/lib/rooms';
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
    if (!room?.versionId || !room.assignedRoleId || room.status !== 'running') {
      throw new Error('PUBLISH_REJECTED');
    }
    const form = await request.formData();
    const clueId = form.get('clueId');
    if (typeof clueId !== 'string') throw new Error('PUBLISH_REJECTED');
    const bundle = loadFrozenBundle(room.versionId);
    const clue = bundle.clues[clueId];
    const activeStageId = room.reachedStages.find((stage) => stage.completedAt === null)?.stageId ?? null;
    const context: AuthorizationContext = {
      joined: true,
      assignedRoleId: room.assignedRoleId,
      assignedRoleIds: new Set(
        room.members.map((member) => member.assignedRoleId).filter((id): id is string => id !== null),
      ),
      activeStageId,
      reachedStageIds: new Set(room.reachedStages.map((stage) => stage.stageId)),
      heldClueIds: new Set(room.clues.filter((item) => item.isHeld).map((item) => item.clueId)),
      roomHeldClueIds: new Set(room.roomHeldClueIds),
      publishedClueIds: new Set(
        room.clues.filter((item) => item.publishedAt !== null).map((item) => item.clueId),
      ),
      investigationCompletedStageIds: new Set(room.investigationCompletedStageIds),
      hostReleaseIds: new Set(room.hostReleaseIds),
      sessionCompleted: false,
    };
    if (
      !clue?.publication.allowed
      || !context.heldClueIds.has(clueId)
      || !evaluateViewerCondition(clue.publication.publishWhen, context)
      || !publishHeldClue({
        code,
        userId: user.id,
        versionId: room.versionId,
        authorizationVersion: room.authorizationVersion,
        clueId,
      })
    ) throw new Error('PUBLISH_REJECTED');
    return NextResponse.redirect(new URL(`/rooms/${code}`, origin), 303);
  } catch {
    return NextResponse.redirect(new URL(`/rooms/${code}?error=publish`, origin), 303);
  }
}
