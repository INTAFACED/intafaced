// node --test tooling/scripts/journey-reach.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INCOMPLETE,
  POSITIONS_SUFFIX,
  REACH_ATTACHMENT,
  decodeMappings,
  executedRanges,
  loadScript,
  makeLogReader,
  makeRecorder,
  mergeRanges,
  originalAt,
  reduceMaps,
  spanSources,
  requestKey,
  routeOf,
  routeTable,
} from './journey-reach.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const vlq = (n) => {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let d = v & 31;
    v >>>= 5;
    if (v) d |= 32;
    out += B64[d];
  } while (v);
  return out;
};
/** mappings from [[genLine0, genCol, src, srcLine0]] (absolute; encoded relative as the format wants). */
function encode(points) {
  const byLine = [];
  for (const p of points) (byLine[p[0]] ??= []).push(p);
  let src = 0;
  let line = 0;
  const out = [];
  for (let l = 0; l < byLine.length; l++) {
    let col = 0;
    out.push(
      (byLine[l] ?? [])
        .sort((a, b) => a[1] - b[1])
        .map(([, c, s, sl]) => {
          const seg = vlq(c - col) + vlq(s - src) + vlq(sl - line) + vlq(0);
          col = c;
          src = s;
          line = sl;
          return seg;
        })
        .join(','),
    );
  }
  return out.join(';');
}

// A built script: line 0 holds two functions from two sources; line 1 the top level of a dependency.
const SCRIPT = 'function a(){return 1}function b(){return 2}\nconsole.log(a());\n';
const SECRET_SOURCE = 'const token = "sk_live_PLANTED_SOURCE_TEXT";';
const ROOT = mkdtempSync(path.join(tmpdir(), 'journey-reach-'));
const DIST = path.join(ROOT, 'apps/customer/dist');
mkdirSync(path.join(DIST, 'assets/sub'), { recursive: true });
writeFileSync(path.join(DIST, 'assets/index-1a2b.js'), SCRIPT);
writeFileSync(
  path.join(DIST, 'assets/index-1a2b.js.map'),
  JSON.stringify({
    version: 3,
    sources: ['../../src/a.ts', '../../../../packages/ui/src/b.ts', '../../../../node_modules/react/index.js'],
    sourcesContent: [SECRET_SOURCE, SECRET_SOURCE, SECRET_SOURCE],
    names: ['PLANTED_NAME'],
    mappings: encode([
      [0, 0, 0, 9],
      [0, 13, 0, 11],
      [0, 22, 1, 3],
      [0, 35, 1, 4],
      [1, 0, 2, 0],
    ]),
  }),
);
writeFileSync(path.join(DIST, 'assets/nomap-1.js'), 'x');
writeFileSync(path.join(DIST, 'assets/sub/broken-1.js.map'), '{not json');
writeFileSync(path.join(DIST, 'assets/style-1.css.map'), '{}');
const reduced = reduceMaps(ROOT, DIST);
const ROUTES = ['/api/identity', '/api/bank', '/api/v1'];

test('reduceMaps: every .map is deleted; a script map becomes positions only, with no source text or names', () => {
  assert.deepEqual(reduced, { reduced: 1, dropped: 2 });
  const all = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : all.push(e.name);
  };
  walk(DIST);
  assert.deepEqual(
    all.filter((f) => f.endsWith('.map')),
    [],
    'no .map file is left in the build',
  );
  const pos = readFileSync(path.join(DIST, `assets/index-1a2b.js${POSITIONS_SUFFIX}`), 'utf8');
  assert.doesNotMatch(pos, /PLANTED/, 'neither source text nor names');
  assert.deepEqual(Object.keys(JSON.parse(pos)).sort(), ['lines', 'sources', 'v']);
  assert.deepEqual(JSON.parse(pos).sources, ['apps/customer/src/a.ts', 'packages/ui/src/b.ts', null]);
});

test('routeTable reads Edge’s own prefixes; routeOf takes only a whole prefix', () => {
  const real = routeTable(REPO);
  assert.ok(real.includes('/api/bank') && real.includes('/api/identity'), 'the table is read from services/svc-edge/src/routes.ts');
  assert.ok(real.every((r) => /^\/api\/[a-z0-9/-]+$/.test(r)));
  assert.equal(routeOf(ROUTES, '/api/bank/accounts/7'), '/api/bank');
  assert.equal(routeOf(ROUTES, '/api/bankrupt/x'), null);
  assert.equal(routeOf(ROUTES, '/accounts/7'), null);
});

test('requestKey: port, a fixed method and an Edge prefix, nothing else of the URL', () => {
  assert.equal(requestKey(ROUTES, 'http://127.0.0.1:14509/accounts/7?token=abc', 'post'), '14509 POST');
  assert.equal(requestKey(ROUTES, 'http://127.0.0.1:3210/api/bank/cards/42', 'GET'), '3210 GET /api/bank');
  assert.equal(requestKey(ROUTES, 'ws://localhost:3210/ws?session=s3cr3t'), '3210 WS');
  assert.equal(requestKey(ROUTES, 'http://127.0.0.1:14500/x', 'BREW'), '14500 OTHER');
  assert.equal(requestKey(ROUTES, 'https://example.com/a'), null, 'an outside host is not the stack');
  assert.equal(requestKey(ROUTES, 'data:text/plain,hi'), null);
  assert.equal(requestKey(ROUTES, 'not a url'), null);
});

test('positions: a generated offset maps to its source line', () => {
  const s = loadScript({ distDir: DIST, scriptPath: '/assets/index-1a2b.js' });
  assert.equal(s.error, undefined);
  assert.deepEqual(originalAt(s, 0), { source: 'apps/customer/src/a.ts', line: 10 });
  assert.deepEqual(originalAt(s, 20), { source: 'apps/customer/src/a.ts', line: 12 });
  assert.deepEqual(originalAt(s, 22), { source: 'packages/ui/src/b.ts', line: 4 });
  assert.equal(originalAt(s, SCRIPT.indexOf('console')), null, 'a dependency is not a repository source');
  assert.equal(decodeMappings('AAAA;;CACA').length, 3);
  assert.throws(() => decodeMappings('A!AA'), /bad base64/);
  assert.deepEqual(loadScript({ distDir: DIST, scriptPath: '/../../etc/passwd' }), { error: 'notBuilt' });
  assert.deepEqual(loadScript({ distDir: DIST, scriptPath: '/assets/gone.js' }), { error: 'notBuilt' });
  assert.deepEqual(loadScript({ distDir: DIST, scriptPath: '/assets/nomap-1.js' }), { noMap: true });
});

const fn = (name, start, end, count) => ({ functionName: name, ranges: [{ startOffset: start, endOffset: end, count }] });
const TOP = fn('', 0, SCRIPT.length, 1);

test('executedRanges: functions that ran, as source line ranges; the top level means the chunk loaded', () => {
  const s = loadScript({ distDir: DIST, scriptPath: '/assets/index-1a2b.js' });
  const r = executedRanges(s, [TOP, fn('a', 0, 22, 2), fn('b', 22, 44, 0)]);
  assert.equal(r.loaded, true);
  assert.deepEqual(r.sources, { 'apps/customer/src/a.ts': [[10, 12]] }, 'b never ran, so it is not listed');
  assert.deepEqual(
    mergeRanges([
      [5, 7],
      [1, 2],
      [3, 4],
      [10, 12],
      [11, 11],
    ]),
    [
      [1, 7],
      [10, 12],
    ],
  );
});

const cov = (functions, url = 'http://127.0.0.1:3210/assets/index-1a2b.js') => [{ url, functions }];

test('the recorder: per file, only what was not attached yet; no map, another build and a missing script', () => {
  const rec = makeRecorder({ root: ROOT, distDir: DIST, routes: ROUTES });
  const F = '/repo/apps/customer/tests/real-app/J-bank-13.pw.mjs';
  rec.request(F, 'http://127.0.0.1:14509/accounts/7', 'GET');
  rec.request(F, 'https://outside.example/x', 'GET');
  rec.coverage(F, cov([TOP, fn('a', 0, 22, 1)]));
  assert.equal(REACH_ATTACHMENT, 'journey-reach');
  assert.deepEqual(rec.take(F), {
    v: 2,
    file: 'J-bank-13.pw.mjs',
    http: ['14509 GET'],
    served: [],
    active: [],
    chunks: ['/assets/index-1a2b.js'],
    sources: { 'apps/customer/src/a.ts': [[10, 12]] },
    table: { '/assets/index-1a2b.js': ['apps/customer/src/a.ts', 'packages/ui/src/b.ts'] },
    nomap: [],
    incomplete: [],
  });
  rec.request(F, 'http://127.0.0.1:14509/accounts/8', 'GET');
  rec.coverage(F, cov([TOP, fn('a', 0, 22, 1)]));
  assert.equal(rec.take(F), null, 'nothing new: no record');
  rec.coverage(F, cov([fn('b', 22, 44, 3)]));
  assert.deepEqual(rec.take(F).sources, { 'packages/ui/src/b.ts': [[4, 5]] });
  rec.coverage(F, cov([TOP], 'http://127.0.0.1:3100/_next/static/chunks/main.js'));
  assert.equal(rec.take(F), null, 'another port is not the customer app');
  rec.coverage(F, cov([fn('', 0, 1, 1)], 'http://127.0.0.1:3210/assets/nomap-1.js'));
  assert.deepEqual(rec.take(F).nomap, ['/assets/nomap-1.js'], 'a script with no positions is named, not incomplete');
  rec.coverage(F, cov([fn('', 0, 1, 1)], 'http://127.0.0.1:3210/assets/nomap-1.js'));
  assert.equal(rec.take(F), null, 'named once per worker');
  rec.coverage(F, cov([fn('', 0, 1, 1)], 'http://127.0.0.1:3210/assets/elsewhere-9.js'));
  assert.deepEqual(rec.take(F).incomplete, ['notBuilt']);
  rec.coverage(F, cov([fn('', 0, 999, 1)]));
  assert.deepEqual(rec.take(F).incomplete, ['otherBuild']);
  rec.afterAll(F);
  assert.deepEqual(rec.files(), [F]);
  assert.equal(rec.take(F).afterAll, true);
  rec.incomplete(F, 'closed');
  rec.incomplete(F, 'Target closed: http://127.0.0.1:3210/account?token=PLANTED');
  assert.deepEqual(rec.take(F).incomplete, ['closed', 'noRead'], 'a reason is a fixed code, never the text given');
  assert.ok(Object.keys(INCOMPLETE).length >= 8);
});

test("the stack's logs: which service served, placed by each line's own time in the file that ran then", () => {
  const logs = path.join(ROOT, 'logs');
  mkdirSync(logs, { recursive: true });
  const line = (time, url, method = 'GET') =>
    JSON.stringify({ level: 30, time, reqId: 'req-1', req: { method, url, remoteAddress: '127.0.0.1' }, msg: 'incoming request' }) + '\n';
  writeFileSync(path.join(logs, 'bank.log'), line(1, '/before-the-run'));
  writeFileSync(path.join(logs, 'postgres.log'), 'LOG:  started\n');
  const reader = makeLogReader(logs);
  assert.deepEqual(reader.read(), [], "what was written before the reader started is nobody's");
  const rec = makeRecorder({ root: ROOT, distDir: DIST, routes: ROUTES });
  rec.enter('A', 100);
  rec.enter('B', 200);
  appendFileSync(path.join(logs, 'bank.log'), line(150, '/accounts/42/cards?x=1') + line(250, '/api/bank/x', 'post') + '{"half":');
  appendFileSync(path.join(logs, 'ledger.log'), JSON.stringify({ level: 30, time: 260, msg: 'event handled' }) + '\n');
  appendFileSync(path.join(logs, 'postgres.log'), 'LOG:  checkpoint\n');
  rec.served(reader.read(), 'B');
  const a = rec.take('A');
  const b = rec.take('B');
  assert.deepEqual([a.served, a.active], [['bank GET'], ['bank']], "a line written while A ran is A's, even read later");
  assert.deepEqual([b.served, b.active], [['bank POST /api/bank'], ['bank', 'ledger', 'postgres']]);
  appendFileSync(path.join(logs, 'bank.log'), '"done"}\n');
  assert.equal(reader.read().length, 1, 'a partial last line is read once it ends');
  writeFileSync(path.join(logs, 'bank.log'), line(300, '/again'));
  assert.equal(reader.read()[0].path, '/again', 'a log that shrank is read from its start');
});

test('planted: a token, an email and an id in a log line or a request leave no trace in the record', () => {
  const PLANTED = [
    'eyJhbGciOiJIUzI1NiJ9.PLANTEDTOKEN.sig',
    'ghp_PLANTEDghpTOKEN0123456789abcdef',
    'planted.person@example.test',
    '0x9fA1PLANTED00000000000000000000000000ab',
    '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    'PLANTED-ID-424242',
  ];
  const logs = path.join(ROOT, 'logs-planted');
  mkdirSync(logs, { recursive: true });
  writeFileSync(path.join(logs, 'identity.log'), '');
  const reader = makeLogReader(logs);
  const rec = makeRecorder({ root: ROOT, distDir: DIST, routes: ROUTES });
  rec.enter('J-identity-01.pw.mjs', 0);
  const lines = [
    {
      level: 30,
      time: 5,
      msg: 'incoming request',
      req: {
        method: 'POST',
        url: `/api/identity/users/${PLANTED[2]}/sessions/${PLANTED[4]}?token=${PLANTED[0]}`,
        headers: { authorization: `Bearer ${PLANTED[1]}` },
      },
    },
    { level: 30, time: 6, msg: `login for ${PLANTED[2]} with ${PLANTED[1]}`, user: PLANTED[5] },
    { level: 30, time: 7, msg: 'incoming request', req: { method: PLANTED[0], url: `/${PLANTED[3]}` } },
  ];
  writeFileSync(
    path.join(logs, 'identity.log'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\nplain text ' + PLANTED.join(' ') + '\n',
  );
  rec.served(reader.read(), 'J-identity-01.pw.mjs');
  rec.request(
    'J-identity-01.pw.mjs',
    `http://127.0.0.1:3210/api/identity/u/${PLANTED[2]}/${PLANTED[5]}?k=${PLANTED[1]}#${PLANTED[0]}`,
    'GET',
  );
  rec.request('J-identity-01.pw.mjs', `ws://127.0.0.1:14523/${PLANTED[4]}?t=${PLANTED[0]}`, 'WS');
  rec.incomplete('J-identity-01.pw.mjs', `failed for ${PLANTED[1]}`);
  // A planted log name and a planted script path are passed over as well.
  writeFileSync(path.join(logs, `${PLANTED[2]}.log`), JSON.stringify(lines[0]) + '\n');
  rec.served(reader.read(), 'J-identity-01.pw.mjs');
  rec.coverage('J-identity-01.pw.mjs', cov([fn('', 0, 1, 1)], `http://127.0.0.1:3210/assets/${PLANTED[2]}.js?t=${PLANTED[0]}`));
  const record = JSON.stringify(rec.take('J-identity-01.pw.mjs'));
  for (const p of PLANTED) assert.equal(record.includes(p), false, `${p} leaked into ${record}`);
  assert.doesNotMatch(record, /PLANTED|example\.test|Bearer|token|sessions|users/i);
  assert.deepEqual(JSON.parse(record).served, ['identity OTHER', 'identity POST /api/identity']);
  assert.deepEqual(JSON.parse(record).http, ['14523 WS', '3210 GET /api/identity']);
});

test('spanSources (#7512 review): a function counts in every source its span maps to, and is never cut short', () => {
  // Line 0: bundler code with no segment at cols 0-4, then a.ts from col 5, then b.ts from col 20 (scope hoisting).
  const script = {
    text: 'x'.repeat(40),
    starts: [0, 30],
    lines: [
      [
        [5, 0, 9],
        [12, 0, 14],
        [20, 1, 2],
      ],
      [[0, 1, 7]],
    ],
    sources: ['apps/customer/src/a.ts', 'packages/ui/src/b.ts', null],
  };
  assert.deepEqual(
    spanSources(script, 0, 25),
    { 'apps/customer/src/a.ts': [10, 15], 'packages/ui/src/b.ts': [3, 3] },
    'a start before the first segment',
  );
  assert.deepEqual(spanSources(script, 13, 35), { 'apps/customer/src/a.ts': [15, 15], 'packages/ui/src/b.ts': [3, 8] }, 'across two lines');
  assert.deepEqual(spanSources(script, 0, 4), {}, 'a span no segment maps is bundler code');
  assert.deepEqual(executedRanges(script, [fn('f', 0, 25, 1)]).sources, {
    'apps/customer/src/a.ts': [[10, 15]],
    'packages/ui/src/b.ts': [[3, 3]],
  });
});

test('the recorder (#7512 review): another folder served is otherDist; a file with afterAll hooks marks them due', () => {
  const rec = makeRecorder({ root: ROOT, distDir: null, routes: ROUTES });
  rec.coverage('A', cov([TOP, fn('a', 0, 22, 1)]));
  assert.deepEqual(rec.take('A').incomplete, ['otherDist']);
  const rec2 = makeRecorder({ root: ROOT, distDir: DIST, routes: ROUTES });
  rec2.declaresAfterAll('B');
  rec2.request('B', 'http://127.0.0.1:14509/x', 'GET');
  assert.equal(rec2.take('B').afterAllDue, true, 'due until its afterAll record comes');
  rec2.request('B', 'http://127.0.0.1:14510/x', 'GET');
  rec2.afterAll('B');
  const last = rec2.take('B');
  assert.equal(last.afterAll, true);
  assert.equal(last.afterAllDue, undefined);
  rec2.request('C', 'http://127.0.0.1:14509/x', 'GET');
  assert.equal(rec2.take('C').afterAllDue, undefined, 'a file with no afterAll hooks owes none');
});

test("the stack's logs (#7512 review): a character split across two reads is decoded whole", () => {
  const logs = mkdtempSync(path.join(tmpdir(), 'journey-reach-logs-'));
  writeFileSync(path.join(logs, 'bank.log'), '');
  const reader = makeLogReader(logs);
  const whole = Buffer.from(JSON.stringify({ time: 1, req: { method: 'GET', url: '/api/bank/ü' }, msg: 'incoming request' }) + '\n');
  const cut = whole.indexOf(Buffer.from('ü')) + 1;
  appendFileSync(path.join(logs, 'bank.log'), whole.subarray(0, cut));
  assert.deepEqual(reader.read(), []);
  appendFileSync(path.join(logs, 'bank.log'), whole.subarray(cut));
  const [l] = reader.read();
  assert.equal(l.path, '/api/bank/ü');
  assert.equal(l.served, true);
});
