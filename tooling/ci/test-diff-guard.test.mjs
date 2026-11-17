/**
 * test-diff-guard.mjs: every check on planted diffs, from a skip added to a test that failed on an earlier head and was
 * then loosened. tooling-tests.mjs runs it with every other tooling test.
 */
import test from 'node:test';
import {
  DECLARED,
  assertionDeltas,
  autoRevert,
  declaredRooms,
  earlierFailures,
  failedInLog,
  gotGreen,
  judge,
  judgeBaselines,
  sourceFor,
} from './test-diff-guard.mjs';

const eq = (got, want, m) => {
  if (got !== want) throw new Error(`${m}: got ${got}, want ${want}`);
};
const t = (c) => judge([{ path: 'a/x.test.ts', status: 'M', removed: [], added: [], sourceExists: true, ...c }]);
const log = [
  '2026-11-13T05:17:14.7515515Z \x1b[31m FAIL \x1b[39m src/edge-trust.test.ts [ src/edge-trust.test.ts ]',
  '2026-11-13T05:17:14.7523672Z  FAIL  src/engine/checks.test.ts > checks > refuses a stale bar',
  '2026-11-13T05:17:20.0000000Z  Failed:    @intafaced/svc-quant#test',
  '2026-11-13T05:17:20.0000000Z  FAIL  is the word in a sentence about nothing',
].join('\n');

test("check 1: a skip, todo, only or fixme added is flagged; a skip gated on the file's own Postgres probe is not", () => {
  eq(t({ added: ["  it.skip('x', () => {})"] }).length, 1, 'skip added');
  eq(t({ added: ["  describe.only('x', () => {"] }).length, 1, 'only added');
  eq(t({ added: ["  xit('x', () => {})"] }).length, 1, 'xit added');
  eq(t({ added: ["  describe.skip('account closure (Postgres unavailable)', () => {"] }).length, 0, 'journalled no-database skip is fine');
  eq(
    t({ added: ["  describe.skip('a (Postgres unavailable)', () => { it.skip('x', () => {}); });"] }).length,
    1,
    'second skip on the same line still flagged',
  );
  eq(t({ added: ["  describe.skip('account closure', () => {"] }).length, 1, 'other describe.skip still flagged');
  // A no-database skip gated on the file's own postgresAvailable probe is fine; any other gate is flagged.
  const probe = "import { postgresAvailable } from '@intafaced/db/testing';\nconst ready = await postgresAvailable(databaseUrl);\n";
  const pg = (line, text = probe + line) => t({ status: 'A', added: [line], text }).length;
  eq(pg("describe.skipIf(!ready)('strategy risk store on Postgres (AL-risk-01)', () => {"), 0, 'skipIf(!probed) is fine');
  eq(pg("describe.runIf(ready)('strategy team store on Postgres', () => {"), 0, 'runIf(probed) is fine');
  eq(
    pg("  describe.skip('svc-agents partner payment (Postgres unavailable — start docker compose)', () => {"),
    0,
    'titled no-database skip in a probed file is fine',
  );
  eq(pg("describe.skipIf(!other)('x', () => {"), 1, 'skipIf on a name the probe did not set: flagged');
  eq(pg("describe.skipIf(true)('x', () => {"), 1, 'skipIf(true): flagged');
  eq(pg("describe.skipIf(!ready || fast)('x', () => {"), 1, 'skipIf on more than the probe: flagged');
  eq(pg("describe.skipIf(!ready)('x', () => { it.skip('y', () => {}); });"), 1, 'second skip after a probed one: flagged');
  eq(pg("describe.skipIf(!ready)('x', () => {", "describe.skipIf(!ready)('x', () => {"), 1, 'skipIf without the probe: flagged');
  eq(
    pg("describe.skipIf(!ready)('x', () => {", 'const ready = true; // postgresAvailable(\n'),
    1,
    'a name not assigned from the probe: flagged',
  );
  eq(
    pg("  describe.skip('x (Postgres unavailable — start docker compose)', () => {", 'const ready = true;\n'),
    1,
    'titled skip in a file without the probe: flagged',
  );
  eq(pg("  it.skipIf(!ready)('x', () => {"), 1, 'it.skipIf: flagged');
  eq(t({ added: ["  it.skip('x (Postgres unavailable)', () => {})"] }).length, 1, 'it.skip still flagged');
  eq(t({ added: ["  it('skips the empty case', () => {"] }).length, 0, 'word skip in a title is fine');
});

test('checks 2-4: fewer assertions, a weaker matcher, a deleted test whose source remains, and the Test-change line', () => {
  eq(t({ removed: ['  expect(a).toBe(1);', '  expect(b).toBe(2);'], added: ['  expect(a).toBe(1);'] }).length, 1, 'fewer assertions');
  eq(t({ removed: ['  expect(a).toBe(1);'], added: ['  expect(a).toBe(2);', '  expect(c).toBe(3);'] }).length, 0, 'more assertions fine');
  eq(t({ removed: ['  expect(a).toEqual({ x: 1 });'], added: ['  expect(a).toBeDefined();'] }).length, 1, 'weaker matcher');
  eq(judge([{ path: 'a/x.test.ts', status: 'D', removed: [], added: [], sourceExists: true }]).length, 1, 'deleted with source');
  eq(judge([{ path: 'a/x.test.ts', status: 'D', removed: [], added: [], sourceExists: false }]).length, 0, 'deleted with source gone');
  // Planted: a suite-named test's source is the name without the suite (builder-fee.money.test.ts tests builder-fee.ts).
  const has =
    (...files) =>
    (p) =>
      files.includes(p);
  eq(sourceFor('r/builder-fee.money.test.ts', has('r/builder-fee.ts')), true, 'x.money.test.ts: x.ts still exists');
  eq(sourceFor('r/store.pg.test.ts', has('r/store.tsx')), true, 'x.pg.test.ts: x.tsx still exists');
  eq(sourceFor('r/router.db.test.ts', has('r/router.db.ts')), true, 'x.db.test.ts: x.db.ts still exists');
  eq(sourceFor('r/x.test.ts', has('r/x.ts')), true, 'x.test.ts: x.ts still exists');
  eq(sourceFor('r/builder-fee.money.test.ts', has()), false, 'x.money.test.ts: source gone with it');
  eq(sourceFor('r/x.test.ts', has('r/y.ts')), false, 'x.test.ts: another file is not its source');
  eq(judge([{ path: 'a/x.ts', status: 'M', removed: ['expect(a)'], added: [], sourceExists: true }]).length, 0, 'non-test ignored');
  eq(DECLARED.test('Why\n\nTest-change: removed the legacy vue snapshot test'), true, 'declared line');
  eq(DECLARED.test('Test-change: n/a'), false, 'declaration needs a real reason');
});

test("journey step files are the test judge's except a focus; browser tests, harnesses and tolerances stay the guard's", () => {
  // Browser tests and harnesses outside the judged paths (a room's look sweep): the guard still holds them.
  const pw = (c) =>
    judge([{ path: 'apps/customer/src/screens/home/home.pw.mjs', status: 'M', removed: [], added: [], sourceExists: true, ...c }]);
  // A journey step file changed on a pull request the judge runs for is the judge's (judged-paths.mjs leftToJudge).
  const runs = { judgeRuns: true };
  const jf = (c, opts = runs, path = 'apps/customer/tests/real-app/J-x-01.pw.mjs') =>
    judge([{ path, status: 'M', removed: [], added: [], sourceExists: true, ...c }], opts);
  const skipLine = ["  test.skip(!process.env.X, 'no stack');"];
  eq(jf({ added: skipLine }).length, 0, 'journey step file: left to the test judge');
  eq(jf({ removed: ["  await expect(page.getByRole('button')).toBeVisible();"] }).length, 0, 'journey assertion: the judge');
  // Planted: a focus in a journey step file drops every other test, which the judge can't see.
  eq(jf({ added: ['test.only(`${J} #2 pays`, async ({ page }) => {'] }).length, 1, 'journey test.only: the guard');
  eq(jf({ added: ["test.describe.only('J-x-01', () => {"] }).length, 1, 'journey describe.only: the guard');
  for (const line of [
    "test.describe.serial.only('x', () => {",
    "test.describe.parallel.only('x', () => {",
    '  .only(',
    "test['only']('x', () => {",
    'test.only.each(rows)(',
    'test.only',
    'const t = test.only;',
    "describe.only ('x', () => {",
  ])
    eq(jf({ added: [line] }).length, 1, `journey focus ${line.trim()}: the guard`);
  eq(jf({ added: ["  test('only the owner sees it', async () => {"] }).length, 0, 'the word only in a title is fine');
  // Planted: everything the judge does not always rule on stays the guard's.
  eq(jf({ added: skipLine }, {}).length, 1, 'no judge job (a fork, another base): the guard');
  eq(jf({ status: 'D', sourceExists: false }).length, 1, 'a deleted journey file: the guard');
  eq(jf({ added: skipLine }, runs, 'apps/customer/tests/real-app/look-sweep-390.pw.mjs').length, 1, 'a look sweep in real-app: the guard');
  eq(
    jf({ added: ["  it.skip('x', () => {})"] }, runs, 'apps/customer/tests/real-app/harness.test.mjs').length,
    1,
    'a unit test in real-app: the guard',
  );
  eq(
    jf(
      { removed: ['  use: { maxDiffPixelRatio: 0.01 },'], added: ['  use: { maxDiffPixelRatio: 0.5 },'] },
      runs,
      'apps/customer/tests/real-app/real-app.playwright.config.mjs',
    ).length,
    1,
    'the journeys config tolerance: the guard',
  );
  eq(
    judge([
      { path: 'tooling/scripts/journey-shards.test.mjs', status: 'M', removed: ['assert.equal(a, 1)'], added: [], sourceExists: true },
    ]).length,
    1,
    "a unit test under tooling/scripts/, which the judge skips, is still the guard's",
  );
  eq(
    judge([{ path: 'services/svc-pay/src/a.test.ts', status: 'M', removed: [], added: ["  it.skip('x', () => {})"], sourceExists: true }])
      .length,
    1,
    "a service unit test is still the guard's",
  );
  eq(pw({ added: ["  test.skip(!process.env.X, 'no stack');"] }).length, 1, 'journey skip added');
  eq(pw({ added: ["test.describe.fixme('J-x-01', () => {"] }).length, 1, 'journey fixme added');
  eq(pw({ removed: ["  await expect(page.getByRole('button')).toBeVisible();"], added: [] }).length, 1, 'journey assertion removed');
  eq(
    pw({
      removed: ["  await expect(page.locator('.cta')).toBeVisible();"],
      added: ["  await expect(page.getByRole('button', { name: 'Buy' })).toBeVisible();"],
    }).length,
    0,
    'locator rewrite keeps the assertion',
  );
  eq(
    pw({ removed: ["  await expect(row).toHaveText('£1.00');"], added: ['  await expect(row).toBeAttached();'] }).length,
    1,
    'journey matcher weakened',
  );
  eq(
    pw({ removed: ['  await expect(btn).toBeVisible();'], added: ['  await expect(btn).toBeAttached();'] }).length,
    1,
    'visible → attached',
  );
  eq(
    judge([{ path: 'apps/customer/src/screens/home/home.pw.mjs', status: 'D', removed: [], added: [], sourceExists: false }]).length,
    1,
    'harness deleted',
  );
  eq(
    pw({
      removed: ['  await expect(page).toHaveScreenshot({ maxDiffPixels: 10 });'],
      added: ['  await expect(page).toHaveScreenshot({ maxDiffPixels: 900 });'],
    }).length,
    1,
    'tolerance raised',
  );
  eq(pw({ added: ['  await expect(page).toHaveScreenshot({ maxDiffPixelRatio: 0.2 });'] }).length, 1, 'tolerance set where none was');
  eq(
    pw({
      removed: ['  await expect(page).toHaveScreenshot({ threshold: 0.2 });'],
      added: ['  await expect(page).toHaveScreenshot({ threshold: 0.1 });'],
    }).length,
    0,
    'tolerance tightened is fine',
  );
  eq(
    judge([
      { path: 'a/J.pw.mjs', status: 'A', removed: [], added: ['expect(page).toHaveScreenshot({ maxDiffPixels: 4 })'], sourceExists: true },
    ]).length,
    0,
    'a new file may set its tolerance',
  );
  eq(
    judge([{ path: 'apps/customer/src/screens/home/stack.mjs', status: 'M', removed: ['expect(a)'], added: [], sourceExists: true }])
      .length,
    0,
    'helper ignored',
  );
});

test('check 6: a look baseline needs a Baseline-change line naming its room; assertion deltas are counted', () => {
  // Baselines.
  const shot = (path, status = 'M') => ({ path, status });
  const b = (changes, body) => judgeBaselines(changes, body);
  eq(b([shot('apps/customer/look-baselines/home/390x844.png')], '').problems.length, 1, 'unnamed baseline change');
  eq(
    b([shot('apps/customer/look-baselines/home/390x844.png')], 'Test-change: the whole home room was redrawn').problems.length,
    1,
    'Test-change does not cover a baseline',
  );
  eq(
    b([shot('apps/customer/look-baselines/home/390x844.png')], 'x\nBaseline-change: home — new hero card\n').problems.length,
    0,
    'named room',
  );
  eq(
    b([shot('apps/customer/look-baselines/home/390x844.png')], 'Baseline-change: home — hero card redrawn').notices.length,
    1,
    'named room is a notice',
  );
  eq(
    b([shot('apps/customer/look-baselines/home/390x844.png')], 'Baseline-change: money — chart moved up').problems.length,
    1,
    'other room named',
  );
  eq(
    b([shot('packages/ui/look-baselines/kit-buttons/phone/1.png', 'A')], 'Baseline-change: kit-buttons — first pictures').problems.length,
    0,
    'new baseline, room named, nested',
  );
  eq(b([shot('apps/customer/look-baselines/home/a.png')], 'Baseline-change: home').problems.length, 1, 'a bare room name is not enough');
  eq(b([shot('apps/customer/look-baselines/home/a.png')], 'Baseline-change: home — x').problems.length, 1, 'the reason needs 8 characters');
  eq(b([shot('apps/customer/look-baselines/trade desk/a.jpeg')], '').problems.length, 1, 'any room folder and format');
  eq(b([shot('packages/ui/look-baselines/kit-buttons/1.png', 'D')], '').problems.length, 1, 'deleted baseline unnamed');
  eq(b([shot('apps/customer/src/assets/logo.png')], '').problems.length, 0, 'other image ignored');
  eq(
    [...declaredRooms('Baseline-change: home\nBaseline-change: trade-desk — moved the chart\n')].join(','),
    'trade-desk',
    'rooms read (a bare name does not count)',
  );
  eq(
    assertionDeltas([
      { path: 'a/J.pw.mjs', status: 'M', removed: ['expect(a).toBe(1)'], added: ['expect(a).toBe(1); expect(b).toBe(2)'] },
    ])[0].added,
    2,
    'assertion delta counted',
  );
});

test("main-bisect's automatic revert is recognised only by every proof", () => {
  // main-bisect's automatic revert: every proof, and each one missing.
  const C = 'c'.repeat(40);
  const H = 'd'.repeat(40);
  const was = 'diff --git a/t.test.ts b/t.test.ts\n--- a/t.test.ts\n+++ b/t.test.ts\n@@ -1,2 +1,3 @@\n a\n+expect(x).toBe(1);\n b\n';
  const back = 'diff --git a/t.test.ts b/t.test.ts\n--- a/t.test.ts\n+++ b/t.test.ts\n@@ -1,3 +1,2 @@\n a\n-expect(x).toBe(1);\n b\n';
  const pr = {
    ref: `revert/auto-${C.slice(0, 10)}`,
    author: 'intafaced-mac-agents[bot]',
    authorType: 'Bot',
    commits: '1',
    headRepo: 'o/r',
    repo: 'o/r',
    headSha: H,
  };
  const reader =
    ({ diff = back, msg = `Revert x\n\nThis reverts commit ${C}.\n`, onMain = true, parents = `${C} p` } = {}) =>
    (args) => {
      if (args[0] === 'log') return msg;
      if (args[0] === 'rev-list') return parents;
      if (args[0] === 'merge-base') {
        if (!onMain) throw new Error('not an ancestor');
        return '';
      }
      if (args[0] === 'diff') return args[2] === `${C}^` ? was : diff;
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
  eq(autoRevert(pr, 'origin/main', reader()), C, 'an automatic revert by every proof');
  eq(autoRevert({ ...pr, author: 'someone' }, 'origin/main', reader()), null, 'not opened by the App');
  eq(autoRevert({ ...pr, authorType: 'User' }, 'origin/main', reader()), null, 'not a Bot');
  eq(autoRevert({ ...pr, ref: 'fix/x' }, 'origin/main', reader()), null, 'not a revert/auto- branch');
  eq(autoRevert({ ...pr, commits: '2' }, 'origin/main', reader()), null, 'more than one commit');
  eq(autoRevert({ ...pr, headRepo: 'fork/r' }, 'origin/main', reader()), null, 'from a fork');
  eq(autoRevert(pr, 'origin/main', reader({ msg: 'no revert line' })), null, 'its commit says no revert');
  eq(autoRevert(pr, 'origin/main', reader({ onMain: false })), null, 'the commit is not on main');
  eq(autoRevert(pr, 'origin/main', reader({ parents: `${C} p q` })), null, 'a merge commit');
  eq(
    autoRevert(pr, 'origin/main', reader({ diff: back.replace('-expect(x).toBe(1);', '-expect(x).toBe(2);') })),
    null,
    'planted fault: not exactly its reverse',
  );
  eq(
    autoRevert(pr, 'origin/main', reader({ diff: `${back}diff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-a\n+b\n` })),
    null,
    'planted fault: one more file',
  );
});

test('checks 2 and 3 hold for every test: money, sign-in, permissions, harnesses and journeys', () => {
  const blocking = (changes, opts) => judge(changes, opts).length;
  const del = (path) => [{ path, status: 'D', removed: [], added: [], sourceExists: true }];
  const fewer = (path) => [{ path, status: 'M', removed: ["  it('x', () => { expect(a).toBe(1); });"], added: [], sourceExists: true }];
  // Planted: a placeholder test deleted, or a case removed, fails as before; its Test-change line names what still guards it.
  eq(blocking(del('apps/customer/src/screens/home/home-card.test.tsx')), 1, 'placeholder file deleted: fails as before');
  eq(blocking(fewer('packages/i18n/src/keys.test.ts')), 1, 'a case removed: fails as before');
  eq(blocking(fewer('services/svc-academy/src/paper/real-money-ban.money.test.ts')), 1, 'a *.money.test.ts case removed: fails as today');
  eq(blocking(del('services/svc-academy/src/paper/real-money-ban.money.test.ts')), 1, 'a *.money.test.ts file deleted: fails as today');
  eq(blocking(fewer('services/svc-ledger/src/posting.test.ts')), 1, 'a money root (MONEY_PATH_ROOTS): fails as today');
  eq(blocking(fewer('services/svc-tax/src/a.db.test.ts')), 1, 'a *.db.test.ts: fails as today');
  eq(blocking(fewer('services/svc-tax/src/a.pg.test.ts')), 1, 'a *.pg.test.ts: fails as today');
  eq(blocking(fewer('services/svc-identity/src/x.test.ts')), 1, 'svc-identity: fails as today');
  eq(blocking(fewer('packages/auth/src/x.test.ts')), 1, 'packages/auth: fails as today');
  eq(blocking(fewer('apps/customer/src/features/public/AuthForm.test.tsx')), 1, 'a sign-in test by name: fails as today');
  // Planted: the gateway's and the venue paths' tests.
  for (const path of [
    'services/svc-edge/src/api-key-revoked.test.ts',
    'services/svc-edge/src/geo-block.test.ts',
    'services/svc-edge/src/execution-kill-p07.e2e.test.ts',
    'services/svc-execution/src/router.test.ts',
    'services/svc-dex/src/quote.test.ts',
    'packages/venue-hyperliquid/src/client.test.ts',
    'packages/execution-mm/src/quote.test.ts',
    'apps/admin/src/lib/api-key-list.test.ts',
    'apps/admin/src/lib/dual-control.test.ts',
    'apps/customer/src/features/live-authority.test.ts',
    'apps/customer/src/features/trade/kill-banner.test.tsx',
    // Edge-trust suites and payout maths.
    'services/svc-mining-pool/src/edge-trust.test.ts',
    'services/svc-indexer/src/edge-trust.test.ts',
    'services/svc-quant/src/edge-trust.test.ts',
    'services/svc-mining-pool/src/pplns.test.ts',
    'services/svc-campaigns/src/owed.test.ts',
    'tooling/ci/journey-verdict.test.mjs',
    'packages/contracts/src/x.test.ts',
    'apps/customer/src/features/bank/pots.test.tsx',
    'apps/admin/src/lib/identity-review.test.ts',
    'apps/admin/src/lib/desk/approval-hash.test.ts',
    'apps/customer/src/shared/password.test.ts',
    'apps/customer/src/shared/api.test.ts',
    // Account security, order drafts, permissions in a DOM test.
    'apps/customer/src/features/account/security-lock.test.ts',
    'apps/customer/src/features/account/close-account.test.ts',
    'apps/customer/src/features/trade/trade.test.ts',
    'apps/customer/src/features/more/agent-connect.dom.test.tsx',
    'apps/customer/src/app/team-desk.render.test.tsx',
    'packages/ui/src/components/amount-input-logic.test.ts',
    'packages/i18n/src/format.test.ts',
  ]) {
    eq(blocking(fewer(path)), 1, `${path}: fails as today`);
    eq(blocking(del(path)), 1, `${path}: deleted, fails as today`);
  }
  eq(blocking(fewer('apps/customer/src/screens/home/clock.test.ts')), 1, 'an ordinary screen test: fails as before');
  eq(blocking(fewer('apps/admin/src/lib/operator-access.test.ts')), 1, 'a permissions test by name: fails as today');
  eq(blocking(fewer('apps/admin/src/lib/custody-ops/model.test.ts')), 1, 'a custody test by folder: fails as today');
  eq(blocking(fewer('apps/customer/src/features/protocol/wallet/SessionKeysPanel.test.tsx')), 1, 'camelCase split: SessionKeys');
  eq(blocking(del('apps/customer/src/screens/home/home.pw.mjs')), 1, 'a harness deleted: fails as today');
  eq(
    blocking([
      {
        path: 'apps/customer/tests/real-app/J-x-01.pw.mjs',
        status: 'M',
        removed: ['  await expect(a).toBeVisible();'],
        added: [],
        sourceExists: true,
      },
    ]),
    1,
    'a journey test edit, no judge job: fails as today',
  );
  eq(
    blocking([{ path: 'apps/customer/tests/real-app/J-x-01.pw.mjs', status: 'D', removed: [], added: [], sourceExists: false }], {
      judgeRuns: true,
    }),
    1,
    'a journey test deleted: fails as today',
  );
  // Unchanged: a skip, a weaker matcher.
  eq(
    blocking([{ ...fewer('packages/i18n/src/keys.test.ts')[0], removed: [], added: ["  it.skip('x', () => {})"] }]),
    1,
    'skip added anywhere: fails',
  );
  eq(
    blocking([
      { ...fewer('packages/i18n/src/keys.test.ts')[0], removed: ['  expect(a).toEqual(1);'], added: ['  expect(a).toBeDefined();'] },
    ]),
    1,
    'weaker matcher anywhere: fails',
  );
});

test('check 7: the log reader and the match against earlier failures', () => {
  const read = failedInLog(log);
  eq(read.packages.join(), 'svc-quant', 'failed packages read');
  eq(read.files.sort().join(), 'src/edge-trust.test.ts,src/engine/checks.test.ts', 'failed files read');
  const failures = read.files.map((file) => ({ sha: 'a'.repeat(40), job: 'Tests (changed)', packages: read.packages, file }));
  eq(gotGreen(['services/svc-quant/src/edge-trust.test.ts'], failures).length, 1, 'planted: deleted after it failed: fails');
  eq(gotGreen(['services/svc-tax/src/edge-trust.test.ts'], failures).length, 0, 'same name, another package: not this failure');
  eq(gotGreen(['services/svc-quant/src/engine/bars.test.ts'], failures).length, 0, 'a test that did not fail: no finding');
});

test('check 7: earlierFailures reads only failed Tests jobs on earlier heads of this branch, and throws on a refusal', async () => {
  // earlierFailures reads only earlier heads of this branch from the head repository, and only failed Tests jobs.
  const H = 'h'.repeat(40);
  const api = async (path) => {
    if (path.includes('/workflows/ci.yml/runs'))
      return {
        workflow_runs: [
          { id: 1, head_sha: H, head_repository: { full_name: 'o/r' } },
          { id: 2, head_sha: 'a'.repeat(40), head_repository: { full_name: 'o/r' } },
          { id: 3, head_sha: 'b'.repeat(40), head_repository: { full_name: 'fork/r' } },
        ],
      };
    if (path.endsWith('/runs/2/jobs?per_page=100'))
      return {
        jobs: [
          { id: 20, name: 'Tests (changed)', conclusion: 'failure' },
          { id: 21, name: 'Doctrine gates', conclusion: 'failure' },
          { id: 22, name: 'Tests (3/16)', conclusion: 'success' },
        ],
      };
    throw new Error(`unexpected ${path}`);
  };
  const text = async (path) => {
    if (path.endsWith('/jobs/20/logs')) return log;
    throw new Error(`unexpected ${path}`);
  };
  const got = await earlierFailures({ repo: 'o/r', branch: 'x', headSha: H }, { api, text });
  eq(got.length, 2, 'earlier failures: one failed Tests job on one earlier head');
  let refused = '';
  await earlierFailures(
    { repo: 'o/r', branch: 'x', headSha: H },
    {
      api: async () => {
        throw new Error('GitHub 403 Forbidden');
      },
      text,
    },
  ).catch((e) => (refused = e.message));
  eq(refused, 'GitHub 403 Forbidden', 'a refusal is thrown, never read as no failures');
});
