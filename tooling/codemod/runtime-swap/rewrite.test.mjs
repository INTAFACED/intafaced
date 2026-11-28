// node --test tooling/codemod/runtime-swap/rewrite.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyStack, dropInstallCalls, rewrite, rewriteStandIns, scan, stackAt } from './rewrite.mjs';

const BASE = `export class TradeService {
  async placeOrder(principal: string, input: { tif?: string }): Promise<{ id: string; status: string }> {
    return { id: 'o', status: 'open' };
  }
  async cancelOrder(principal: string, id: string): Promise<{ id: string; status: string }> {
    return { id, status: 'cancelled' };
  }
  private toEngineRequest(id: string, input: { tif?: string }): { tif: string } {
    return { tif: input.tif ?? 'GTC' };
  }
}
`;

// The shape every installer had (spot/fok-place.ts before this change).
const FOK = `import { TradeService } from './trade-service.js';

const FLAG = Symbol.for('test.fok');

export function installFokPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: string, input: { tif?: string }) => Promise<{ id: string; status: string }>;
    toEngineRequest: (...args: unknown[]) => { tif: string };
    cancelOrder: (principal: string, id: string) => Promise<unknown>;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: string, input: { tif?: string }) {
    const order = await origPlace.call(this, principal, input);
    if (input.tif === 'FOK' && order.status === 'open') return proto.cancelOrder.call(this, principal, order.id);
    return order;
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    return req;
  };
}

installFokPlace(TradeService);
`;

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-swap-'));
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
  return dir;
}

test('an installer becomes a layer: the captured method is super, a method read off the prototype is this', () => {
  const dir = repo({ 'trade-service.ts': BASE, 'fok-place.ts': FOK });
  const { out, done, left, privates } = rewrite(join(dir, 'fok-place.ts'), FOK);
  assert.deepEqual(done, ['installFokPlace']);
  assert.deepEqual(left, []);
  assert.match(out, /export function withFokPlace\(Base: typeof TradeService\): typeof TradeService \{/u);
  assert.match(out, /return class FokPlace extends Base \{/u);
  assert.match(
    out,
    /override async placeOrder\(principal: string, input: \{ tif\?: string \}\): ReturnType<TradeService\['placeOrder'\]>/u,
  );
  assert.match(out, /await super\.placeOrder\(principal, input\)/u);
  // Read off the shared prototype when it ran, so the newest cancelOrder: the most derived one.
  assert.match(out, /return this\.cancelOrder\(principal, order\.id\)/u);
  assert.match(out, /super\.toEngineRequest\(\.\.\.\(args as Parameters<TradeService\['toEngineRequest'\]>\)\)/u);
  // No flag, no import-time install, no prototype left.
  assert.doesNotMatch(out, /FLAG|prototype|installFokPlace|origPlace|proto\b/u);
  // A private member a layer overrides must become protected in the base.
  assert.deepEqual([...[...privates.values()][0].names], ['toEngineRequest']);
});

test('safe to rerun: a rewritten file changes nothing the second time', () => {
  const dir = repo({ 'trade-service.ts': BASE, 'fok-place.ts': FOK });
  const once = rewrite(join(dir, 'fok-place.ts'), FOK).out;
  const twice = rewrite(join(dir, 'fok-place.ts'), once);
  assert.equal(twice.out, once);
  assert.deepEqual(twice.done, []);
});

test('an installer with a statement it does not know is left, with its reason', () => {
  const odd = FOK.replace('  const origPlace = proto.placeOrder;', '  console.log(proto);\n  const origPlace = proto.placeOrder;');
  const dir = repo({ 'trade-service.ts': BASE, 'fok-place.ts': odd });
  const { out, done, left } = rewrite(join(dir, 'fok-place.ts'), odd);
  assert.deepEqual(done, []);
  assert.equal(left.length, 1);
  assert.match(left[0].reason, /a statement it does not know/u);
  assert.equal(out, odd);
});

test('`orig` used another way than a call on this is left: super would not mean the same', () => {
  const odd = FOK.replace(
    'const order = await origPlace.call(this, principal, input);',
    'const order = await origPlace.call(other, principal, input);',
  );
  const dir = repo({ 'trade-service.ts': BASE, 'fok-place.ts': odd });
  assert.match(rewrite(join(dir, 'fok-place.ts'), odd).left[0].reason, /used another way/u);
});

test('the stack at an entry is the order its imports installed in, each installer once, and is applied where it constructs', () => {
  const dir = repo({
    'trade-service.ts': BASE,
    'fok-place.ts': FOK,
    'ioc-place.ts': FOK.replaceAll('Fok', 'Ioc').replace("'test.fok'", "'test.ioc'"),
    'layered.ts':
      'export function layered<C>(base: C, ...layers: ReadonlyArray<(c: C) => C>): C { return layers.reduce((c, l) => l(c), base); }\n',
    'a.test.ts': `import './ioc-place.js';\nimport { installFokPlace } from './fok-place.js';\nimport { TradeService } from './trade-service.js';\ninstallFokPlace(TradeService);\nconst t = new TradeService();\n`,
  });
  const files = ['trade-service.ts', 'fok-place.ts', 'ioc-place.ts'].map((f) => join(dir, f));
  const { installers, atImport } = scan(files);
  const entry = join(dir, 'a.test.ts');
  assert.deepEqual(stackAt(entry, atImport), ['installIocPlace', 'installFokPlace']);
  let src = dropInstallCalls(
    entry,
    `import './ioc-place.js';\nimport { installFokPlace } from './fok-place.js';\nimport { TradeService } from './trade-service.js';\ninstallFokPlace(TradeService);\nconst t = new TradeService();\n`,
    new Set(['installFokPlace', 'installIocPlace']),
  );
  // The test's own call on the real class changed nothing (the flag was set on import): it goes, and its import with it.
  assert.doesNotMatch(src, /installFokPlace/u);
  src = applyStack(entry, src, ['installIocPlace', 'installFokPlace'], installers, join(dir, 'layered.ts')).out;
  assert.match(src, /const LayeredTradeService = layered\(TradeService, withIocPlace, withFokPlace\);/u);
  assert.match(src, /new LayeredTradeService\(\)/u);
  assert.match(src, /import \{ withIocPlace \} from '\.\/ioc-place\.js';/u);
  assert.match(src, /import \{ layered \} from '\.\/layered\.js';/u);
});

test("a test's own stand-in class is layered, not changed: later `new` builds the layered one", () => {
  const src = `it('x', () => {\n  class Door {}\n  installFokPlace(Door as unknown as typeof TradeService);\n  const door = new Door();\n});\n`;
  const { out } = rewriteStandIns('/x.test.ts', src, new Set(['installFokPlace']));
  assert.match(out, /const LayeredDoor = layeredStandIn\(Door, withFokPlace\);/u);
  assert.match(out, /const door = new LayeredDoor\(\);/u);
  // A call on a stand-in really installed, so it is never just deleted.
  assert.equal(dropInstallCalls('/x.test.ts', src, new Set(['installFokPlace'])), src);
});

test('installs on one stand-in merge into one layering, and an alias of the class stands for it', () => {
  const src = `it('x', () => {\n  class Owner {}\n  const ctor = Owner as unknown as typeof PositionService;\n  installA(ctor);\n  installB(ctor);\n  const o = new Owner();\n});\n`;
  const { out } = rewriteStandIns('/x.test.ts', src, new Set(['installA', 'installB']));
  assert.match(out, /const LayeredOwner = layeredStandIn\(Owner, withA, withB\);/u);
  assert.match(out, /const o = new LayeredOwner\(\);/u);
  // The alias nothing reads any more goes.
  assert.doesNotMatch(out, /const ctor/u);
});
