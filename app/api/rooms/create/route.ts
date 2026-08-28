import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth';
import { createRoom } from '@/lib/rooms';
import { assertSameOrigin } from '@/lib/security';

export async function POST(request: NextRequest) {
  let origin = new URL(request.url).origin;
  try {
    origin = assertSameOrigin(request);
    const user = getRequestUser(request);
    if (!user) return NextResponse.redirect(new URL('/#account', origin), 303);
    const form = await request.formData();
    const versionId = form.get('versionId');
    if (typeof versionId !== 'string') throw new Error('PACK_SELECTION_REQUIRED');
    const code = createRoom(user.id, versionId);
    if (!code) throw new Error('ROOM_CREATE_FAILED');
    return NextResponse.redirect(new URL(`/rooms/${code}`, origin), 303);
  } catch {
    return NextResponse.redirect(new URL('/rooms?error=create', origin), 303);
  }
}
