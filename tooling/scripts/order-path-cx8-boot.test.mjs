import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CX8_SMOKE_ENV, cx8RoleEnv } from './order-path-cx8-boot.mjs';

test('CX-8 smoke publishes the D-44 integers on the processes that refuse a blank', () => {
  assert.deepEqual(CX8_SMOKE_ENV, {
    DATABASE_POOL_MAX: '10',
    RECONCILE_CRON_MINUTES: '60',
    MATCHING_SNAPSHOT_EVERY: '500',
  });
  assert.deepEqual(cx8RoleEnv('matching'), { MATCHING_SNAPSHOT_EVERY: '500' });
  assert.deepEqual(cx8RoleEnv('ledger'), { DATABASE_POOL_MAX: '10', RECONCILE_CRON_MINUTES: '60' });
  assert.deepEqual(cx8RoleEnv('identity'), { DATABASE_POOL_MAX: '10' });
  assert.deepEqual(cx8RoleEnv('trade'), { DATABASE_POOL_MAX: '10' });
});

test('each booted process spreads that role env', () => {
  const src = readFileSync(new URL('./order-path-cx8-boot.mjs', import.meta.url), 'utf8');
  for (const role of ['matching', 'ledger', 'identity', 'trade']) {
    assert.match(src, new RegExp(`start\\('${role}'[\\s\\S]*?\\.\\.\\.cx8RoleEnv\\('${role}'\\)`));
  }
});
