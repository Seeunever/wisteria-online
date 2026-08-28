import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import type { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from './db';
import {
  hashPassword,
  normalizeUsername,
  validDisplayName,
  validPassword,
  verifyPassword,
} from './security';

export const SESSION_COOKIE = 'wisteria_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;

export type SessionUser = { id: string; displayName: string };

function tokenHash(token: string) {
  return createHash('sha256').update(token, 'ascii').digest('hex');
}

function lookupSession(token: string | undefined): SessionUser | null {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const now = Date.now();
  const row = getDatabase().prepare(`
    SELECT users.id AS id, users.display_name AS displayName
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(tokenHash(token), now) as SessionUser | undefined;
  return row ?? null;
}

export async function registerUser(displayNameInput: string, password: string) {
  const displayName = displayNameInput.normalize('NFKC').trim();
  if (!validDisplayName(displayName) || !validPassword(password)) return null;
  const id = randomUUID();
  const { salt, hash } = await hashPassword(password);
  try {
    getDatabase().prepare(`
      INSERT INTO users (id, username_key, display_name, password_salt, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, normalizeUsername(displayName), displayName, salt, hash, Date.now());
    return { id, displayName } satisfies SessionUser;
  } catch {
    return null;
  }
}

export async function authenticateUser(displayName: string, password: string) {
  if (!validDisplayName(displayName) || !validPassword(password)) return null;
  const row = getDatabase().prepare(`
    SELECT id, display_name AS displayName, password_salt AS salt, password_hash AS hash
    FROM users WHERE username_key = ?
  `).get(normalizeUsername(displayName)) as
    | (SessionUser & { salt: string; hash: string })
    | undefined;
  if (!row || !(await verifyPassword(password, row.salt, row.hash))) return null;
  return { id: row.id, displayName: row.displayName } satisfies SessionUser;
}

export function createSession(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  getDatabase().prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(tokenHash(token), userId, now, now + SESSION_SECONDS * 1000);
  return token;
}

export function applySessionCookie(response: NextResponse, token: string) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_SECONDS,
  });
}

export function clearSession(response: NextResponse, token?: string) {
  if (token) {
    getDatabase().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
  }
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
}

export async function getCurrentUser() {
  return lookupSession((await cookies()).get(SESSION_COOKIE)?.value);
}

export function getRequestUser(request: NextRequest) {
  return lookupSession(request.cookies.get(SESSION_COOKIE)?.value);
}
