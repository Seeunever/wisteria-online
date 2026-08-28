import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export function normalizeUsername(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

export function validDisplayName(value: string) {
  const normalized = value.normalize('NFKC').trim();
  const length = Array.from(normalized).length;
  return length >= 1
    && length <= 24
    && /^[\p{L}\p{N}_ -]+$/u.test(normalized);
}

export function validPassword(value: string) {
  return value.length >= 8 && value.length <= 128;
}

export async function hashPassword(password: string, salt?: string) {
  const actualSalt = salt ?? randomBytes(16).toString('hex');
  const derived = (await scrypt(password, actualSalt, 64)) as Buffer;
  return { salt: actualSalt, hash: derived.toString('hex') };
}

export async function verifyPassword(password: string, salt: string, expected: string) {
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expectedBuffer = Buffer.from(expected, 'hex');
  return derived.length === expectedBuffer.length
    && timingSafeEqual(derived, expectedBuffer);
}

export function externalRequestOrigin(request: Request) {
  const host = request.headers.get('host');
  const rawForwardedProtocol = request.headers.get('x-forwarded-proto');
  if (rawForwardedProtocol?.includes(',')) throw new Error('INVALID_ORIGIN');
  const forwardedProtocol = rawForwardedProtocol?.trim().toLowerCase();
  const protocol = forwardedProtocol || new URL(request.url).protocol.slice(0, -1);
  if (!host || !['http', 'https'].includes(protocol)) {
    throw new Error('INVALID_ORIGIN');
  }

  const parsed = new URL(`${protocol}://${host}`);
  if (
    parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('INVALID_ORIGIN');
  }
  return parsed.origin;
}

export function assertSameOrigin(request: Request) {
  const expectedOrigin = externalRequestOrigin(request);
  const origin = request.headers.get('origin');

  if (origin && origin !== 'null') {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== expectedOrigin) {
      throw new Error('INVALID_ORIGIN');
    }
    return expectedOrigin;
  }

  // Under this site's no-referrer policy, some browsers omit Origin or
  // serialize it as "null" on a document form POST. Fetch metadata is
  // browser-controlled, so it remains a safe fallback without accepting
  // cross-site submissions.
  if (request.headers.get('sec-fetch-site') !== 'same-origin') {
    throw new Error('INVALID_ORIGIN');
  }
  return expectedOrigin;
}
