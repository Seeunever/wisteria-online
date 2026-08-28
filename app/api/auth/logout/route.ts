import { NextRequest, NextResponse } from 'next/server';
import { clearSession, SESSION_COOKIE } from '@/lib/auth';
import { assertSameOrigin } from '@/lib/security';

export async function POST(request: NextRequest) {
  let origin = new URL(request.url).origin;
  try {
    origin = assertSameOrigin(request);
    const response = NextResponse.redirect(new URL('/', origin), 303);
    clearSession(response, request.cookies.get(SESSION_COOKIE)?.value);
    return response;
  } catch {
    return NextResponse.redirect(new URL('/', origin), 303);
  }
}
