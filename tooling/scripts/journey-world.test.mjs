// Proves the shared-world scan on the real journey files and on planted faults. Run: node --test tooling/scripts/journey-world.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOURNEY_DIR, WORLD, declaredWorld, directWorld, fileWorld, helperWorld, scan, worldFiles } from './journey-world.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL = path.join(ROOT, JOURNEY_DIR);
const SCRIPT = path.join(ROOT, 'tooling/scripts/journey-world.mjs');

/** A journey folder in a temp dir: the real helper modules, and the journey files given (name → source). */
function plant(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-world-'));
  for (const f of fs.readdirSync(REAL).filter((f) => f.endsWith('.mjs') && !f.endsWith('.pw.mjs')))
    fs.copyFileSync(path.join(REAL, f), path.join(dir, f));
  for (const [name, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), src);
  return dir;
}
const real = (name) => fs.readFileSync(path.join(REAL, name), 'utf8');
const withLine = (src, line) => src.replace(/^\/\/ World: .*$/m, line);
const run = (dir) => spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });

test('every real journey file declares at least what it changes, and the CLI passes', () => {
  const rows = scan(REAL);
  assert.ok(rows.length > 200, `found ${rows.length} journey files`);
  const bad = rows.filter((r) => r.error || r.declared === null || r.missing.length);
  assert.deepEqual(
    bad.map((r) => `${r.file}: ${r.error ?? r.missing.join(',')}`),
    [],
  );
  const cli = run(REAL);
  assert.equal(cli.status, 0, cli.stderr);
});

test('planted: the run-1247 leak. J-copy-bots-otc-30 rests a bid and J-ops-console-08 restarts the maker; undeclared, both fail', () => {
  const dir = plant({
    'J-copy-bots-otc-30.pw.mjs': withLine(real('J-copy-bots-otc-30.pw.mjs'), '// World: none'),
    'J-ops-console-08.pw.mjs': withLine(real('J-ops-console-08.pw.mjs'), '// World: freeze'),
    'J-portfolio-04.pw.mjs': real('J-portfolio-04.pw.mjs'),
  });
  const rows = Object.fromEntries(scan(dir).map((r) => [r.file, r]));
  assert.deepEqual(rows['J-copy-bots-otc-30.pw.mjs'].missing, ['book']);
  assert.deepEqual(rows['J-ops-console-08.pw.mjs'].missing.sort(), ['market', 'restart']);
  assert.deepEqual(rows['J-portfolio-04.pw.mjs'].missing, []);
  const cli = run(dir);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /J-copy-bots-otc-30\.pw\.mjs: changes book but does not declare it/);
  assert.match(cli.stderr, /J-ops-console-08\.pw\.mjs: changes .*market.*restart|J-ops-console-08\.pw\.mjs: changes .*restart.*market/);
  // Declared as the real files are, the same three pass, and the two that change the world are the ones kept apart.
  const fixed = plant({
    'J-copy-bots-otc-30.pw.mjs': real('J-copy-bots-otc-30.pw.mjs'),
    'J-ops-console-08.pw.mjs': real('J-ops-console-08.pw.mjs'),
    'J-portfolio-04.pw.mjs': real('J-portfolio-04.pw.mjs'),
  });
  assert.equal(run(fixed).status, 0);
  assert.deepEqual(worldFiles(fixed), ['J-copy-bots-otc-30.pw.mjs', 'J-ops-console-08.pw.mjs']);
});

test('planted: a file with no World line fails, naming the line it needs', () => {
  const dir = plant({ 'J-planted-01.pw.mjs': "import { restartWith } from './stack.mjs';\nrestartWith('trade', 'X', false);\n" });
  const cli = run(dir);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /J-planted-01\.pw\.mjs: no "\/\/ World:" line; it needs: \/\/ World: restart/);
});

test('each shared part is found directly, through a computed subcommand, and through the screens', () => {
  assert.deepEqual([...directWorld("tool('local-test-market.mjs', 'move', 'BTC/USDT', '+1%')")], ['market']);
  assert.deepEqual([...directWorld("tool('local-test-market.mjs', cmd)")], ['market']);
  assert.deepEqual([...directWorld("tool('local-test-stack.mjs', 'restart', 'trade')")], ['restart']);
  assert.deepEqual([...directWorld("tool('local-test-stack.mjs', what, 'trade')")], ['restart']);
  assert.deepEqual([...directWorld("tool('local-test-stack.mjs', 'age-addresses')")], ['stack']);
  assert.deepEqual([...directWorld("tool('local-test-gates.mjs', 'risk', 'BTC/USDT')")], ['gates']);
  assert.deepEqual([...directWorld("tool('local-test-gates.mjs', 'posting-freeze', 'on')")], ['freeze']);
  assert.deepEqual([...directWorld("tool('local-test-chain.mjs', 'gate', 'closed')")], ['gates']);
  assert.deepEqual([...directWorld("await me.post('/api/v1/orders', { symbol })")], ['book']);
  assert.deepEqual([...directWorld('await me.post(`/api/v1/futures/orders/split`, body)')], ['book']);
  assert.deepEqual([...directWorld("await page.getByRole('button', { name: 'Sell BTC' }).click();")], ['book']);
  assert.deepEqual([...directWorld("await confirm.getByRole('button', { name: 'Confirm open long' }).dblclick();")], ['book']);
  // Seeing a button, reading a book, or acting on one named account is not a change to the shared world.
  assert.deepEqual([...directWorld("await expect(page.getByRole('button', { name: 'Open long' })).toBeVisible();")], []);
  assert.deepEqual([...directWorld("await me.get('/api/v1/orders/open?symbol=BTC%2FUSDT')")], []);
  assert.deepEqual(
    [...directWorld("tool('local-test-gates.mjs', 'verify'); tool('local-test-stack.mjs', 'fund', email, 'USDT', '10')")],
    [],
  );
});

test('a helper passes on what the helpers it calls change, however deep', () => {
  const dir = plant({
    'deep.mjs': [
      "import { tool } from './stack.mjs';",
      'export function bottom() {',
      "  return tool('local-test-market.mjs', 'stop');",
      '}',
      'export async function middle() {',
      '  await bottom();',
      '}',
      'export const top = async () => {',
      '  await middle();',
      '};',
      'export function bystander() {',
      '  return 1;',
      '}',
    ].join('\n'),
  });
  const helpers = helperWorld(dir);
  assert.deepEqual([...helpers.get('top')], ['market']);
  assert.deepEqual([...helpers.get('bystander')], []);
  assert.deepEqual([...fileWorld('await top();', helpers)], ['market']);
  assert.deepEqual([...fileWorld('await bystander();', helpers)], []);
});

test('the World line: none, known parts only, and none never mixed with a part', () => {
  assert.deepEqual([...declaredWorld('// World: none\n')], []);
  assert.deepEqual([...declaredWorld('// World: book, restart\n')], ['book', 'restart']);
  assert.equal(declaredWorld('// world: none\n'), null);
  assert.throws(() => declaredWorld('// World: weather\n'), /unknown world part/);
  assert.throws(() => declaredWorld('// World: none, book\n'), /unknown world part/);
  assert.deepEqual(Object.keys(WORLD), ['book', 'market', 'restart', 'freeze', 'gates', 'stack']);
});
