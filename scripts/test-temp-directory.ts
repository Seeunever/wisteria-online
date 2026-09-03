import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function candidateBases() {
  const candidates = process.platform === 'win32'
    ? [os.tmpdir()]
    : [os.tmpdir(), '/var/tmp'];
  return [...new Set(candidates.flatMap((candidate) => {
    try {
      return [realpathSync(candidate)];
    } catch {
      return [];
    }
  }))];
}

function hasGitAncestor(root: string) {
  let cursor = root;
  for (;;) {
    if (existsSync(path.join(cursor, '.git'))) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

export function createTestTempDirectory(prefix: string, requireOutsideGit = false) {
  for (const base of candidateBases()) {
    if (requireOutsideGit && hasGitAncestor(base)) continue;
    try {
      return realpathSync(mkdtempSync(path.join(base, prefix)));
    } catch {
      // Try the next approved system temporary directory.
    }
  }
  throw new Error('NO_SAFE_TEST_TEMP_DIRECTORY');
}

export function removeTestTempDirectory(root: string, prefix: string) {
  const resolved = realpathSync(root);
  const parent = realpathSync(path.dirname(resolved));
  if (!candidateBases().includes(parent) || !path.basename(resolved).startsWith(prefix)) {
    throw new Error('UNSAFE_TEST_CLEANUP_TARGET');
  }
  rmSync(resolved, { recursive: true, force: false });
}
