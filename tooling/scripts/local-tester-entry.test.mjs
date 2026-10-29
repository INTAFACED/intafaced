// The tester entry's outbox reading, without a stack. Run: node --test tooling/scripts/local-tester-entry.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mailedTo, waitingDeviceCode } from './local-tester-entry.mjs';

const A = 'local-test-founder-a@local-test.invalid';
const NOW = new Date('2026-10-29T17:00:00.000Z');
const OUTBOX = [
  `LOCAL-TEST purpose=email-confirm email=${A} expires=2026-10-30T17:00:00.000Z link=confirm-email?token=abc`,
  `LOCAL-TEST purpose=new-device-code email=${A} expires=2026-10-29T16:50:00.000Z code=111111`,
  `LOCAL-TEST purpose=new-device-code email=${A} expires=2026-10-29T17:10:00.000Z code=222222`,
  `LOCAL-TEST purpose=new-device-code email=other@local-test.invalid expires=2026-10-29T17:10:00.000Z code=333333`,
  `LOCAL-TEST purpose=login-code email=${A} expires=2026-10-29T17:10:00.000Z code=444444`,
  `purpose=new-device-code email=${A} expires=2026-10-29T17:10:00.000Z code=555555`,
  '',
].join('\n');

test('reads only the purpose and address asked for, oldest first', () => {
  assert.deepEqual(
    mailedTo(OUTBOX, 'new-device-code', A).map((m) => m.code),
    ['111111', '222222'],
  );
  assert.equal(mailedTo(OUTBOX, 'email-confirm', A)[0].link, 'confirm-email?token=abc');
});

test('the waiting device code is the newest one that has not expired, else none', () => {
  assert.equal(waitingDeviceCode(OUTBOX, A, NOW)?.code, '222222');
  assert.equal(waitingDeviceCode(OUTBOX, A, new Date('2026-10-29T17:20:00.000Z')), null);
  assert.equal(waitingDeviceCode('', A, NOW), null);
});

test('refuses a bad command before touching anything', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./local-tester-entry.mjs', import.meta.url)), 'code', 'c'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: node tooling\/scripts\/local-tester-entry\.mjs code\|device a\|b/);
});
