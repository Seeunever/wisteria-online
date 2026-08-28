import { NextRequest, NextResponse } from 'next/server';
import { assertSameOrigin } from '@/lib/security';

export async function POST(request: NextRequest) {
  let origin = new URL(request.url).origin;
  try {
    origin = assertSameOrigin(request);
  } catch {
    // Keep legacy requests on the public entry page without accepting passwords.
  }
  return NextResponse.redirect(new URL('/?auth=invalid#account', origin), 303);
}
