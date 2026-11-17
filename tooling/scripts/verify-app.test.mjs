// pnpm local:stack verify (verify-app.mjs): the feature map, the drive plan, the doctor, the evidence and the stop rule.
// Run: node --test tooling/scripts/verify-app.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  STEP_TITLE,
  doctorChecks,
  harnessNotes,
  shellWord,
  titlePattern,
  featureMarkdown,
  indexMarkdown,
  journeyIndex,
  pagePaths,
  parseArgs,
  lsofPorts,
  parseHealth,
  planDrive,
  againCommand,
  installedAnvil,
  reportTests,
  stackId,
  stopDecision,
  summaryMarkdown,
  testTitles,
} from './verify-app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SERIAL = `// World: book, restart
import { test, expect } from './journey.mjs';
const J = 'J-x-01';
test.describe.configure({ mode: 'serial' });
test(\`\${J} starts: a TEST person\`, async () => {});
test(\`\${J} #1 opens the room\`, async ({ page }) => {
  await page.goto('/room'); // page.goto('/commented-out') in a comment is no path
});
test(
  \`\${J} #2 pays
     across two lines\`,
  async ({ page }) => {
    await page.goto(\`/pay/\${id}\`);
  },
);
`;
const PLAIN = `// World: none
import { test } from './journey.mjs';
const J = 'J-x-01';
test(\`\${J} #3 reads the chart's candles\`, async ({ page }) => {
  await page.goto("/room");
});
test('J-y-02 #10 a literal title', async () => {});
`;
const SHARED = `// World: book
import { test } from './journey.mjs';
import { journeyState } from './stack.mjs';
import { testChain } from './dex.mjs';
const J = 'J-s-01';
const run = journeyState(J);
test(\`\${J} #1 signs up\`, async () => {});
test(\`\${J} #2 buys 0.01 for \${price} USDT\`, async () => {});
test(\`\${J} #3 sells\`, async () => {});
`;
const files = { 'J-x-01.pw.mjs': SERIAL, 'J-x-01-more.pw.mjs': PLAIN };
const index = journeyIndex(Object.keys(files), (f) => files[f]);

test('arguments: steps as #n or n, quoted selectors, usage errors', () => {
  assert.deepEqual(parseArgs(['drive', 'J-x-01', '#2', '1', '#2']), { cmd: 'drive', id: 'J-x-01', steps: [1, 2] });
  assert.deepEqual(parseArgs(['drive', 'J-x-01']), { cmd: 'drive', id: 'J-x-01', steps: [] });
  assert.match(parseArgs(['drive']).error, /drive needs a journey id/);
  assert.match(parseArgs(['drive', 'J-x-01', 'two']).error, /steps are written #1 #2/);
  assert.deepEqual(parseArgs(['look', '/predict', '--sign-up', '--selector', '[data-testid="x"]']), {
    cmd: 'look',
    path: '/predict',
    signUp: true,
    selector: '[data-testid="x"]',
  });
  assert.match(parseArgs(['look', 'predict']).error, /starts with \//);
  assert.deepEqual(parseArgs(['launch', 'J-x-01', '--only', 'edge,bank']), { cmd: 'launch', ids: ['J-x-01'], only: 'edge,bank' });
  assert.match(parseArgs(['launch', '--only']).error, /--only needs a value/);
  assert.match(parseArgs(['doctor', 'extra']).error, /takes no arguments/);
  assert.match(parseArgs(['restart']).error, /^usage:/);
});

test('titles: the file’s J is put in, a title over two lines is one, only `<J-id> #<n>` titles are steps', () => {
  const titles = testTitles(SERIAL).map((t) => t.title);
  assert.deepEqual(titles, ['J-x-01 starts: a TEST person', 'J-x-01 #1 opens the room', 'J-x-01 #2 pays across two lines']);
  assert.equal(STEP_TITLE.test(titles[0]), false);
  assert.equal(testTitles(SERIAL)[1].line, 6);
  assert.deepEqual(testTitles(PLAIN).map((t) => t.title)[1], 'J-y-02 #10 a literal title');
});

test('paths: the pages a test opens, once each, a templated part as …, comments left out', () => {
  assert.deepEqual(pagePaths(SERIAL), ['/room', '/pay/…']);
  assert.deepEqual(pagePaths(PLAIN), ['/room']);
});

test('index: a journey across two files, its steps, and each file’s facts', () => {
  const x = index.get('J-x-01');
  assert.deepEqual([...x.files.keys()].sort(), ['J-x-01-more.pw.mjs', 'J-x-01.pw.mjs']);
  assert.deepEqual([...x.steps.keys()], [1, 2, 3]);
  assert.equal(x.steps.get(2)[0].words, 'pays across two lines');
  const serial = x.files.get('J-x-01.pw.mjs');
  assert.equal(serial.serial, true);
  assert.deepEqual(serial.world, ['book', 'restart']);
  assert.equal(serial.others, 1);
  assert.equal(x.files.get('J-x-01-more.pw.mjs').past, true); // "candles"
  assert.deepEqual([...index.get('J-y-02').steps.keys()], [10]);
});

test('drive plan: a step alone greps that step; where tests hand a person on, every test up to the step runs', () => {
  const one = planDrive('J-x-01', [3], index.get('J-x-01'));
  assert.deepEqual(one.files, ['J-x-01-more.pw.mjs']);
  assert.deepEqual(one.chained, []);
  const re = new RegExp(one.grep);
  assert.ok(re.test('J-x-01-more.pw.mjs J-x-01 #3 reads the chart'));
  assert.ok(!re.test('J-x-01 #30 something else'));
  assert.ok(!re.test('J-x-01 #1 opens'));
  assert.deepEqual(one.past, ['J-x-01-more.pw.mjs']);
  // The serial file: #2 runs with the start and #1 before it, which made the person #2 acts as.
  const serial = planDrive('J-x-01', [2], index.get('J-x-01'));
  assert.deepEqual(serial.chained, [{ file: 'J-x-01.pw.mjs', tests: 3 }]);
  const chain = new RegExp(serial.grep);
  for (const t of ['J-x-01 starts: a TEST person', 'J-x-01 #1 opens the room', 'J-x-01 #2 pays across two lines'])
    assert.ok(chain.test(t), t);
  // A journeyState file that is not serial is chained the same way, and only up to the last step asked for.
  const shared = journeyIndex(['J-s-01.pw.mjs'], () => SHARED).get('J-s-01');
  const two = planDrive('J-s-01', [2], shared);
  assert.deepEqual(two.chained, [{ file: 'J-s-01.pw.mjs', tests: 2 }]);
  const re2 = new RegExp(two.grep);
  assert.ok(re2.test('J-s-01 #1 signs up') && re2.test('J-s-01 #2 buys 0.01 for 12 USDT'));
  assert.ok(!re2.test('J-s-01 #3 sells'));
  // Both kinds in one drive: the plain file's steps and the chained file's tests.
  const both = planDrive('J-x-01', [2, 3], index.get('J-x-01'));
  assert.deepEqual(both.files, ['J-x-01-more.pw.mjs', 'J-x-01.pw.mjs']);
  assert.ok(new RegExp(both.grep).test('J-x-01 #3 reads') && new RegExp(both.grep).test('J-x-01 starts: a TEST person'));
  assert.deepEqual(planDrive('J-x-01', [], index.get('J-x-01')).steps, [1, 2, 3]);
  assert.match(planDrive('J-x-01', [4], index.get('J-x-01')).error, /no test titled #4 \(it has #1 #2 #3\)/);
  assert.match(planDrive('J-z-03', [1], undefined).error, /no test is titled J-z-03/);
});

test('a title as a pattern, and a word for a shell: literal, with what a shell or regex would read quoted', () => {
  assert.equal(titlePattern('J-a-01 #1 pays 0.5 (TEST) ${amount} now'), 'J-a-01 #1 pays 0\\.5 \\(TEST\\) .* now');
  assert.ok(new RegExp(titlePattern('J-a-01 #1 pays ${x} in USDT')).test('J-a-01 #1 pays 12.5 in USDT'));
  assert.equal(shellWord('--config'), '--config');
  assert.equal(shellWord('J-x-01 #(?:1|2)\\b'), "'J-x-01 #(?:1|2)\\b'");
  assert.equal(shellWord("it's"), "'it'\\''s'");
});

const JOURNEY = {
  id: 'J-x-01',
  title: 'Open the room and pay',
  module: 'x',
  persona: 'retail',
  tier: 'core',
  order: 1,
  steps: [
    { n: 1, slices: [], noSlice: false },
    { n: 2, slices: [], noSlice: false },
    { n: 3, slices: [], noSlice: false },
    { n: 4, slices: [], noSlice: false, later: 'custody' },
    { n: 5, slices: [], noSlice: false },
  ],
};

test('feature file: H1, one paragraph, then exactly the four sections in order, each step with its exact drive', () => {
  const md = featureMarkdown(JOURNEY, index.get('J-x-01'));
  assert.ok(md.startsWith('# J-x-01: Open the room and pay\n\nA retail person’s'.replace('’', "'")));
  assert.deepEqual(md.match(/^## .+$/gm), ['## Sub-features', '## How to get to it (user POV)', '## Driving it with verify', '## Gotchas']);
  assert.match(md, /- `#1` opens the room\n/);
  assert.match(md, /- `#4` no test is titled with this step yet: nothing drives it \(later \(custody\)\)/);
  assert.match(md, /Open `\/pay\/…`/);
  assert.match(md, /^Preconditions:$/m);
  assert.match(
    md,
    /Run `pnpm local:stack verify drive J-x-01 '#3'`\. It passes when `apps\/customer\/tests\/real-app\/J-x-01-more\.pw\.mjs:4` passes/,
  );
  assert.match(md, /`J-x-01\.pw\.mjs` runs serially: a later step acts as the TEST person an earlier one made/);
  const shared = featureMarkdown({ ...JOURNEY, id: 'J-s-01' }, journeyIndex(['J-s-01.pw.mjs'], () => SHARED).get('J-s-01'));
  assert.match(shared, /`J-s-01\.pw\.mjs` hands state from test to test \(journeyState\)/);
  assert.match(shared, /`J-s-01\.pw\.mjs` uses the TEST chain: on a stack without one/);
  assert.match(md, /launch with `pnpm local:stack verify launch J-x-01`/);
  assert.match(md, /Steps #5 have no test titled with them/);
  assert.match(md, /Marked in journeys\.json: #4 later \(custody\)/);
  const none = featureMarkdown({ ...JOURNEY, id: 'J-q-09' }, undefined);
  assert.match(none, /No journey test file holds a test titled with its id yet/);
  assert.match(none, /Nothing to drive yet/);
});

test('index file: every journey by module with its drivable count', () => {
  const md = indexMarkdown([JOURNEY, { ...JOURNEY, id: 'J-a-02', module: 'a', title: 'Another', steps: [{ n: 1 }] }], index);
  assert.ok(md.indexOf('## a') < md.indexOf('## x'));
  assert.match(md, /- \[J-x-01\]\(\.\/J-x-01\.md\) Open the room and pay \(3 of 5 steps drivable\)/);
  assert.match(md, /- \[J-a-02\]\(\.\/J-a-02\.md\) Another \(0 of 1 steps drivable\)/);
});

test('the real map: every journey in journeys.json gets a feature file in the four-section shape, from the real tests', () => {
  const journeys = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/roadmap/journeys.json'), 'utf8'));
  const dir = path.join(ROOT, 'apps/customer/tests/real-app');
  const names = fs.readdirSync(dir).filter((f) => /^J-[A-Za-z0-9._-]+\.pw\.mjs$/.test(f));
  const real = journeyIndex(names, (f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  let drivable = 0;
  for (const j of journeys) {
    const md = featureMarkdown(j, real.get(j.id));
    assert.deepEqual(
      md.match(/^## .+$/gm),
      ['## Sub-features', '## How to get to it (user POV)', '## Driving it with verify', '## Gotchas'],
      j.id,
    );
    if (real.get(j.id)?.steps.size) drivable++;
  }
  assert.ok(drivable > journeys.length / 2, `${drivable} of ${journeys.length} journeys have a step test`);
});

test('health table: the rows only, not the lines printed after it', () => {
  const text = [
    '  SERVICE          PORT        PID     HEALTH',
    '  postgres         15460       owned   ok',
    '  svc-bank         14509       12      DOWN (0)',
    '  team-tls (TEST)  3143        13      ok',
    '',
    "  Customer: this checkout's own build (/w/apps/customer/dist)",
  ].join('\n');
  assert.deepEqual(parseHealth(text), [
    { name: 'postgres', pid: null, health: 'ok' },
    { name: 'svc-bank', pid: 12, health: 'DOWN (0)' },
    { name: 'team-tls', pid: 13, health: 'ok' },
  ]);
  assert.deepEqual(lsofPorts('p51983\nf21\nn127.0.0.1:3999\nf22\nn*:14523\np7\nf5\nn[::1]:3999\n'), [3999, 14523]);
  assert.deepEqual(parseHealth('no table here'), []);
});

const TABLE =
  '  SERVICE          PORT        PID     HEALTH\n  svc-edge         14500       1       ok\n  market-maker     -           2       ok (last log 0s ago)\n';
const healthy = {
  claim: { slot: 1, live: true, claim: { repo: '/w', state: '/s' } },
  status: { code: 0, text: TABLE },
  plan: { services: [{ name: 'edge', running: true, onCurrentBuild: true }], build: { backend: 'none', customer: false, head: 'abc' } },
  launch: { stack: '10@20', readiedAt: '2026-11-16T00:00:00Z' },
  stack: '10@20',
};
const failing = (input) =>
  doctorChecks(input)
    .filter((c) => !c.ok)
    .map((c) => c.name);

test('doctor: worth driving only when every check holds; each failure names its check and its fix', () => {
  assert.deepEqual(failing(healthy), []);
  assert.equal(doctorChecks(healthy).find((c) => c.name === 'build').detail, 'running the build of abc');
  const edited = { ...healthy, plan: { ...healthy.plan, build: { ...healthy.plan.build, edits: true } } };
  assert.match(doctorChecks(edited).find((c) => c.name === 'build').detail, /with this checkout's uncommitted edits$/);
  assert.match(doctorChecks(healthy)[0].detail, /slot 1, this checkout's, Customer at http:\/\/127\.0\.0\.1:4210/);
  const none = doctorChecks({ ...healthy, claim: null });
  assert.deepEqual(
    none.map((c) => [c.name, c.ok, c.fix]),
    [['stack', false, 'pnpm local:stack verify launch']],
  );
  assert.deepEqual(failing({ ...healthy, status: { code: 1, text: TABLE.replace('ok\n  market', 'DOWN (0)\n  market') } }), ['health']);
  assert.deepEqual(failing({ ...healthy, status: { code: 1, text: TABLE.replace('ok (last log', 'stale (last log') } }), ['market']);
  assert.deepEqual(failing({ ...healthy, plan: { ...healthy.plan, services: [{ name: 'edge', running: false }] } }), ['owned']);
  assert.deepEqual(failing({ ...healthy, plan: { ...healthy.plan, build: { backend: 'full', customer: true } } }), ['build']);
  assert.deepEqual(failing({ ...healthy, plan: { ...healthy.plan, services: [{ name: 'edge', running: true, onCurrentBuild: false }] } }), [
    'build',
  ]);
  assert.deepEqual(failing({ ...healthy, plan: null }), ['owned', 'build']);
  // A readying of another stack (stopped and started again since) is not this one's.
  assert.deepEqual(failing({ ...healthy, stack: '11@30' }), ['readied']);
  assert.deepEqual(failing({ ...healthy, launch: null }), ['readied']);
});

test('stack identity: Postgres pid and start time, null when unreadable', () => {
  assert.equal(stackId('87121\n/s/data/postgres\n1794855383\n15460\n'), '87121@1794855383');
  assert.equal(stackId(''), null);
  assert.equal(stackId('x\n/d\ny'), null);
});

test('stop: stops only the very stack verify launch started; a stack it found running, or a later one, is left', () => {
  const claim = { live: true };
  assert.equal(stopDecision({ claim: null, launch: null, stack: null }), 'none');
  assert.equal(stopDecision({ claim, launch: { startedByUs: true, stack: '1@2' }, stack: '1@2' }), 'stop');
  assert.equal(stopDecision({ claim, launch: { startedByUs: false, stack: '1@2' }, stack: '1@2' }), 'not-ours');
  assert.equal(stopDecision({ claim, launch: { startedByUs: true, stack: '1@2' }, stack: '3@4' }), 'not-ours');
  assert.equal(stopDecision({ claim, launch: { startedByUs: true }, stack: null }), 'not-ours');
  assert.equal(stopDecision({ claim, launch: null, stack: '1@2' }), 'not-ours');
});

test('evidence: each test with its verdict, first error line and screenshots; the summary names the command', () => {
  const report = {
    suites: [
      {
        file: 'J-x-01.pw.mjs',
        specs: [
          {
            title: 'J-x-01 #1 opens',
            line: 12,
            tests: [
              {
                status: 'expected',
                results: [
                  {
                    attachments: [
                      { name: 'screenshot', contentType: 'image/png', path: '/r/results/a/test-finished-2.png' },
                      { name: 'screenshot', contentType: 'image/png', path: '/r/results/a/test-finished-1.png' },
                    ],
                  },
                ],
              },
            ],
          },
          {
            title: 'J-x-01 #2 pays',
            tests: [
              {
                status: 'unexpected',
                results: [
                  {
                    error: { message: '\u001b[31mError: expect(locator).toBeVisible() failed\u001b[39m\n\nLocator: x' },
                    attachments: [{ name: 'trace', contentType: 'application/zip', path: '/r/results/b/trace.zip' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    errors: [],
  };
  const tests = reportTests(report);
  assert.deepEqual(
    tests.map((t) => [t.title, t.line, t.status, t.error, t.shots, t.trace]),
    [
      ['J-x-01 #1 opens', 12, 'passed', null, ['/r/results/a/test-finished-1.png', '/r/results/a/test-finished-2.png'], null],
      ['J-x-01 #2 pays', null, 'failed', 'Error: expect(locator).toBeVisible() failed', [], '/r/results/b/trace.zip'],
    ],
  );
  assert.deepEqual(reportTests(null), []);
  const run = {
    dir: '/r',
    label: 'J-x-01-s1',
    verdict: 'FAIL',
    what: 'journey J-x-01, steps #1 #2',
    command: 'JOURNEY_FILES="J-x-01.pw.mjs" pnpm exec playwright test',
    head: 'abc',
    dirty: 2,
    branch: 'fix/1',
    slot: 0,
    customer: 'http://127.0.0.1:3210',
    startedAt: 's',
    endedAt: 'e',
    exit: 1,
    tests,
    files: ['report.json'],
  };
  const md = summaryMarkdown(run);
  assert.match(md, /^# J-x-01-s1: FAIL$/m);
  assert.match(
    md,
    /- Command \(runs it again, writing to a new temporary folder, \$OUT, never this one\): `JOURNEY_FILES="J-x-01\.pw\.mjs" pnpm exec playwright test`/,
  );
  assert.equal(
    againCommand(
      '/w x',
      { JOURNEY_FILES: 'J-a.pw.mjs J-b.pw.mjs', JOURNEY_REPORT: '/w x/.verify/runs/r1/report.json' },
      ['pnpm', 'exec', 'playwright', 'test', '--output', '/w x/.verify/runs/r1/results', '--grep', 'J-a #2 (\\D|$)'],
      '/w x/.verify/runs/r1',
    ),
    `cd '/w x' && OUT="$(mktemp -d)" && JOURNEY_FILES='J-a.pw.mjs J-b.pw.mjs' JOURNEY_REPORT="$OUT"/report.json pnpm exec playwright test --output "$OUT"/results --grep 'J-a #2 (\\D|$)'`,
  );
  assert.match(md, /## What the harness said\n\nNo WORLD RESTORE line in output\.log: /);
  assert.match(md, /- Code: abc, with uncommitted edits \(2 path\(s\) in git status\), branch fix\/1/);
  assert.match(
    summaryMarkdown({ ...run, dirty: 0, branch: 'HEAD', notes: ['WORLD RESTORE after J-a-01.pw.mjs: x: cancel-all answered 403'] }),
    /- Code: abc, clean \(git status empty\), detached HEAD[\s\S]*## What the harness said[\s\S]*- WORLD RESTORE after J-a-01\.pw\.mjs: x: cancel-all answered 403/,
  );
  assert.deepEqual(harnessNotes('Running 1 test\n\u001b[2mWORLD RESTORE after J-b.pw.mjs: gone\u001b[22m\n  ✓ 1 x\n'), [
    'WORLD RESTORE after J-b.pw.mjs: gone',
  ]);
  assert.match(
    md,
    /- PASS J-x-01 #1 opens \(`J-x-01\.pw\.mjs:12`\)\n {2}- 2 screenshots, one per browser page the test used: [^\n]*\n {2}- screenshot: results\/a\/test-finished-1\.png\n {2}- screenshot: results\/a\/test-finished-2\.png/,
  );
  assert.match(
    md,
    /- FAIL J-x-01 #2 pays \(`J-x-01\.pw\.mjs`\): Error: expect\(locator\)\.toBeVisible\(\) failed\n {2}- trace: results\/b\/trace\.zip/,
  );
});

test('anvil: the stack’s own rule first; else Foundry’s, then the newest ~/.intafaced install', () => {
  const have = new Set();
  const args = (env = {}) => ({
    env: { PATH: '/usr/bin', ...env },
    home: '/h',
    exists: (p) => have.has(p),
    list: (d) => (d === '/h/.intafaced' ? ['slots', 'foundry-1.5.1', 'foundry-1.10.0', 'foundry-notes'] : []),
  });
  assert.equal(installedAnvil(args()), null);
  have.add('/h/.intafaced/foundry-1.5.1/anvil');
  assert.equal(installedAnvil(args()), '/h/.intafaced/foundry-1.5.1/anvil');
  have.add('/h/.intafaced/foundry-1.10.0/anvil');
  assert.equal(installedAnvil(args()), '/h/.intafaced/foundry-1.10.0/anvil');
  have.add('/h/.foundry/bin/anvil');
  assert.equal(installedAnvil(args()), '/h/.foundry/bin/anvil');
  have.add('/c/.tools/foundry/bin/anvil'); // the folder only the removed one-time setup script made: never read now
  assert.equal(installedAnvil(args()), '/h/.foundry/bin/anvil');
  assert.equal(installedAnvil(args({ LOCAL_STACK_ANVIL_BIN: '/x/anvil' })), null);
  have.add('/usr/bin/anvil');
  assert.equal(installedAnvil(args()), null);
});
