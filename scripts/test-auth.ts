import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('username-only identity remains bound to its original device credential', async () => {
  const temporaryRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wisteria-auth-test-')));
  process.env.WISTERIA_DATA_DIR = temporaryRoot;
  let closeDatabase: (() => void) | undefined;
  try {
    const [{ claimIdentity, getIdentityForDevice }, { getDatabase }] = await Promise.all([
      import('../lib/identity.ts'),
      import('../lib/db.ts'),
    ]);
    const database = getDatabase();
    closeDatabase = () => database.close();

    const created = claimIdentity('阿紫');
    assert.equal(created.status, 'ok');
    assert.equal(created.created, true);
    assert.match(created.deviceToken ?? '', /^[A-Za-z0-9_-]{43}$/);

    const resumed = claimIdentity('阿紫', created.deviceToken ?? undefined);
    assert.equal(resumed.status, 'ok');
    assert.equal(resumed.created, false);
    assert.equal(resumed.user.id, created.user.id);

    assert.deepEqual(claimIdentity('阿紫'), { status: 'claimed' });
    assert.deepEqual(claimIdentity('另一位', created.deviceToken ?? undefined), {
      status: 'device-bound',
    });
    assert.deepEqual(claimIdentity('不允许。'), { status: 'invalid' });
    const deviceIdentity = getIdentityForDevice(created.deviceToken ?? undefined);
    assert.equal(deviceIdentity?.id, created.user.id);
    assert.equal(deviceIdentity?.displayName, created.user.displayName);
    assert.equal(getIdentityForDevice('invalid'), null);
    const userCount = database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    const credentialCount = database.prepare(
      'SELECT COUNT(*) AS count FROM device_credentials',
    ).get() as { count: number };
    assert.equal(userCount.count, 1);
    assert.equal(credentialCount.count, 1);
  } finally {
    closeDatabase?.();
    const resolved = realpathSync(temporaryRoot);
    const expectedPrefix = `${realpathSync(os.tmpdir())}${path.sep}`;
    if (!resolved.startsWith(expectedPrefix) || !path.basename(resolved).startsWith('wisteria-auth-test-')) {
      throw new Error('UNSAFE_TEST_CLEANUP_TARGET');
    }
    rmSync(resolved, { recursive: true, force: false });
  }
});
