import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyse,
  buildIndex,
  buildJourneys,
  dependsOn,
  journeyOrder,
  keepParkedNeeds,
  laneFor,
  liveJourneys,
  parkedJourneys,
  parseJourneys,
  parseSpec,
  passedSteps,
  progress,
  queue,
  render,
  untangle,
} from './roadmap.mjs';

test('a slice heading and its table rows are read', () => {
  const text = [
    '### SP-order-entry-02. Market order sizing by value',
    '',
    '| | |',
    '|---|---|',
    '| IDs | `cex-spot-order-entry-001` Market order (thin, core) |',
    '| Depends | `SP-order-entry-01` (typed body). Blocks `SP-conditional-algo-01`. |',
    '| Size | M |',
  ].join('\n');
  const [slice] = parseSpec(text, 'cex-spot', 'spot-order-entry', 'modules/cex-spot/specs/spot-order-entry.md');
  assert.equal(slice.id, 'SP-order-entry-02');
  assert.equal(slice.fields.Size, 'M');
  assert.match(slice.fields.Depends, /typed body/);
});

test('only what a slice needs counts as a dependency, not what it unblocks', () => {
  const known = new Set(['SP-order-entry-01', 'SP-order-entry-02', 'SP-conditional-algo-01']);
  assert.deepEqual(dependsOn('`SP-order-entry-01` (typed body). Blocks `SP-conditional-algo-01`.', known, 'SP-order-entry-02'), [
    'SP-order-entry-01',
  ]);
  assert.deepEqual(dependsOn('None. First slice of the group. Blocks `SP-order-entry-02`.', known, 'SP-order-entry-01'), []);
});

test('"slice 03" means slice 03 of the same group, "slice xfer-07" a slice of the same module; "not needed" is not a dependency', () => {
  const known = new Set(['I-signin-sessions-01', 'I-signin-sessions-03', 'I-signin-sessions-04', 'I-signin-sessions-05']);
  assert.deepEqual(dependsOn('Slice 03 for reset wiring.', known, 'I-signin-sessions-04'), ['I-signin-sessions-03']);
  assert.deepEqual(dependsOn('Slice 01 not needed (sign-out is not guarded).', known, 'I-signin-sessions-05'), []);
  assert.deepEqual(dependsOn('None; uses the flows table also needed by slices 19 and 20.', known, 'I-signin-sessions-03'), []);
  const bank = new Set(['BK-xfer-04', 'BK-xfer-07']);
  assert.deepEqual(dependsOn('`rail.bank`. Slice xfer-07 for proof and linking.', bank, 'BK-xfer-04'), ['BK-xfer-07']);
});

test('a slice is built in its back-end service lane, split where one service serves two modules', () => {
  const base = { packages: [], areas: [], apps: ['customer'] };
  assert.equal(laneFor({ ...base, module: 'cex-spot', services: ['svc-trade'] }), 'svc-trade spot');
  assert.equal(laneFor({ ...base, module: 'derivatives', services: ['svc-trade'] }), 'svc-trade futures');
  assert.equal(laneFor({ ...base, module: 'wallet', services: ['svc-pay'] }), 'svc-pay wallet');
  assert.equal(laneFor({ ...base, module: 'merchant', services: ['svc-ledger', 'svc-pay'] }), 'svc-pay merchant');
  assert.equal(laneFor({ ...base, module: 'bank', services: ['svc-ledger'] }), 'ledger');
  assert.equal(laneFor({ ...base, module: 'home-ia', services: [], areas: ['customer: home'] }), 'customer: home');
});

test('slices that need nothing come first; slices in a loop are found, not guessed', () => {
  const slices = [
    { id: 'A-x-01', module: 'm', depends: [] },
    { id: 'A-x-02', module: 'm', depends: ['A-x-01'] },
    { id: 'A-x-03', module: 'm', depends: ['A-x-04'] },
    { id: 'A-x-04', module: 'm', depends: ['A-x-03'] },
  ];
  const analysis = analyse(slices);
  assert.deepEqual([...analysis.tangled].sort(), ['A-x-03', 'A-x-04']);
  assert.equal(analysis.depth.get('A-x-02'), 2);
  assert.equal(queue(slices, analysis)[0].id, 'A-x-01');
});

test('progress counts PRs per slice, excludes reverts, and gives 3-hour and 7-day rates', () => {
  const slices = [
    { id: 'SP-x-01', lane: 'svc-trade spot' },
    { id: 'SP-x-02', lane: 'svc-trade spot' },
    { id: 'BK-y-01', lane: 'svc-bank' },
    { id: 'BK-y-02', lane: 'svc-bank' },
  ];
  const page = progress(
    slices,
    [
      { at: '2026-10-20T11:00:00Z', subject: 'svc-trade: SP-x-02 limit order, part 2 (#4)' },
      { at: '2026-10-20T10:30:00Z', subject: 'Revert "svc-bank: BK-y-02 statements (#3)"' },
      { at: '2026-10-20T07:00:00Z', subject: 'svc-trade: SP-x-02 limit order, part 1 (#2)' },
      { at: '2026-10-19T12:00:00Z', subject: 'svc-trade: SP-x-01 market order (#1)' },
      { at: '2026-10-01T12:00:00Z', subject: 'svc-bank: BK-y-01 accounts (#0)' },
      { at: '2026-10-20T11:30:00Z', subject: 'svc-bank: tidy, mentions NOPE-z-01' },
    ],
    '2026-10-20T12:00:00Z',
  );
  assert.match(page, /Started \(named in at least one merged PR\): 3 of 4 slices\. Not started: 1\./);
  assert.match(page, /PRs per started slice: 1\.3 on average; 2 have one PR, 1 two, 0 three or more\./);
  assert.match(page, /Last 3 hours: 1 PR, 0 slices started \(8\.0 PRs a day\)\./);
  assert.match(page, /Last 7 days: 3 PRs, 2 slices started \(0\.4 PRs a day\)\./);
  assert.match(page, /Forecast at the 3-hour pace: about 1 day for the 1 unstarted slice at 2\.0 PRs each/);
  assert.match(page, /\| svc-trade spot \| 2 \| 2 \| 3 \|/);
});

test('progress counts the first named merge when tracking began under 7 days ago', () => {
  const slices = [
    { id: 'SP-x-01', lane: 'svc-trade spot' },
    { id: 'SP-x-02', lane: 'svc-trade spot' },
  ];
  const commits = [
    { at: '2026-10-20T08:00:00Z', subject: 'svc-trade: SP-x-01 market order, part 2 (#2)' },
    { at: '2026-10-20T07:00:00Z', subject: 'svc-trade: SP-x-01 market order, part 1 (#1)' },
  ];
  const page = progress(slices, commits, '2026-10-20T12:00:00Z');
  assert.match(page, /Last 5 hours \(since the first named merge\): 2 PRs, 1 slice started \(9\.6 PRs a day\)\./);
  assert.match(page, /Forecast at the 5-hour pace: about 1 day for the 1 unstarted slice/);
  const fresh = progress(slices, commits, '2026-10-20T09:00:00Z');
  assert.match(fresh, /Last 3 hours: 2 PRs, 1 slice started/);
  assert.doesNotMatch(fresh, /since the first named merge/);
});

test('a lane override beats the computed lane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-'));
  mkdirSync(join(dir, 'modules', 'wallet', 'specs'), { recursive: true });
  const spec = (id) => [`### ${id}. Something`, '', '| | |', '|---|---|', '| Module | nothing that names a service |', '| Size | S |', ''];
  writeFileSync(join(dir, 'modules', 'wallet', 'specs', 'w.md'), [...spec('W-x-01'), ...spec('W-x-02')].join('\n'));
  const lanes = Object.fromEntries(buildIndex(dir, { 'W-x-02': 'svc-bank' }).map((s) => [s.id, s.lane]));
  assert.equal(lanes['W-x-02'], 'svc-bank');
  assert.notEqual(lanes['W-x-01'], 'svc-bank');
});

test('two slices that each need the other: the earlier one goes first, and its edge moves to later', () => {
  const out = untangle([
    { id: 'Q-a-01', spec: 's.md', depends: ['Q-a-02'] },
    { id: 'Q-a-02', spec: 's.md', depends: ['Q-a-01'] },
    { id: 'T-b-01', spec: 't.md', depends: ['Q-a-01', 'U-c-01'] },
    { id: 'U-c-01', spec: 'u.md', depends: ['T-b-01'] },
  ]);
  const by = Object.fromEntries(out.map((s) => [s.id, s]));
  assert.deepEqual(by['Q-a-01'].depends, []);
  assert.deepEqual(by['Q-a-01'].later, ['Q-a-02']);
  assert.deepEqual(by['Q-a-02'].depends, ['Q-a-01']);
  assert.deepEqual(by['U-c-01'].depends, [], 'fewer dependencies goes first across specs');
  assert.deepEqual(by['T-b-01'].depends, ['Q-a-01', 'U-c-01']);
  assert.equal(analyse(out).tangled.size, 0);
});

const JOURNEY = [
  '# Cex-spot journeys',
  '',
  '## J-cex-spot-01: I sign up and trade',
  '- Persona: pro-trader',
  '- Tier: core',
  '- Order: 1',
  '- Starts: a visitor',
  '',
  '| # | The person does | They see | Slices | Proof today |',
  '| - | - | - | - | - |',
  '| 1 | Signs up | An account | I-kyc-compliance-06 | trade-onboarding.journey.ts (API) |',
  '| 2 | Places a limit buy | It rests | SP-order-entry-01, SP-lifecycle-history-01 | none |',
  '| 3 | Shares the order | A link | NO-SLICE | none |',
  '',
  '## J-cex-spot-02: I retry safely',
  '- Persona: pro-trader',
  '- Order: 2',
  '',
  '| # | The person does | They see | Slices | Proof today |',
  '| - | - | - | - | - |',
  '| 1 | Presses twice | One order | SP-order-entry-01 | none |',
  '',
  '## Coverage',
  '- Slices in no journey: SP-order-03: acceptance only',
].join('\n');

test('a journey map is read: fields, steps, slice ids and NO-SLICE; the Coverage section is not a journey', () => {
  const journeys = parseJourneys(JOURNEY, 'cex-spot');
  assert.deepEqual(
    journeys.map((j) => [j.id, j.persona, j.order, j.steps.length]),
    [
      ['J-cex-spot-01', 'pro-trader', 1, 3],
      ['J-cex-spot-02', 'pro-trader', 2, 1],
    ],
  );
  assert.deepEqual(journeys[0].steps[1].slices, ['SP-order-entry-01', 'SP-lifecycle-history-01']);
  assert.equal(journeys[0].steps[2].noSlice, true);
  assert.deepEqual(journeys[0].steps[2].slices, []);
  const order = journeyOrder(journeys);
  assert.equal(order.get('SP-order-entry-01'), 1, 'the lowest Order of the journeys that need it');
  assert.equal(order.has('SP-order-03'), false);
});

test('a lane queue takes slices of a first usable journey before others that are equally ready', () => {
  const slices = [
    { id: 'A-x-01', module: 'm', depends: [], order: 0 },
    { id: 'A-x-02', module: 'm', depends: [], order: 2 },
    { id: 'A-x-03', module: 'm', depends: [], order: 1 },
  ];
  assert.deepEqual(
    queue(slices, analyse(slices)).map((s) => s.id),
    ['A-x-03', 'A-x-02', 'A-x-01'],
  );
});

test('two specs giving one id to different slices fail the index instead of dropping one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-'));
  for (const m of ['cex-spot', 'support-public']) {
    mkdirSync(join(dir, 'modules', m, 'specs'), { recursive: true });
    writeFileSync(join(dir, 'modules', m, 'specs', `${m}.md`), `### SP-order-01. Something in ${m}\n\n| Size | S |\n`);
  }
  assert.throws(() => buildIndex(dir, {}), /SP-order-01 is used in both/);
});

test('the scoreboard counts a journey once every step passed in the real-app report', () => {
  const journeys = parseJourneys(JOURNEY, 'cex-spot');
  const ok = { tests: [{ status: 'expected' }] };
  const report = {
    suites: [
      {
        specs: [
          { title: 'J-cex-spot-01 #1 signs up', ok: true, ...ok },
          { title: 'J-cex-spot-01 #2 places a limit buy', ok: true, ...ok },
          { title: 'J-cex-spot-01 #3 shares the order', ok: false, tests: [{ status: 'unexpected' }] },
        ],
        suites: [{ specs: [{ title: 'J-cex-spot-02 #1 presses twice', ok: true, tests: [{ status: 'flaky' }] }] }],
      },
    ],
  };
  const passed = passedSteps(report);
  assert.deepEqual([...passed].sort(), ['J-cex-spot-01#1', 'J-cex-spot-01#2', 'J-cex-spot-02#1']);
  const slices = [{ id: 'SP-order-entry-01', lane: 'svc-trade spot' }];
  const commits = [{ at: '2026-10-20T08:00:00Z', subject: 'svc-trade: SP-order-entry-01 (#1)' }];
  const page = progress(slices, commits, '2026-10-20T09:00:00Z', journeys, passed);
  assert.match(page, /Passing in the real app on main: 1 of 2 journeys \(3 of 4 steps\)\. Order 1: 0 of 1\./);
  assert.match(page, /ready to prove, builders' claim\): 1 of 2 journeys/);
  assert.match(progress(slices, commits, '2026-10-20T09:00:00Z', journeys, null), /not measured/);
});

test('a deferred journey or step leaves the scoreboard and the slice order', () => {
  const text = JOURNEY.replace('- Order: 2', '- Order: 2\n- Deferred: until launch prep').replace(
    '| 3 | Shares the order | A link | NO-SLICE |',
    '| 3 | Shares the order | A link | DEFERRED until launch prep (was SP-share-01) |',
  );
  const journeys = parseJourneys(text, 'cex-spot');
  assert.equal(journeys[1].deferred, true);
  assert.equal(journeys[0].steps[2].deferred, true);
  assert.equal(journeys[0].deferred, undefined);
  assert.throws(() => parseJourneys(JOURNEY.replace('- Order: 2', '- Order: 2\n- Deferred: no'), 'cex-spot'), /Deferred: no/);
  assert.equal(journeyOrder(journeys).has('SP-share-01'), false);
  assert.equal(journeyOrder(journeys).get('SP-order-entry-01'), 1, 'still needed by the live first journey');
  const passed = new Set(['J-cex-spot-01#1', 'J-cex-spot-01#2']);
  const page = progress([], [], '2026-10-20T09:00:00Z', journeys, passed);
  assert.match(page, /Passing in the real app on main: 1 of 1 journeys \(2 of 2 steps\)\. Order 1: 1 of 1\./);
  assert.match(page, /Deferred \(launch prep, or set aside by an owner decision\) and not counted: 1 journey and 2 steps\./);
});

test('a parked journey or step stays in the map, leaves the count and the slice order, and comes back unparked (OWNER 183)', () => {
  const text = JOURNEY.replace('- Order: 2', '- Order: 2\n- Parked: until after launch (OWNER 183 (2): the mining pool)').replace(
    '| 2 | Places a limit buy | It rests | SP-order-entry-01, SP-lifecycle-history-01 | none |',
    '| 2 | Places a limit buy | It rests | PARKED until after launch (OWNER 183; was SP-order-entry-01, SP-lifecycle-history-01) | none |',
  );
  const journeys = parseJourneys(text, 'cex-spot');
  assert.equal(journeys.length, 2, 'parked journeys stay in the map');
  assert.equal(journeys[1].parked, true);
  assert.equal(journeys[1].parkedUntil, 'after launch (OWNER 183 (2): the mining pool)');
  assert.equal(journeys[0].steps[1].parked, true);
  assert.equal(journeys[0].steps[1].parkedUntil, 'after launch (OWNER 183)');
  assert.deepEqual(
    journeys[0].steps[1].slices,
    ['SP-order-entry-01', 'SP-lifecycle-history-01'],
    'a parked step keeps its slices (money rule)',
  );
  assert.deepEqual(
    liveJourneys(journeys).map((j) => [j.id, j.steps.map((st) => st.n)]),
    [['J-cex-spot-01', [1, 3]]],
  );
  const order = journeyOrder(journeys);
  assert.equal(order.has('SP-lifecycle-history-01'), false, 'a slice only a parked step names leaves the order');
  assert.equal(order.has('SP-order-entry-01'), false);
  const parked = parkedJourneys(journeys);
  assert.deepEqual(
    parked.whole.map((j) => j.id),
    ['J-cex-spot-02'],
  );
  assert.deepEqual(
    parked.steps.map(({ j, st }) => `${j.id}#${st.n}`),
    ['J-cex-spot-01#2'],
  );
  const page = progress([], [], '2026-10-20T09:00:00Z', journeys, new Set(['J-cex-spot-01#1', 'J-cex-spot-01#3']));
  assert.match(page, /Passing in the real app on main: 1 of 1 journeys \(2 of 2 steps\)\./);
  assert.match(page, /Parked by the owner \(OWNER 183\) and not counted: 1 whole journey and 2 steps\./);
  assert.doesNotMatch(page, /Deferred/);
  const map = render([], journeys);
  assert.match(map, /### Parked/);
  assert.match(map, /J-cex-spot-02 I retry safely \| whole journey \| after launch/);
  assert.match(map, /J-cex-spot-01 I sign up and trade \| steps #2 \| after launch \(OWNER 183\)/);
  // Unparked: the same map without the marks is all live again.
  assert.deepEqual(
    liveJourneys(parseJourneys(JOURNEY, 'cex-spot')).map((j) => j.steps.length),
    [3, 1],
  );
  assert.doesNotMatch(render([], parseJourneys(JOURNEY, 'cex-spot')), /### Parked/);
  // A live step that still names the slice keeps it in the order: a capability another journey needs is never parked.
  const keep = journeys.map((j) => (j.id === 'J-cex-spot-02' ? { ...j, parked: undefined } : j));
  assert.equal(journeyOrder(keep).get('SP-order-entry-01'), 2);
  assert.throws(() => parseJourneys(JOURNEY.replace('- Order: 2', '- Order: 2\n- Parked: maybe'), 'cex-spot'), /Parked: until <when>/);
  assert.throws(
    () =>
      parseJourneys(
        JOURNEY.replace('| 3 | Shares the order | A link | NO-SLICE |', '| 3 | Shares the order | A link | PARKED |'),
        'cex-spot',
      ),
    /PARKED with no "until <when>"/,
  );
});

test('a slice only parked steps name keeps the order of a live slice that needs it (OWNER 183: needed capabilities stay)', () => {
  const journeys = [
    { id: 'J-a-01', order: 1, steps: [{ n: 1, slices: ['A-live-01'] }] },
    { id: 'J-a-02', order: 3, parked: true, steps: [{ n: 1, slices: ['A-parked-01', 'A-parked-02', 'A-parked-03'] }] },
  ];
  const slices = [
    { id: 'A-live-01', order: 1, depends: ['A-parked-01'] },
    { id: 'A-parked-01', order: 0, depends: ['A-parked-02'] },
    { id: 'A-parked-02', order: 0, depends: [] },
    { id: 'A-parked-03', order: 0, depends: [] },
  ];
  const kept = new Map(keepParkedNeeds(slices, journeys).map((s) => [s.id, s]));
  assert.equal(kept.get('A-parked-01').order, 1);
  assert.deepEqual(kept.get('A-parked-01').keptFor, ['A-live-01']);
  assert.equal(kept.get('A-parked-02').order, 1, 'through another parked slice');
  assert.deepEqual(kept.get('A-parked-02').keptFor, ['A-parked-01']);
  assert.equal(kept.get('A-parked-03').order, 0, 'a parked slice no live slice needs stays parked');
  assert.equal(kept.get('A-parked-03').keptFor, undefined);
  // Unparked, the journey's own order applies and nothing is marked kept.
  assert.equal(keepParkedNeeds(slices, [journeys[0], { ...journeys[1], parked: undefined }]), slices);
});

test('needed slices are kept through a slice no journey names, and for a live journey with no Order (review of #7197)', () => {
  const journeys = [
    { id: 'J-a-01', order: 1, steps: [{ n: 1, slices: ['A-live-01'] }] },
    { id: 'J-a-03', order: 0, steps: [{ n: 1, slices: ['A-live-02'] }] },
    { id: 'J-a-02', order: 3, parked: true, steps: [{ n: 1, slices: ['A-parked-01', 'A-parked-02'] }] },
  ];
  const slices = [
    { id: 'A-live-01', order: 1, depends: ['A-free-01'] },
    { id: 'A-free-01', order: 0, depends: ['A-parked-01'] },
    { id: 'A-live-02', order: 0, depends: ['A-parked-02'] },
    { id: 'A-parked-01', order: 0, depends: [] },
    { id: 'A-parked-02', order: 0, depends: [] },
  ];
  const kept = new Map(keepParkedNeeds(slices, journeys).map((s) => [s.id, s]));
  assert.equal(kept.get('A-parked-01').order, 1, 'through A-free-01, which no journey names');
  assert.deepEqual(kept.get('A-parked-01').keptFor, ['A-free-01']);
  assert.equal(kept.get('A-free-01').keptFor, undefined, 'only parked-only slices are marked');
  assert.deepEqual(kept.get('A-parked-02').keptFor, ['A-live-02'], 'kept for a live journey with no Order');
  assert.equal(kept.get('A-parked-02').order, 0, 'no order to give, but marked kept');
});

test('a journey whose every step is parked one by one counts as parked, and the counts add up', () => {
  const journeys = parseJourneys(
    JOURNEY.replace(
      '| 1 | Presses twice | One order | SP-order-entry-01 | none |',
      '| 1 | Presses twice | One order | PARKED until after launch (OWNER 183; was SP-order-entry-01) | none |',
    ).replace(
      '| 3 | Shares the order | A link | NO-SLICE | none |',
      '| 3 | Shares the order | A link | DEFERRED until launch prep (was SP-share-01) | none |',
    ),
    'cex-spot',
  );
  const parked = parkedJourneys(journeys);
  assert.deepEqual(
    parked.whole.map((j) => j.id),
    ['J-cex-spot-02'],
  );
  assert.equal(parked.stepCount, 1);
  const page = progress([], [], '2026-10-20T09:00:00Z', journeys, null);
  assert.match(page, /1 journeys, 2 steps\./);
  assert.match(page, /Deferred \(launch prep, or set aside by an owner decision\) and not counted: 0 journeys and 1 step\./);
  assert.match(page, /Parked by the owner \(OWNER 183\) and not counted: 1 whole journey and 1 step\./);
  assert.match(render([], journeys), /J-cex-spot-02 I retry safely \| whole journey \| after launch \(OWNER 183\)/);
});

test('a skipped step, a step with no tests, or a failing duplicate title does not pass', () => {
  const passed = passedSteps({
    suites: [
      {
        specs: [
          { title: 'J-a-01 #1 skipped', ok: true, tests: [{ status: 'skipped' }] },
          { title: 'J-a-01 #2 no tests', ok: true, tests: [] },
          { title: 'J-a-01 #3 passes', ok: true, tests: [{ status: 'expected' }] },
          { title: 'J-a-01 #3 same step, fails', ok: false, tests: [{ status: 'unexpected' }] },
          { title: 'J-a-01 #4 passes', ok: true, tests: [{ status: 'expected' }] },
        ],
      },
    ],
  });
  assert.deepEqual([...passed], ['J-a-01#4']);
});

test('a step whose Slices cell is empty counts as NO-SLICE; a journey id used twice fails the index', () => {
  const [j] = parseJourneys(['## J-a-01: x', '- Order: 1', '| 1 | does | sees |  | none |'].join('\n'), 'a');
  assert.equal(j.steps[0].noSlice, true);
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-'));
  for (const m of ['a', 'b']) {
    mkdirSync(join(dir, 'modules', m, 'acceptance'), { recursive: true });
    writeFileSync(join(dir, 'modules', m, 'acceptance', 'journeys.md'), '## J-a-01: x\n- Order: 1\n');
  }
  assert.throws(() => buildJourneys(dir), /journey id J-a-01 is used twice/);
});
