// The published-routes gate, replayed on the route changes that lost their push while the route list was kept by hand
// in three places. Each test copies svc-trade's sources and the customer app's two files into a scratch checkout and
// runs the gate there, as .githooks/pre-push does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generatedLines, generatedText, wordsProblems } from './published-routes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = join(ROOT, 'tooling/ci/published-routes.mjs');
const TRADE = 'services/svc-trade/src';
const GENERATED = 'apps/customer/src/features/developers/served-routes.generated.ts';
const REFERENCE = 'apps/customer/src/features/developers/developers-reference.ts';

/** A scratch checkout holding svc-trade's route sources and the customer app's generated file and route words. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'published-routes-'));
  cpSync(join(ROOT, TRADE), join(dir, TRADE), {
    recursive: true,
    filter: (src) => !src.endsWith('.test.ts') && (!/\.\w+$/.test(src) || src.endsWith('.ts')),
  });
  cpSync(join(ROOT, TRADE, 'route-declarations.test-harness.ts'), join(dir, TRADE, 'route-declarations.test-harness.ts'));
  for (const file of [GENERATED, REFERENCE]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(ROOT, file), join(dir, file));
  }
  const edit = (file, from, to) => {
    const text = readFileSync(join(dir, file), 'utf8');
    assert.ok(text.includes(from), `${file} holds ${from.slice(0, 80)}`);
    writeFileSync(join(dir, file), text.replace(from, to));
  };
  const gate = (...args) => {
    const r = spawnSync(process.execPath, [GATE, ...args], { cwd: dir, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  /** Every file the scratch checkout holds that differs from this checkout's copy. */
  const changed = () =>
    [GENERATED, REFERENCE, 'services/svc-trade/src/venue/user-venue-rest.ts', 'services/svc-trade/src/private-rest.ts'].filter(
      (file) => readFileSync(join(dir, file), 'utf8') !== readFileSync(join(ROOT, file), 'utf8'),
    );
  return { dir, edit, gate, changed, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const HISTORY = "app.get<{ Querystring: Query & Record<string, string | undefined> }>('/api/v1/venue/orders/history', privateRead,";
const RECORD = "app.get<{ Querystring: Query }>('/api/v1/venue/orders/record', privateRead,";

/** This checkout's text with #8571's two routes taken out: the registrations unmounted, their lines and words gone. */
function before8571(s) {
  s.edit('services/svc-trade/src/venue/user-venue-rest.ts', HISTORY, HISTORY.replace('app.get', 'void').replace(', privateRead,', ','));
  s.edit('services/svc-trade/src/venue/user-venue-rest.ts', RECORD, RECORD.replace('app.get', 'void').replace(', privateRead,', ','));
  const generated = readFileSync(join(s.dir, GENERATED), 'utf8');
  const lines = generatedLines(generated).filter((line) => !/^GET \/api\/v1\/venue\/orders\/(history|record) /.test(line));
  writeFileSync(join(s.dir, GENERATED), generatedText(lines));
  const reference = readFileSync(join(s.dir, REFERENCE), 'utf8');
  const row = (name) => {
    const start = reference.lastIndexOf('\n  {', reference.indexOf(`name: '${name}'`));
    return reference.slice(start, reference.indexOf('\n  },', start) + 5);
  };
  const rows = row('venueOrderHistory') + row('venueOrderRecord');
  writeFileSync(join(s.dir, REFERENCE), reference.replace(row('venueOrderHistory'), '').replace(row('venueOrderRecord'), ''));
  return rows;
}

test('replay #8571: its registrations fail before the push, naming the command and the words; the command and the words are all it needs', () => {
  const s = scratch();
  try {
    const rows = before8571(s);
    assert.equal(s.gate().code, 0, 'the checkout before #8571 passes');
    // #8571's first commit (a0112ab493): the two registrations alone.
    s.edit('services/svc-trade/src/venue/user-venue-rest.ts', HISTORY.replace('app.get', 'void').replace(', privateRead,', ','), HISTORY);
    s.edit('services/svc-trade/src/venue/user-venue-rest.ts', RECORD.replace('app.get', 'void').replace(', privateRead,', ','), RECORD);
    const first = s.gate();
    assert.equal(first.code, 1);
    assert.match(first.out, /served-routes\.generated\.ts is stale: run `node tooling\/ci\/published-routes\.mjs --write` and commit it/);
    assert.match(first.out, /registered, not in the file: GET \/api\/v1\/venue\/orders\/history private trade:read/);
    assert.match(first.out, /served with no words: GET \/api\/v1\/venue\/orders\/record/);
    // The command writes the access and scopes; only the routes' words are left, the prose the change itself writes.
    assert.equal(s.gate('--write').code, 1);
    const words = s.gate();
    assert.doesNotMatch(words.out, /is stale/);
    assert.match(words.out, /served with no words: GET \/api\/v1\/venue\/orders\/history/);
    // #8571's words for its routes, with no access line: no list is edited by hand.
    const reference = readFileSync(join(s.dir, REFERENCE), 'utf8');
    const anchor = "    name: 'venueFills',";
    const at = reference.lastIndexOf('\n  {', reference.indexOf(anchor));
    writeFileSync(join(s.dir, REFERENCE), reference.slice(0, at) + rows + reference.slice(at));
    const after = s.gate();
    assert.equal(after.code, 0, after.out);
    // The result is this checkout's own files: the generated file and the words as main holds them.
    assert.deepEqual(s.changed(), []);
  } finally {
    s.done();
  }
});

test('replay #8146: a route that comes to need a second scope passes once the command is run, with no hand edit of a second file', () => {
  const s = scratch();
  try {
    // Before #8146 the lead route asked only trade:write.
    const lead = "app.post('/api/v1/copy/lead/orders', privateWith('trade:write', 'copy:lead'),";
    s.edit('services/svc-trade/src/private-rest.ts', lead, "app.post('/api/v1/copy/lead/orders', privateWrite,");
    assert.equal(s.gate('--write').code, 0);
    assert.match(readFileSync(join(s.dir, GENERATED), 'utf8'), /'POST \/api\/v1\/copy\/lead\/orders private trade:write',/);
    // #8146's change to the registration.
    s.edit('services/svc-trade/src/private-rest.ts', "app.post('/api/v1/copy/lead/orders', privateWrite,", lead);
    const stale = s.gate();
    assert.equal(stale.code, 1);
    assert.match(stale.out, /is stale: run `node tooling\/ci\/published-routes\.mjs --write`/);
    assert.match(stale.out, /registered, not in the file: POST \/api\/v1\/copy\/lead\/orders private trade:write\+copy:lead/);
    assert.equal(s.gate('--write').code, 0);
    assert.equal(s.gate().code, 0);
    assert.deepEqual(s.changed(), []);
  } finally {
    s.done();
  }
});

test('a route removed from svc-trade leaves the file stale and its words named, so neither copy outlives the route', () => {
  const s = scratch();
  try {
    s.edit('services/svc-trade/src/venue/user-venue-rest.ts', HISTORY, HISTORY.replace('app.get', 'void').replace(', privateRead,', ','));
    const r = s.gate();
    assert.equal(r.code, 1);
    assert.match(r.out, /in the file, not registered: GET \/api\/v1\/venue\/orders\/history private trade:read/);
    assert.match(r.out, /worded, not served: GET \/api\/v1\/venue\/orders\/history/);
  } finally {
    s.done();
  }
});

test('wordsProblems reads ROUTE_WORDS only, both ways', () => {
  const reference = [
    'export const ROUTE_WORDS: readonly RouteWords[] = [',
    "  { name: 'a', method: 'GET', path: '/api/v1/a', product: 'spot', summary: 'A' },",
    '  {',
    "    name: 'b',",
    "    method: 'POST',",
    "    path: '/api/v1/b',",
    "    product: 'spot',",
    "    summary: 'B',",
    '  },',
    '];',
    "const other = { method: 'GET', path: '/api/v1/c' };",
    '',
  ].join('\n');
  assert.deepEqual(wordsProblems(['GET /api/v1/a public trade:read', 'POST /api/v1/b private trade:write'], reference), []);
  assert.deepEqual(wordsProblems(['GET /api/v1/a public trade:read', 'GET /api/v1/c public trade:read'], reference), [
    'served with no words: GET /api/v1/c',
    'worded, not served: POST /api/v1/b',
  ]);
});
