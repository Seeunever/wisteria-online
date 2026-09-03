import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth';
import { loadInstalledPack } from '@/lib/packs';
import { claimRole, getRoomForMember } from '@/lib/rooms';
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
    if (!room?.versionId || room.assignedRoleId) throw new Error('ROLE_CLAIM_REJECTED');
    const form = await request.formData();
    const roleId = form.get('roleId');
    if (typeof roleId !== 'string') throw new Error('ROLE_CLAIM_REJECTED');
    const { bundle } = loadInstalledPack(room.versionId);
    if (!Object.hasOwn(bundle.roles, roleId) || !claimRole(code, user.id, roleId)) {
      throw new Error('ROLE_CLAIM_REJECTED');
    }
    return NextResponse.redirect(new URL(`/rooms/${code}`, origin), 303);
  } catch {
    return NextResponse.redirect(new URL(`/rooms/${code}?error=role`, origin), 303);
  }
}
