/**
 * What the trade router and the position service can reach, asked of the modules themselves.
 *
 * The money mills that settle dated futures, reconcile funding, gate ADL and haircut collateral are run by the jobs
 * and the open path, never by a tRPC procedure. Each test fresh-imports the module with those mills replaced by
 * recorders (every export, so a new one is watched too), then drives what the module offers and asserts the mills were
 * never loaded, or never called.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts/edge';
import type { Principal } from '@intafaced/auth';

/** The mills no procedure may run, by the module that defines them (relative to this file). */
const MILLS = [
  './adl-last-resort.js',
  './liquidation-adl-gate.js',
  './collateral-haircut.js',
  './dated-futures-settlement.js',
  './funding-recon.js',
] as const;

/** Mills the router's own module graph never loads at all (the others reach it through the open and close paths). */
const NEVER_LOADED_BY_ROUTER = ['./collateral-haircut.js', './dated-futures-settlement.js', './funding-recon.js'] as const;

/** Refusal codes only those mills raise. */
const MILL_CODES = /haircut_unset|funding_recon_diverged|funding_rate_unset|adl_unconfigured|adl_no_eligible|dated_futures_settlement/;

const SECRET = 'dev-only-futures-module-reach-edge-secret-0123456789';

interface Watch {
  loaded: string[];
  called: string[];
}

/** Replace every function each mill exports with a recorder that still runs the real one. */
function watchMills(): Watch {
  const watch: Watch = { loaded: [], called: [] };
  for (const path of MILLS) {
    vi.doMock(path, async (importOriginal) => {
      watch.loaded.push(path);
      const real = await importOriginal<Record<string, unknown>>();
      const out: Record<string, unknown> = { ...real };
      for (const [name, value] of Object.entries(real)) {
        if (typeof value !== 'function' || /^class\b/.test(Function.prototype.toString.call(value))) continue;
        out[name] = (...args: unknown[]) => {
          watch.called.push(`${path}#${name}`);
          return (value as (...a: unknown[]) => unknown)(...args);
        };
      }
      return out;
    });
  }
  return watch;
}

afterEach(() => {
  for (const path of MILLS) vi.doUnmock(path);
  vi.resetModules();
});

/** A recording stand-in for every service the router is handed: each method answers undefined. */
function recordingService(calls: string[], name: string): never {
  return new Proxy(
    {},
    {
      get: (_t, key) => (typeof key === 'symbol' ? undefined : async () => void calls.push(`${name}.${String(key)}`)),
    },
  ) as never;
}

function signedHeaders(): Record<string, string> {
  const userId = '11111111-1111-4111-8111-111111111111';
  const principal = {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write', 'admin:read', 'admin:write'],
    tier: 'basic',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const encoded = encodePrincipal(principal);
  return {
    'x-intafaced-principal': encoded,
    'x-intafaced-principal-sig': signPrincipalHeader(encoded, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

describe('the trade router runs no futures money mill', () => {
  it('mounts no ADL, haircut, funding-recon or dated-settlement procedure', async () => {
    vi.resetModules();
    const { createTradeRouter } = await import('../router.js');
    const paths = Object.keys(createTradeRouter({} as never)._def.procedures as Record<string, unknown>);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => /(^|\.)adl|Adl|[hH]aircut|[fF]unding\.?[rR]econ|[dD]ated|[lL]astResort|[mM]axReduce/.test(p))).toEqual([]);
  });

  it('never loads the haircut, funding-recon or dated-settlement mill', async () => {
    vi.resetModules();
    const watch = watchMills();
    const router = await import('../router.js');
    // Every export the router module offers is driven: the factory builds the whole router.
    expect(Object.keys(router).sort()).toEqual(['PlaceAttemptBook', 'createTradeRouter', 'toTrpcError']);
    new router.PlaceAttemptBook();
    router.toTrpcError(new Error('probe'));
    router.createTradeRouter({} as never);
    for (const path of NEVER_LOADED_BY_ROUTER) expect(watch.loaded, path).not.toContain(path);
  });

  it('calls no mill from any procedure, signed in with every scope it checks', async () => {
    vi.resetModules();
    const watch = watchMills();
    const { createTradeRouter } = await import('../router.js');
    const services: string[] = [];
    const router = createTradeRouter(
      recordingService(services, 'trade'),
      recordingService(services, 'otc'),
      recordingService(services, 'copy'),
      recordingService(services, 'controls'),
      recordingService(services, 'admin'),
      recordingService(services, 'insurance'),
      recordingService(services, 'support'),
      recordingService(services, 'lead'),
    );
    const context = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });
    const caller = router.createCaller(context({ headers: signedHeaders(), id: 'req-module-reach' })) as unknown as Record<string, unknown>;
    const paths = Object.keys(router._def.procedures as Record<string, unknown>);
    const codes: string[] = [];
    for (const path of paths) {
      const fn = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], caller) as (i?: unknown) => Promise<unknown>;
      for (const input of [undefined, {}]) {
        try {
          await fn(input);
        } catch (err) {
          const e = err as { code?: unknown; cause?: { code?: unknown }; message?: unknown };
          codes.push(String(e.cause?.code ?? ''), String(e.code ?? ''), String(e.message ?? ''));
        }
      }
    }
    // The calls did reach the handlers (the services were asked), and no handler ran a mill or raised its code.
    expect(services.length).toBeGreaterThan(0);
    expect(watch.called).toEqual([]);
    expect(codes.filter((c) => MILL_CODES.test(c))).toEqual([]);
  });
});

describe('the position service does not wrap its own open in the haircut layer', () => {
  it('never loads collateral-haircut: the layer is applied at start-up, outside it', async () => {
    vi.resetModules();
    const watch = watchMills();
    const mod = await import('./position-service.js');
    expect(typeof mod.PositionService).toBe('function');
    expect(watch.loaded).not.toContain('./collateral-haircut.js');
  });
});
