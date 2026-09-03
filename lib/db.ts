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

    CREATE TABLE IF NOT EXISTS pack_runtime_profiles (
      version_id TEXT PRIMARY KEY REFERENCES pack_versions(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('canonical', 'sidecar', 'legacy_embedded')),
      canonical_payload_hash TEXT NOT NULL,
      bundle_payload_hash TEXT,
      policy_schema TEXT,
      policy_path TEXT UNIQUE,
      policy_payload_hash TEXT,
      runtime_policy_hash TEXT,
      created_at INTEGER NOT NULL,
      CHECK (
        (
          mode = 'sidecar'
          AND bundle_payload_hash IS NOT NULL
          AND policy_schema = 'wisteria-runtime-policy/1.0'
          AND policy_path IS NOT NULL
          AND policy_payload_hash IS NOT NULL
          AND runtime_policy_hash IS NOT NULL
        )
        OR
        (
          mode = 'canonical'
          AND bundle_payload_hash IS NOT NULL
          AND policy_schema IS NULL
          AND policy_path IS NULL
          AND policy_payload_hash IS NULL
          AND runtime_policy_hash IS NULL
        )
        OR
        (
          mode = 'legacy_embedded'
          AND policy_schema IS NULL
          AND policy_path IS NULL
          AND policy_payload_hash IS NULL
          AND runtime_policy_hash IS NULL
        )
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS pack_render_profiles (
      version_id TEXT PRIMARY KEY REFERENCES pack_versions(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('manifest', 'legacy_embedded')),
      canonical_payload_hash TEXT NOT NULL,
      bundle_payload_hash TEXT,
      manifest_schema TEXT,
      manifest_path TEXT UNIQUE,
      manifest_payload_hash TEXT,
      render_manifest_hash TEXT,
      created_at INTEGER NOT NULL,
      CHECK (
        (
          mode = 'manifest'
          AND bundle_payload_hash IS NOT NULL
          AND manifest_schema = 'wisteria-render-manifest/1.0'
          AND manifest_path IS NOT NULL
          AND manifest_payload_hash IS NOT NULL
          AND render_manifest_hash IS NOT NULL
        )
        OR
        (
          mode = 'legacy_embedded'
          AND manifest_schema IS NULL
          AND manifest_path IS NULL
          AND manifest_payload_hash IS NULL
          AND render_manifest_hash IS NULL
        )
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS app_schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
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

    CREATE TABLE IF NOT EXISTS investigation_rounds (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      stage_id TEXT NOT NULL,
      round_number INTEGER NOT NULL CHECK (round_number > 0),
      tie_break_membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
      selected_location_id TEXT,
      cursor_membership_id TEXT REFERENCES memberships(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY(room_id, stage_id, round_number)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS investigation_votes (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      stage_id TEXT NOT NULL,
      round_number INTEGER NOT NULL CHECK (round_number > 0),
      membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
      location_id TEXT NOT NULL,
      voted_at INTEGER NOT NULL,
      PRIMARY KEY(room_id, stage_id, round_number, membership_id),
      FOREIGN KEY(room_id, stage_id, round_number)
        REFERENCES investigation_rounds(room_id, stage_id, round_number) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS investigation_acquisitions (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      clue_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      round_number INTEGER NOT NULL CHECK (round_number > 0),
      membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
      acquired_at INTEGER NOT NULL,
      PRIMARY KEY(room_id, clue_id),
      FOREIGN KEY(room_id, clue_id)
        REFERENCES clue_holdings(room_id, clue_id) ON DELETE CASCADE,
      FOREIGN KEY(room_id, stage_id, round_number)
        REFERENCES investigation_rounds(room_id, stage_id, round_number) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS investigation_completion_votes (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      stage_id TEXT NOT NULL,
      membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
      authorization_version INTEGER NOT NULL CHECK (authorization_version > 0),
      consent INTEGER NOT NULL CHECK (consent IN (0, 1)),
      voted_at INTEGER NOT NULL,
      PRIMARY KEY(room_id, stage_id, membership_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS investigation_stage_completions (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      stage_id TEXT NOT NULL,
      completed_at INTEGER NOT NULL,
      PRIMARY KEY(room_id, stage_id)
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
  const completionVoteColumns = database.prepare(
    'PRAGMA table_info(investigation_completion_votes)',
  ).all() as Array<{ name: string }>;
  if (!completionVoteColumns.some((column) => column.name === 'authorization_version')) {
    database.exec(`
      ALTER TABLE investigation_completion_votes
      ADD COLUMN authorization_version INTEGER NOT NULL DEFAULT 1 CHECK (authorization_version > 0)
    `);
  }

  const runtimeProfileColumns = database.prepare(
    'PRAGMA table_info(pack_runtime_profiles)',
  ).all() as Array<{ name: string }>;
  if (!runtimeProfileColumns.some((column) => column.name === 'bundle_payload_hash')) {
    database.exec(`
      ALTER TABLE pack_runtime_profiles
      ADD COLUMN bundle_payload_hash TEXT
    `);
  }

  const runtimeProfileMigration = '2026-09-03-pack-runtime-profile-registry';
  const runtimeProfilesBackfilled = database.prepare(
    'SELECT 1 FROM app_schema_migrations WHERE id = ?',
  ).get(runtimeProfileMigration);
  if (!runtimeProfilesBackfilled) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`
        INSERT OR IGNORE INTO pack_runtime_profiles
          (version_id, mode, canonical_payload_hash, created_at)
        SELECT id, 'legacy_embedded', source_hash, ?
        FROM pack_versions
      `).run(Date.now());
      database.prepare(`
        INSERT INTO app_schema_migrations (id, applied_at)
        VALUES (?, ?)
      `).run(runtimeProfileMigration, Date.now());
      database.exec('COMMIT');
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
      throw error;
    }
  }

  const renderProfileMigration = '2026-09-03-pack-render-profile-registry';
  const renderProfilesBackfilled = database.prepare(
    'SELECT 1 FROM app_schema_migrations WHERE id = ?',
  ).get(renderProfileMigration);
  if (!renderProfilesBackfilled) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`
        INSERT OR IGNORE INTO pack_render_profiles
          (version_id, mode, canonical_payload_hash, created_at)
        SELECT id, 'legacy_embedded', source_hash, ?
        FROM pack_versions
      `).run(Date.now());
      database.prepare(`
        INSERT INTO app_schema_migrations (id, applied_at)
        VALUES (?, ?)
      `).run(renderProfileMigration, Date.now());
      database.exec('COMMIT');
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* transaction did not start */ }
      throw error;
    }
  }
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
