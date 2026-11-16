// garden/no-hand-typed-patch on planted files: each hand-typed member of a prototype patch fires and names the typed way;
// a member typed from the class, a flag, an uncast prototype, a test file and a cast of anything else pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const skip = !existsSync(OXLINT) && 'no node_modules';
const RULE = 'garden(no-hand-typed-patch)';

/** Each planted file's findings of this rule, as `file:line`. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-patch-'));
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', '.oxlintrc.json', '--format', 'unix', ...Object.keys(files)], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return out.split('\n').filter((l) => l.includes(RULE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const F = 'services/svc-x/src/spot/x-place.ts';

test("the three closers' shape fires once per hand-typed member, never on the flag", skip, () => {
  const out = findings({
    [F]: [
      "const FLAG = Symbol.for('x');",
      'export function installX(ctor: typeof TradeService): void {',
      '  const proto = ctor.prototype as unknown as {',
      '    settleOutcome: (market: Market, fills: readonly EngineFill[], cancellations: readonly EngineCancellation[]) => Promise<void>;',
      "    finalize: (orderId: string, status: 'cancelled' | 'filled' | 'expired' | 'rejected', reason?: string | null) => Promise<void>;",
      '    [FLAG]?: true;',
      '  };',
      '  const settling = proto as unknown as { settleFillEvent: (input: { makerOrderId: string }) => Promise<void> };',
      '}',
    ].join('\n'),
  });
  assert.equal(out.length, 3, out.join('\n'));
  assert.ok(out[0].startsWith(`${F}:4:`), out[0]);
  assert.ok(out[1].includes("'finalize' on a prototype patch has a hand-written type"), out[1]);
  assert.ok(out[1].includes("TradeServiceInternal['finalize']"), out[1]);
  assert.ok(out[2].startsWith(`${F}:8:`), out[2]);
});

test('a single cast, a method signature, unknown, and a local alias or Host[...] fire', skip, () => {
  const out = findings({
    [F]: [
      'type Host = { submit: (marketId: string, order: unknown, proof?: unknown) => Promise<unknown> };',
      'type BookAmend = (cmd: unknown) => unknown;',
      'export function install(ctor: typeof OrderBook): void {',
      '  const a = ctor.prototype as { cancel(orderId: string): unknown };',
      '  const b = ctor.prototype as unknown as { amendOrder: unknown };',
      "  const c = ctor.prototype as unknown as { submit: Host['submit']; amend: BookAmend };",
      '}',
    ].join('\n'),
  });
  assert.deepEqual(
    out.map((l) => l.split(':').slice(0, 2).join(':')),
    [`${F}:4`, `${F}:5`, `${F}:6`, `${F}:6`],
  );
});

test('members typed from the class, an uncast prototype, other casts and test files pass', skip, () => {
  const clean = [
    "const FLAG = Symbol.for('x');",
    'export function install(ctor: typeof TradeService): void {',
    "  const proto = ctor.prototype as unknown as { finalize: TradeServiceInternal['finalize']; open: PositionService['open']; [FLAG]?: true; on?: boolean };",
    '  const place = ctor.prototype.placeOrder;',
    '  const flag = (OrderBook.prototype as unknown as Record<symbol, unknown>)[FLAG];',
    '  const other = value as { f: () => void };',
    '}',
  ].join('\n');
  const hand = 'export function install(ctor: typeof X) { const p = ctor.prototype as { f: () => void }; }\n';
  assert.deepEqual(findings({ [F]: clean, 'services/svc-x/src/spot/x-place.test.ts': hand, 'services/svc-x/src/x.testkit.ts': hand }), []);
});
