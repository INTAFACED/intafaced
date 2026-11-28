// Proves launch's custody switch has one home that the beta and CI's launch-desk journeys both read (#11077).
// Run: node --test tooling/scripts/launch-custody.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FROZEN_CUSTODY_LAYER,
  LAUNCH_CUSTODY_LAYER,
  NOT_YET_OFF,
  fileCustody,
  journeyIdOf,
  launchJourneyIds,
  readLaunchJourneyIds,
  shardCustody,
} from './launch-custody.mjs';
import { BETA_CUSTODY } from '../beta/beta-host.mjs';
import { startCustodyLayer } from './local-test-state.mjs';
import { JOURNEY_DIR, journeyFiles } from './journey-shards.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('launch runs custody off, the beta reads it from here, and frozen journeys keep the stack default', () => {
  assert.equal(LAUNCH_CUSTODY_LAYER, 'off');
  assert.equal(BETA_CUSTODY, LAUNCH_CUSTODY_LAYER);
  assert.equal(FROZEN_CUSTODY_LAYER, startCustodyLayer({}));
});

test('a journey file names its journey; a part file names its journey too', () => {
  assert.equal(journeyIdOf('J-cex-spot-10.pw.mjs'), 'J-cex-spot-10');
  assert.equal(journeyIdOf('J-cex-spot-10-venue.pw.mjs'), 'J-cex-spot-10');
  assert.equal(journeyIdOf('apps/customer/tests/real-app/J-identity-06-trusted.pw.mjs'), 'J-identity-06');
  assert.equal(journeyIdOf('menu-reach.pw.mjs'), null);
});

test('the launch desk is the Order 1 journeys; every other file keeps the stack default', () => {
  const ids = launchJourneyIds([
    { id: 'J-a-1', order: 1 },
    { id: 'J-b-1', order: 2 },
  ]);
  assert.deepEqual([...ids], ['J-a-1']);
  assert.equal(fileCustody('J-a-1-venue.pw.mjs', ids), 'off');
  assert.equal(fileCustody('J-b-1.pw.mjs', ids), 'on');
  assert.equal(fileCustody('menu-reach.pw.mjs', ids), 'on');
  assert.throws(() => launchJourneyIds([]), /no journey/);
});

test("a shard's switch is its files' one switch; a mix is refused by name", () => {
  const ids = new Set(['J-a-1']);
  assert.equal(shardCustody(['J-a-1.pw.mjs', 'J-a-1-venue.pw.mjs'], ids), 'off');
  assert.equal(shardCustody(['J-b-1.pw.mjs', ''], ids), 'on');
  assert.throws(
    () => shardCustody(['J-a-1.pw.mjs', 'J-b-1.pw.mjs'], ids),
    /mixes custody off \(J-a-1\.pw\.mjs\) and on \(J-b-1\.pw\.mjs\)/,
  );
  assert.throws(() => shardCustody([''], ids), /no journey file/);
});

test("the real journeys list has a launch desk, and the command prints a shard's switch or refuses a mix", () => {
  const ids = readLaunchJourneyIds();
  assert.ok(ids.has('J-cex-spot-01') && ids.has('J-wallet-01') && ids.has('J-identity-01'), [...ids].join(' '));
  const run = (files) => spawnSync('node', ['tooling/scripts/launch-custody.mjs', '--files', files], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run('J-cex-spot-01.pw.mjs J-wallet-09.pw.mjs').stdout, 'off\n');
  assert.equal(run('J-p2p-01.pw.mjs').stdout, 'on\n');
  const mixed = run('J-cex-spot-01.pw.mjs J-p2p-01.pw.mjs');
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /::error::one shard mixes custody/);
});

test("a launch-desk file still failing custody off keeps today's switch, and every such entry is a launch-desk file (#11102)", () => {
  const ids = new Set(['J-a-1']);
  assert.equal(fileCustody('J-a-1.pw.mjs', ids, new Set(['J-a-1'])), 'on');
  assert.equal(fileCustody('apps/customer/tests/real-app/J-a-1.pw.mjs', ids, new Set(['J-a-1'])), 'on');
  assert.equal(fileCustody('J-a-1-venue.pw.mjs', ids, new Set(['J-a-1'])), 'off');
  const launch = readLaunchJourneyIds();
  const files = new Set(journeyFiles(path.join(ROOT, JOURNEY_DIR)));
  const stale = [...NOT_YET_OFF].filter((f) => !files.has(`${f}.pw.mjs`) || !launch.has(journeyIdOf(`${f}.pw.mjs`)));
  assert.deepEqual(stale, [], 'NOT_YET_OFF names a file that is gone or no launch-desk file: delete it from the list');
});

test("a launch-desk journey's custodial part file keeps today's switch; its other files run launch's (#11102)", () => {
  const ids = new Set(['J-a-1']);
  assert.equal(fileCustody('J-a-1-custodial.pw.mjs', ids), 'on');
  assert.equal(fileCustody('apps/customer/tests/real-app/J-a-1-custodial.pw.mjs', ids), 'on');
  assert.equal(fileCustody('J-a-1.pw.mjs', ids), 'off');
  assert.equal(fileCustody('J-a-1-custodial-venue.pw.mjs', ids), 'off');
  assert.equal(journeyIdOf('J-a-1-custodial.pw.mjs'), 'J-a-1');
  assert.equal(fileCustody('J-cex-spot-03-custodial.pw.mjs', readLaunchJourneyIds()), 'on');
  assert.equal(fileCustody('J-derivatives-04-custodial.pw.mjs', readLaunchJourneyIds()), 'on');
  assert.equal(fileCustody('J-derivatives-01-custodial.pw.mjs', readLaunchJourneyIds()), 'on');
  assert.equal(fileCustody('J-derivatives-01-venue.pw.mjs', readLaunchJourneyIds()), 'off');
  assert.equal(fileCustody('J-charts-desk-01-custodial.pw.mjs', readLaunchJourneyIds()), 'on');
  assert.equal(fileCustody('J-cex-spot-18-custodial.pw.mjs', readLaunchJourneyIds()), 'on');
  assert.equal(fileCustody('J-charts-desk-01-venue.pw.mjs', readLaunchJourneyIds()), 'off');
  assert.equal(fileCustody('J-cex-spot-03.pw.mjs', readLaunchJourneyIds()), 'off');
});

// The ledger's TEST funding (`fund` from stack.mjs, `local-test-stack.mjs fund`) credits a customer account, which a
// custody-off stack refuses (`local_test.custody_layer_off`, exit 3). A file that runs custody off and funds that way,
// itself or through a helper of its folder that does (desk.mjs fundedTrader), fails every run (#11159: J-wallet-01 and
// J-p2p-21 did, once #11129 stopped the world restore turning custody back on).
const LEDGER_FUND_CALL = [/\bfund\(/, /['"]local-test-stack\.mjs['"]\s*,\s*['"]fund['"]/];
const STACK_FUND_IMPORT = /import\s*\{[^}]*\bfund\b[^}]*\}\s*from\s*'\.\/stack\.mjs'/;
/** `stack.fund(` through `import * as stack from './stack.mjs'`. */
const stackSpaceFunds = (src) =>
  [...src.matchAll(/import\s*\*\s*as\s+(\w+)\s*from\s*'\.\/stack\.mjs'/g)].some((m) =>
    new RegExp(`(?<![\\w.])${m[1]}\\.fund\\(`).test(src),
  );
const fundsDirectly = (src) => STACK_FUND_IMPORT.test(src) || LEDGER_FUND_CALL[1].test(src) || stackSpaceFunds(src);
/** The local names `src` binds to `names` exported by `./<from>`: named imports (with `as`), and `ns.<name>` of a namespace import. */
const localNames = (src, from, names) => {
  const mod = `'\\./${from.replace(/\./g, '\\.')}'`;
  const named = [...src.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*${mod}`, 'g'))].flatMap((m) =>
    m[1]
      .split(',')
      .map((n) => n.trim().split(/\s+as\s+/))
      .filter(([name]) => names.includes(name))
      .map(([name, alias]) => alias ?? name),
  );
  const spaces = [...src.matchAll(new RegExp(`import\\s*\\*\\s*as\\s+(\\w+)\\s*from\\s*${mod}`, 'g'))].flatMap((m) =>
    names.map((n) => `${m[1]}.${n}`),
  );
  return [...named, ...spaces];
};
const calls = (code, name) => new RegExp(`(?<![\\w.])${name.replace('.', '\\.')}\\(`).test(code);

/**
 * The exported functions of a helper module whose own body funds through the ledger: it calls `fund`, the stack's fund
 * command, or a function another helper exports that does (`helpers`, module file to its funding exports). Pure.
 */
function ledgerFunders(src, helpers = {}) {
  const direct = fundsDirectly(src);
  const via = Object.entries(helpers).flatMap(([file, names]) => localNames(src, file, names));
  if (!direct && via.length === 0) return [];
  return src
    .split(/^(?=export |function |async function |const |let )/m)
    .map((part) => [/^export (?:async )?function\s+(\w+)|^export const\s+(\w+)/.exec(part), part.replace(/^.*?\{/s, '')])
    .filter(([m, body]) => m && ((direct && LEDGER_FUND_CALL.some((re) => re.test(body))) || via.some((n) => calls(body, n))))
    .map(([m]) => m[1] ?? m[2]);
}

/** Every helper module of `dir` (file to its funding exports), followed through helpers that call helpers until none is added. */
function fundingHelpers(dir) {
  const sources = Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.mjs') && !f.endsWith('.pw.mjs') && f !== 'stack.mjs')
      .map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]),
  );
  let helpers = {};
  for (;;) {
    const next = Object.fromEntries(
      Object.entries(sources)
        .map(([f, src]) => [f, ledgerFunders(src, helpers)])
        .filter(([, names]) => names.length > 0),
    );
    if (JSON.stringify(next) === JSON.stringify(helpers)) return helpers;
    helpers = next;
  }
}

/** Whether a journey file funds through the ledger, itself or by calling a funding export of `helpers`. */
function fundsThroughLedger(src, helpers = {}) {
  if (fundsDirectly(src)) return true;
  return Object.entries(helpers).some(([file, names]) => localNames(src, file, names).some((n) => calls(src, n)));
}

test('a file that runs custody off never funds a customer through our ledger, which custody off refuses (#11159)', () => {
  assert.ok(fundsThroughLedger("import { api, fund, tool } from './stack.mjs';"));
  assert.ok(fundsThroughLedger("tool('local-test-stack.mjs', 'fund', email, 'USDT', '5')"));
  assert.ok(fundsThroughLedger("import * as stack from './stack.mjs';\nstack.fund(email, 'USDT', '5');"));
  assert.ok(!fundsThroughLedger("import * as stack from './stack.mjs';\nstack.api(who);"));
  assert.ok(!fundsThroughLedger("import { api, tool } from './stack.mjs';\nconst fund = async () => {};"));
  const helper =
    "import { api, fund } from './stack.mjs';\nexport async function rich(p) {\n  fund(p, 'USDT', '9');\n}\nexport function plain() {}\n";
  assert.deepEqual(ledgerFunders(helper), ['rich']);
  assert.ok(fundsThroughLedger("import { plain, rich as r } from './h.mjs';\nawait r(p);", { 'h.mjs': ['rich'] }));
  assert.ok(!fundsThroughLedger("import { plain } from './h.mjs';\nplain();", { 'h.mjs': ['rich'] }));
  assert.ok(fundsThroughLedger("import * as h from './h.mjs';\nawait h.rich(p);", { 'h.mjs': ['rich'] }));
  // A helper that funds through another helper is found too.
  assert.deepEqual(
    ledgerFunders("import { rich } from './h.mjs';\nexport async function setUp(p) {\n  await rich(p);\n}\n", { 'h.mjs': ['rich'] }),
    ['setUp'],
  );

  const launch = readLaunchJourneyIds();
  const dir = path.join(ROOT, JOURNEY_DIR);
  const helpers = fundingHelpers(dir);
  assert.ok(helpers['desk.mjs']?.includes('fundedTrader'), `the helpers that fund: ${JSON.stringify(helpers)}`);
  assert.ok(helpers['agents.mjs']?.includes('agentsRun'), `agents.mjs funds through desk.mjs: ${JSON.stringify(helpers)}`);
  const funding = journeyFiles(dir).filter(
    (f) => fileCustody(f, launch) === LAUNCH_CUSTODY_LAYER && fundsThroughLedger(fs.readFileSync(path.join(dir, f), 'utf8'), helpers),
  );
  assert.deepEqual(
    funding,
    [],
    'these files run custody off and fund through our ledger: fund the person where launch holds their money (the TEST partner, their TEST venue account or wallet), or move the custodial check to a `<journey>-custodial.pw.mjs` part file',
  );
});
