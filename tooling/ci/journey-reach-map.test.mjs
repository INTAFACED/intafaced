// node --test tooling/ci/journey-reach-map.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  workspaceInputs,
  MONEY_SERVICES,
  MIN_RUNS,
  REACH_MAP_MODE,
  reportTests,
  speaksFor,
  unbuiltSteps,
  STALE_RUNS,
  buildMap,
  builtMap,
  mapBuild,
  newerMap,
  candidates,
  dependentPackages,
  harnessImports,
  customerImporters,
  importTargets,
  moduleKeys,
  pathReach,
  headWanted,
  nodeTargets,
  patchText,
  readHead,
  sinceMap,
  mapText,
  verifyMap,
  loadMap,
  mapProblem,
  reachSelect,
  runReach,
  runsBehind,
  serviceDir,
  sourceOwner,
} from './journey-reach-map.mjs';
import { checkoutHead, journeyTouch } from './journey-touch.mjs';
import { JOURNEYS_WORKFLOW, reachInputs, sealPull } from './journey-seal.mjs';
import { manifestsAt, moneyCodeDirs } from './journey-verdict.mjs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url));

const REPO = 'INTAFACED/intafaced';
const HEAD = 'a'.repeat(40);
const SERVICES = new Set(['services/svc-tax', 'services/svc-bank', 'services/svc-edge', 'services/svc-notify', 'services/svc-support']);

// ---- A small world: four journeys, recorded on three whole main runs ----

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const rec = (file, over = {}) => ({
  v: 2,
  file,
  http: [],
  served: [],
  active: [],
  chunks: [],
  sources: {},
  table: {},
  nomap: [],
  incomplete: [],
  ...over,
});
/** A Playwright JSON report: one spec per journey file, its records attached to its first test. */
const report = (records, files = [...new Set(records.map((r) => r.file))], failing = new Set()) => ({
  suites: files.map((f) => ({
    file: f,
    specs: [
      {
        title: `${f.replace('.pw.mjs', '')} #1 step`,
        file: f,
        tests: [
          {
            status: failing.has(f) ? 'unexpected' : 'expected',
            results: [
              {
                status: failing.has(f) ? 'failed' : 'passed',
                attachments: records
                  .filter((r) => r.file === f)
                  .map((r) => ({ name: 'journey-reach', contentType: 'application/json', body: b64(r) })),
              },
            ],
          },
        ],
      },
    ],
  })),
});
const TAX = 'J-tax-01.pw.mjs';
const BANK = 'J-bank-01.pw.mjs';
const BOTH = 'J-bank-02.pw.mjs';
const POPUP = 'J-merchant-01.pw.mjs';
const FILES = new Set([TAX, BANK, BOTH, POPUP]);
const records = (popup = ['popup']) => [
  rec(TAX, {
    served: ['edge GET /api/tax', 'tax GET'],
    active: ['edge', 'tax', 'postgres'],
    chunks: ['/assets/index-1.js'],
    sources: { 'apps/customer/src/features/tax/TaxRoom.tsx': [[1, 40]] },
    table: { '/assets/index-1.js': ['apps/customer/src/main.tsx', 'packages/ui/dist/button.js'] },
  }),
  rec(BANK, {
    served: ['edge GET /api/bank', 'bank POST'],
    active: ['edge', 'bank', 'migrate-bank'],
    chunks: ['/assets/index-1.js'],
    sources: { 'apps/customer/src/features/bank/Cards.tsx': [[3, 9]], 'packages/market-data/dist/x.js': [[1, 2]] },
  }),
  rec(BOTH, { served: ['bank GET', 'support GET'], active: ['edge', 'bank', 'trade-2'] }),
  rec(POPUP, { served: ['edge GET'], active: ['edge'], incomplete: popup }),
];
const run = (id, created, recs = records(), files = FILES, failing = new Set()) => ({
  id,
  head: HEAD,
  created,
  report: report(recs, [...files], failing),
  files,
});
const RUNS = [run(3, '2026-11-08T15:00:00Z'), run(2, '2026-11-08T14:00:00Z'), run(1, '2026-11-08T13:00:00Z')];
/**
 * A run whose journeys have several tests (an unnumbered `starts:` setup test, `#1`, `#2`, `#3`): `over[file]` names
 * the tests that fail (`fail`) and are skipped (`skip`), each by the start of its title after the journey id, and the
 * file's records (`recs`, each attached to the test of the same index, or to the afterAll hook's last test). Files not
 * named pass whole with records().
 */
const STEPS = ['starts: the stack', '#1 step', '#2 step', '#3 step'];
const stepsRun = (id, over = {}, files = FILES) => {
  const base = records();
  return {
    id,
    head: HEAD,
    created: `2026-11-08T1${id + 2}:00:00Z`,
    files,
    report: {
      suites: [...files].map((f) => {
        const o = over[f] ?? {};
        const recs = o.recs ?? base.filter((r) => r.file === f);
        const J = f.replace('.pw.mjs', '');
        const is = (list, title) => (list ?? []).some((x) => title.startsWith(x));
        return {
          title: f,
          file: f,
          suites: [
            {
              title: J,
              file: f,
              specs: STEPS.map((title, i) => {
                const st = is(o.fail, title) ? 'failed' : is(o.skip, title) ? 'skipped' : 'passed';
                return {
                  title: `${J} ${title}`,
                  file: f,
                  tests: [
                    {
                      projectName: 'chromium',
                      status: { failed: 'unexpected', skipped: 'skipped', passed: 'expected' }[st],
                      results: [
                        {
                          status: st,
                          attachments: recs
                            .filter((_, j) => j === i || (i === STEPS.length - 1 && j >= STEPS.length))
                            .map((r) => ({ name: 'journey-reach', contentType: 'application/json', body: b64(r) })),
                        },
                      ],
                    },
                  ],
                };
              }),
            },
          ],
        };
      }),
    },
  };
};
/** Main's journey baseline in the tests: TAX's #3 is unbuilt, its #2 a regression; BANK's #2 and POPUP's #3 are unbuilt. */
const BASELINE = {
  run: { number: 1 },
  steps: [
    { step: 'J-tax-01#3', file: `apps/customer/tests/real-app/${TAX}`, state: 'unbuilt', money: true },
    { step: 'J-tax-01#2', file: `apps/customer/tests/real-app/${TAX}`, state: 'regression', money: false, issue: 1 },
    { step: 'J-bank-01#2', file: `apps/customer/tests/real-app/${BANK}`, state: 'unbuilt', money: true },
    { step: 'J-merchant-01#3', file: `apps/customer/tests/real-app/${POPUP}`, state: 'unbuilt', money: false },
  ],
};
const reachOf = (map, key, dir) => (map[key][dir] ?? []).map((i) => map.journeys[i]).sort();
const CONSUMERS = {
  'packages/ui': ['apps/admin', 'apps/customer'],
  'packages/market-data': ['apps/customer', 'services/svc-bank'],
  'packages/telemetry': ['services/svc-notify'],
  'packages/events': ['services/svc-bank'],
  'packages/lonely': [],
  'packages/money-util': ['services/svc-ledger'],
};
const DEPENDENTS = { 'packages/market-data': [], 'packages/money-util': [] };
const build = (runs = RUNS, over = {}) =>
  buildMap({
    runs,
    services: SERVICES,
    consumers: CONSUMERS,
    dependents: DEPENDENTS,
    harness: ['packages/events', 'apps/customer/deployment/host-dispatch.mjs'],
    subscribers: ['services/svc-notify'],
    money: ['packages/ledger-client', 'services/svc-ops'],
    baseline: BASELINE,
    ...over,
  });
const MAP = build();
// The map ships off (REACH_MAP_MODE 'full'); these tests judge it switched on.
const select = (paths, over = {}) => reachSelect({ map: MAP, paths, behind: 0, atHead: FILES, mode: 'reach', ...over });

test('the map: built from the newest three whole runs, each journey reaching its services, customer files and packages', () => {
  assert.equal(MAP.mode, 'reach');
  assert.deepEqual(
    MAP.runs.map((r) => r.id),
    [3, 2, 1],
  );
  const at = (o, k) => (o[k] ?? []).map((i) => MAP.journeys[i]).sort();
  assert.deepEqual(at(MAP.services, 'services/svc-tax'), [TAX]);
  assert.deepEqual(at(MAP.services, 'services/svc-bank'), [BANK, BOTH], 'migrate-bank and bank are svc-bank');
  assert.deepEqual(at(MAP.services, 'services/svc-support'), [BOTH]);
  assert.deepEqual(at(MAP.customer, 'apps/customer/src/main.tsx'), [BANK, TAX], 'a loaded script reaches every source in its table');
  assert.deepEqual(at(MAP.packages, 'packages/ui'), [BANK, TAX], 'packages/ui/dist is packages/ui');
  assert.deepEqual(Object.keys(MAP.full), [POPUP], 'an incomplete record reaches everything');
  assert.equal(serviceDir('trade-2', new Set(['services/svc-trade'])), 'services/svc-trade');
  assert.equal(serviceDir('migrate-support-empty-catalogue', SERVICES), 'services/svc-support');
  assert.equal(serviceDir('postgres', SERVICES), null);
  assert.deepEqual(sourceOwner('packages/ui/dist/a.js'), { package: 'packages/ui' });
  assert.equal(sourceOwner('node_modules/x.js'), null);
});

test('planted: a one-service change selects that service’s journeys and no others, plus the journeys the map can’t speak for', () => {
  const tax = select(['services/svc-tax/src/rates.ts']);
  assert.equal(tax.mode, 'files');
  assert.deepEqual(tax.files, [POPUP, TAX], 'J-tax-01, and the incomplete J-merchant-01; not the bank journeys');
  const support = select(['services/svc-support/src/x.ts']);
  assert.deepEqual(support.files, [BOTH, POPUP]);
  const customer = select(['apps/customer/src/features/bank/Cards.tsx']);
  assert.deepEqual(customer.files, [BANK, POPUP]);
  // A package only services and the customer bundle use: the journeys running its built code or reaching a consumer.
  assert.deepEqual(select(['packages/market-data/src/x.ts']).files, [BANK, BOTH, POPUP]);
  // A journey file at the head the map doesn't know (added after it was built) runs with every change.
  const later = select(['services/svc-tax/src/rates.ts'], { atHead: new Set([...FILES, 'J-tax-02.pw.mjs']) });
  assert.deepEqual(later.files, [POPUP, TAX, 'J-tax-02.pw.mjs']);
});

test('journeyTouch with the map: product code joins the files list; any other full path keeps the whole change full', () => {
  const reach = { map: MAP, behind: 0, journeyFiles: FILES, subscribes: () => false, mode: 'reach' };
  assert.equal(journeyTouch(['services/svc-tax/src/rates.ts'], () => true, { ...reach, mode: undefined }).mode, 'files', 'on by default');
  const t = journeyTouch(['services/svc-tax/src/rates.ts', `apps/customer/tests/real-app/${BANK}`], () => true, reach);
  assert.equal(t.mode, 'files');
  assert.deepEqual(t.files, [BANK, POPUP, TAX]);
  assert.match(t.reach.join('\n'), /services\/svc-tax\/src\/rates\.ts: 1 journey file\(s\) reach it/);
  const shared = journeyTouch(['services/svc-tax/src/rates.ts', 'tooling/scripts/local-test-stack.mjs'], () => true, reach);
  assert.equal(shared.mode, 'full', 'a script under tooling/scripts');
  const setup = journeyTouch(['services/svc-tax/src/rates.ts', 'tooling/scripts/local-stack-services/x.mjs'], () => true, reach);
  assert.equal(setup.mode, 'full', 'shared setup');
  const helper = journeyTouch(['services/svc-tax/src/rates.ts', 'apps/customer/tests/real-app/journey.mjs'], () => true, reach);
  assert.equal(helper.mode, 'full', 'a real-app helper (shared setup)');
  assert.equal(journeyTouch(['tooling/ci/journey-reach-map.json'], () => true, reach).mode, 'full', 'the map itself');
  assert.equal(journeyTouch(['services/svc-tax/src/rates.ts']).mode, 'full', 'no map given: product code is full');
  assert.equal(journeyTouch(['services/svc-tax/src/rates.test.ts'], () => true, reach).mode, 'none', 'a unit test runs nothing');
});

test('planted: reach is taken only from runs where the journey passed whole (review 7561-R1)', () => {
  // TAX fails in the newest run, whose record would miss what its later steps reach: that run adds nothing for it.
  const short = rec(TAX, { served: ['edge GET /api/tax'], active: ['edge'] });
  const failedOnce = build([
    run(3, '2026-11-08T15:00:00Z', [...records().filter((r) => r.file !== TAX), short], FILES, new Set([TAX])),
    run(2, '2026-11-08T14:00:00Z'),
    run(1, '2026-11-08T13:00:00Z'),
  ]);
  assert.equal(failedOnce.mode, 'reach');
  assert.deepEqual(
    (failedOnce.services['services/svc-tax'] ?? []).map((i) => failedOnce.journeys[i]),
    [TAX],
    'from the clean runs',
  );
  // Planted: TAX fails a different step in each run, so no run speaks for it, and it runs with every change.
  const allFailed = build([3, 2, 1].map((id) => stepsRun(id, { [TAX]: { fail: [`#${id}`], recs: [short] } })));
  assert.match(allFailed.full[TAX], /no run the map is built from speaks for it/);
  const sel = reachSelect({ map: allFailed, paths: ['services/svc-support/src/x.ts'], behind: 0, atHead: FILES, mode: 'reach' });
  assert.deepEqual(sel.files, [BOTH, POPUP, TAX], 'an unproven journey joins every selection');
  // A test that did not end expected (timedOut, no result, flaky with no pass after a failure) did not pass; a test.fail()
  // that failed ended expected, and a flaky test that passed on its retry passed (journey-verdict.mjs testPassed).
  const r = report(records(), [...FILES]);
  Object.assign(r.suites[0].specs[0].tests[0], { status: 'unexpected', results: [{ status: 'timedOut' }] });
  Object.assign(r.suites[1].specs[0].tests[0], { status: undefined, results: [] });
  Object.assign(r.suites[2].specs[0].tests[0], { status: 'expected', results: [{ status: 'failed' }] });
  Object.assign(r.suites[3].specs[0].tests[0], { status: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] });
  const passed = (f) => [...reportTests(r).get(f).tests.values()].every((t) => t.passed);
  assert.deepEqual([...FILES].filter((f) => !passed(f)).sort(), [BANK, TAX].sort());
  Object.assign(r.suites[3].specs[0].tests[0], { status: 'flaky', results: [{ status: 'failed' }, { status: 'skipped' }] });
  assert.equal(passed(POPUP), false, 'a failed test whose retry was skipped did not pass');
});

test('planted: a journey red in the same tests in every run takes its recorded reach and is not full (project-state#1574)', () => {
  // TAX's #3 is unbuilt in main's baseline and red in every run: what its tests recorded is its reach.
  const map = build([3, 2, 1].map((id) => stepsRun(id, { [TAX]: { fail: ['#3'] } })));
  assert.equal(map.mode, 'reach');
  assert.equal(map.full[TAX], undefined, 'a persistently red step does not make it full');
  assert.deepEqual(reachOf(map, 'services', 'services/svc-tax'), [TAX]);
  assert.deepEqual(reachOf(map, 'customer', 'apps/customer/src/features/tax/TaxRoom.tsx'), [TAX]);
  const sel = reachSelect({ map, paths: ['services/svc-support/src/x.ts'], behind: 0, atHead: FILES, mode: 'reach' });
  assert.deepEqual(sel.files, [BOTH, POPUP], 'it no longer joins every selection');
});

test('planted: a test that fails in one run and passes in another disqualifies the run where it failed (review 7561-R1)', () => {
  // TAX's #2 fails only in run 3, whose record stops short at svc-edge; runs 2 and 1 passed whole and speak for it.
  const short = rec(TAX, { served: ['edge GET /api/tax'], active: ['edge'], sources: { 'apps/customer/src/x.tsx': [[1, 2]] } });
  const once = build([stepsRun(3, { [TAX]: { fail: ['#2'], recs: [short] } }), stepsRun(2), stepsRun(1)]);
  assert.equal(once.full[TAX], undefined);
  assert.deepEqual(reachOf(once, 'services', 'services/svc-tax'), [TAX], 'from the clean runs');
  assert.deepEqual(reachOf(once, 'customer', 'apps/customer/src/x.tsx'), [], 'run 3 adds nothing');
  // #3 red in every run is persistent, but #2 red only in run 3 still disqualifies run 3.
  const mixed = build([
    stepsRun(3, { [TAX]: { fail: ['#2', '#3'], recs: [short] } }),
    stepsRun(2, { [TAX]: { fail: ['#3'] } }),
    stepsRun(1, { [TAX]: { fail: ['#3'] } }),
  ]);
  assert.deepEqual(reachOf(mixed, 'customer', 'apps/customer/src/x.tsx'), [], 'the flaky step still disqualifies run 3');
  assert.deepEqual(reachOf(mixed, 'services', 'services/svc-tax'), [TAX]);
  // No run clean: #1 fails in run 3 only, #2 in runs 2 and 1 only. Neither is red in every run, so TAX is full.
  const none = build([
    stepsRun(3, { [TAX]: { fail: ['#1'] } }),
    stepsRun(2, { [TAX]: { fail: ['#2'] } }),
    stepsRun(1, { [TAX]: { fail: ['#2'] } }),
  ]);
  assert.match(none.full[TAX], /no run the map is built from speaks for it/);
  // A red test only run 3 holds (a step added since) is not red in every run, so run 3 doesn't count.
  const added = stepsRun(3, { [TAX]: { recs: [short] } });
  const spec = added.report.suites[0].suites[0];
  spec.specs.push({
    ...spec.specs[1],
    title: 'J-tax-01 #4 step',
    tests: [{ projectName: 'chromium', status: 'unexpected', results: [{ status: 'failed' }] }],
  });
  const fresh = build([added, stepsRun(2), stepsRun(1)]);
  assert.deepEqual(reachOf(fresh, 'customer', 'apps/customer/src/x.tsx'), [], 'a red test the other runs lack disqualifies the run');
});

test('planted: a red test excuses a run only when every whole run holds the file (project-state#1574)', () => {
  // TAX is in runs 3 and 2 only (run 1's head predates it), its unbuilt #3 red in both: two runs can't show it red for
  // good, so neither counts, and it is full.
  const noTax = new Set([...FILES].filter((f) => f !== TAX));
  const two = build([stepsRun(3, { [TAX]: { fail: ['#3'] } }), stepsRun(2, { [TAX]: { fail: ['#3'] } }), stepsRun(1, {}, noTax)]);
  assert.equal(two.mode, 'reach');
  assert.match(two.full[TAX], /no run the map is built from speaks for it/);
  // The old rule still holds for such a file: a run where it passed whole speaks for it.
  const one = build([stepsRun(3, { [TAX]: { fail: ['#3'] } }), stepsRun(2), stepsRun(1, {}, noTax)]);
  assert.equal(one.full[TAX], undefined);
  assert.deepEqual(reachOf(one, 'services', 'services/svc-tax'), [TAX]);
});

test('planted: only an unbuilt step of main’s baseline, and the tests skipped after it, excuse a red run (project-state#1574)', () => {
  const every = (over) => build([3, 2, 1].map((id) => stepsRun(id, over)));
  // A red setup test, red in every run (its steps all skipped): full, not the setup's own small reach.
  const setup = every({ [TAX]: { fail: ['starts:'], skip: ['#'] } });
  assert.match(setup.full[TAX], /no run the map is built from speaks for it/);
  // A red step the baseline calls a regression, and one it doesn't list, red in every run: full.
  assert.match(every({ [TAX]: { fail: ['#2'] } }).full[TAX], /speaks for it/, 'a regression step');
  assert.match(every({ [TAX]: { fail: ['#1'] } }).full[TAX], /speaks for it/, 'a step not in the baseline');
  // An unbuilt step of another file with the same number excuses nothing here.
  assert.match(every({ [BOTH]: { fail: ['#3'] } }).full[BOTH], /speaks for it/, 'J-bank-02 #3 is not listed');
  // So a flaky step that happens to be red in every sampled run is full too: it is not an unbuilt step of the baseline.
  // BANK's unbuilt #2 is red in every run and #3 is skipped after it: the run counts, with every record of the file.
  const recs = [rec(BANK, { served: ['edge GET'] }), rec(BANK, { served: ['bank GET'] }), rec(BANK, { served: ['support GET'] })];
  const ok = every({ [BANK]: { fail: ['#2'], skip: ['#3'], recs } });
  assert.equal(ok.full[BANK], undefined);
  assert.deepEqual(reachOf(ok, 'services', 'services/svc-bank'), [BANK, BOTH]);
  assert.deepEqual(reachOf(ok, 'services', 'services/svc-support'), [BANK, BOTH], 'the unbuilt step’s own record counts');
  // A skipped test with no excused step before it is not excused.
  assert.match(every({ [BANK]: { skip: ['#3'] } }).full[BANK], /speaks for it/, 'a skip with nothing red before it');
  assert.match(every({ [BANK]: { fail: ['#2'], skip: ['#1'] } }).full[BANK], /speaks for it/, 'a skip before the unbuilt step');
  // No baseline given: nothing is excused.
  assert.match(
    build(
      [3, 2, 1].map((id) => stepsRun(id, { [BANK]: { fail: ['#2'] } })),
      { baseline: null },
    ).full[BANK],
    /speaks for it/,
  );
});

test('planted: a red unbuilt step another run lacks, or a spec with no test, excuses nothing (project-state#1574)', () => {
  // TAX's unbuilt #3 is red in runs 3 and 2, and run 1 has no #3 (its head predates the step): runs 3 and 2 don't count,
  // so what only their records carried is not its reach; run 1 passed whole and speaks for it.
  const extra = rec(TAX, { served: ['support GET'], active: ['support'] });
  const tax = records().filter((r) => r.file === TAX);
  const old = stepsRun(1);
  const spec = old.report.suites.find((x) => x.file === TAX).suites[0];
  spec.specs = spec.specs.filter((x) => !x.title.includes('#3'));
  const map = build([stepsRun(3, { [TAX]: { fail: ['#3'], recs: [...tax, extra] } }), stepsRun(2, { [TAX]: { fail: ['#3'] } }), old]);
  assert.equal(map.full[TAX], undefined);
  assert.deepEqual(reachOf(map, 'services', 'services/svc-support'), [BOTH], 'run 3 adds nothing for TAX');
  // A spec of TAX holding no test, in every run, with every other test green: full.
  const broken = [3, 2, 1].map((id) => {
    const r = stepsRun(id);
    r.report.suites.find((x) => x.file === TAX).suites[0].specs.push({ title: 'J-tax-01 #4 step', file: TAX, tests: [] });
    return r;
  });
  assert.match(build(broken).full[TAX], /no run the map is built from speaks for it/);
});

test('unbuiltSteps and speaksFor: the baseline reader leaves out a step listed twice or not baselined', () => {
  const u = unbuiltSteps({
    steps: [
      { step: 'J-a-01#1', file: 'x/J-a-01.pw.mjs', state: 'unbuilt' },
      { step: 'J-a-01#2', file: 'x/J-a-01.pw.mjs', state: 'unbuilt' },
      { step: 'J-a-01#2', file: 'x/J-a-01.pw.mjs', state: 'unbuilt' },
      { step: 'J-a-01#3', file: 'x/J-a-01.pw.mjs', state: 'unbuilt' },
      { step: 'J-a-01#4', file: 'x/J-a-01.pw.mjs', state: 'regression' },
    ],
    notBaselined: [{ step: 'J-a-01#3' }],
  });
  assert.deepEqual([...u], [['J-a-01#1', 'J-a-01.pw.mjs']]);
  assert.deepEqual(unbuiltSteps(null).size, 0);
  // speaksFor straight: BANK's unbuilt #2 red in all three runs; a run where it passed whole speaks too.
  const whole = [3, 2, 1].map((id) => {
    const r = stepsRun(id, { [BANK]: { fail: id === 1 ? [] : ['#2'], skip: id === 1 ? [] : ['#3'] } });
    return { ...r, tests: reportTests(r.report) };
  });
  assert.deepEqual(speaksFor(whole, BANK, unbuiltSteps(BASELINE)), [false, false, true], '#2 passed in run 1, so it is built');
});

test('planted: a persistently red journey whose afterAll record never came stays full (project-state#1574)', () => {
  const due = records()
    .filter((r) => r.file === TAX)
    .map((r) => ({ ...r, afterAllDue: true }));
  const map = build([3, 2, 1].map((id) => stepsRun(id, { [TAX]: { fail: ['#3'], recs: due } })));
  assert.match(map.full[TAX], /afterAll record never came/);
  // And one whose record is incomplete (a popup) stays full though its red step is persistent.
  const pop = build([3, 2, 1].map((id) => stepsRun(id, { [POPUP]: { fail: ['#3'] } })));
  assert.match(pop.full[POPUP], /incomplete \(popup\)/);
});

test('planted: the reach of a persistently red journey holds what only its failing test’s record carried', () => {
  // Each record holds only what its worker had not sent yet: #3 (red in every run) is the only one reaching svc-support.
  const recs = [
    rec(TAX, { served: ['edge GET /api/tax'], active: ['edge'] }),
    rec(TAX, { served: ['tax GET'], active: ['tax'] }),
    rec(TAX, { served: [], active: [] }),
    rec(TAX, { served: ['support GET'], active: ['support'], sources: { 'packages/market-data/dist/y.js': [[1, 2]] } }),
  ];
  const map = build([3, 2, 1].map((id) => stepsRun(id, { [TAX]: { fail: ['#3'], recs } })));
  assert.equal(map.full[TAX], undefined);
  assert.deepEqual(reachOf(map, 'services', 'services/svc-support'), [BOTH, TAX], 'the red step’s record counts');
  assert.deepEqual(reachOf(map, 'packages', 'packages/market-data'), [BANK, TAX]);
  assert.deepEqual(reachOf(map, 'services', 'services/svc-tax'), [TAX]);
});

test('planted: money code narrows like any path (REVIEW.md C4 entry, OWNER 249)', () => {
  // svc-tax as money code: a change to it still runs only the journeys recorded reaching it.
  const map = build(RUNS, { money: ['packages/ledger-client', 'services/svc-tax'] });
  assert.ok(map.money.includes('services/svc-tax'), 'the map still lists money code, for the record');
  const r = select(['services/svc-tax/src/rates.ts'], { map });
  assert.equal(r.mode, 'files', JSON.stringify(r));
  assert.deepEqual(r.files, [POPUP, TAX]);
  // A package only a money package depends on narrows to the journeys of the services that use it.
  const over = {
    consumers: { ...CONSUMERS, 'packages/fee-math': ['services/svc-tax'] },
    dependents: { ...DEPENDENTS, 'packages/fee-math': ['packages/wallet-kit'] },
    money: ['packages/ledger-client', 'packages/wallet-kit', 'services/svc-ops'],
  };
  assert.deepEqual(select(['packages/fee-math/src/round.ts'], { map: build(RUNS, over) }).files, [POPUP, TAX].sort());
  // A map with no money list narrows the same.
  const { money, ...bare } = map;
  assert.ok(money);
  assert.equal(select(['services/svc-tax/src/rates.ts'], { map: bare }).mode, 'files');
});

test('dependentPackages: packages through packages', () => {
  // dependentPackages follows packages through packages, and leaves apps and services to consumersOf.
  const ws = {
    dirs: ['packages/fee-math', 'packages/wallet-kit', 'packages/top', 'services/svc-tax', 'apps/customer'],
    deps: {
      'packages/fee-math': [],
      'packages/wallet-kit': ['packages/fee-math'],
      'packages/top': ['packages/wallet-kit'],
      'services/svc-tax': ['packages/top'],
      'apps/customer': ['packages/fee-math'],
    },
  };
  assert.deepEqual(dependentPackages(ws), {
    'packages/fee-math': ['packages/top', 'packages/wallet-kit'],
    'packages/wallet-kit': ['packages/top'],
    'packages/top': [],
  });
});

test('verify: a map is exactly what the builder builds from the runs it names (review 7561-R1 #2)', () => {
  const good = mapText(MAP);
  const asked = [];
  const rebuild = (until) => (asked.push(until), good);
  assert.deepEqual(verifyMap(good, rebuild), { ok: true });
  assert.deepEqual(asked, [3], 'rebuilt up to the newest run the map names');
  // Planted: a hand edit (a journey dropped from a service) fails, naming the key.
  const edited = JSON.parse(good);
  edited.services['services/svc-bank'] = edited.services['services/svc-bank'].slice(1);
  const r = verifyMap(mapText(edited), rebuild);
  assert.equal(r.ok, false);
  assert.match(r.why, /differs from the one built from main.s runs up to run 3 in: services$/);
  // Planted: a key only the pull request's map holds is counted, never printed (review 7578-R1 #1).
  const forged = { ...JSON.parse(good), 'x\n::warning::forged': 1 };
  const f = verifyMap(mapText(forged), rebuild);
  assert.equal(f.ok, false);
  assert.doesNotMatch(f.why, /forged|::warning::/);
  assert.match(f.why, /in: 1 key\(s\) main.s builder never writes$/);
  // Only what main's code holds differs: main moved since the build, and the message says to rebuild.
  const moved = JSON.parse(good);
  moved.consumers['packages/new'] = [];
  assert.match(
    verifyMap(mapText(moved), rebuild).why,
    /in: consumers \(only what main.s code holds: main moved since it was built, so rebuild it\)$/,
  );
  // Planted: a hand-picked map (an older run in place of the newest whole one) fails: the rebuild reads every run up to
  // the newest it names, so the run left out comes back.
  const picked = mapText(build([RUNS[0], RUNS[2]], { minRuns: 2 }));
  const rebuiltPicked = mapText(build([RUNS[0], RUNS[1]], { minRuns: 2 }));
  assert.match(verifyMap(picked, () => rebuiltPicked).why, /in: runs/);
  // Planted: the same map reformatted is not byte for byte the built one.
  assert.match(verifyMap(`${JSON.stringify(MAP, null, 2)}\n`, rebuild).why, /layout differs/);
  // A map that can't be read, names no run, or can't be rebuilt fails.
  assert.match(verifyMap('{', rebuild).why, /not JSON/);
  assert.match(verifyMap(mapText({ v: 1, runs: [], mode: 'full' }), rebuild).why, /names no run/);
  assert.match(
    verifyMap(good, () => {
      throw new Error('HTTP 404\nmore');
    }).why,
    /couldn't be rebuilt \(HTTP 404\)$/,
  );
});

test("candidates: main's finished full runs, the named ones, up to the run named", () => {
  const r = (id, created, over = {}) => ({
    id,
    created_at: created,
    head_branch: 'main',
    head_repository: { full_name: REPO },
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    ...over,
  });
  const list = [
    r(1, '2026-11-08T10:00:00Z'),
    r(2, '2026-11-08T11:00:00Z', { conclusion: 'failure' }),
    r(3, '2026-11-08T12:00:00Z', { conclusion: 'cancelled' }),
    r(4, '2026-11-08T13:00:00Z', { head_branch: 'feature' }),
    r(5, '2026-11-08T14:00:00Z', { status: 'in_progress' }),
    r(6, '2026-11-08T15:00:00Z'),
  ];
  const ids = (xs) => xs.map((x) => x.id);
  assert.deepEqual(ids(candidates(list, { repo: REPO })), [6, 2, 1], 'newest first; a red run is read, a cancelled one not');
  assert.deepEqual(ids(candidates(list, { repo: REPO, until: list[1] })), [2, 1], 'nothing after the run named');
  assert.deepEqual(ids(candidates(list, { repo: REPO, ids: ['1', '6'] })), [6, 1]);
});

test('planted: each full fallback', () => {
  const full = (r, why) => {
    assert.equal(r.mode, 'full', JSON.stringify(r));
    assert.match(r.why, why);
  };
  full(select(['apps/admin/src/page.tsx']), /admin app/);
  full(select(['apps/mobile/src/x.ts']), /does not cover/);
  full(select(['apps/customer/vite.config.ts']), /does not cover/);
  full(select(['apps/customer/src/brand-new.tsx']), /no journey was recorded running this customer source file/);
  full(select(['packages/ui/src/button.tsx']), /apps\/admin depend\(s\) on packages\/ui/);
  full(select(['packages/new-one/src/x.ts']), /the map doesn't know packages\/new-one/);
  full(select(['packages/lonely/src/x.ts']), /no journey was recorded reaching packages\/lonely/);
  full(select(['packages/events/src/catalog.ts']), /the journey harness imports it/);
  full(select(['apps/customer/deployment/host-dispatch.mjs']), /the journey harness imports it/);
  full(select(['packages/telemetry/src/x.ts']), /svc-notify depends on packages\/telemetry and subscribes/);
  full(select(['services/svc-notify/src/send.ts']), /subscribes to bus events/);
  full(select(['services/svc-tax/src/consumer.ts'], { subscribes: () => true }), /it subscribes to bus events/);
  full(select(['services/svc-fix/src/x.ts']), /no journey was recorded reaching services\/svc-fix/);
  full(select(['services/svc-edge/src/x.ts']), /holds every journey/);
  full(select(['services/svc-tax/src/x.ts'], { map: null }), /missing or unreadable/);
  full(select(['services/svc-tax/src/x.ts'], { map: { ...MAP, v: 9 } }), /version 9/);
  full(select(['services/svc-tax/src/x.ts'], { map: { ...MAP, runs: MAP.runs.slice(0, 2) } }), /fewer than 3 runs/);
  full(select(['services/svc-tax/src/x.ts'], { behind: STALE_RUNS + 1 }), /stale: 25 finished main runs/);
  full(select(['services/svc-tax/src/x.ts'], { behind: null }), /couldn't be read/);
  full(select(['services/svc-tax/src/x.ts'], { atHead: null }), /couldn't be listed/);
  assert.equal(select(['services/svc-tax/src/x.ts'], { behind: STALE_RUNS }).mode, 'files', 'exactly STALE_RUNS behind still serves');
  // An afterAll record that never came: the journey is full, so it runs with every change.
  const due = [rec(TAX, { served: ['tax GET'], afterAllDue: true }), ...records().slice(1)];
  const dueMap = build([run(3, 'x', due), run(2, 'y'), run(1, 'z')]);
  assert.match(dueMap.full[TAX], /afterAll record never came/);
  const late = [rec(TAX, { served: ['tax GET'], afterAllDue: true }), rec(TAX, { afterAll: true }), ...records().slice(1)];
  assert.equal(build([run(3, 'x', late), run(2, 'y'), run(1, 'z')]).full[TAX], undefined, 'the afterAll record came');
  // A journey with no record in a run where it existed.
  const none = build([
    run(
      3,
      'x',
      records().filter((r) => r.file !== BOTH),
    ),
    run(2, 'y'),
    run(1, 'z'),
  ]);
  assert.match(none.full[BOTH], /holds no record of it/);
});

// ---- A customer file no run recorded takes the journeys of the files that load it (#8648) ----

const SRC = 'apps/customer/src';
const IMPORTERS = {
  [`${SRC}/features/tax/tax.css`]: [`${SRC}/features/tax/TaxRoom.tsx`],
  [`${SRC}/features/bank/cards.css`]: [`${SRC}/features/bank/bank.css`],
  [`${SRC}/features/bank/bank.css`]: [`${SRC}/features/bank/Cards.tsx`, `${SRC}/features/bank/Cards.test.tsx`],
  [`${SRC}/app/registry.ts`]: [`${SRC}/app/registry.test.ts`],
  [`${SRC}/app/pw-only.ts`]: [`${SRC}/app/pw-only.pw.mjs`],
  [`${SRC}/app/boot.ts`]: [`${SRC}/main.tsx`, 'apps/customer/vite.config.ts'],
  [`${SRC}/app/docs.ts`]: [`${SRC}/main.tsx`],
  [`${SRC}/screens/harness/main.tsx`]: [`${SRC}/screens/harness/index.html`],
  [`${SRC}/screens/rooms/load.ts`]: [`${SRC}/main.tsx`],
};
const LOADERS = build(RUNS, { importers: IMPORTERS, built: [`${SRC}/app/docs.ts`] });
const COMPUTED = build(RUNS, { importers: IMPORTERS, computed: [`${SRC}/screens/rooms/load.ts`] });
/**
 * loadersReach's `head` as a checkout of it reads: the changed files' `texts`, the unknown files the merge base holds
 * (`based`), and each folder's entries: every file the map knows and every changed file still at the head, plus `extra`.
 */
const at = (texts = [], { based = [], extra = [], map = LOADERS } = {}) => {
  const dirs = new Map();
  const files = [
    ...Object.keys(map.customer),
    ...Object.keys(map.importers ?? {}),
    ...texts.filter(([, t]) => t !== null).map(([f]) => f),
    ...extra,
  ];
  for (const f of files)
    for (let d = posix.dirname(f), n = posix.basename(f); d !== '.'; n = posix.basename(d), d = posix.dirname(d))
      dirs.set(d, (dirs.get(d) ?? new Set()).add(n));
  return { texts: new Map(texts), based: new Set(based), dirs };
};
const loaders = (path, head = at(), map = LOADERS) => pathReach(map, path, false, head);
const names = (r) => (r.journeys ?? []).map((i) => LOADERS.journeys[i]).sort();

test('importTargets: every way a file names another to load, resolved against it; packages left out', () => {
  const t = [
    "import { a } from './a';",
    "export * from '../b/index.js';",
    "import type { C } from './c.tsx';",
    "import './side.css';",
    "const d = await import('./d');",
    "const e = import(/* @vite-ignore */ './e');",
    "const f = require('./f.cjs');",
    "const w = new URL('./worker.ts?worker', import.meta.url);",
    "import x from 'react';",
    "import y from '@intafaced/ui';",
    "const home = '/src/main.tsx';",
  ].join('\n');
  assert.deepEqual(importTargets(t, `${SRC}/app/x.tsx`).sort(), [
    `${SRC}/app/a`,
    `${SRC}/app/c.tsx`,
    `${SRC}/app/d`,
    `${SRC}/app/e`,
    `${SRC}/app/f.cjs`,
    `${SRC}/app/side.css`,
    `${SRC}/app/worker.ts`,
    `${SRC}/b/index.js`,
  ]);
  const css =
    "@import './base.css';\n@import url(\"../fonts.css\");\n.a { background: url(./bg.png); }\n.b { composes: c from './c.module.css'; }";
  assert.deepEqual(importTargets(css, `${SRC}/app/x.css`).sort(), [
    `${SRC}/app/base.css`,
    `${SRC}/app/bg.png`,
    `${SRC}/app/c.module.css`,
    `${SRC}/fonts.css`,
  ]);
  assert.deepEqual(importTargets('<script type="module" src="/src/main.tsx"></script>', 'apps/customer/index.html'), [`${SRC}/main.tsx`]);
  assert.deepEqual(moduleKeys(`${SRC}/b/index.ts`), [
    `${SRC}/b/index.ts`,
    `${SRC}/b/index`,
    `${SRC}/b`,
    `${SRC}/b/index.js`,
    `${SRC}/b/index.jsx`,
  ]);
  assert.deepEqual(moduleKeys(`${SRC}/a.css`), [`${SRC}/a.css`], 'a style sheet is loaded by its full name only');
});

test('planted: a customer file no run recorded takes the journeys of the files that load it, never fewer', () => {
  assert.deepEqual(names(loaders(`${SRC}/features/tax/tax.css`)), [TAX], 'a style sheet: the journeys that ran the room loading it');
  assert.deepEqual(
    names(loaders(`${SRC}/features/bank/cards.css`)),
    [BANK],
    'followed up through a style sheet no run recorded; a unit test loads nothing',
  );
  // A file this pull request adds takes the journeys of the changed files that load it at the head.
  const fresh = `${SRC}/features/tax/TaxRules.tsx`;
  const texts = [
    [fresh, 'export const x = 1;'],
    [`${SRC}/features/tax/TaxRoom.tsx`, "import { x } from './TaxRules';"],
    [`${SRC}/features/bank/Cards.tsx`, "import { x } from '../tax/TaxRules.js';"],
    [`${SRC}/features/tax/TaxRules.test.tsx`, "import { x } from './TaxRules';"],
  ];
  assert.deepEqual(names(loaders(fresh, at(texts))), [BANK, TAX]);
  assert.deepEqual(
    reachSelect({
      map: LOADERS,
      paths: [fresh, `${SRC}/features/tax/TaxRoom.tsx`],
      behind: 0,
      atHead: FILES,
      head: at(texts),
      mode: 'reach',
    }).files,
    [BANK, POPUP, TAX],
    'through reachSelect: the selection holds what its loaders reach',
  );
  // A customer file that loads what it doesn't spell (a glob, a computed import) may load any customer file.
  const y = `${SRC}/features/tax/y.ts`;
  assert.deepEqual(
    names(loaders(y, at([[y, '']], { map: COMPUTED }), COMPUTED)),
    [BANK, TAX],
    'load.ts may load it; main.tsx loads load.ts',
  );
  assert.deepEqual(names(loaders(`${SRC}/features/tax/tax.css`, at([], { map: COMPUTED }), COMPUTED)), [BANK, TAX]);
  const glob = [
    [`${SRC}/x/new.ts`, ''],
    [`${SRC}/y/glob.ts`, "const all = import.meta.glob('../x/*.ts');"],
  ];
  assert.match(
    loaders(`${SRC}/x/new.ts`, at(glob)).full,
    /nothing but tests loads apps\/customer\/src\/y\/glob.ts/,
    'a changed file that globs loads it',
  );
});

test('planted: where the map cannot know who loads a customer file, it is full', () => {
  const full = (r, why) => {
    assert.ok(r.full, JSON.stringify(r));
    assert.match(r.full, why);
  };
  full(pathReach(MAP, `${SRC}/features/tax/tax.css`, false, at()), /^no journey was recorded running this customer source file$/);
  full(loaders(`${SRC}/features/tax/tax.css`, null), /the files that load it at the head couldn't be read/);
  full(loaders(`${SRC}/features/tax/tax.css`, {}), /the files that load it at the head couldn't be read/, 'a read that failed');
  full(loaders(`${SRC}/app/registry.ts`), /nothing but tests loads/);
  full(loaders(`${SRC}/app/pw-only.ts`), /nothing but tests loads/, 'a Playwright file in the source is its own config’s test');
  const brand = `${SRC}/features/tax/Brand.tsx`;
  full(loaders(brand, at([[brand, '']])), /nothing but tests loads/, 'a new file nothing changed loads');
  // A file the map doesn't know that this pull request doesn't add: main added it after the map was built, and files the
  // map never read may load it (the checker's case: a follow-up to a file merged hours earlier).
  const rules = `${SRC}/features/tax/TaxRules.tsx`;
  const follow = [
    [rules, 'export const x = 2;'],
    [`${SRC}/features/tax/TaxRoom.tsx`, "import { x } from './TaxRules';"],
  ];
  full(loaders(rules, at(follow, { based: [rules] })), /TaxRules.tsx is newer than the map/);
  full(
    loaders(rules, at([[`${SRC}/features/tax/TaxRoom.tsx`, "import { x } from './TaxRules';"]])),
    /is newer than the map/,
    'not a changed file',
  );
  full(loaders(`${SRC}/app/boot.ts`), /apps\/customer\/vite.config.ts loads/, 'loaded from outside the customer source');
  full(loaders(`${SRC}/app/docs.ts`), /Node code \(the journey harness or the app's build\) runs/);
  full(loaders(`${SRC}/screens/harness/main.tsx`), /index.html loads/, 'a page loads it');
  const ts = `${SRC}/features/tax/TaxRoom.ts`;
  full(
    loaders(ts, at([[ts, '']])),
    /is new and shares its import name with TaxRoom.tsx/,
    'a new x.ts beside x.tsx: an unchanged import may now load it',
  );
  const fees = `${SRC}/features/tax/Fees.ts`;
  full(
    loaders(fees, at([[fees, '']], { extra: [`${SRC}/features/tax/Fees.tsx`] })),
    /shares its import name with Fees.tsx/,
    'beside a file main added after the map was built: the head’s own folder says so',
  );
  const index = `${SRC}/features/tax/index.ts`;
  full(
    loaders(index, at([[index, '']], { extra: [`${SRC}/features/tax.tsx`] })),
    /shares its import name with tax.tsx/,
    'x/index.ts beside x.tsx',
  );
  full(loaders(fees, { ...at([[fees, '']]), dirs: new Map() }), /couldn't be listed at the head/);
  full(
    loaders(`${SRC}/features/tax/tax.css`, at([['tooling/scripts/x.mjs', "import '../../apps/customer/src/features/tax/tax.css';"]])),
    /tooling\/scripts\/x.mjs, which runs in Node, loads/,
    'a changed file outside the customer source that loads it',
  );
  const sel = reachSelect({ map: LOADERS, paths: [`${SRC}/app/registry.ts`], behind: 0, atHead: FILES, head: at(), mode: 'reach' });
  assert.equal(sel.mode, 'full');
  assert.match(sel.why, /nothing but tests/);
});

test('headWanted, the seal and the touch job: the head is read only for a customer file the map has no record of', async () => {
  const fresh = `${SRC}/features/tax/New.tsx`;
  const index = `${SRC}/features/tax/index.ts`;
  const paths = [`${SRC}/features/tax/tax.css`, `${SRC}/features/tax/TaxRoom.tsx`, 'services/svc-tax/README.md', fresh, index];
  assert.deepEqual(headWanted(LOADERS, paths), {
    texts: [paths[0], paths[1], fresh, index],
    unknown: [fresh, index],
    dirs: [`${SRC}/features`, `${SRC}/features/tax`],
  });
  assert.equal(headWanted(LOADERS, [`${SRC}/features/tax/TaxRoom.tsx`]), null, 'every customer file recorded: nothing read');
  assert.equal(headWanted(MAP, paths), null, 'a map with no importers reads nothing');
  const MB = 'b'.repeat(40);
  const io = {
    mainRuns: async () => [],
    journeyFiles: async () => FILES,
    reachMap: async () => LOADERS,
    runs: async () => [],
    dirNames: async (d) => (d.endsWith('/tax') ? ['TaxRoom.tsx', 'New.tsx', 'index.ts'] : ['tax']),
    mergeBase: async () => MB,
    // Main changed main.tsx since the map's head: its new side is read, and it counts as newer than the map.
    compare: async (a, b) =>
      a === HEAD && b === MB
        ? { status: 'ahead', files: [{ filename: `${SRC}/main.tsx`, status: 'modified', patch: '@@ -1 +1 @@\n+x' }] }
        : null,
  };
  const text = async (p, ref) => (ref === MB ? (p === index ? 'x' : null) : p.endsWith('TaxRoom.tsx') ? "import './tax.css';" : '');
  const r = await reachInputs({ io, paths, head: HEAD, base: 'c'.repeat(40), text });
  assert.deepEqual([...r.head.texts.keys()], [paths[0], paths[1], fresh, index, `${SRC}/main.tsx`]);
  assert.deepEqual([...r.head.based], [`${SRC}/main.tsx`, index], 'index.ts is on the merge base: main added it after the map');
  assert.deepEqual([...r.head.dirs.get(`${SRC}/features/tax`)], ['TaxRoom.tsx', 'New.tsx', 'index.ts']);
  const broken = await reachInputs({ io, paths, head: HEAD, base: 'c'.repeat(40), text: async () => { throw new Error('HTTP 502'); } }); // prettier-ignore
  assert.deepEqual(broken.head, {}, 'a read that fails leaves the head unknown: full');
  const noList = await reachInputs({ io: { ...io, dirNames: undefined }, paths, head: HEAD, base: 'c'.repeat(40), text });
  assert.deepEqual(noList.head, {});
  const noCompare = await reachInputs({ io: { ...io, compare: undefined }, paths, head: HEAD, base: 'c'.repeat(40), text });
  assert.deepEqual(noCompare.head, {}, "main's changes since the map unread: full");
  // The touch job reads the same from its checkout of the head.
  const root = mkdtempSync(join(tmpdir(), 'reach-head-'));
  try {
    mkdirSync(join(root, SRC, 'features/tax'), { recursive: true });
    writeFileSync(join(root, SRC, 'features/tax/TaxRoom.tsx'), "import './tax.css';");
    writeFileSync(join(root, SRC, 'features/tax/New.tsx'), '');
    writeFileSync(join(root, SRC, 'features/tax/index.ts'), 'x');
    const base =
      (over = {}) =>
      async () => ({ mergeBase: MB, atBase: async (p) => p === index, compare: io.compare, ...over });
    const h = await checkoutHead(LOADERS, paths, { root, base: base() });
    assert.deepEqual([...h.texts.keys()], [paths[0], paths[1], fresh, index, `${SRC}/main.tsx`]);
    assert.equal(h.texts.get(paths[0]), null, 'removed at the head');
    assert.deepEqual([...h.based], [`${SRC}/main.tsx`, index]);
    assert.deepEqual([...h.dirs.get(`${SRC}/features/tax`)].sort(), ['New.tsx', 'TaxRoom.tsx', 'index.ts']);
    assert.deepEqual(await checkoutHead(LOADERS, paths, { root, base: base({ atBase: async () => { throw new Error('HTTP 502'); } }) }), {}); // prettier-ignore
    assert.deepEqual(await checkoutHead(LOADERS, paths, { root, base: async () => { throw new Error('no merge base'); } }), {}); // prettier-ignore
    assert.equal(await checkoutHead(MAP, paths, { root, base: base() }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('planted: what main changed between the map and the merge base loads a file too (sinceMap, patchText)', async () => {
  const MB = 'b'.repeat(40);
  const map = { runs: [{ head: HEAD }] };
  const patch = "@@ -1,2 +1,2 @@\n import a from './a';\n-import b from './b';\n+import c from './c';\n@@ -40 +40 @@\n+const m = import(";
  const plus = patchText(patch, '+');
  assert.ok(importTargets(plus, `${SRC}/app/x.ts`).includes(`${SRC}/app/c`), 'the new side’s import');
  assert.match(plus, /import\(\n;/, 'a hunk ends cut off: its open load reads as computed');
  assert.doesNotMatch(patchText(patch, '-'), /^import c from/m, 'the old side holds no added line');
  const files = [
    { filename: `${SRC}/app/x.ts`, status: 'modified', patch },
    { filename: `${SRC}/app/gone.ts`, status: 'removed' },
    { filename: `${SRC}/app/to.ts`, previous_filename: `${SRC}/app/from.ts`, status: 'renamed', patch: '@@ -1 +1 @@\n+y' },
    { filename: `${SRC}/app/big.ts`, status: 'modified' },
    { filename: `${SRC}/app/x.test.ts`, status: 'modified', patch },
    { filename: 'docs/a.md', status: 'modified', patch },
    { filename: 'tooling/scripts/s.mjs', status: 'added', patch: "@@ -0,0 +1 @@\n+import '../../apps/customer/src/a.ts';" },
  ];
  const ahead = await sinceMap(map, MB, async (a, b) => (a === HEAD && b === MB ? { status: 'ahead', files } : null));
  assert.deepEqual(
    [...ahead].map(([f, t]) => [f, t === undefined ? 'read' : t === null ? 'gone' : 'patch']),
    [
      [`${SRC}/app/x.ts`, 'patch'],
      [`${SRC}/app/gone.ts`, 'gone'],
      [`${SRC}/app/to.ts`, 'read'],
      [`${SRC}/app/from.ts`, 'gone'],
      [`${SRC}/app/big.ts`, 'read'],
      ['tooling/scripts/s.mjs', 'patch'],
    ],
  );
  // A merge base older than the map: the map's head compared from it, read on its old side.
  const behind = await sinceMap(map, MB, async (a, b) =>
    a === HEAD ? { status: 'behind', files: [] } : a === MB && b === HEAD ? { status: 'ahead', files } : null,
  );
  assert.equal(behind.get(`${SRC}/app/gone.ts`), undefined, 'removed since, no patch given: the merge base holds it, read it');
  assert.equal(behind.get(`${SRC}/app/from.ts`), undefined, 'renamed since: the merge base holds the old name, read it');
  assert.equal(behind.get(`${SRC}/app/to.ts`), null);
  assert.equal(behind.get('tooling/scripts/s.mjs'), null, 'added since: the merge base doesn’t hold it');
  assert.match(behind.get(`${SRC}/app/x.ts`), /import b from/);
  assert.deepEqual([...(await sinceMap(map, HEAD, async () => null))], [], 'the merge base is the map’s head');
  const throws = (compare, mb = MB, m = map) => assert.rejects(sinceMap(m, mb, compare));
  await throws(async () => ({ status: 'diverged', files: [] }));
  await throws(async () => ({ status: 'ahead', files: Array.from({ length: 300 }, (_, i) => ({ filename: `docs/${i}.md` })) }), MB);
  await throws(async () => ({ status: 'ahead' }));
  await throws(async () => ({ status: 'ahead', files: [] }), 'main');
  await throws(async () => ({ status: 'ahead', files: [] }), MB, { runs: [] });
  // The map's graph is read at its newest run's head.
  const seen = [];
  const graphed = build(RUNS, { graph: (sha) => (seen.push(sha), { importers: { [`${SRC}/app/n.ts`]: [] }, built: [], computed: [] }) });
  assert.deepEqual(seen, [HEAD]);
  assert.deepEqual(graphed.importers, { [`${SRC}/app/n.ts`]: [] });
  // The checker's case: a file this pull request adds, loaded by a changed file, and by a glob main added after the map.
  const fresh = `${SRC}/features/tax/TaxRules.tsx`;
  const want = { texts: [fresh, `${SRC}/features/bank/Cards.tsx`], unknown: [fresh], dirs: [`${SRC}/features/tax`] };
  const pr = {
    [fresh]: 'export const x = 1;',
    [`${SRC}/features/bank/Cards.tsx`]: "import { x } from '../tax/TaxRules';",
  };
  const glob = {
    filename: `${SRC}/features/tax/TaxRoom.tsx`,
    status: 'modified',
    patch: "@@ -3 +3 @@\n+const all = import.meta.glob('./*.tsx');",
  };
  const head = (changed) =>
    readHead(LOADERS, want, {
      read: async (p) => pr[p] ?? null,
      list: async () => ['TaxRoom.tsx', 'TaxRules.tsx', 'tax.css'],
      mergeBase: MB,
      atBase: async () => false,
      compare: async () => ({ status: 'ahead', files: changed }),
    });
  assert.deepEqual(names(loaders(fresh, await head([]))), [BANK], 'nothing on main loads it: its own loader’s journeys');
  assert.deepEqual(names(loaders(fresh, await head([glob]))), [BANK, TAX], 'the glob main added loads it: TaxRoom’s journeys too');
  const imp = { ...glob, patch: "@@ -3 +3 @@\n+import { x } from './TaxRules';" };
  assert.deepEqual(names(loaders(fresh, await head([imp]))), [BANK, TAX], 'an import main added');
  const cut = { ...glob, patch: "@@ -3,2 +3,2 @@\n const all = import(\n+  './TaxRules'\n@@ -9 +9 @@\n+x" };
  assert.deepEqual(names(loaders(fresh, await head([cut]))), [BANK, TAX], 'an import whose keyword the patch cuts off');
  const added = { filename: `${SRC}/features/tax/Other.tsx`, status: 'added', patch: "@@ -0,0 +1 @@\n+import './TaxRules';" };
  assert.match(loaders(fresh, await head([added])).full, /Other.tsx is newer than the map/, 'a file main added that loads it');
  // A recorded file the build runs loads it: what the build emits, no record ties to a journey.
  const docs = { ...glob, filename: `${SRC}/app/docs.ts`, patch: "@@ -1 +1 @@\n+import '../features/tax/TaxRules';" };
  assert.match(loaders(fresh, await head([docs])).full, /apps\/customer\/src\/app\/docs.ts, which runs in Node, loads/);
  // What runs in Node grows after the map (the checker's round 3 case): a file read at the head that the harness or the
  // build runs, loading a customer file the map doesn't hold as run there, may run it in every journey.
  const node = (filename, line) => ({ filename, status: 'modified', patch: `@@ -1 +1,2 @@\n x\n+${line}` });
  const harnessed = { ...LOADERS, harness: [...LOADERS.harness, `${SRC}/features/bank/Cards.tsx`] };
  const nodeHead = (changed, map = LOADERS) =>
    readHead(map, want, {
      read: async (p) => pr[p] ?? null,
      list: async () => ['TaxRoom.tsx', 'TaxRules.tsx', 'tax.css'],
      mergeBase: MB,
      atBase: async () => false,
      compare: async () => ({ status: 'ahead', files: changed }),
    });
  for (const [why, files, map] of [
    ['the harness runs a recorded loader', [], harnessed],
    [
      'a harness script starts loading a customer file',
      [node('tooling/scripts/s.mjs', "import '../../apps/customer/src/features/bank/Cards.tsx';")],
    ],
    ['the build starts loading a customer file', [node('apps/customer/vite.config.ts', "import './src/features/bank/Cards';")]],
    [
      'a journey file starts loading one',
      [node('apps/customer/tests/real-app/helpers/x.mjs', "import '../../../src/features/bank/Cards.tsx';")],
    ],
  ])
    assert.ok(loaders(fresh, await nodeHead(files, map), map).full, why);
  assert.match(
    loaders(`${SRC}/features/bank/cards.css`, at([], { map: harnessed }), harnessed).full,
    /the journey harness runs apps\/customer\/src\/features\/bank\/Cards.tsx, which loads it/,
    'a recorded loader the harness runs, from main’s graph',
  );
  // Node code that builds a load's path (the checker's round 4 case): its quoted paths count, and pieces of one are full.
  for (const [why, file, line] of [
    ['a harness script', 'tooling/scripts/s.mjs', "await import(path.join(ROOT, 'apps/customer/src/features/bank/Cards.tsx'));"],
    ['the build', 'apps/customer/vite.config.ts', "await runnerImport(resolve(__dirname, 'src/features/bank/Cards.tsx'));"],
    [
      'a journey helper',
      'apps/customer/tests/real-app/helpers/x.mjs',
      "await import(pathToFileURL(join(HERE, '../../../src/features/bank/Cards.tsx')).href);",
    ],
    ['a path in pieces', 'tooling/scripts/s.mjs', "await import(path.join(ROOT, 'apps', 'customer', 'src', name));"],
    ['a template path', 'tooling/scripts/s.mjs', 'await import(`${HERE}/../../apps/x/src/${name}`);'],
  ]) {
    assert.ok(loaders(fresh, await nodeHead([node(file, line)])).full, why);
    // GitHub gives no patch: the file is read whole at the head.
    pr[file] = line;
    assert.ok(loaders(fresh, await nodeHead([{ filename: file, status: 'modified' }])).full, `${why}, read whole`);
    delete pr[file];
  }
  assert.deepEqual(
    nodeTargets("await import(path.join(ROOT, 'services/svc-x/dist/a.js'));", 'tooling/scripts/s.mjs'),
    { targets: [], any: false },
    'a built path elsewhere names no customer file',
  );
  assert.deepEqual(
    nodeTargets("const title = 'customer src';", 'tooling/scripts/s.mjs'),
    { targets: [], any: false },
    'no load built from a path: plain text',
  );
  assert.deepEqual(
    names(loaders(fresh, await nodeHead([node('apps/customer/vite.config.ts', "import './src/app/docs';")]))),
    [BANK],
    'loading what the build already runs changes nothing',
  );
});

test('customerImporters on this repository: who loads a style sheet, the build’s own files, a file only a test loads', () => {
  const { importers, built, computed } = customerImporters();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
  assert.deepEqual(customerImporters(ROOT_DIR, head), customerImporters(ROOT_DIR), 'read at a commit, the same as its checkout');
  assert.ok(importers[`${SRC}/features/trade/news/news.css`].includes(`${SRC}/features/trade/news/NewsRooms.tsx`));
  assert.ok(importers[`${SRC}/main.tsx`].includes('apps/customer/index.html'));
  assert.ok(built.includes(`${SRC}/app/boot.ts`), 'vite.config.ts imports it');
  assert.ok(
    built.includes(`${SRC}/features/developers/developers-files.ts`),
    'vite.config.ts loads it with new URL() and runs it in the build',
  );
  assert.equal(built.includes(`${SRC}/main.tsx`), false, 'the app itself is not the build’s Node code');
  for (const h of harnessImports().filter((x) => x.startsWith(`${SRC}/`))) assert.ok(built.includes(h), `the harness runs ${h}`);
  // Node code that loads a customer folder or a templated path may load any customer file (round 5's static cases).
  for (const [why, line] of [
    ['a template', 'await import(`${ROOT}/apps/customer/src/app/${name}.ts`);'],
    ['a folder', "for (const n of readdirSync(new URL('../../apps/customer/src/app/sub/', import.meta.url))) await import(n);"],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'reach-node-'));
    try {
      mkdirSync(join(dir, SRC, 'app/sub'), { recursive: true });
      mkdirSync(join(dir, 'tooling/scripts'), { recursive: true });
      writeFileSync(join(dir, SRC, 'app/sub/x.ts'), 'export const x = 1;\n');
      writeFileSync(join(dir, 'tooling/scripts/s.mjs'), `${line}\n`);
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '-A'], { cwd: dir });
      assert.ok(customerImporters(dir).built.includes(`${SRC}/app/sub/x.ts`), why);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(importers[`${SRC}/app/room-templates.ts`], [], 'only its unit test imports it; a scaffold reads it as text');
  for (const f of computed) assert.match(f, /^apps\/customer\/src\//);
  assert.equal(importers[`${SRC}/features/pay/portal/w3c2.pw.mjs`], undefined, 'a Playwright file in the source is a test');
  for (const [f, v] of Object.entries(importers)) {
    assert.doesNotMatch(f, /\.(test|spec)\./);
    for (const g of v) assert.doesNotMatch(g, /\.(test|spec)\.[cm]?[jt]sx?$/, `${f}: a unit test loads nothing`);
  }
});

test('planted: the off switch and the builder’s refusal', () => {
  assert.equal(REACH_MAP_MODE, 'reach', 'on: setting it to full turns every product change back to the full suite');
  assert.equal(
    reachSelect({ map: MAP, paths: ['services/svc-tax/src/rates.ts'], behind: 0, atHead: FILES }).mode,
    'files',
    'the default is on',
  );
  const off = select(['services/svc-tax/src/rates.ts'], { mode: 'full' });
  assert.equal(off.mode, 'full');
  assert.match(off.why, /switched off \(REACH_MAP_MODE is 'full'\)/);
  assert.equal(mapProblem(MAP, 0, 'full') !== null, true);
  // Fewer than three whole runs: the builder writes a full map, and nothing narrows.
  const two = build(RUNS.slice(0, 2));
  assert.equal(two.mode, 'full');
  assert.match(two.why, /built from 2 whole main run\(s\) holding records; it needs 3/);
  assert.equal(select(['services/svc-tax/src/rates.ts'], { map: two }).mode, 'full');
  // A run with a lost shard (a journey file at its head that its report lacks) is not whole and is passed over.
  const lost = { ...run(4, '2026-11-08T16:00:00Z'), files: new Set([...FILES, 'J-gone-01.pw.mjs']) };
  const m = build([lost, ...RUNS]);
  assert.deepEqual(
    m.runs.map((r) => r.id),
    [3, 2, 1],
  );
  assert.match(m.skipped[0], /^4: its report lacks 1 journey file\(s\) at its head \(a lost shard\)/);
  const before = build([...RUNS.slice(0, 2), { ...run(0, 'w'), report: report([], [...FILES]) }]);
  assert.equal(before.mode, 'full', 'a run before the recorder is not whole');
  assert.equal(MIN_RUNS, 3);
});

test('runsBehind: main’s finished full runs after the map’s newest run; unknown when the list stops short', () => {
  const mainRun = (id, created, over = {}) => ({
    id,
    created_at: created,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    head_repository: { full_name: REPO },
    ...over,
  });
  const runs = [
    mainRun(10, '2026-11-08T18:00:00Z'),
    mainRun(9, '2026-11-08T17:00:00Z', { conclusion: 'cancelled' }),
    mainRun(8, '2026-11-08T16:00:00Z', { head_branch: 'b/x' }),
    mainRun(7, '2026-11-08T15:30:00Z', { event: 'schedule' }),
    mainRun(3, '2026-11-08T15:00:00Z'),
  ];
  assert.equal(runsBehind(MAP, runs), 2, 'the cancelled run and the branch run do not count');
  assert.equal(runsBehind(MAP, runs.slice(0, 3)), null, "the list doesn't reach back to the map's newest run");
  assert.equal(runsBehind(MAP, null), null);
  assert.equal(runsBehind(null, runs), null);
});

test('runReach: a recorded file whose record is incomplete reaches everything', () => {
  const r = runReach(records(), SERVICES);
  assert.match(r[POPUP].full, /incomplete \(popup\)/);
  assert.deepEqual([...r[TAX].services].sort(), ['services/svc-edge', 'services/svc-tax']);
});

// ---- The seal holds the pull request to the selection ----

const ghRun = (id, over = {}) => ({
  id,
  head_sha: HEAD,
  path: JOURNEYS_WORKFLOW,
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  created_at: `2026-11-08T1${id % 10}:00:00Z`,
  run_started_at: `2026-11-08T1${id % 10}:00:00Z`,
  head_repository: { full_name: REPO },
  repository: { full_name: REPO },
  ...over,
});
const sealWith = ({
  files,
  runs,
  reports,
  verdict,
  map = MAP,
  mainRuns = [ghRun(3, { created_at: '2026-11-08T15:00:00Z', head_branch: 'main', event: 'push' })],
}) =>
  sealPull({
    repo: REPO,
    number: 9,
    sha: HEAD,
    io: {
      pull: async () => ({ state: 'open', head: { sha: HEAD }, base: { sha: 'b'.repeat(40) }, title: 'svc-tax: rates', body: '' }),
      runs: async () => runs,
      reportOf: async (r) => reports[r.id],
      files: async () => files,
      text: async () => '',
      verdictOf: verdict,
      reachMap: async () => map,
      mainRuns: async () => mainRuns,
      journeyFiles: async () => FILES,
      reachMode: 'reach',
    },
  });
const clean = { red: [], failing: 0, missing: [] };

test('planted: the seal accepts a run of exactly the selected journeys, and fails when one is missing or red', async () => {
  const files = ['services/svc-tax/src/rates.ts'];
  const exact = await sealWith({ files, runs: [ghRun(1)], reports: { 1: { states: {}, ran: [POPUP, TAX] } }, verdict: async () => clean });
  assert.equal(exact.ok, true, exact.lines.join('\n'));
  assert.match(
    exact.lines.join('\n'),
    /touched journeys: it touches 2 journey file\(s\) \(J-merchant-01\.pw\.mjs, J-tax-01\.pw\.mjs\), by the touched-journeys map/,
  );
  const missing = await sealWith({ files, runs: [ghRun(1)], reports: { 1: { states: {}, ran: [TAX] } }, verdict: async () => clean });
  assert.equal(missing.ok, false);
  assert.match(missing.lines.join('\n'), /no finished Real-app journeys run on this exact head ran J-merchant-01\.pw\.mjs/);
  // A planted fault breaks one selected journey: its red step fails the seal.
  const broken = await sealWith({
    files,
    runs: [ghRun(1)],
    reports: { 1: { states: { 'J-tax-01#1': 'failed' }, ran: [POPUP, TAX] } },
    verdict: async () => ({ red: [{ step: 'J-tax-01#1', why: 'failing, not in the baseline' }], failing: 1, missing: [] }),
  });
  assert.equal(broken.ok, false);
  assert.match(broken.lines.join('\n'), /J-tax-01#1: failing, not in the baseline/);
  // The same change with the map off or stale needs the full run, so the targeted run no longer seals it.
  const stale = await sealWith({
    files,
    runs: [ghRun(1)],
    reports: { 1: { states: {}, ran: [POPUP, TAX] } },
    verdict: async () => ({ ...clean, missing: [BANK, BOTH] }),
    mainRuns: [],
  });
  assert.equal(stale.ok, false);
  assert.match(stale.lines.join('\n'), /full run: it changes what can reach any journey .*couldn't be read/);
});

// ---- The committed map is public: only repository paths, service directories, journey names and run facts ----

test('the committed map holds only shapes a public map may hold', () => {
  const map = loadMap();
  assert.ok(map, 'tooling/ci/journey-reach-map.json is readable');
  assert.equal(map.v, 1);
  assert.ok(['reach', 'full'].includes(map.mode));
  const allowed = new Set([
    'v',
    'mode',
    'why',
    'runs',
    'skipped',
    'journeys',
    'full',
    'services',
    'packages',
    'customer',
    'consumers',
    'dependents',
    'harness',
    'subscribers',
    'money',
    'importers',
    'built',
    'computed',
  ]);
  for (const k of Object.keys(map)) assert.ok(allowed.has(k), `unexpected key ${k}`);
  for (const r of map.runs) {
    assert.ok(Number.isInteger(r.id));
    assert.match(r.head, /^[0-9a-f]{40}$/);
    assert.match(r.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }
  // The roots manifestsAt (journey-verdict.mjs) reads workspace folders from: the money list holds tooling/pay-sim.
  const PATH = /^(apps|packages|services|tooling)\/[A-Za-z0-9._@/-]+$/;
  const JOURNEY = /^J-[a-z0-9-]+\.pw\.mjs$/;
  for (const j of map.journeys ?? []) assert.match(j, JOURNEY);
  for (const k of ['services', 'packages', 'customer', 'consumers', 'dependents'])
    for (const [p, v] of Object.entries(map[k] ?? {})) {
      assert.match(p, PATH);
      for (const x of v) assert.ok(Number.isInteger(x) || PATH.test(x), `${k}.${p}`);
    }
  for (const p of [...(map.harness ?? []), ...(map.subscribers ?? []), ...(map.money ?? []), ...(map.built ?? []), ...(map.computed ?? [])])
    assert.match(p, PATH);
  for (const [p, v] of Object.entries(map.importers ?? {})) {
    assert.match(p, PATH);
    for (const x of v) assert.match(x, PATH, `importers.${p}`);
  }
  for (const f of Object.keys(map.full ?? {})) assert.match(f, JOURNEY);
});

test('the harness: what tooling/scripts and the real-app files run in Node, followed through relative imports', () => {
  const h = harnessImports();
  for (const p of [
    'packages/events', // imported by name from journey files
    'packages/contracts',
    'apps/customer/src/app/path-match.ts', // ../../src/app/path-match.ts from a real-app file
    'apps/customer/deployment/host-dispatch.mjs', // from tooling/scripts/local-test-stack.mjs
    'services/svc-fix/scripts/ensure-toolchain.mjs',
  ])
    assert.ok(h.includes(p), `${p} is part of the harness`);
  assert.equal(h.includes('services/svc-tax'), false, 'a service the harness does not import is not the harness');
});

test('the committed map’s money list is REVIEW.md’s money code: ledger-client, every workspace folder depending on it directly, the named services and svc-ledger (CI review on a50417c8)', () => {
  const map = loadMap();
  if (map?.mode !== 'reach') return; // a full map narrows nothing
  const want = [...new Set([...moneyCodeDirs(manifestsAt(ROOT_DIR)), ...MONEY_SERVICES])].sort();
  assert.deepEqual(map.money, want);
  // apps/customer reaches ledger-client only through other packages (consumers follows dependencies through packages),
  // so it is not money code by the definition; its money journeys run through the money services it calls.
  const customer = JSON.parse(readFileSync(join(ROOT_DIR, 'apps/customer/package.json'), 'utf8'));
  const direct = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(
    (k) => customer[k] && Object.hasOwn(customer[k], '@intafaced/ledger-client'),
  );
  assert.equal(
    map.money.includes('apps/customer'),
    direct,
    'apps/customer is money code exactly when it depends on ledger-client directly',
  );
});

test('planted: verify reads the workspace inputs from the checkout it is given, so a pull request adding a money package holds its own map (B1, #7724)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reach-ws-'));
  try {
    const pkg = (d, name, deps = {}) => {
      mkdirSync(join(dir, d, 'src'), { recursive: true });
      writeFileSync(join(dir, d, 'package.json'), JSON.stringify({ name, dependencies: deps }));
      writeFileSync(join(dir, d, 'src/index.ts'), 'export {};\n');
    };
    pkg('packages/ledger-client', '@intafaced/ledger-client');
    pkg('packages/venue-new', '@intafaced/venue-new', { '@intafaced/ledger-client': 'workspace:*' });
    pkg('services/svc-new', '@intafaced/svc-new', { '@intafaced/venue-new': 'workspace:*' });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const pr = workspaceInputs(dir);
    assert.ok(pr.money.includes('packages/venue-new'), 'the given checkout’s new money package is in its money list');
    assert.ok(pr.services.has('services/svc-new'));
    assert.deepEqual(pr.dependents['packages/ledger-client']?.includes('packages/venue-new'), true);
    // The default (this checkout) does not see it: reading the base's workspaces was the bug.
    assert.equal(workspaceInputs().money.includes('packages/venue-new'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The verify command passes `--workspace` through to the build it compares against.
  const src = readFileSync(join(ROOT_DIR, 'tooling/ci/journey-reach-map.mjs'), 'utf8');
  assert.match(src, /opt\('--workspace'\)/);
  assert.match(src, /buildFromMain\(\{ until, root \}\)/);
  assert.match(src, /const inputs = workspaceInputs\(root\);/, 'the build reads its workspace inputs from the root it is given');
});

// ---- The map main's map workflow built, instead of a committed copy nobody refreshes (the OG, project-state#1574, 23:51 UTC 9 Nov) ----

const mapRun = (id, created, over = {}) => ({
  id,
  status: 'completed',
  conclusion: 'success',
  head_branch: 'main',
  event: 'workflow_run',
  path: '.github/workflows/journey-reach-map.yml',
  created_at: created,
  head_repository: { full_name: REPO },
  ...over,
});

test('mapBuild: the newest verified build from main, created no later than the journeys run', () => {
  const runs = [
    mapRun(1, '2026-11-09T15:00:00Z'),
    mapRun(2, '2026-11-09T18:00:00Z'),
    mapRun(3, '2026-11-09T23:00:00Z'),
    mapRun(4, '2026-11-09T19:00:00Z', { conclusion: 'failure' }), // its verify step failed
    mapRun(5, '2026-11-09T20:00:00Z', { head_branch: 'u4/x', event: 'workflow_dispatch' }), // another branch's builder
    mapRun(8, '2026-11-09T23:30:00Z', { event: 'workflow_dispatch' }), // a dispatch runs whatever ref it names (a tag called main)
    mapRun(6, '2026-11-09T21:00:00Z', { head_repository: { full_name: 'someone/fork' } }),
    mapRun(7, '2026-11-09T22:00:00Z', { path: '.github/workflows/other.yml' }),
  ];
  assert.equal(mapBuild(runs, { repo: REPO })?.id, 3);
  assert.equal(mapBuild(runs, { before: Date.parse('2026-11-09T22:30:00Z'), repo: REPO })?.id, 2);
  assert.equal(mapBuild(runs, { before: Date.parse('2026-11-09T14:00:00Z'), repo: REPO }), null);
  assert.equal(mapBuild(null), null);
});

test('newerMap: the built map when it is usable and newer than the committed one, else the committed one', () => {
  const older = build(RUNS.slice(1).concat([run(0, '2026-11-08T12:00:00Z')]));
  assert.equal(newerMap(MAP, older), MAP);
  assert.equal(newerMap(older, MAP), MAP);
  assert.equal(newerMap(null, MAP), MAP);
  assert.equal(newerMap({ ...MAP, mode: 'full' }, older), older);
  assert.equal(newerMap({ ...MAP, v: 99 }, older), older);
  assert.equal(newerMap(MAP, null), MAP);
});

test('builtMap: reads the build’s artifact; any failed read is null, so the committed map stays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'built-map-test-'));
  try {
    writeFileSync(join(dir, 'journey-reach-map.json'), mapText(MAP));
    execFileSync('zip', ['-q', 'a.zip', 'journey-reach-map.json'], { cwd: dir });
    const zip = readFileSync(join(dir, 'a.zip'));
    const asked = [];
    const get = async (path) => {
      asked.push(path);
      if (path.includes('/workflows/journey-reach-map.yml/runs')) return { workflow_runs: [mapRun(3, '2026-11-09T23:00:00Z')] };
      if (path.endsWith('/runs/3/artifacts?name=journey-reach-map'))
        return { artifacts: [{ id: 77, name: 'journey-reach-map', expired: false }] };
      throw new Error(`unexpected ${path}`);
    };
    const got = await builtMap({ get, raw: async (path) => (path.endsWith('/artifacts/77/zip') ? zip : null), repo: REPO });
    assert.deepEqual(got, MAP);
    assert.match(asked[0], /branch=main&status=success/);
    assert.equal(await builtMap({ get: async () => Promise.reject(new Error('HTTP 502')), raw: async () => zip, repo: REPO }), null);
    const expired = async (path) =>
      path.includes('/artifacts?') ? { artifacts: [{ id: 77, name: 'journey-reach-map', expired: true }] } : get(path);
    assert.equal(await builtMap({ get: expired, raw: async () => zip, repo: REPO }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planted: a committed map too old to read makes a one-service change full; the fresh build narrows it, and the seal picks the build the run chose', async () => {
  const files = ['services/svc-tax/src/rates.ts'];
  // The case of 9 Nov: main's newest 100 runs don't reach back to the committed map's newest run, so its age is unknown.
  const tooOld = { ...MAP, runs: MAP.runs.map((r) => ({ ...r, created: '2026-11-01T00:00:00Z' })) };
  const mainRuns = [
    ghRun(4, { created_at: '2026-11-08T16:00:00Z', head_branch: 'main', event: 'push' }),
    ghRun(3, { created_at: '2026-11-08T15:00:00Z', head_branch: 'main', event: 'push' }),
  ];
  const behindOf = (m) => runsBehind(m, mainRuns, REPO);
  assert.equal(behindOf(tooOld), null);
  assert.equal(select(files, { map: tooOld, behind: behindOf(tooOld) }).mode, 'full');
  const fresh = newerMap(MAP, tooOld);
  assert.equal(fresh, MAP);
  assert.deepEqual(select(files, { map: fresh, behind: behindOf(fresh) }).files, [POPUP, TAX]);
  // The seal asks for the build no later than the head's newest journeys run, and holds the run to what it selects.
  let asked;
  const sealed = await sealPull({
    repo: REPO,
    number: 9,
    sha: HEAD,
    io: {
      pull: async () => ({ state: 'open', head: { sha: HEAD }, base: { sha: 'b'.repeat(40) }, title: 'svc-tax: rates', body: '' }),
      runs: async () => [ghRun(1, { created_at: '2026-11-08T17:00:00Z' }), ghRun(2, { created_at: '2026-11-08T17:30:00Z' })],
      reportOf: async () => ({ states: {}, ran: [POPUP, TAX] }),
      files: async () => files,
      text: async () => '',
      verdictOf: async () => clean,
      reachMap: async (before) => {
        asked = before;
        return fresh;
      },
      mainRuns: async () => mainRuns,
      journeyFiles: async () => FILES,
      reachMode: 'reach',
    },
  });
  assert.equal(asked, Date.parse('2026-11-08T17:30:00Z'));
  assert.equal(sealed.ok, true, sealed.lines.join('\n'));
});
