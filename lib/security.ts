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

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!origin || !host) throw new Error('INVALID_ORIGIN');
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== host) {
    throw new Error('INVALID_ORIGIN');
  }
  return parsed.origin;
}
