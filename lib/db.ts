import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type GlobalDatabase = typeof globalThis & { __wisteriaDb?: DatabaseSync };

function databasePath() {
  const dataDirectory = process.env.WISTERIA_DATA_DIR
    ? path.resolve(process.env.WISTERIA_DATA_DIR)
    : path.join(process.cwd(), '.data');
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  return path.join(dataDirectory, 'wisteria.sqlite3');
}

function initialize(database: DatabaseSync) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username_key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS device_credentials (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS pack_versions (
      id TEXT PRIMARY KEY,
      public_label TEXT NOT NULL,
      payload_path TEXT NOT NULL UNIQUE,
      source_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('validated', 'frozen', 'retired')),
      created_at INTEGER NOT NULL,
      frozen_at INTEGER
    ) STRICT;

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      version_id TEXT REFERENCES pack_versions(id),
      status TEXT NOT NULL CHECK (status IN ('lobby', 'running', 'completed')),
      authorization_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at INTEGER NOT NULL,
      left_at INTEGER,
      UNIQUE(room_id, user_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS role_assignments (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL,
      membership_id TEXT NOT NULL UNIQUE REFERENCES memberships(id) ON DELETE CASCADE,
      assigned_at INTEGER NOT NULL,
      PRIMARY KEY(room_id, role_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS room_stages (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      stage_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      entered_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY(room_id, stage_id),
      UNIQUE(room_id, sequence)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS clue_holdings (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      clue_id TEXT NOT NULL,
      holder_membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
      acquired_at INTEGER NOT NULL,
      published_at INTEGER,
      PRIMARY KEY(room_id, clue_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS clue_holdings_holder
      ON clue_holdings(room_id, holder_membership_id);

    CREATE TABLE IF NOT EXISTS search_uses (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      location_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
      uses INTEGER NOT NULL CHECK (uses > 0),
      PRIMARY KEY(room_id, location_id, stage_id, membership_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS location_search_totals (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      location_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      uses INTEGER NOT NULL CHECK (uses > 0),
      PRIMARY KEY(room_id, location_id, stage_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS room_host_releases (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      release_id TEXT NOT NULL,
      released_at INTEGER NOT NULL,
      PRIMARY KEY(room_id, release_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS room_events (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      actor_membership_id TEXT REFERENCES memberships(id),
      event_type TEXT NOT NULL,
      object_id TEXT,
      event_payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(room_id, event_type, object_id, actor_membership_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS room_events_room_time ON room_events(room_id, created_at);
  `);
}

export function getDatabase() {
  const scope = globalThis as GlobalDatabase;
  if (!scope.__wisteriaDb) {
    scope.__wisteriaDb = new DatabaseSync(databasePath(), {
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
    initialize(scope.__wisteriaDb);
  }
  return scope.__wisteriaDb;
}
