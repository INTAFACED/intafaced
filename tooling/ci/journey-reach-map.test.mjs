// node --test tooling/ci/journey-reach-map.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MIN_RUNS,
  REACH_MAP_MODE,
  reportUnclean,
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
  assert.equal(journeyTouch(['services/svc-tax/src/rates.ts'], () => true, { ...reach, mode: undefined }).mode, 'full', 'shipped off');
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
  // Planted: TAX fails in every run, so no run speaks for it, and it runs with every change.
  const allFailed = build(
    [3, 2, 1].map((id) =>
      run(id, `2026-11-08T1${id + 2}:00:00Z`, [...records().filter((r) => r.file !== TAX), short], FILES, new Set([TAX])),
    ),
  );
  assert.match(allFailed.full[TAX], /no run the map is built from passed every one of its tests/);
  const sel = reachSelect({ map: allFailed, paths: ['services/svc-support/src/x.ts'], behind: 0, atHead: FILES, mode: 'reach' });
  assert.deepEqual(sel.files, [BOTH, POPUP, TAX], 'an unproven journey joins every selection');
  // A test with no result, or whose last result is skipped or timedOut, is not clean.
  const r = report(records(), [...FILES]);
  r.suites[0].specs[0].tests[0].results[0].status = 'timedOut';
  r.suites[1].specs[0].tests[0].results = [];
  assert.deepEqual([...reportUnclean(r)].sort(), [BANK, TAX].sort());
});

test('planted: money code never narrows (the CI review on b26447ca)', () => {
  assert.deepEqual(MAP.money, ['packages/ledger-client', 'services/svc-ledger', 'services/svc-ops'], 'svc-ledger always');
  for (const p of ['services/svc-ledger/src/post.ts', 'services/svc-ops/src/x.ts', 'packages/ledger-client/src/recipes.ts']) {
    const r = select([p]);
    assert.equal(r.mode, 'full', p);
    assert.match(r.why, /money code, which always runs the full suite/);
  }
  const dep = select(['packages/money-util/src/x.ts']);
  assert.equal(dep.mode, 'full');
  assert.match(dep.why, /money code depends on packages\/money-util/);
  // A map with no money list can't say what is money: everything is full.
  const { money, ...bare } = MAP;
  assert.ok(money);
  assert.match(select(['services/svc-tax/src/rates.ts'], { map: bare }).why, /lists no money code/);
  // Mixed with a narrowable path, the money path keeps the whole change full.
  assert.equal(select(['services/svc-tax/src/rates.ts', 'services/svc-ledger/src/post.ts']).mode, 'full');
});

test('planted: a package only a money package depends on never narrows (review 7561-R2)', () => {
  // packages/fee-math is used only by packages/wallet-kit, a money package; consumersOf reaches svc-tax through it, and
  // svc-tax is not money code, so without the dependents list the change would narrow to svc-tax's journeys.
  const over = {
    consumers: { ...CONSUMERS, 'packages/fee-math': ['services/svc-tax'] },
    dependents: { ...DEPENDENTS, 'packages/fee-math': ['packages/wallet-kit'] },
    money: ['packages/ledger-client', 'packages/wallet-kit', 'services/svc-ops'],
  };
  const map = build(RUNS, over);
  const r = select(['packages/fee-math/src/round.ts'], { map });
  assert.equal(r.mode, 'full', JSON.stringify(r));
  assert.match(r.why, /money code \(packages\/wallet-kit\) depends on packages\/fee-math/);
  // The fault it closes: the same package under a package that is not money narrows to svc-tax's journeys.
  const plain = build(RUNS, { ...over, dependents: { ...DEPENDENTS, 'packages/fee-math': ['packages/other'] } });
  assert.deepEqual(
    select(['packages/fee-math/src/round.ts'], { map: plain }).files,
    [POPUP, TAX].sort(),
    'its journeys, and the one the map cannot speak for',
  );
  // A map without the list can't tell: every package path is full, and a service path still narrows.
  const { dependents, ...bare } = plain;
  assert.ok(dependents);
  assert.match(select(['packages/fee-math/src/round.ts'], { map: bare }).why, /does not list which packages depend/);
  assert.match(select(['packages/market-data/src/x.ts'], { map: bare }).why, /does not list which packages depend/);
  assert.equal(select(['services/svc-tax/src/rates.ts'], { map: bare }).mode, 'files');
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
  assert.equal(REACH_MAP_MODE, 'full', 'off in this commit: narrowing turns on only in a reviewed code change');
  assert.equal(
    reachSelect({ map: MAP, paths: ['services/svc-tax/src/rates.ts'], behind: 0, atHead: FILES }).mode,
    'full',
    'the default is off',
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
  const PATH = /^(apps|packages|services)\/[A-Za-z0-9._@/-]+$/;
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
