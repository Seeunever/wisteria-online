import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth';
import { loadInstalledPack } from '@/lib/packs';
import { attachFrozenPackToRoom } from '@/lib/rooms';
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
    const form = await request.formData();
    const versionId = form.get('versionId');
    if (typeof versionId !== 'string') {
      throw new Error('PACK_ATTACH_FAILED');
    }
    loadInstalledPack(versionId);
    if (!attachFrozenPackToRoom(code, user.id, versionId)) throw new Error('PACK_ATTACH_FAILED');
    return NextResponse.redirect(new URL(`/rooms/${code}`, origin), 303);
  } catch {
    return NextResponse.redirect(new URL(`/rooms/${code}?error=pack`, origin), 303);
  }
}
