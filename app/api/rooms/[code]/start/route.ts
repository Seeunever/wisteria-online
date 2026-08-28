import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth';
import { evaluateCondition, type AuthorizationContext } from '@/lib/blind-runtime';
import { loadFrozenBundle } from '@/lib/packs';
import { getRoomForMember, startRoom } from '@/lib/rooms';
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
    if (!room?.versionId || room.ownerUserId !== user.id || room.status !== 'lobby') {
      throw new Error('ROOM_START_REJECTED');
    }
    const bundle = loadFrozenBundle(room.versionId);
    const roleIds = Object.keys(bundle.roles);
    const assignedRoleIds = new Set(
      room.members.map((member) => member.assignedRoleId).filter((id): id is string => id !== null),
    );
    const firstStage = Object.values(bundle.stages).find((stage) => stage.sequence === 1);
    const context: AuthorizationContext = {
      joined: true,
      assignedRoleId: room.assignedRoleId,
      assignedRoleIds,
      activeStageId: null,
      reachedStageIds: new Set(),
      heldClueIds: new Set(),
      roomHeldClueIds: new Set(),
      publishedClueIds: new Set(),
      hostReleaseIds: new Set(),
      sessionCompleted: false,
    };
    if (
      !firstStage
      || assignedRoleIds.size !== roleIds.length
      || !evaluateCondition(firstStage.enterWhen, context)
      || !startRoom(code, user.id, room.versionId, roleIds, firstStage.stageId, firstStage.sequence)
    ) throw new Error('ROOM_START_REJECTED');
    return NextResponse.redirect(new URL(`/rooms/${code}`, origin), 303);
  } catch {
    return NextResponse.redirect(new URL(`/rooms/${code}?error=start`, origin), 303);
  }
}
