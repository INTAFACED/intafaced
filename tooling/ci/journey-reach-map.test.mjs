// node --test tooling/ci/journey-reach-map.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MONEY_SERVICES,
  MIN_RUNS,
  REACH_MAP_MODE,
  reportTests,
  speaksFor,
  unbuiltSteps,
  STALE_RUNS,
  buildMap,
  candidates,
  dependentPackages,
  harnessImports,
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
import { journeyTouch } from './journey-touch.mjs';
import { JOURNEYS_WORKFLOW, sealPull } from './journey-seal.mjs';
import { manifestsAt, moneyCodeDirs } from './journey-verdict.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  for (const p of [...(map.harness ?? []), ...(map.subscribers ?? []), ...(map.money ?? [])]) assert.match(p, PATH);
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
