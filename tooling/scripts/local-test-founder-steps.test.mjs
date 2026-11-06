// The founders' TOTP steps are shared by every process on a stack: no two processes may send the same step (#7209).
// Run: node --test tooling/scripts/local-test-founder-steps.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FOUNDER_STEPS_DIR, claimFounderStep, pruneFounderSteps, spendFounderSteps } from './local-test-founders.mjs';
import { reserveFounderStep } from './local-test-gates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEP_MS = 30_000;
const NOW = 1_800_000_000_000; // a fixed clock: its step, and the one after it, are the only two in identity's window
const CURRENT = Math.floor(NOW / STEP_MS);
const stateDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'founder-steps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const ctxFor = (dir) => ({ paths: { stateDir: dir }, clock: () => NOW });
const claimed = (dir) => fs.readdirSync(path.join(dir, FOUNDER_STEPS_DIR)).sort();

test('a step is handed out once: the current step, then the next, then none until the clock moves', (t) => {
  const dir = stateDir(t);
  const ctx = ctxFor(dir);
  assert.equal(reserveFounderStep(ctx, { founderKey: 'a', lastStep: 0 }), CURRENT);
  assert.equal(
    reserveFounderStep(ctx, { founderKey: 'a', lastStep: 0 }),
    CURRENT + 1,
    'a second process, knowing nothing, gets the next step',
  );
  assert.equal(reserveFounderStep(ctx, { founderKey: 'a', lastStep: 0 }), null, 'both steps in the window are spent: wait for the clock');
  assert.equal(reserveFounderStep(ctx, { founderKey: 'b', lastStep: 0 }), CURRENT, 'founder b has steps of their own');
  assert.deepEqual(claimed(dir), [`a-${CURRENT}`, `a-${CURRENT + 1}`, `b-${CURRENT}`]);
});

test('a step this process already holds is never handed out again', (t) => {
  const dir = stateDir(t);
  assert.equal(reserveFounderStep(ctxFor(dir), { founderKey: 'a', lastStep: CURRENT }), CURRENT + 1);
  assert.equal(reserveFounderStep(ctxFor(dir), { founderKey: 'a', lastStep: CURRENT + 1 }), null);
});

test('after a refusal, the steps identity may hold are spent for every process, not only the one refused', (t) => {
  const dir = stateDir(t);
  // Process 1 was refused at CURRENT and now holds CURRENT + 1 (stepAfterRefusal); it marks both used for everyone.
  spendFounderSteps(dir, 'a', CURRENT, CURRENT + 1);
  assert.equal(reserveFounderStep(ctxFor(dir), { founderKey: 'a', lastStep: 0 }), null, 'another process waits for the next window');
  assert.equal(claimFounderStep(dir, 'a', CURRENT + 1), false, 'a spent step is never claimed again');
});

test('claims for steps no code can use any more are pruned, and only those', (t) => {
  const dir = stateDir(t);
  for (const step of [CURRENT - 4, CURRENT - 3, CURRENT - 2, CURRENT]) claimFounderStep(dir, 'a', step);
  claimFounderStep(dir, 'b', CURRENT - 9);
  pruneFounderSteps(dir, CURRENT - 2);
  assert.deepEqual(claimed(dir), [`a-${CURRENT - 2}`, `a-${CURRENT}`]);
  // reserveFounderStep prunes as it goes, so the folder never grows past a few files.
  reserveFounderStep({ paths: { stateDir: dir }, clock: () => NOW + 10 * STEP_MS }, { founderKey: 'a', lastStep: 0 });
  assert.deepEqual(claimed(dir), [`a-${CURRENT + 10}`]);
});

/**
 * One process that loads the module, says "ready", waits until the parent creates `go`, then reserves a step for
 * founder `key` at the fixed clock and prints it (or "null"). The barrier makes the processes reserve together.
 */
function reserveInChild(dir, key, go) {
  const src = `
    import fs from 'node:fs';
    import { reserveFounderStep } from ${JSON.stringify(path.join(HERE, 'local-test-gates.mjs'))};
    process.stdout.write('ready\\n');
    while (!fs.existsSync(${JSON.stringify(go)})) {}
    process.stdout.write(String(reserveFounderStep({ paths: { stateDir: ${JSON.stringify(dir)} }, clock: () => ${NOW} }, { founderKey: ${JSON.stringify(key)}, lastStep: 0 })));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const ready = new Promise((resolve) =>
    child.stdout.on('data', (d) => {
      out += d;
      if (out.startsWith('ready\n')) resolve();
    }),
  );
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve, reject) =>
    child.on('close', (code) =>
      code === 0 ? resolve(out.slice('ready\n'.length).trim()) : reject(new Error(`child exited ${code}: ${err}`)),
    ),
  );
  return { ready, done };
}

test('planted race: eight processes reserving at the same instant never share a step', async (t) => {
  const dir = stateDir(t);
  const go = path.join(dir, 'go');
  const children = Array.from({ length: 8 }, () => reserveInChild(dir, 'a', go));
  await Promise.all(children.map((c) => c.ready));
  fs.writeFileSync(go, '');
  const got = await Promise.all(children.map((c) => c.done));
  const steps = got.filter((s) => s !== 'null').map(Number);
  assert.deepEqual(
    steps.sort((x, y) => x - y),
    [CURRENT, CURRENT + 1],
    `exactly the two steps in the window go out, once each: ${got.join(', ')}`,
  );
  assert.equal(got.filter((s) => s === 'null').length, 6);
});
