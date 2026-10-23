import { afterEach, describe, expect, it } from 'vitest';
import { isModuleId, MODULE_IDS } from '@intafaced/config';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALWAYS_ALLOWED_REST, KillSwitchState, MODULE_BY_PREFIX, procedureLeaf, procedureOf, resolvedPathname } from './kill-switch.js';
import { UPSTREAMS } from './routes.js';

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const ownedDirectories: string[] = [];
function fixtureDir(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  ownedDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of ownedDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const WHY = 'incident 2026-07-30, book quoting stale prices';

describe('kill-switch route map', () => {
  it('covers every upstream, so no route is un-killable', () => {
    for (const upstream of UPSTREAMS) {
      expect(MODULE_BY_PREFIX.get(upstream.prefix), upstream.prefix).toBeDefined();
    }
  });

  it('names a real module for every route', () => {
    for (const [prefix, module] of MODULE_BY_PREFIX) {
      expect(isModuleId(module), `${prefix} → ${module}`).toBe(true);
    }
  });

  /**
   * THE BUG. `/api/v1` is the public CCXT REST contract and it forwards to
   * `svc-trade`, but the prefix does not spell "trade". An earlier revision
   * derived the module by stripping `/api/`, which meant `/api/v1` mapped to
   * nothing — so halting `trade` would have refused the tRPC order path while
   * `POST /api/v1/orders` kept taking new risk, with the console showing
   * "trade: killed" the whole time.
   */
  it('maps the CCXT REST prefix to trade, not to "v1"', () => {
    expect(MODULE_BY_PREFIX.get('/api/v1')).toBe('trade');
  });

  it('routes that share an upstream share a module, or halting one halts half of it', () => {
    expect(MODULE_BY_PREFIX.get('/api/trade')).toBe(MODULE_BY_PREFIX.get('/api/v1'));
  });
});

describe('procedure parsing', () => {
  it('reads the tRPC procedure out of a proxied path', () => {
    expect(procedureOf('/api/trade/trpc/orders.create')).toBe('orders.create');
    expect(procedureOf('/api/trade/trpc/orders.cancel?batch=1')).toBe('orders.cancel');
  });

  it('has no procedure for a non-tRPC path', () => {
    expect(procedureOf('/api/pay/webhooks/crypto')).toBeNull();
  });

  it('takes the leaf, so nesting depth does not change the rule', () => {
    expect(procedureLeaf('orders.cancel')).toBe('cancel');
    expect(procedureLeaf('spot.orders.cancel')).toBe('cancel');
  });
});

describe('a killed module', () => {
  const state = () => {
    const s = new KillSwitchState();
    s.set('trade', true, OPERATOR, WHY);
    return s;
  };

  /**
   * §14's own worked example, and the reason the whole file exists: "`trade.spot`
   * disabled refuses new orders while still allowing cancels."
   */
  it('refuses a new order', () => {
    const d = state().decide('/api/trade/trpc/orders.create', 'POST');
    expect(d).toMatchObject({ module: 'trade', refused: true, reason: 'module-killed' });
  });

  it('still lets a user cancel — a control that traps funds is not a safety control', () => {
    const d = state().decide('/api/trade/trpc/orders.cancel', 'POST');
    expect(d).toMatchObject({ module: 'trade', refused: false, reason: 'lets-the-user-out' });
  });

  it('still serves reads', () => {
    expect(state().decide('/api/trade/trpc/orders.open', 'GET').refused).toBe(false);
    expect(state().decide('/api/trade/trpc/markets.list', 'GET').refused).toBe(false);
  });

  it('does not touch any other module', () => {
    const s = state();
    expect(s.decide('/api/identity/trpc/auth.login', 'POST').refused).toBe(false);
    expect(s.decide('/api/pay/trpc/deposit.credit', 'POST').refused).toBe(false);
  });

  it('refuses a non-tRPC write too — an unknown shape is a commitment', () => {
    const s = new KillSwitchState();
    s.set('pay', true, OPERATOR, 'rail partner outage, stop taking payments');
    expect(s.decide('/api/pay/webhooks/crypto', 'POST').refused).toBe(true);
  });

  it('comes back on, and the reason goes with it', () => {
    const s = state();
    expect(s.reasonFor('trade')).toContain('incident');
    s.set('trade', false, OPERATOR, 'resolved');
    expect(s.isKilled('trade')).toBe(false);
    expect(s.reasonFor('trade')).toBeNull();
    expect(s.decide('/api/trade/trpc/orders.create', 'POST').refused).toBe(false);
  });
});

/**
 * THE OTHER HALF OF THE SAME BUG, and the one that failed in the trapping
 * direction.
 *
 * `svc-trade` serves cancels twice: `orders.cancel` over tRPC, and the CCXT REST
 * contract every ccxt client actually calls. The tRPC rule was the entire escape
 * hatch, so `DELETE /api/v1/orders/:id` had no procedure, fell through to "an
 * unknown shape is a commitment", and was refused. A halted market would have
 * left users holding open orders with no way to close them — the precise outcome
 * the asymmetry exists to prevent.
 */
describe('a killed market still lets users out through the REST contract', () => {
  const state = () => {
    const s = new KillSwitchState();
    s.set('trade', true, OPERATOR, WHY);
    return s;
  };

  it('refuses POST /api/v1/orders — that is new risk', () => {
    expect(state().decide('/api/v1/orders', 'POST')).toMatchObject({ module: 'trade', refused: true, reason: 'module-killed' });
  });

  it('allows DELETE /api/v1/orders/:id — cancel one', () => {
    expect(state().decide('/api/v1/orders/8f3c1d2e-0000-4000-8000-000000000001', 'DELETE')).toMatchObject({
      refused: false,
      reason: 'lets-the-user-out',
    });
  });

  it('allows DELETE /api/v1/orders — cancel all', () => {
    expect(state().decide('/api/v1/orders', 'DELETE')).toMatchObject({ refused: false, reason: 'lets-the-user-out' });
  });

  it('allows DELETE /api/v1/positions/:id — the request reaches trade, which refuses it as cancel-not-close', () => {
    expect(state().decide('/api/v1/positions/8f3c1d2e-0000-4000-8000-000000000099', 'DELETE')).toMatchObject({
      module: 'trade',
      refused: false,
      reason: 'lets-the-user-out',
    });
  });

  it('allows the futures close routes so a kill does not trap margin', () => {
    expect(state().decide('/api/v1/positions/8f3c1d2e-0000-4000-8000-000000000099/close', 'POST')).toMatchObject({
      refused: false,
      reason: 'lets-the-user-out',
    });
    expect(state().decide('/api/v1/futures/positions/close-all', 'POST')).toMatchObject({
      refused: false,
      reason: 'lets-the-user-out',
    });
  });

  it('refuses POST /api/v1/positions — new risk under kill', () => {
    expect(state().decide('/api/v1/positions', 'POST')).toMatchObject({ module: 'trade', refused: true, reason: 'module-killed' });
  });

  it('allows cancel-all with a symbol filter — a query string must not decide whether you can leave', () => {
    expect(state().decide('/api/v1/orders?symbol=BTC/USDT', 'DELETE').refused).toBe(false);
  });

  it('still serves the REST reads a user needs to see what they are cancelling', () => {
    expect(state().decide('/api/v1/orders/open', 'GET').refused).toBe(false);
    expect(state().decide('/api/v1/account/balance', 'GET').refused).toBe(false);
  });

  it('treats the method case-insensitively, because a proxy is not a style guide', () => {
    expect(state().decide('/api/v1/orders', 'delete').refused).toBe(false);
    expect(state().decide('/api/v1/orders/x', 'Delete').refused).toBe(false);
  });

  it('does not let the release list leak to a different module', () => {
    const s = new KillSwitchState();
    s.set('pay', true, OPERATOR, 'rail partner outage, stop taking payments');
    // Same shape, different module: nothing in ALWAYS_ALLOWED_REST names it.
    expect(s.decide('/api/pay/orders/x', 'DELETE').refused).toBe(true);
  });

  it('keeps every release entry explicit and upper-cased', () => {
    // Guards against somebody adding a release path without an argument for it.
    for (const r of ALWAYS_ALLOWED_REST) {
      expect(r.what.length, `${r.method} ${r.pattern}`).toBeGreaterThan(0);
      expect(r.method).toBe(r.method.toUpperCase());
    }
  });
});

describe('an unrouted path', () => {
  it('is nobody"s module, and the 404 is the proxy"s job not the switch"s', () => {
    const s = new KillSwitchState();
    s.set('trade', true, OPERATOR, WHY);
    expect(s.decide('/api/unknown/x', 'POST')).toMatchObject({ module: null, refused: false, reason: 'no-route' });
  });

  it('matches on a segment boundary, so /api/tradesomething is not trade', () => {
    const s = new KillSwitchState();
    s.set('trade', true, OPERATOR, WHY);
    expect(s.decide('/api/tradesomething/x', 'POST').module).toBeNull();
  });
});

/**
 * The one bug that makes a safety control worse than nothing.
 *
 * If the switch's own check throws and the request is allowed through, the
 * operator believes the market is halted, the console says it is halted, and
 * orders are being accepted.
 */
describe('failing closed', () => {
  it('refuses when the decision itself throws', () => {
    const s = new KillSwitchState();
    // Broken from the outside rather than by reaching into privates: a pathname
    // that is not a string makes `startsWith` throw inside `evaluate`.
    const d = s.decide(undefined as unknown as string, 'POST');
    expect(d).toMatchObject({ refused: true, reason: 'undecidable' });
  });

  it('reports undecidable distinctly from a deliberate halt', () => {
    // The two call for different responses at 3am, so they must never share a
    // reason code in the logs.
    const s = new KillSwitchState();
    s.set('trade', true, OPERATOR, WHY);
    expect(s.decide('/api/trade/trpc/orders.create', 'POST').reason).toBe('module-killed');
    expect(s.decide(undefined as unknown as string, 'POST').reason).toBe('undecidable');
  });

  it('does not throw out of decide, whatever it is given', () => {
    const s = new KillSwitchState();
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(() => s.decide(bad as unknown as string, 'POST')).not.toThrow();
      expect(s.decide(bad as unknown as string, 'POST').refused).toBe(true);
    }
  });
});

describe('optional restart durability (EDGE_KILL_STATE_PATH)', () => {
  it('rehydrates killed modules from disk after a new process', () => {
    const dir = fixtureDir('edge-kill-');
    const path = join(dir, 'state.json');
    // An explicit empty list is the recorded all-on state. A missing file is not.
    writeFileSync(path, `${JSON.stringify({ killed: [] })}\n`);
    const a = new KillSwitchState({ statePath: path });
    expect(a.isKilled('trade')).toBe(false);
    a.set('trade', true, OPERATOR, WHY);
    expect(a.isKilled('trade')).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).killed).toEqual(expect.arrayContaining([expect.objectContaining({ module: 'trade' })]));

    const b = new KillSwitchState({ statePath: path });
    expect(b.isKilled('trade')).toBe(true);
    expect(b.decide('/api/v1/orders', 'POST')).toMatchObject({ refused: true, reason: 'module-killed' });
  });

  it('reports file durability as process-local, never multi-replica shared', () => {
    const dir = fixtureDir('edge-kill-');
    const path = join(dir, 'state.json');
    const d = new KillSwitchState({ statePath: path }).durability();
    expect(d.persistence).toBe('file');
    expect(d.multiReplicaShared).toBe(false);
    expect(d.note).toMatch(/§13|replica/i);
  });

  it('reports memory durability as process-local, never multi-replica shared', () => {
    const d = new KillSwitchState().durability();
    expect(d.persistence).toBe('memory');
    expect(d.multiReplicaShared).toBe(false);
    expect(d.note).toMatch(/Memory only|§13/i);
  });

  it('a missing, empty, or unreadable state file does not come back with every module ON, and a failed write does not drop the halt', () => {
    const expectHalted = (state: KillSwitchState) => {
      expect(state.disabledModules()).toEqual([...MODULE_IDS]);
      expect(state.decide('/api/v1/orders', 'POST')).toMatchObject({ refused: true, reason: 'module-killed' });
    };

    const missingDir = fixtureDir('edge-kill-');
    expectHalted(new KillSwitchState({ statePath: join(missingDir, 'missing.json') }));

    const emptyDir = fixtureDir('edge-kill-');
    const emptyPath = join(emptyDir, 'state.json');
    writeFileSync(emptyPath, '');
    expectHalted(new KillSwitchState({ statePath: emptyPath }));

    const blankDir = fixtureDir('edge-kill-');
    const blankPath = join(blankDir, 'state.json');
    writeFileSync(blankPath, '\n');
    expectHalted(new KillSwitchState({ statePath: blankPath }));

    const tornDir = fixtureDir('edge-kill-');
    const tornPath = join(tornDir, 'state.json');
    writeFileSync(tornPath, '{"killed":[{"module":"trade","reason":"incident halt"}');
    expectHalted(new KillSwitchState({ statePath: tornPath }));

    const shapelessDir = fixtureDir('edge-kill-');
    const shapelessPath = join(shapelessDir, 'state.json');
    writeFileSync(shapelessPath, '{}\n');
    expectHalted(new KillSwitchState({ statePath: shapelessPath }));

    const sealedDir = fixtureDir('edge-kill-');
    const sealedPath = join(sealedDir, 'state.json');
    writeFileSync(sealedPath, `${JSON.stringify({ killed: [] })}\n`);
    chmodSync(sealedPath, 0o000);
    try {
      expectHalted(new KillSwitchState({ statePath: sealedPath }));
    } finally {
      chmodSync(sealedPath, 0o644);
    }

    const durableDir = fixtureDir('edge-kill-');
    const durablePath = join(durableDir, 'state.json');
    const incident = `${JSON.stringify({ killed: [{ module: 'trade', reason: 'incident halt' }], updatedAt: '2026-07-30T00:00:00.000Z' }, null, 2)}\n`;
    writeFileSync(durablePath, incident);
    const live = new KillSwitchState({ statePath: durablePath });
    expect(live.isKilled('trade')).toBe(true);
    expect(live.isKilled('pay')).toBe(false);

    chmodSync(durablePath, 0o444);
    chmodSync(durableDir, 0o555);
    try {
      expect(() => live.set('pay', true, OPERATOR, WHY)).toThrow(/EACCES/);
    } finally {
      chmodSync(durableDir, 0o755);
      chmodSync(durablePath, 0o644);
    }

    expect(live.isKilled('trade')).toBe(true);
    expect(live.isKilled('pay')).toBe(false);
    expect(live.auditTrail().some((entry) => entry.module === 'pay')).toBe(false);
    expect(readFileSync(durablePath, 'utf8')).toBe(incident);

    const next = new KillSwitchState({ statePath: durablePath });
    expect(next.isKilled('trade')).toBe(true);
    expect(next.isKilled('pay')).toBe(false);
    expect(next.decide('/api/v1/orders', 'POST')).toMatchObject({ refused: true, reason: 'module-killed' });
  });
});

/**
 * TWO PARSERS, TWO ANSWERS — the shape that walked through a halted module.
 *
 * The guard prefix-matched the raw target; the proxy re-read the same request
 * with `new URL`, which removes dot segments. So `/api/trade/../identity/...`
 * was "trade" to the guard and "identity" to the upstream, and an operator who
 * had halted identity kept serving it — with the console still reporting it
 * disabled and no 503 anywhere in the log.
 */
it('halts every module for corrupt rows rather than silently dropping them', () => {
  const path = join(fixtureDir('edge-corrupt-row-'), 'state.json');
  for (const killed of [
    [null],
    [[]],
    [{ module: 'unknown' }],
    [{ module: 'trade', reason: 123 }],
    [{ module: 'trade' }, { module: 'unknown' }],
  ]) {
    writeFileSync(path, JSON.stringify({ killed }));
    const state = new KillSwitchState({ statePath: path });
    expect(state.disabledModules()).toEqual(MODULE_IDS);
    expect(state.decide('/api/v1/orders', 'POST').refused).toBe(true);
    expect(state.decide('/api/v1/orders', 'GET').refused).toBe(false);
    expect(state.decide('/api/v1/orders/id', 'DELETE').refused).toBe(false);
  }
});

describe('resolvedPathname — the guard and the proxy must agree', () => {
  it('resolves a dot segment the way the proxy does, rather than matching the raw target', () => {
    // `new URL` collapses these, so the guard must too or it is answering a
    // question about a path nobody will be served.
    expect(resolvedPathname('/api/trade/../identity/trpc/auth.login')).toBe('/api/identity/trpc/auth.login');
    expect(resolvedPathname('/api/v1/../identity/trpc/auth.login')).toBe('/api/identity/trpc/auth.login');
    expect(resolvedPathname('/api/trade/./orders')).toBe('/api/trade/orders');
  });

  it('collapses a percent-encoded dot segment too, rather than refusing it', () => {
    // Checked against this Node rather than assumed: `new URL` decodes %2e and
    // resolves these exactly like `..`, so the resolved path is already the one
    // the proxy will use and there is nothing to refuse.
    expect(resolvedPathname('/api/trade/%2e%2e/identity/trpc/auth.login')).toBe('/api/identity/trpc/auth.login');
    expect(resolvedPathname('/api/trade/%2E%2E/identity/trpc/auth.login')).toBe('/api/identity/trpc/auth.login');
    expect(resolvedPathname('/api/trade/%2e/orders')).toBe('/api/trade/orders');
  });

  it('refuses a dot segment hidden behind an encoded slash — the one URL leaves alone', () => {
    // `%2f` hides the segment boundary from the parser, so these survive
    // verbatim and whether they become a separator is the UPSTREAM's decision.
    // That is the same disagreement, one layer down.
    expect(resolvedPathname('/api/trade/..%2fidentity/trpc/auth.login')).toBeNull();
    expect(resolvedPathname('/api/trade/%2f../identity/trpc/auth.login')).toBeNull();
  });

  it('does NOT refuse an ordinary encoded slash — the cancel path must keep working', () => {
    // A CCXT symbol is not a traversal, and `/api/v1/orders/...` is a release
    // route that lets users out during an incident.
    expect(resolvedPathname('/api/v1/orders/BTC%2FUSDT')).toBe('/api/v1/orders/BTC%2FUSDT');
  });

  it('refuses a malformed escape rather than throwing', () => {
    expect(resolvedPathname('/api/trade/%zz/orders')).toBeNull();
  });

  it('leaves an ordinary path alone, including tRPC dots and a query string', () => {
    expect(resolvedPathname('/api/trade/trpc/orders.create')).toBe('/api/trade/trpc/orders.create');
    expect(resolvedPathname('/api/v1/orders?symbol=BTC/USDT')).toBe('/api/v1/orders');
    expect(resolvedPathname('/health')).toBe('/health');
    expect(resolvedPathname('/admin/status')).toBe('/admin/status');
  });

  it('a traversal cannot reach a killed module through a live prefix', () => {
    const state = new KillSwitchState();
    state.set('identity', true, OPERATOR, WHY);

    // What the guard now decides on is the resolved path, so the answer is the
    // same one the upstream would give.
    const resolved = resolvedPathname('/api/trade/../identity/trpc/auth.login');
    expect(resolved).not.toBeNull();
    expect(state.decide(resolved!, 'POST')).toMatchObject({ module: 'identity', refused: true });

    // And the raw target — what the old guard matched — is what made it look safe.
    expect(state.decide('/api/trade/../identity/trpc/auth.login', 'POST')).toMatchObject({ refused: false });
  });
});

/**
 * A tRPC batch is ONE request carrying several calls, and the rule read only
 * the last of them — so the attacker chose the order.
 */
describe('a batch is allowed only if every call in it is allowed', () => {
  function halted() {
    const state = new KillSwitchState();
    state.set('trade', true, OPERATOR, WHY);
    return state;
  }

  it('refuses a batch that hides a create behind a trailing cancel', () => {
    // This is the exact pair that used to pass: leaf of the raw capture was
    // `cancel`, so the create rode in with it.
    expect(halted().decide('/api/trade/trpc/orders.create,orders.cancel', 'POST')).toMatchObject({
      refused: true,
      reason: 'module-killed',
    });
  });

  it('refuses it in the other order too — the answer must not depend on ordering', () => {
    expect(halted().decide('/api/trade/trpc/orders.cancel,orders.create', 'POST')).toMatchObject({ refused: true });
  });

  it('still lets a pure cancel out, batched or not — the release path is the point', () => {
    expect(halted().decide('/api/trade/trpc/orders.cancel', 'POST')).toMatchObject({
      refused: false,
      reason: 'lets-the-user-out',
    });
    expect(halted().decide('/api/trade/trpc/orders.cancel,positions.cancel', 'POST')).toMatchObject({
      refused: false,
      reason: 'lets-the-user-out',
    });
  });

  it('refuses an encoded comma the same way — encoding is not an argument', () => {
    expect(halted().decide('/api/trade/trpc/orders.create%2Corders.cancel', 'POST')).toMatchObject({ refused: true });
  });
});
