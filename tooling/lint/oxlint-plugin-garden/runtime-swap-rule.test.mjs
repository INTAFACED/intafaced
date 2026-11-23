// garden/no-runtime-swap on planted files: replacing a method on an imported class's prototype fires, directly, through a
// parameter, through an alias of the prototype or of the class, and through Object.assign / Object.defineProperty, and the
// message names the fix; a flag, a read, a class of the same file, a browser global's polyfill, a plain helper and a test
// file stay quiet. The count command reads the same findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countOf } from '../count-rule.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const skip = !existsSync(OXLINT) && 'no node_modules';
const RULE = 'garden/no-runtime-swap';

/** oxlint's JSON diagnostics over planted files, linted with the root config. */
function lint(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-runtime-swap-'));
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', '.oxlintrc.json', '--format', 'json', ...Object.keys(files)], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return JSON.parse(out).diagnostics ?? [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DIRECT = 'services/svc-trade/src/spot/new-place.ts';
const ALIAS = 'services/svc-matching/src/engine/new-fence.ts';

test('a method swapped on an imported class fires, directly and through aliases, and names the fix', skip, () => {
  const diagnostics = lint({
    // The past mistake, as services/svc-trade/src/spot/gtd-gtt-place.ts wrote it, plus the direct and `??=` forms.
    [DIRECT]: [
      "import { TradeService } from './trade-service.js';",
      'export function install(ctor: typeof TradeService): void {',
      '  const proto = ctor.prototype as unknown as { placeOrder: (i: unknown) => Promise<unknown> };',
      '  const orig = proto.placeOrder;',
      '  proto.placeOrder = async function (this: TradeService, i: unknown) { return orig.call(this, i); };',
      '}',
      'TradeService.prototype.cancelOrder = async () => undefined;',
      "TradeService.prototype['amendOrder'] ??= wrapped;",
    ].join('\n'),
    [ALIAS]: [
      "import { MatchingEngine as Engine } from './engine.js';",
      'const C = Engine;',
      'const p = C.prototype;',
      'const q = p;',
      'q.halt = function () {};',
      'const r = (cond ? Engine.prototype : Engine.prototype) as { resume: unknown };',
      'r.resume = makeResume();',
      'Object.assign(Engine.prototype, { submit() {}, recover: async () => {}, enabled: true });',
      "Object.defineProperty(q, 'isSplitBrain', { get() { return false; } });",
    ].join('\n'),
  });
  const { total, files } = countOf(diagnostics, RULE);
  assert.deepEqual(files, { [ALIAS]: 5, [DIRECT]: 3 });
  assert.equal(total, 8);
  for (const d of diagnostics.filter((x) => x.code === 'garden(no-runtime-swap)'))
    assert.match(d.message, /replaced on another module's class at run time: put the behaviour in the class itself/u);
});

test('flags, reads, own classes, polyfills, plain helpers and tests stay quiet', skip, () => {
  const swap = "import { TradeService } from './t.js';\nTradeService.prototype.placeOrder = async () => undefined;";
  const diagnostics = lint({
    [DIRECT]: [
      "import { TradeService } from './trade-service.js';",
      "const FLAG = Symbol.for('x');",
      'export function install(ctor: typeof TradeService): void {',
      '  const proto = ctor.prototype as unknown as { placeOrder: unknown; installed?: boolean; [FLAG]?: true };',
      '  if (proto[FLAG]) return;',
      '  proto[FLAG] = true;',
      '  proto.installed = true;',
      "  if (typeof proto.placeOrder === 'function') proto.placeOrder;",
      '  const service = new ctor();',
      '  service.label = makeLabel();',
      '}',
      'class Own { run() {} }',
      'Own.prototype.run = function () {};',
      'HTMLDialogElement.prototype.showModal ??= function () {};',
      'Storage.prototype.setItem = function () {};',
      'export function helper(x: { total: number }) { x.total = add(x.total, 1); return x; }',
      'const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);',
    ].join('\n'),
    'services/svc-trade/src/spot/new-place.test.ts': swap,
    'services/svc-trade/test/new-place.ts': swap,
    'apps/customer/tests/real-app/J-x.pw.mjs': swap,
  });
  assert.deepEqual(countOf(diagnostics, RULE), { total: 0, files: {} });
});
