#!/usr/bin/env node
import { access, chmod, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const sourcePath = path.join(process.env.WISTERIA_DATA_DIR ?? '/var/lib/wisteria', 'wisteria.sqlite3');
const backupDirectory = process.env.WISTERIA_BACKUP_DIR ?? '/var/backups/wisteria';
const retention = 14;

await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
try {
  await access(sourcePath);
} catch {
  process.stdout.write('{"code":"DATABASE_BACKUP_SKIPPED","status":"private"}\n');
  process.exit(0);
}
const source = new DatabaseSync(sourcePath, { readOnly: true });
try {
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace('.000Z', 'Z');
  const destination = path.join(backupDirectory, `wisteria-${stamp}.sqlite3`);
  await backup(source, destination);
  await chmod(destination, 0o600);
} finally {
  source.close();
}

const candidates = (await readdir(backupDirectory))
  .filter((name) => /^wisteria-[0-9TZ]+\.sqlite3$/.test(name))
  .map((name) => path.join(backupDirectory, name));
const ordered = await Promise.all(candidates.map(async (name) => ({ name, time: (await stat(name)).mtimeMs })));
ordered.sort((left, right) => right.time - left.time);
for (const expired of ordered.slice(retention)) await unlink(expired.name);

process.stdout.write('{"code":"DATABASE_BACKUP_WRITTEN","status":"private"}\n');
