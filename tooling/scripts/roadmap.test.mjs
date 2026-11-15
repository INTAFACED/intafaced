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
  finishLine,
  finishLineProblems,
  journeyOrder,
  keepParkedNeeds,
  laneFor,
  liveJourneys,
  isLaterStep,
  isLaterJourney,
  pullLaterDepsForward,
  finishLineLines,
  parkedJourneys,
  parseJourneys,
  sliceIdCandidates,
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
        suites: [{ specs: [{ title: 'J-cex-spot-02 #1 presses twice', ok: true, tests: [{ status: 'expected' }] }] }],
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

test('a step names upper-case and one-segment slice ids (OPS-ORD-01, LOAN-03), and only ids that are a slice heading', () => {
  const text = [
    '## J-a-01: x',
    '- Order: 1',
    '| 1 | does | sees | OPS-ORD-01 | none |',
    '| 2 | does | sees | LOAN-03, CS-orders-02 | none |',
    // Requirement ids share the shape (TRD-0082, ORD-001); with the headings known they are not slices.
    '| 3 | does | sees | TRD-0082 ORD-001 | none |',
    '| 4 | does | sees | NO-SLICE | none |',
  ].join('\n');
  const known = new Set(['OPS-ORD-01', 'LOAN-03', 'CS-orders-02']);
  const [j] = parseJourneys(text, 'a', known);
  assert.deepEqual(
    j.steps.map((s) => [s.n, s.slices, s.noSlice]),
    [
      [1, ['OPS-ORD-01'], false],
      [2, ['LOAN-03', 'CS-orders-02'], false],
      [3, [], true],
      [4, [], true],
    ],
  );
  // From a spec folder: buildJourneys knows the slices from the spec headings.
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-'));
  mkdirSync(join(dir, 'modules', 'a', 'acceptance'), { recursive: true });
  mkdirSync(join(dir, 'modules', 'a', 'specs'), { recursive: true });
  writeFileSync(join(dir, 'modules', 'a', 'acceptance', 'journeys.md'), text);
  writeFileSync(join(dir, 'modules', 'a', 'specs', 'a-ops.md'), '### OPS-ORD-01. One\n\n### LOAN-03. Two\n');
  const [built] = buildJourneys(dir);
  assert.deepEqual(
    built.steps.map((s) => s.slices),
    [['OPS-ORD-01'], ['LOAN-03'], [], []],
  );
});

test('a joined range names both slices; an id may touch `_`; a requirement id inside an id is not a slice', () => {
  assert.deepEqual(
    sliceIdCandidates('bots engine (CB-bots-02-CB-bots-19); feed').filter((id) => /^CB-bots-\d+$/.test(id)),
    ['CB-bots-02', 'CB-bots-19'],
  );
  assert.deepEqual(sliceIdCandidates('_BK-loan-01_', { longest: true }), ['BK-loan-01']);
  assert.deepEqual(sliceIdCandidates('see OPS-ORD-01.', { longest: true }), ['OPS-ORD-01']);
  const known = new Set(['CB-copy-20', 'CB-bots-02', 'CB-bots-19']);
  assert.deepEqual(dependsOn('bots engine (CB-bots-02-CB-bots-19); derivatives liquidation feed.', known, 'CB-copy-20'), [
    'CB-bots-02',
    'CB-bots-19',
  ]);
  const [j] = parseJourneys(['## J-a-01: x', '- Order: 1', '| 1 | does | sees | CB-bots-02-CB-bots-19 | none |'].join('\n'), 'a', known);
  assert.deepEqual(j.steps[0].slices, ['CB-bots-02', 'CB-bots-19']);
});

// The finish line's order (OWNER 223 (3), OWNER 226; the factory plan of 8 Nov, R5 §2): a `Later: custody` journey stays
// live, ranks after every launch journey, and is never Order 1.
const finishMap = (later1 = '2', laterLine = '- Later: custody (OWNER 226)') =>
  [
    '## J-wallet-01: I see what I hold',
    '- Persona: retail',
    '- Tier: core',
    '- Order: 1',
    '',
    '| # | The person does | They see | Slices | Proof |',
    '| - | - | - | - | - |',
    '| 1 | Opens Assets | Balances | W-balances-01 | none |',
    '| 2 | Places an order | Locked | W-balances-01, W-balances-02 | none |',
    '',
    '## J-wallet-02: I deposit crypto',
    '- Persona: pro-trader',
    '- Tier: core',
    `- Order: ${later1}`,
    laterLine,
    '',
    '| # | The person does | They see | Slices | Proof |',
    '| - | - | - | - | - |',
    '| 1 | Opens Deposit | An address | W-deposit-01 | none |',
    '',
    '## J-wallet-16: I run reconciliation (finance)',
    '- Persona: operator:finance',
    '- Tier: core',
    '- Order: 1',
    '',
    '| # | The person does | They see | Slices | Proof |',
    '| - | - | - | - | - |',
    '| 1 | Runs reconciliation | Breaks | W-balances-02 | none |',
    '',
    '## J-wallet-08: I look back at my activity',
    '- Persona: retail',
    '- Tier: core',
    '- Order: 2',
    '',
    '| # | The person does | They see | Slices | Proof |',
    '| - | - | - | - | - |',
    '| 1 | Opens Activity | Rows | W-activity-01 | none |',
  ].join('\n');

test('a Later: custody line marks the journey later; it stays live and its slices rank after every launch Order', () => {
  const journeys = parseJourneys(finishMap(), 'wallet');
  assert.equal(journeys[1].later, 'custody');
  assert.equal(journeys[0].later, undefined);
  assert.deepEqual(finishLineProblems(journeys), []);
  assert.equal(liveJourneys(journeys).length, 4, 'later is not parked: it stays live and in "finished"');
  const order = journeyOrder(journeys);
  assert.equal(order.get('W-deposit-01'), 4, 'a slice only a later journey needs comes after Orders 1 to 3');
  assert.equal(order.get('W-activity-01'), 2);
  assert.equal(order.get('W-balances-01'), 1);
});

const laterStepMap = (does = 'Later (OWNER 226): Proposes a trade bust') =>
  [
    '## J-cex-spot-18: I look up a routed order',
    '- Persona: operator:support',
    '- Tier: core',
    '- Order: 1',
    '',
    '| # | The person does | They see | Slices | Proof |',
    '| - | - | - | - | - |',
    '| 1 | Looks up an order | The order | SP-ops-01 | none |',
    `| 2 | ${does} | The bust | SP-ops-03 | none |`,
    '| 3 | Exports | A file that says Later (OWNER 226): further on | SP-ops-01 | none |',
  ].join('\n');

test('a step whose cell starts "Later (OWNER 226):" is a later step: live, out of the open count, its slices queued later', () => {
  const [j] = parseJourneys(laterStepMap(), 'cex-spot');
  assert.deepEqual(
    j.steps.map((st) => [st.n, st.later]),
    [
      [1, undefined],
      [2, 'custody'],
      [3, undefined],
    ],
  );
  assert.equal(isLaterStep(j.steps[1]), true);
  assert.deepEqual(finishLineProblems([j]), [], 'a later step at Order 1 is fine: the journey launches without it');
  assert.deepEqual(
    liveJourneys([j])[0].steps.map((st) => st.n),
    [1, 2, 3],
    'a later step stays live and in "finished"',
  );
  assert.equal(finishLine([j])[0].open, 2, 'the later step is not launch work');
  const order = journeyOrder([j]);
  assert.equal(order.get('SP-ops-03'), 4, 'a slice only a later step needs is queued with the later journeys');
  assert.equal(order.get('SP-ops-01'), 1);
});

test('planted: a step that starts with "Later" in any other form is refused; plain words that start with "Later" are not', () => {
  for (const does of [
    'Later: Proposes a trade bust',
    'later (OWNER 226): Proposes',
    'Later (OWNER 223): Proposes',
    '**Later (OWNER 226):** Proposes',
  ])
    assert.throws(
      () => parseJourneys(laterStepMap(does), 'cex-spot'),
      /J-cex-spot-18 #2 starts with "Later" but not "Later \(OWNER 226\):"/,
      does,
    );
  const [j] = parseJourneys(laterStepMap('Later that day, opens the alert'), 'cex-spot');
  assert.equal(j.steps[1].later, undefined);
});

test('review fixes: later steps share no launch work, totals say what is later, a bad step flag or an all-later Order 1 is refused', () => {
  const [j] = parseJourneys(laterStepMap(), 'cex-spot');
  const other = { id: 'J-cex-spot-30', persona: 'retail', order: 1, steps: [{ n: 1, slices: ['SP-ops-03'] }] };
  assert.equal(finishLine([j, other]).find((e) => e.j.id === 'J-cex-spot-18').unblocks, 0, 'SP-ops-03 is shared only through a later step');
  assert.equal(finishLine([j, other]).find((e) => e.j.id === 'J-cex-spot-30').unblocks, 0, 'nor does J-cex-spot-30 unblock it');
  assert.match(
    finishLineLines(finishLine([j]), null).join('\n'),
    /J-cex-spot-18 .*\(2 steps \(\+1 later\);/,
    'the total is launch steps, the later ones named apart',
  );
  const all = { ...j, steps: j.steps.map((st) => ({ ...st, later: 'custody' })) };
  assert.equal(isLaterJourney(all), true);
  assert.deepEqual(finishLineProblems([all]), [
    'J-cex-spot-18 is at Order 1 with every live step later; Order 1 is the launch wedge, so give it Order 2 or 3',
  ]);
  assert.equal(finishLine([{ ...all, order: 2 }, other]).at(-1).j.id, 'J-cex-spot-18', 'an all-later journey ranks with the later ones');
  const odd = structuredClone(j);
  odd.steps[1].later = 'someday';
  assert.match(finishLineProblems([odd]).join('\n'), /J-cex-spot-18 #2 is later for "someday"/);
});

test("review fix: a slice queued later that a launch slice depends on takes the launch slice's Order", () => {
  const slices = [
    { id: 'A-01', order: 1, depends: ['B-01'] },
    { id: 'C-01', order: 2, depends: ['B-01'] },
    { id: 'B-01', order: 4, depends: ['D-01'] },
    { id: 'D-01', order: 4, depends: [] },
    { id: 'E-01', order: 4, depends: [] },
  ];
  assert.deepEqual(
    pullLaterDepsForward(slices).map((s) => [s.id, s.order]),
    [
      ['A-01', 1],
      ['C-01', 2],
      ['B-01', 1],
      ['D-01', 1],
      ['E-01', 4],
    ],
  );
});

test('planted: a later journey at Order 1, or a later reason other than custody, is refused', () => {
  const atOne = parseJourneys(finishMap('1'), 'wallet');
  assert.match(finishLineProblems(atOne).join('\n'), /J-wallet-02 is later \(custody\) at Order 1/);
  assert.throws(() => parseJourneys(finishMap('2', '- Later: no'), 'wallet'), /the only later reason is "Later: custody"/);
  const odd = structuredClone(parseJourneys(finishMap(), 'wallet'));
  odd[1].later = 'someday';
  assert.match(finishLineProblems(odd).join('\n'), /J-wallet-02 is later for "someday"/);
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-later-'));
  mkdirSync(join(dir, 'modules', 'wallet', 'acceptance'), { recursive: true });
  writeFileSync(join(dir, 'modules', 'wallet', 'acceptance', 'journeys.md'), finishMap('1'));
  assert.throws(
    () => buildJourneys(dir, new Set(['W-balances-01', 'W-balances-02', 'W-deposit-01', 'W-activity-01'])),
    /later \(custody\) at Order 1/,
  );
  writeFileSync(join(dir, 'modules', 'wallet', 'acceptance', 'journeys.md'), finishMap('2'));
  assert.equal(buildJourneys(dir, new Set(['W-balances-01', 'W-balances-02', 'W-deposit-01', 'W-activity-01'])).length, 4);
});

test('the finish line: launch before later, then Order, customers before operators, then the most shared slices, then the fewest open steps', () => {
  const journeys = parseJourneys(finishMap(), 'wallet');
  assert.deepEqual(
    finishLine(journeys).map((e) => [e.rank, e.j.id, e.later, e.unblocks]),
    [
      [1, 'J-wallet-01', false, 1],
      [2, 'J-wallet-16', false, 1],
      [3, 'J-wallet-08', false, 0],
      [4, 'J-wallet-02', true, 0],
    ],
  );
  // With a report, the open steps break a tie: two Order 2 customer journeys sharing nothing, one with a passing step.
  const two = [
    {
      id: 'J-m-01',
      persona: 'retail',
      order: 2,
      steps: [
        { n: 1, slices: ['A-1'] },
        { n: 2, slices: ['A-1'] },
      ],
    },
    {
      id: 'J-m-02',
      persona: 'retail',
      order: 2,
      steps: [
        { n: 1, slices: ['B-1'] },
        { n: 2, slices: ['B-1'] },
      ],
    },
  ];
  assert.deepEqual(
    finishLine(two, new Set(['J-m-02#1'])).map((e) => [e.j.id, e.open]),
    [
      ['J-m-02', 1],
      ['J-m-01', 2],
    ],
  );
});

test('a test that passed only on its retry is not a pass on the scoreboard (CI review on #7363, 1fbf031)', () => {
  const report = {
    suites: [
      {
        specs: [
          { title: 'J-cex-spot-01 #1 signs up', ok: true, tests: [{ status: 'expected' }] },
          { title: 'J-cex-spot-01 #2 places a limit buy', ok: true, tests: [{ status: 'flaky' }] },
          { title: 'J-cex-spot-02 #1 presses twice', ok: true, tests: [{ status: 'expected' }, { status: 'flaky' }] },
        ],
      },
    ],
  };
  assert.deepEqual([...passedSteps(report)], ['J-cex-spot-01#1']);
});
