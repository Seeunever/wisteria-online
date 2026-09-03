import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth';
import { selectRotatingBlindDrawTieLocation } from '@/lib/investigation/rotating-blind-draw-room';
import { isRotatingBlindDrawMechanism } from '@/lib/investigation/rotating-blind-draw';
import { loadInstalledPack } from '@/lib/packs';
import { getRoomForMember } from '@/lib/rooms';
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
    const stageId = room?.reachedStages.find((stage) => stage.completedAt === null)?.stageId;
    if (!room?.versionId || !room.assignedRoleId || room.status !== 'running' || !stageId) {
      throw new Error('TIE_BREAK_REJECTED');
    }
    const form = await request.formData();
    const locationId = form.get('locationId');
    const authorizationVersion = Number(form.get('authorizationVersion'));
    if (typeof locationId !== 'string' || authorizationVersion !== room.authorizationVersion) {
      throw new Error('TIE_BREAK_REJECTED');
    }
    const { bundle, runtimePolicy } = loadInstalledPack(room.versionId);
    const mechanism = runtimePolicy.stageMechanisms[stageId];
    if (
      !isRotatingBlindDrawMechanism(mechanism)
      || !selectRotatingBlindDrawTieLocation({
        code: room.code,
        userId: user.id,
        versionId: room.versionId,
        authorizationVersion,
        stageId,
        locationId,
        bundle,
        mechanism,
      })
    ) throw new Error('TIE_BREAK_REJECTED');
    return NextResponse.redirect(new URL(`/rooms/${code}`, origin), 303);
  } catch {
    return NextResponse.redirect(new URL(`/rooms/${code}?error=tie-break`, origin), 303);
  }
}
