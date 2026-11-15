// The correction a blocking finding names (ci-review.mjs findingClass; project-state #2582): read by code from the
// finding's words after the verdict, for the garden's census. It never changes what blocks, and the Verdict step prints
// one annotation with the classes and no finding's text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINDING_CLASSES, CLASSES_TITLE, findingClass, findingClasses } from './ci-review.mjs';

// Real findings from CI review FAILs of 12 to 15 Nov 2026 (shortened), with the class each must read as.
const REAL = [
  [
    'services/svc-trade/src/quant/live-run/live-runs.ts:1150 (freezeStop): item 4: the bare `catch {}` around `cancelOpen(...)` drops every error',
    'catch-all',
  ],
  [
    "services/svc-trade/src/private-rest.ts:3078: item 4 (and item 2): `privateWith('trade:write', ...)` only declares route-inventory metadata",
    'route-scope',
  ],
  [
    'apps/customer/tests/real-app/J-cex-spot-04.pw.mjs:71 and :205: item 3: two tests had titles naming step #2 and #4; the PR retitles them',
    'step-id-dropped',
  ],
  [
    'apps/customer/tests/real-app/J-portfolio-02.pw.mjs:279: item 3: the deleted #6 test ended with a hidden-balances check',
    'test-weakened',
  ],
  ['services/svc-campaigns/src/tasks.ts:661: item 2: for a paid USDC reward the claim now skips the `held` state', 'security-loosened'],
  [
    'services/svc-agents/src/runs/background.ts:295: item 4: the new UsageOwedError is thrown where the comment says it returns',
    'says-not-does',
  ],
  [
    'services/svc-pay/src/payment-service/lifecycle.ts:713: item 1: the partner branch calls recipes.partnerFeeEarn with a rate the recipe reads as bps',
    'money-path',
  ],
  [
    "the diff is 912000 bytes, over 400000, and can't be reviewed in parts (11 parts); it can't be reviewed whole; split the pull request",
    'unreviewable',
  ],
  ['services/svc-x/src/a.ts:3: item 5: calls a live outside service on a test path', 'other'],
  ['something with no ground at all', 'other'],
];

test('the closed list holds the five corrections project-state #2582 counted most, and other', () => {
  for (const c of ['test-weakened', 'says-not-does', 'security-loosened', 'unreviewable', 'catch-all', 'other'])
    assert.ok(FINDING_CLASSES.includes(c), c);
});

test('each real finding reads as its class, the most specific first', () => {
  for (const [f, want] of REAL) assert.equal(findingClass(f), want, f);
  assert.ok(REAL.every(([, c]) => FINDING_CLASSES.includes(c)));
});

test('classes are listed once each, notes left out', () => {
  assert.deepEqual(findingClasses([REAL[0][0], 'note: a catch {} here is fine', REAL[0][0], REAL[3][0]]), ['catch-all', 'test-weakened']);
});

test('judge prints one classes annotation with no finding text on a FAIL, none on a PASS, and the same exit as before', () => {
  const script = fileURLToPath(new URL('./ci-review.mjs', import.meta.url));
  const run = (v) => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-review-classes-'));
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify(v));
    const env = { ...process.env, GITHUB_EVENT_PATH: join(dir, 'none.json'), GITHUB_STEP_SUMMARY: '' };
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [script, 'judge', dir], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
        err: '',
      };
    } catch (e) {
      return { code: e.status, out: String(e.stdout), err: String(e.stderr) };
    }
  };
  // A finding whose text would read as an outage to the census (403, rate limit) must not reach the annotation.
  const findings = ['s.ts:403: item 4: a rate limit error swallowed', 'x.ts:2: item 3: y', 'note: z'];
  const fail = run({ head: 'a'.repeat(40), verdict: 'FAIL', findings });
  assert.equal(fail.code, 1);
  assert.deepEqual(
    fail.err.split('\n').filter((l) => l.startsWith(`::error title=${CLASSES_TITLE}::`)),
    [`::error title=${CLASSES_TITLE}::catch-all test-weakened`],
  );
  // The summary keeps every finding exactly as the reviewer wrote it.
  for (const f of findings) assert.ok(fail.out.includes(`- ${f}`), f);
  const pass = run({ head: 'a'.repeat(40), verdict: 'PASS', findings: ['note: z'] });
  assert.equal(pass.code, 0);
  assert.ok(!pass.err.includes(CLASSES_TITLE));
});
