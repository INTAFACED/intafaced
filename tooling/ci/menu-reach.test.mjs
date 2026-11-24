import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { BETA_MOVES, BETA_SCREENS, menuReach, pathsOf, readReport, stepOf } from './menu-reach.mjs';
import { MENU_REACH, crawlFrom, linkPath } from '../scripts/menu-crawl.mjs';
import { makeMoves } from '../scripts/journey-moves.mjs';

const ROOMS = {
  '/': '/',
  '/home': '/home',
  '/money': '/money',
  '/money/fx': '/money/fx',
  '/hidden/room': '/hidden/room',
  '/after/hidden': '/after/hidden',
  '/old': '/old',
};
const roomOf = (path) => {
  if (path.startsWith('/trade/spot/')) return { room: '/trade/spot/:pair', alias: false };
  return ROOMS[path] ? { room: ROOMS[path], alias: path === '/old' } : null;
};
// Every page the fixtures link to was opened and seen as itself, unless a test says otherwise.
const OPENED = ['/', '/home', '/money', '/money/fx', '/trade/spot/BTC-USDT', '/hidden/room', '/after/hidden'].map((p) => [p, p]);
const crawl = (signedIn, opened = OPENED) => ({
  version: 1,
  signedOut: { roots: ['/'], edges: [], opened: [['/', '/']], errors: [] },
  signedIn: { roots: ['/home'], edges: signedIn, opened, errors: [] },
});
const screens = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
const EDGES = [
  ['/home', '/money'],
  ['/money', '/money/fx'],
  ['/money', '/trade/spot/BTC-USDT'],
  ['/home', '/hidden/room'],
  ['/hidden/room', '/after/hidden'],
];

test('a screen a link path reaches from Home is reached, with that path', () => {
  const r = menuReach({ crawl: crawl(EDGES), screens: screens({ 'J-x-01#1': ['/home', '/money/fx'] }), roomOf, hidden: new Set() });
  assert.deepEqual(r.notReached, []);
  assert.deepEqual(r.reached['/money/fx'], ['/home', '/money', '/money/fx']);
  assert.deepEqual(r.stepRooms['J-x-01#1'], ['/home', '/money/fx']);
});

test('planted fault: the route to a reached screen removed, its step is not reached', () => {
  const without = EDGES.filter(([a, b]) => !(a === '/money' && b === '/money/fx'));
  const r = menuReach({ crawl: crawl(without), screens: screens({ 'J-x-01#1': ['/home', '/money/fx'] }), roomOf, hidden: new Set() });
  assert.deepEqual(r.notReached, [{ step: 'J-x-01#1', paths: ['/money/fx'] }]);
});

test('a link to a room the crawl was sent away from (a sign-in guard) leads where it landed, never to the room', () => {
  const opened = OPENED.map(([p]) => (p === '/money/fx' ? ['/money/fx', '/'] : [p, p]));
  const r = menuReach({
    crawl: crawl(EDGES, opened),
    screens: screens({ 'J-x-05#1': ['/money/fx'] }),
    roomOf: (p) => (p === '/' ? { room: '/', alias: false } : roomOf(p)),
    hidden: new Set(),
  });
  assert.deepEqual(r.notReached, [{ step: 'J-x-05#1', paths: ['/money/fx'] }]);
  // A room linked but never opened is not reached either.
  const never = OPENED.filter(([p]) => p !== '/money/fx');
  assert.deepEqual(
    menuReach({ crawl: crawl(EDGES, never), screens: screens({ 'J-x-05#1': ['/money/fx'] }), roomOf, hidden: new Set() }).notReached,
    [{ step: 'J-x-05#1', paths: ['/money/fx'] }],
  );
});

test('a crawl cut short is unread: what its unopened rooms reach is unknown, not unreached', () => {
  const c = crawl(EDGES);
  c.signedIn = { ...c.signedIn, partial: true, left: 7 };
  assert.match(
    menuReach({ crawl: c, screens: screens({ 'J-x-01#1': ['/home'] }), roomOf, hidden: new Set() }).unread,
    /cut short with 7 rooms/,
  );
});

test('one address of a room stands for the room: another market of a reached desk is reached', () => {
  const r = menuReach({ crawl: crawl(EDGES), screens: screens({ 'J-x-02#1': ['/trade/spot/ETH-USDT'] }), roomOf, hidden: new Set() });
  assert.deepEqual(r.notReached, []);
});

test('a room the beta hides is no page to pass through; a hidden screen is the verdict’s, not this list’s', () => {
  const r = menuReach({
    crawl: crawl(EDGES),
    screens: screens({ 'J-x-03#1': ['/after/hidden'], 'J-x-03#2': ['/hidden/room'] }),
    roomOf,
    hidden: new Set(['/hidden/room']),
  });
  assert.deepEqual(r.notReached, [{ step: 'J-x-03#1', paths: ['/after/hidden'] }]);
  assert.equal(r.reached['/hidden/room'], undefined);
});

test('an alias or a path of no room is no screen to reach', () => {
  const r = menuReach({ crawl: crawl(EDGES), screens: screens({ 'J-x-04#1': ['/old', '/no/such/room'] }), roomOf, hidden: new Set() });
  assert.deepEqual(r.notReached, []);
  assert.deepEqual(r.stepRooms['J-x-04#1'], []);
});

test('no record, a broken crawl, a crawl missing a side, or no screens: unread, never every step reached', () => {
  const s = screens({ 'J-x-01#1': ['/home'] });
  assert.match(menuReach({ crawl: null, screens: s, roomOf, hidden: new Set() }).unread, /did not run/);
  assert.match(menuReach({ crawl: { unread: 'boom' }, screens: s, roomOf, hidden: new Set() }).unread, /broke: boom/);
  assert.match(menuReach({ crawl: { signedOut: {} }, screens: s, roomOf, hidden: new Set() }).unread, /lacks/);
  assert.match(menuReach({ crawl: crawl(EDGES), screens: {}, roomOf, hidden: new Set() }).unread, /recorded its screens/);
});

test('stepOf: a step and a part of a step; setup is none', () => {
  assert.equal(stepOf('J-tax-01 #3 the person files'), 'J-tax-01#3');
  assert.equal(stepOf('J-identity-15, part of #1: the code'), 'J-identity-15#1');
  assert.equal(stepOf('J-tax-01 starts: an account'), null);
  assert.equal(stepOf('menu reach: the links'), null);
});

const report = (crawlRecord, steps) => ({
  suites: [
    {
      title: 'a',
      specs: [
        {
          title: 'menu reach: the links from the front page and Home',
          file: 'menu-reach.pw.mjs',
          tests: [{ annotations: [], results: [{ annotations: [{ type: MENU_REACH, description: JSON.stringify(crawlRecord) }] }] }],
        },
        // Another test's copy of the annotation is no crawl record.
        {
          title: 'J-z-01 #1 forged',
          file: 'J-z-01.pw.mjs',
          tests: [{ results: [{ annotations: [{ type: MENU_REACH, description: '{"unread":"forged"}' }] }] }],
        },
        ...Object.entries(steps).map(([title, paths]) => ({
          title,
          tests: [{ annotations: [{ type: BETA_SCREENS, description: JSON.stringify(paths) }], results: [] }],
        })),
      ],
      suites: [
        {
          title: 'b',
          specs: [{ title: 'J-y-01 #2 more', tests: [{ results: [{ annotations: [{ type: BETA_SCREENS, description: 'not json' }] }] }] }],
        },
      ],
    },
  ],
});

test('readReport: the crawl record on a result, screens on a test, a bad annotation none', () => {
  const { crawl: c, screens: s } = readReport(report(crawl(EDGES), { 'J-x-01 #1 a': ['/money/fx'] }));
  assert.deepEqual(c.signedIn.roots, ['/home']);
  assert.deepEqual([...s['J-x-01#1']], ['/money/fx']);
  assert.equal(s['J-y-01#2'], undefined);
  assert.deepEqual(pathsOf(c, s), ['/', '/after/hidden', '/hidden/room', '/home', '/money', '/money/fx', '/trade/spot/BTC-USDT']);
});

test('the CLI writes notReached with stand-ins for the beta rule and the route table, and exits 0 when the rule is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'menu-reach-'));
  writeFileSync(
    join(dir, 'report.json'),
    JSON.stringify(report(crawl(EDGES.slice(0, 1)), { 'J-x-01 #1 a': ['/home', '/money/fx'], 'J-x-01 #2 b': ['/money'] })),
  );
  writeFileSync(
    join(dir, 'rule.mjs'),
    "import { readFileSync } from 'node:fs'; const p = JSON.parse(readFileSync(0, 'utf8')); process.stdout.write(JSON.stringify({ hidden: p.filter((x) => x.startsWith('/hidden')) }));\n",
  );
  writeFileSync(
    join(dir, 'routes.mjs'),
    "export const findRoom = (p) => (['/', '/home', '/money', '/money/fx'].includes(p) ? { path: p } : undefined);\n",
  );
  const cli = fileURLToPath(new URL('./menu-reach.mjs', import.meta.url));
  const run = (rule) =>
    execFileSync(
      process.execPath,
      [cli, '--report', join(dir, 'report.json'), '--out', join(dir, 'out.json'), '--beta-rule', rule, '--routes', join(dir, 'routes.mjs')],
      {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
      },
    );
  run(join(dir, 'rule.mjs'));
  const out = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
  assert.deepEqual(out.notReached, [{ step: 'J-x-01#1', paths: ['/money/fx'] }]);
  assert.deepEqual(out.reached['/money'], ['/home', '/money']);
  run(join(dir, 'no-such-rule.mjs'));
  assert.match(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')).unread, /beta's rule .* is missing/);
});

test('linkPath: the app’s own pages only', () => {
  const o = 'http://127.0.0.1:3210';
  assert.equal(linkPath('/money/fx?x=1#y', o), '/money/fx');
  assert.equal(linkPath('http://127.0.0.1:3210/home/', o), '/home');
  assert.equal(linkPath('https://example.com/home', o), null);
  assert.equal(linkPath('mailto:a@b.c', o), null);
  assert.equal(linkPath('/api/x', o), null);
  assert.equal(linkPath('/files/a.pdf', o), null);
  assert.equal(linkPath('/logout', o), null);
});

test('crawlFrom: each room opened once, a redirect is an edge, a page that fails is an error, the limit marks it partial', async () => {
  const pages = { '/': ['/a', '/b/1', '/b/2', 'https://x.test/'], '/a': ['/', '/c'], '/b/1': ['/a'], '/c': ['/boom'] };
  let here = null;
  const open = async (path) => {
    if (path === '/boom') throw new Error('timeout');
    here = path === '/c' ? '/c2' : path;
    return here;
  };
  const roomOf = (path) => (path.startsWith('/b/') ? '/b/:id' : path);
  const links = async () => pages[here === '/c2' ? '/c' : here] ?? [];
  const r = await crawlFrom(['/'], { open, links, roomOf, origin: 'http://h.test' });
  assert.deepEqual(r.opened, [
    ['/', '/'],
    ['/a', '/a'],
    ['/b/1', '/b/1'],
    ['/c', '/c2'],
    ['/c2', '/c2'],
  ]);
  assert.equal(r.left, 0);
  assert.ok(r.edges.some(([a, b]) => a === '/c' && b === '/c2'));
  assert.ok(r.edges.some(([a, b]) => a === '/' && b === '/b/2'));
  assert.deepEqual(
    r.errors.map((e) => e.path),
    ['/boom'],
  );
  assert.equal(r.partial, false);
  const capped = await crawlFrom(['/'], { open, links, roomOf, origin: 'http://h.test', limit: 2 });
  assert.equal(capped.partial, true);
});

// The in-app moves of passing steps (tooling/scripts/journey-moves.mjs): a room only a record the step made leads to.
const AGENT = '/agents/0f9a7c';
const roomOfAgents = (path) => {
  if (path === '/agents' || path === '/agents/new' || path === '/unreached' || path === '/unreached/next')
    return { room: path, alias: false };
  if (path.startsWith('/agents/')) return { room: '/agents/:agentId', alias: false };
  return roomOf(path);
};
const AGENT_EDGES = [...EDGES, ['/home', '/agents'], ['/agents', '/agents/new']];
const AGENT_OPENED = [...OPENED, ['/agents', '/agents'], ['/agents/new', '/agents/new']];
const agents = (moves, hidden = new Set(), shown = { 'J-agents-02#1': [AGENT] }) =>
  menuReach({ crawl: crawl(AGENT_EDGES, AGENT_OPENED), screens: screens(shown), moves, roomOf: roomOfAgents, hidden });

test('known-good: an in-app move from a reached room reaches a record’s own room, with that path', () => {
  assert.deepEqual(agents([]).notReached, [{ step: 'J-agents-02#1', paths: [AGENT] }], 'the crawl alone: no link to it');
  const r = agents([['/agents/new', AGENT]]);
  assert.deepEqual(r.notReached, []);
  assert.deepEqual(r.reached['/agents/:agentId'], ['/home', '/agents', '/agents/new', AGENT]);
  // Another agent of the same room is reached by the one address.
  assert.deepEqual(agents([['/agents/new', AGENT]], new Set(), { 'J-agents-08#3': ['/agents/77aa'] }).notReached, []);
});

test('planted fault: a move from a room no path reaches leaves both unreached', () => {
  const r = agents([['/unreached', '/unreached/next']], new Set(), { 'J-x-01#1': ['/unreached', '/unreached/next'] });
  assert.deepEqual(r.notReached, [{ step: 'J-x-01#1', paths: ['/unreached', '/unreached/next'] }]);
  // Nor does a chain that starts there reach the record's room.
  assert.deepEqual(agents([['/unreached', AGENT]]).notReached, [{ step: 'J-agents-02#1', paths: [AGENT] }]);
});

test('planted fault: a move through a room the beta hides is dropped, at either end', () => {
  const hidden = new Set(['/hidden/room']);
  assert.deepEqual(agents([['/hidden/room', AGENT]], hidden).notReached, [{ step: 'J-agents-02#1', paths: [AGENT] }]);
  const r = agents(
    [
      ['/agents/new', '/hidden/room'],
      ['/hidden/room', AGENT],
    ],
    hidden,
  );
  assert.equal(r.reached['/hidden/room'], undefined);
  assert.deepEqual(r.notReached, [{ step: 'J-agents-02#1', paths: [AGENT] }]);
  // The same moves with nothing hidden do reach it: the drop is the beta's rule, not a missing link.
  assert.deepEqual(agents([['/hidden/room', AGENT]]).notReached, []);
});

/** A report of one crawl and steps, each { title, status, screens, moves }; the crawl's own moves are its own. */
const movesReport = (steps) => ({
  suites: [
    {
      title: 'a',
      specs: [
        {
          title: 'menu reach: the links from the front page and Home',
          file: 'menu-reach.pw.mjs',
          ok: true,
          tests: [
            {
              status: 'expected',
              annotations: [{ type: BETA_MOVES, description: JSON.stringify([['/hidden/room', AGENT]]) }],
              results: [{ annotations: [{ type: MENU_REACH, description: JSON.stringify(crawl(AGENT_EDGES, AGENT_OPENED)) }] }],
            },
          ],
        },
        ...steps.map(({ title, status = 'expected', ok = status === 'expected', shown, moves }) => ({
          title,
          ok,
          tests: [
            {
              status,
              annotations: [
                { type: BETA_SCREENS, description: JSON.stringify(shown) },
                ...(moves ? [{ type: BETA_MOVES, description: typeof moves === 'string' ? moves : JSON.stringify(moves) }] : []),
              ],
              results: [],
            },
          ],
        })),
      ],
    },
  ],
});

test('readReport: moves only from steps that passed first time, never from the crawl, a bad annotation none', () => {
  const { moves } = readReport(
    movesReport([
      { title: 'J-agents-02 #1 a', shown: [AGENT], moves: [['/agents/new', AGENT]] },
      { title: 'J-agents-02 #2 again', shown: [AGENT], moves: [['/agents/new', AGENT]] }, // the same move once
      { title: 'J-agents-03 #1 failed', status: 'unexpected', shown: [], moves: [['/agents', '/unreached']] },
      { title: 'J-agents-03 #2 flaky', status: 'flaky', shown: [], moves: [['/agents', '/unreached/next']] },
      { title: 'J-agents-03 #3 ok but not', ok: false, status: 'expected', shown: [], moves: [['/agents', '/x']] },
      { title: 'J-agents-04 #1 junk', shown: [], moves: 'not json' },
      { title: 'J-agents-04 #2 odd', shown: [], moves: [['/a'], ['/a', 7], ['http://x.test/a', '/b'], 'x'] },
      { title: 'J-agents-04 setup', shown: [], moves: [['/agents', '/y']] }, // not a step
    ]),
  );
  assert.deepEqual(moves, [['/agents/new', AGENT]]);
});

test('planted fault: a step that failed made its move, and the room stays unreached', () => {
  const read = readReport(
    movesReport([
      { title: 'J-agents-02 #1 shows', shown: [AGENT] },
      { title: 'J-agents-02 #2 fails', status: 'unexpected', shown: [AGENT], moves: [['/agents/new', AGENT]] },
    ]),
  );
  assert.deepEqual(read.moves, []);
  const r = menuReach({ ...read, roomOf: roomOfAgents, hidden: new Set() });
  assert.deepEqual(
    r.notReached.map((x) => x.step),
    ['J-agents-02#1', 'J-agents-02#2'],
  );
});

/** A page as Playwright drives it: typed entries navigate while they run; `app(url)` is a click the app follows. */
function drivenPage() {
  const page = new EventEmitter();
  let url = 'about:blank';
  const main = { url: () => url };
  const nav = (next) => ((url = new URL(next, 'http://127.0.0.1:5173').href), page.emit('framenavigated', main));
  page.mainFrame = () => main;
  page.url = () => url;
  page.goto = async (next) => nav(next);
  page.app = nav;
  return page;
}

test('planted fault: a room entered by page.goto, recorded by journey.mjs’s recorder, stays unreached; a click reaches it', async () => {
  const recorder = makeMoves((u) => new URL(u).port === '5173');
  const run = async (drive) => {
    const page = drivenPage();
    recorder.watch(page);
    const seen = recorder.begin();
    await drive(page);
    const note = recorder.end(seen);
    const report = movesReport([{ title: 'J-agents-02 #1 opens it', shown: [AGENT] }]);
    if (note) report.suites[0].specs[1].tests[0].annotations.push(note);
    return menuReach({ ...readReport(report), roomOf: roomOfAgents, hidden: new Set() });
  };
  const typed = await run(async (page) => {
    await page.goto('/agents/new');
    await page.goto(AGENT);
  });
  assert.deepEqual(typed.notReached, [{ step: 'J-agents-02#1', paths: [AGENT] }]);
  const clicked = await run(async (page) => {
    await page.goto('/agents/new');
    page.app(AGENT);
  });
  assert.deepEqual(clicked.notReached, []);
});

test('the CLI reads the moves, counts them, and passes their paths to the beta rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'menu-reach-moves-'));
  writeFileSync(
    join(dir, 'report.json'),
    JSON.stringify(
      movesReport([
        { title: 'J-agents-02 #1 a', shown: [AGENT], moves: [['/agents/new', AGENT]] },
        { title: 'J-agents-02 #2 b', shown: ['/agents/hidden-one'], moves: [['/agents/new', '/agents/hidden-one']] },
      ]),
    ),
  );
  writeFileSync(
    join(dir, 'rule.mjs'),
    "import { readFileSync } from 'node:fs'; const p = JSON.parse(readFileSync(0, 'utf8')); process.stdout.write(JSON.stringify({ hidden: p.filter((x) => x.includes('hidden')) }));\n",
  );
  writeFileSync(
    join(dir, 'routes.mjs'),
    "export const findRoom = (p) => (['/', '/home', '/agents', '/agents/new'].includes(p) ? { path: p } : p.startsWith('/agents/') ? { path: '/agents/:agentId' } : undefined);\n",
  );
  const cli = fileURLToPath(new URL('./menu-reach.mjs', import.meta.url));
  execFileSync(
    process.execPath,
    [
      cli,
      '--report',
      join(dir, 'report.json'),
      '--out',
      join(dir, 'out.json'),
      '--beta-rule',
      join(dir, 'rule.mjs'),
      '--routes',
      join(dir, 'routes.mjs'),
    ],
    { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } },
  );
  const out = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
  assert.equal(out.moves, 2);
  assert.deepEqual(out.notReached, []);
  assert.deepEqual(out.reached['/agents/:agentId'], ['/home', '/agents', '/agents/new', AGENT]);
});
