import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDatabase } from './db.ts';
import { normalizeUsername, validDisplayName } from './security.ts';

export type IdentityUser = { id: string; displayName: string };

export type IdentityResult =
  | { status: 'ok'; user: IdentityUser; deviceToken: string | null; created: boolean }
  | { status: 'invalid' | 'claimed' | 'device-bound' };

function tokenHash(token: string) {
  return createHash('sha256').update(token, 'ascii').digest('hex');
}

export function getIdentityForDevice(token: string | undefined): IdentityUser | null {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = getDatabase().prepare(`
    SELECT users.id AS id, users.display_name AS displayName
    FROM device_credentials
    JOIN users ON users.id = device_credentials.user_id
    WHERE device_credentials.token_hash = ?
  `).get(tokenHash(token)) as IdentityUser | undefined;
  return row ?? null;
}

export function claimIdentity(displayNameInput: string, currentDeviceToken?: string): IdentityResult {
  const displayName = displayNameInput.normalize('NFKC').trim();
  if (!validDisplayName(displayName)) return { status: 'invalid' };
  const usernameKey = normalizeUsername(displayName);
  const database = getDatabase();
  const validDeviceToken = currentDeviceToken && /^[A-Za-z0-9_-]{43}$/.test(currentDeviceToken)
    ? currentDeviceToken
    : null;
  try {
    database.exec('BEGIN IMMEDIATE');
    if (validDeviceToken) {
      const bound = database.prepare(`
        SELECT users.id, users.username_key AS usernameKey, users.display_name AS displayName
        FROM device_credentials
        JOIN users ON users.id = device_credentials.user_id
        WHERE device_credentials.token_hash = ?
      `).get(tokenHash(validDeviceToken)) as
        | (IdentityUser & { usernameKey: string })
        | undefined;
      if (bound) {
        if (bound.usernameKey !== usernameKey) {
          database.exec('ROLLBACK');
          return { status: 'device-bound' };
        }
        database.prepare('UPDATE device_credentials SET last_used_at = ? WHERE user_id = ?')
          .run(Date.now(), bound.id);
        database.exec('COMMIT');
        return {
          status: 'ok',
          user: { id: bound.id, displayName: bound.displayName },
          deviceToken: null,
          created: false,
        };
      }
    }

    const existing = database.prepare(
      'SELECT id FROM users WHERE username_key = ?',
    ).get(usernameKey) as { id: string } | undefined;
    if (existing) {
      database.exec('ROLLBACK');
      return { status: 'claimed' };
    }

    const id = randomUUID();
    const deviceToken = randomBytes(32).toString('base64url');
    const now = Date.now();
    database.prepare(`
      INSERT INTO users (id, username_key, display_name, password_salt, password_hash, created_at)
      VALUES (?, ?, ?, '', '', ?)
    `).run(id, usernameKey, displayName, now);
    database.prepare(`
      INSERT INTO device_credentials (user_id, token_hash, created_at, last_used_at)
      VALUES (?, ?, ?, ?)
    `).run(id, tokenHash(deviceToken), now, now);
    database.exec('COMMIT');
    return {
      status: 'ok',
      user: { id, displayName },
      deviceToken,
      created: true,
    };
  } catch {
    try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    return { status: 'invalid' };
  }
}
