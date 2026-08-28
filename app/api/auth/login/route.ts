import { NextRequest, NextResponse } from 'next/server';
import { applySessionCookie, authenticateUser, createSession } from '@/lib/auth';
import { assertSameOrigin } from '@/lib/security';

export async function POST(request: NextRequest) {
  let origin = new URL(request.url).origin;
  try {
    origin = assertSameOrigin(request);
    const form = await request.formData();
    const user = await authenticateUser(
      String(form.get('displayName') ?? ''),
      String(form.get('password') ?? ''),
    );
    if (!user) return NextResponse.redirect(new URL('/?auth=failed#account', origin), 303);
    const response = NextResponse.redirect(new URL('/rooms', origin), 303);
    applySessionCookie(response, createSession(user.id));
    return response;
  } catch {
    return NextResponse.redirect(new URL('/?auth=failed#account', origin), 303);
  }
}
