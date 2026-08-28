import { NextRequest, NextResponse } from 'next/server';
import {
  applyDeviceCookie,
  applySessionCookie,
  createSession,
  DEVICE_COOKIE,
} from '@/lib/auth';
import { claimIdentity } from '@/lib/identity';
import { assertSameOrigin } from '@/lib/security';

export async function POST(request: NextRequest) {
  let origin = new URL(request.url).origin;
  try {
    origin = assertSameOrigin(request);
    const form = await request.formData();
    const result = claimIdentity(
      String(form.get('displayName') ?? ''),
      request.cookies.get(DEVICE_COOKIE)?.value,
    );
    if (result.status !== 'ok') {
      return NextResponse.redirect(new URL(`/?auth=${result.status}#account`, origin), 303);
    }
    const response = NextResponse.redirect(new URL('/rooms', origin), 303);
    applySessionCookie(response, createSession(result.user.id));
    if (result.deviceToken) applyDeviceCookie(response, result.deviceToken);
    return response;
  } catch {
    return NextResponse.redirect(new URL('/?auth=invalid#account', origin), 303);
  }
}
