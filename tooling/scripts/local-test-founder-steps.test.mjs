// The founders' TOTP steps are shared by every process on a stack: no two processes may send the same step (#7209).
// Run: node --test tooling/scripts/local-test-founder-steps.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FOUNDER_STEPS_LOCK_STALE_MS, FOUNDER_STEPS_NAME, recordFounderStep, withFounderSteps } from './local-test-founders.mjs';
import { reserveFounderStep } from './local-test-gates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEP_MS = 30_000;
const NOW = 1_800_000_000_000; // a fixed clock: step 60,000,000, and the one after it, are the only two in the window
const CURRENT = Math.floor(NOW / STEP_MS);
const stateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'founder-steps-'));
const ctxFor = (dir) => ({ paths: { stateDir: dir }, clock: () => NOW });
const recorded = (dir) => JSON.parse(fs.readFileSync(path.join(dir, FOUNDER_STEPS_NAME), 'utf8'));

/** One process that reserves a step for founder `key` at the fixed clock and prints it (or "null"). */
function reserveInChild(dir, key, startAt) {
  const src = `
    import { reserveFounderStep } from ${JSON.stringify(path.join(HERE, 'local-test-gates.mjs'))};
    while (Date.now() < ${startAt}) {}
    process.stdout.write(String(reserveFounderStep({ paths: { stateDir: ${JSON.stringify(dir)} }, clock: () => ${NOW} }, { founderKey: ${JSON.stringify(key)}, lastStep: 0 })));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`child exited ${code}: ${err}`))));
  });
}

test('a step is reserved once: the current step, then the next, then none until the clock moves', () => {
  const dir = stateDir();
  const ctx = ctxFor(dir);
  assert.equal(reserveFounderStep(ctx, { founderKey: 'a', lastStep: 0 }), CURRENT);
  assert.equal(
    reserveFounderStep(ctx, { founderKey: 'a', lastStep: 0 }),
    CURRENT + 1,
    'a second process, knowing nothing, still gets the next step',
  );
  assert.equal(reserveFounderStep(ctx, { founderKey: 'a', lastStep: 0 }), null, 'both steps in the window are spent: wait');
  assert.equal(reserveFounderStep(ctx, { founderKey: 'b', lastStep: 0 }), CURRENT, 'founder b keeps steps of their own');
  assert.deepEqual(recorded(dir), { a: CURRENT + 1, b: CURRENT });
});

test('a step this process already holds is never handed out again, nor one any process recorded', () => {
  const dir = stateDir();
  const ctx = ctxFor(dir);
  // After identity refused a code, the caller holds a later step than the file (stepAfterRefusal).
  assert.equal(reserveFounderStep(ctx, { founderKey: 'a', lastStep: CURRENT }), CURRENT + 1);
  recordFounderStep(dir, 'a', CURRENT - 5);
  assert.equal(recorded(dir).a, CURRENT + 1, 'recording an older step never moves the record back');
});

test('planted race: eight processes reserving at the same instant never share a step', async () => {
  const dir = stateDir();
  const startAt = Date.now() + 400;
  const got = await Promise.all(Array.from({ length: 8 }, () => reserveInChild(dir, 'a', startAt)));
  const steps = got.filter((s) => s !== 'null').map(Number);
  assert.deepEqual(
    steps.sort((x, y) => x - y),
    [CURRENT, CURRENT + 1],
    `exactly the two steps in the window go out, once each: ${got.join(', ')}`,
  );
  assert.equal(got.filter((s) => s === 'null').length, 6);
});

test('a lock left by a process that died holding it is taken over once it is stale', () => {
  const dir = stateDir();
  const lock = path.join(dir, `${FOUNDER_STEPS_NAME}.lock`);
  fs.writeFileSync(lock, '999999');
  const old = (Date.now() - FOUNDER_STEPS_LOCK_STALE_MS - 1_000) / 1000;
  fs.utimesSync(lock, old, old);
  assert.equal(reserveFounderStep(ctxFor(dir), { founderKey: 'a', lastStep: 0 }), CURRENT);
  assert.equal(fs.existsSync(lock), false, 'the lock is let go after the write');
});

test('a held lock that is not stale is waited for, and a lock held too long is an error naming it', () => {
  const dir = stateDir();
  const lock = path.join(dir, `${FOUNDER_STEPS_NAME}.lock`);
  fs.writeFileSync(lock, String(process.pid));
  let t = Date.now();
  // A clock that runs 1 s per read: the lock stays fresh (its mtime moves with it) until the wait limit passes.
  const now = () => {
    t += 1_000;
    fs.utimesSync(lock, t / 1000, t / 1000);
    return t;
  };
  assert.throws(() => withFounderSteps(dir, () => ({ next: null }), { now }), /steps lock .* is held past/);
  fs.unlinkSync(lock);
});
