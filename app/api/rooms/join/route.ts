import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth';
import { joinRoom } from '@/lib/rooms';
import { assertSameOrigin } from '@/lib/security';

export async function POST(request: NextRequest) {
  let origin = new URL(request.url).origin;
  try {
    origin = assertSameOrigin(request);
    const user = getRequestUser(request);
    if (!user) return NextResponse.redirect(new URL('/#account', origin), 303);
    const form = await request.formData();
    const code = String(form.get('code') ?? '').normalize('NFKC').trim().toUpperCase();
    if (!joinRoom(user.id, code)) throw new Error('ROOM_JOIN_FAILED');
    return NextResponse.redirect(new URL(`/rooms/${code}`, origin), 303);
  } catch {
    return NextResponse.redirect(new URL('/rooms?error=join', origin), 303);
  }
}
