import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth';
import { deleteRoom } from '@/lib/rooms';
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
    if (form.get('confirmDelete') !== 'yes' || !deleteRoom(code, user.id)) {
      throw new Error('ROOM_DELETE_REJECTED');
    }
    return NextResponse.redirect(new URL('/rooms?deleted=1', origin), 303);
  } catch {
    return NextResponse.redirect(new URL(`/rooms/${code}?error=delete`, origin), 303);
  }
}
