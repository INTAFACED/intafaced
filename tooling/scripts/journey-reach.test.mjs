// node --test tooling/scripts/journey-reach.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  REACH_ATTACHMENT,
  decodeMappings,
  executedRanges,
  loadScript,
  makeLogReader,
  makeRecorder,
  mergeRanges,
  originalAt,
  pathTemplate,
  repoSource,
} from './journey-reach.mjs';

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
/** mappings from [[genLine0, genCol, src, srcLine0]] (absolute values; encoded relative as the format wants). */
function encode(points) {
  const byLine = [];
  for (const p of points) (byLine[p[0]] ??= []).push(p);
  let src = 0;
  let line = 0;
  const out = [];
  for (let l = 0; l < byLine.length; l++) {
    let col = 0;
    const segs = (byLine[l] ?? [])
      .sort((a, b) => a[1] - b[1])
      .map(([, c, s, sl]) => {
        const seg = vlq(c - col) + vlq(s - src) + vlq(sl - line) + vlq(0);
        col = c;
        src = s;
        line = sl;
        return seg;
      });
    out.push(segs.join(','));
  }
  return out.join(';');
}

// A built script: line 0 holds two functions from two sources; line 1 the top level of a third.
const SCRIPT = 'function a(){return 1}function b(){return 2}\nconsole.log(a());\n';
const ROOT = mkdtempSync(path.join(tmpdir(), 'journey-reach-'));
const DIST = path.join(ROOT, 'apps/customer/dist');
mkdirSync(path.join(DIST, 'assets'), { recursive: true });
writeFileSync(path.join(DIST, 'assets/index-1a2b.js'), SCRIPT);
writeFileSync(
  path.join(DIST, 'assets/index-1a2b.js.map'),
  JSON.stringify({
    version: 3,
    sources: ['../../src/a.ts', '../../../../packages/ui/src/b.ts', '../../../../node_modules/react/index.js'],
    mappings: encode([
      [0, 0, 0, 9], // function a: apps/customer/src/a.ts line 10
      [0, 13, 0, 11], // its body ends at line 12
      [0, 22, 1, 3], // function b: packages/ui/src/b.ts line 4
      [0, 35, 1, 4],
      [1, 0, 2, 0], // the top level: react
    ]),
  }),
);
writeFileSync(path.join(DIST, 'assets/nomap-1.js'), 'x');

test('pathTemplate and requestKey: ids, hashes, emails and addresses read :id; no query, host or body', async () => {
  const { requestKey } = await import('./journey-reach.mjs');
  assert.equal(pathTemplate('/api/bank/accounts/123/cards'), '/api/bank/accounts/:id/cards');
  assert.equal(pathTemplate('/api/trade/orders/0x9fA1/cancel'), '/api/trade/orders/:id/cancel');
  assert.equal(pathTemplate('/api/identity/users/a@b.test'), '/api/identity/users/:id');
  assert.equal(pathTemplate('/api/x/3f2504e0-4f89-11d3-9a0c-0305e82c3301'), '/api/x/:id');
  assert.equal(pathTemplate('/api/markets/BTC-USDT/book'), '/api/markets/:id/book');
  assert.equal(pathTemplate('/assets/PublicRoutes-Bhg9FGwS.js'), '/assets/:file');
  assert.equal(pathTemplate('/customer-deployment.json'), '/:file');
  assert.equal(pathTemplate('/health'), '/health');
  assert.equal(requestKey('http://127.0.0.1:14509/accounts/7?x=1', 'post'), '14509 POST /accounts/:id');
  assert.equal(requestKey('ws://localhost:3210/ws', 'WS'), '3210 WS /ws');
  assert.equal(requestKey('https://example.com/a'), null, 'an outside host is not the stack');
  assert.equal(requestKey('data:text/plain,hi'), null);
  assert.equal(requestKey('not a url'), null);
});

test('decodeMappings and originalAt: a generated offset maps to its source line', () => {
  const s = loadScript({ root: ROOT, distDir: DIST, scriptPath: '/assets/index-1a2b.js' });
  assert.equal(s.error, undefined);
  assert.deepEqual(s.sources, ['apps/customer/src/a.ts', 'packages/ui/src/b.ts', null], 'a dependency maps to no repository source');
  assert.deepEqual(originalAt(s, 0), { source: 'apps/customer/src/a.ts', line: 10 });
  assert.deepEqual(originalAt(s, 20), { source: 'apps/customer/src/a.ts', line: 12 });
  assert.deepEqual(originalAt(s, 22), { source: 'packages/ui/src/b.ts', line: 4 });
  assert.equal(originalAt(s, SCRIPT.indexOf('console')), null, 'react is not a repository source');
  assert.equal(decodeMappings('AAAA;;CACA').length, 3);
  assert.throws(() => decodeMappings('A!AA'), /bad base64/);
});

test('loadScript refuses a script outside the build, missing, or with no map', () => {
  assert.match(loadScript({ root: ROOT, distDir: DIST, scriptPath: '/../../../etc/passwd' }).error, /outside the build/);
  assert.match(loadScript({ root: ROOT, distDir: DIST, scriptPath: '/assets/gone.js' }).error, /not in the build/);
  assert.match(loadScript({ root: ROOT, distDir: DIST, scriptPath: '/assets/nomap-1.js' }).error, /no source map/);
  assert.equal(repoSource(ROOT, path.join(DIST, 'x.map'), '../../../../../outside.ts'), null);
});

const fn = (name, start, end, count) => ({ functionName: name, ranges: [{ startOffset: start, endOffset: end, count }] });
const TOP = fn('', 0, SCRIPT.length, 1);

test('executedRanges: functions that ran, as source line ranges; the top level means the chunk loaded', () => {
  const s = loadScript({ root: ROOT, distDir: DIST, scriptPath: '/assets/index-1a2b.js' });
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

test('the recorder: per file, only what was not attached yet; an unmappable or foreign build is incomplete', () => {
  const rec = makeRecorder({ root: ROOT, distDir: DIST });
  const F = '/repo/apps/customer/tests/real-app/J-bank-13.pw.mjs';
  rec.request(F, 'http://127.0.0.1:14509/accounts/7', 'GET');
  rec.request(F, 'https://outside.example/x', 'GET');
  const cov = (functions, url = 'http://127.0.0.1:3210/assets/index-1a2b.js') => [{ url, functions }];
  rec.coverage(F, cov([TOP, fn('a', 0, 22, 1)]));
  const first = rec.take(F);
  assert.equal(REACH_ATTACHMENT, 'journey-reach');
  assert.deepEqual(first, {
    v: 1,
    file: 'J-bank-13.pw.mjs',
    http: ['14509 GET /accounts/:id'],
    served: [],
    active: [],
    chunks: ['/assets/index-1a2b.js'],
    sources: { 'apps/customer/src/a.ts': [[10, 12]] },
    table: { '/assets/index-1a2b.js': ['apps/customer/src/a.ts', 'packages/ui/src/b.ts'] },
    nomap: [],
    incomplete: [],
  });
  // The same again adds nothing; a new function does.
  rec.request(F, 'http://127.0.0.1:14509/accounts/8', 'GET');
  rec.coverage(F, cov([TOP, fn('a', 0, 22, 1)]));
  assert.equal(rec.take(F), null, 'nothing new: no record');
  rec.coverage(F, cov([fn('b', 22, 44, 3)]));
  assert.deepEqual(rec.take(F).sources, { 'packages/ui/src/b.ts': [[4, 5]] });
  // Another port's script is not the customer app's; one with no map, or a build of another length, is incomplete.
  rec.coverage(F, cov([TOP], 'http://127.0.0.1:3100/_next/static/chunks/main.js'));
  assert.equal(rec.take(F), null);
  rec.coverage(F, cov([fn('', 0, 1, 1)], 'http://127.0.0.1:3210/assets/nomap-1.js'));
  const nomap = rec.take(F);
  assert.deepEqual([nomap.nomap, nomap.incomplete], [['/assets/nomap-1.js'], []], 'a script with no map is named, not incomplete');
  rec.coverage(F, cov([fn('', 0, 1, 1)], 'http://127.0.0.1:3210/assets/nomap-1.js'));
  assert.equal(rec.take(F), null, 'named once per worker');
  rec.coverage(F, cov([fn('', 0, 1, 1)], 'http://127.0.0.1:3210/assets/served-elsewhere.js'));
  assert.match(rec.take(F).incomplete[0], /can't be mapped \(not in the build/, 'a script the build on disk lacks is incomplete');
  rec.coverage(F, cov([fn('', 0, 999, 1)]));
  assert.match(rec.take(F).incomplete[0], /ran with 999 characters, the build on disk has/);
  // A script that ran nothing is passed over; an anonymous script has no file.
  rec.coverage(F, [
    { url: '', functions: [fn('', 0, 3, 1)] },
    { url: 'http://127.0.0.1:3210/assets/index-1a2b.js', functions: [fn('a', 0, 22, 0)] },
  ]);
  assert.equal(rec.take(F), null);
  // A file's afterAll hooks: their record says so, even with nothing new in it.
  rec.afterAll(F);
  assert.deepEqual(rec.files(), [F]);
  assert.equal(rec.take(F).afterAll, true);
  rec.incomplete(F, 'a page closed before its coverage was read');
  assert.deepEqual(rec.take(F).incomplete, ['a page closed before its coverage was read']);
});

test("the stack's logs: what each service served, placed by each line's own time in the file that ran then", () => {
  const logs = path.join(ROOT, 'logs');
  mkdirSync(logs, { recursive: true });
  const line = (time, url, method = 'GET') =>
    JSON.stringify({ level: 30, time, reqId: 'req-1', req: { method, url, remoteAddress: '127.0.0.1' }, msg: 'incoming request' }) + '\n';
  writeFileSync(path.join(logs, 'bank.log'), line(1, '/before-the-run'));
  writeFileSync(path.join(logs, 'postgres.log'), 'LOG:  started\n');
  const reader = makeLogReader(logs);
  assert.deepEqual(reader.read(), [], "what was written before the reader started is nobody's");
  const rec = makeRecorder({ root: ROOT, distDir: DIST });
  rec.enter('A', 100);
  rec.enter('B', 200);
  appendFileSync(path.join(logs, 'bank.log'), line(150, '/accounts/42/cards?x=1') + line(250, '/accounts/43/cards', 'post') + '{"half":');
  appendFileSync(path.join(logs, 'ledger.log'), JSON.stringify({ level: 30, time: 260, msg: 'event handled' }) + '\n');
  appendFileSync(path.join(logs, 'postgres.log'), 'LOG:  checkpoint\n');
  rec.served(reader.read(), 'B');
  const a = rec.take('A');
  const b = rec.take('B');
  assert.deepEqual(
    [a.served, a.active],
    [['bank GET /accounts/:id/cards'], ['bank']],
    "a line written while A ran is A's, even read later",
  );
  assert.deepEqual([b.served, b.active], [['bank POST /accounts/:id/cards'], ['bank', 'ledger', 'postgres']]);
  appendFileSync(path.join(logs, 'bank.log'), '"done"}\n');
  assert.deepEqual(reader.read().length, 1, 'a partial last line is read once it ends');
  writeFileSync(path.join(logs, 'bank.log'), line(300, '/again'));
  assert.equal(reader.read()[0].url, '/again', 'a log that shrank is read from its start');
});
