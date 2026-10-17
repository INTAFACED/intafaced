import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAccess } from '@intafaced/config';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
} from '@intafaced/contracts';
import {
  QUANT_BACKTEST_FILLS_MISSING,
  QUANT_BACKTEST_LAKE_MISSING,
  QUANT_BACKTEST_WALK_FORWARD_REQUIRED,
  QUANT_CASH_UNSET,
  QUANT_SANDBOX_ESCAPE,
  QUANT_SANDBOX_MAX_OPS_UNSET,
  QUANT_SANDBOX_MAX_SOURCE_UNSET,
  QUANT_SANDBOX_UNWIRED,
  QUANT_ENVIRONMENT_REQUIRED,
  QUANT_SIMULATED_AS_LIVE,
  QUANT_STUDIO_RISK_BLOCK_REQUIRED,
  QUANT_VENUE_VAULT_UNSET,
} from './errors.js';
import type { BacktestLake } from './backtest/lake.js';
import { createQuantRouter, type QuantRouter } from './router.js';
import { createMemoryStrategyRepository } from './studio/memory-repository.js';

const SECRET = 'a-quant-mount-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const anonymous = (region = 'DE') => edgeContext({ headers: { 'x-intafaced-region': region }, id: 'req-anon' });

function signed(userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'): ReturnType<typeof edgeContext> {
  const principal = {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read'],
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } satisfies Parameters<typeof encodePrincipal>[0];
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-region': 'DE',
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE'),
    },
    id: `req-${userId}`,
  });
}

const limits = { maxOps: 5_000, maxSource: 8_000 };

const SAMPLE_JS = `const px = market.last("BTC-USD");
oms.buy("BTC-USD", "0.01");
console.log(px);
console.log(book.cash());
console.log(book.pnl());`;

async function mountQuant(router: QuantRouter): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<QuantRouter>['trpcOptions'],
  });
  await app.ready();
  return app;
}

describe('svc-quant mount — sandbox.run', () => {
  it('serves a five-line javascript run over the wire with decimal-string pnl', async () => {
    const caller = createQuantRouter({ wired: true, venueVaultSet: false, limits }).createCaller(anonymous());
    const ran = await caller.sandbox.run({
      language: 'javascript',
      source: SAMPLE_JS,
      cash: '10000',
      environment: 'paper',
      idempotencyKey: 'idem-mount',
    });
    expect(ran.ok).toBe(true);
    expect(typeof ran.pnl).toBe('string');
    expect(typeof ran.cash).toBe('string');
    expect(ran.fills[0]?.qty).toBe('0.01');
    expect(ran.venue).toBe('internal');
    expect(ran.venueVault).toBe('unset');
    expect(ran.live).toBe(false);
    expect(ran.simulated).toBe(true);
    expect(ran.environment).toBe('paper');
    expect(ran.claimLabel).toBe('Paper — not live performance');
    expect(ran.kind).toBe('paper');
  });

  it('serves python the same way', async () => {
    const caller = createQuantRouter({ wired: true, venueVaultSet: false, limits }).createCaller(anonymous());
    const ran = await caller.sandbox.run({
      language: 'python',
      source: 'oms.buy("BTC-USD", "0.01")\nprint(book.pnl())',
      cash: '10000',
      environment: 'paper',
      idempotencyKey: 'idem-python',
    });
    expect(ran.pnl).toBe('0');
    expect(ran.logs[0]).toBe('0');
  });

  it('refuses unwired isolate by name, and does not invent pnl', async () => {
    const caller = createQuantRouter({ wired: false, venueVaultSet: false, limits }).createCaller(anonymous());
    await expect(
      caller.sandbox.run({ language: 'javascript', source: SAMPLE_JS, cash: '10000', environment: 'paper', idempotencyKey: 'idem-mount' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(QUANT_SANDBOX_UNWIRED),
    });
  });

  it('refuses unpublished SANDBOX_MAX_OPS by name — never invent 50000', async () => {
    const caller = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits: { maxOps: undefined, maxSource: 8_000 },
    }).createCaller(anonymous());
    await expect(
      caller.sandbox.run({ language: 'javascript', source: SAMPLE_JS, cash: '10000', environment: 'paper', idempotencyKey: 'idem-mount' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(QUANT_SANDBOX_MAX_OPS_UNSET),
    });
  });

  it('refuses unpublished SANDBOX_MAX_SOURCE by name — never invent 8000', async () => {
    const caller = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits: { maxOps: 5_000, maxSource: undefined },
    }).createCaller(anonymous());
    await expect(
      caller.sandbox.run({ language: 'javascript', source: SAMPLE_JS, cash: '10000', environment: 'paper', idempotencyKey: 'idem-mount' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(QUANT_SANDBOX_MAX_SOURCE_UNSET),
    });
  });

  it('refuses a network escape rather than running it', async () => {
    const caller = createQuantRouter({ wired: true, venueVaultSet: false, limits }).createCaller(anonymous());
    await expect(
      caller.sandbox.run({
        language: 'javascript',
        source: 'fetch("https://evil.example")',
        cash: '10000',
        environment: 'paper',
        idempotencyKey: 'idem-escape',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(QUANT_SANDBOX_ESCAPE),
    });
  });

  it('refuses venue OMS when the vault pin is unset', async () => {
    const caller = createQuantRouter({ wired: true, venueVaultSet: false, limits }).createCaller(anonymous());
    await expect(
      caller.sandbox.run({
        language: 'javascript',
        source: 'oms.venueBuy("BTC-USD", "0.01")',
        cash: '10000',
        environment: 'paper',
        idempotencyKey: 'idem-venue',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(QUANT_VENUE_VAULT_UNSET),
    });
  });

  it('refuses sandbox.run when cash is omitted — never invents 10000', async () => {
    const caller = createQuantRouter({ wired: true, venueVaultSet: false, limits }).createCaller(anonymous());
    await expect(
      caller.sandbox.run({ language: 'javascript', source: SAMPLE_JS, environment: 'paper', idempotencyKey: 'idem-cash' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(QUANT_CASH_UNSET),
    });
  });

  it('refuses sandbox.run when cash is null — never invents 10000', async () => {
    const caller = createQuantRouter({ wired: true, venueVaultSet: false, limits }).createCaller(anonymous());
    await expect(
      caller.sandbox.run({ language: 'javascript', source: SAMPLE_JS, cash: null, environment: 'paper', idempotencyKey: 'idem-cash-null' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(QUANT_CASH_UNSET),
    });
  });

  it('accepts explicit cash 10000 (owner-published, not invented)', async () => {
    const caller = createQuantRouter({ wired: true, venueVaultSet: false, limits }).createCaller(anonymous());
    const ran = await caller.sandbox.run({
      language: 'javascript',
      source: SAMPLE_JS,
      cash: '10000',
      environment: 'paper',
      idempotencyKey: 'idem-explicit-cash',
    });
    expect(ran.ok).toBe(true);
    expect(ran.cash).toBeTruthy();
  });

  it('admits the sandbox without KYC on the fiat paper book', () => {
    const decision = checkAccess({ module: 'quant', plane: 'fiat', region: 'DE', kycTier: 'none' });
    expect(decision.allowed).toBe(true);
  });

  it('reports capabilities without fabricating a vault', async () => {
    const caller = createQuantRouter({ wired: true, venueVaultSet: false, limits }).createCaller(anonymous());
    const caps = await caller.sandbox.capabilities();
    expect(caps.isolate).toBe('wired');
    expect(caps.venueVault).toBe('unset');
    expect(caps.languages).toContain('python');
  });
});

describe('svc-quant mount — studio.save', () => {
  const risk = { maxDrawdown: '500', maxNotional: '10000', kill: '100' };
  const blocks = [{ side: 'buy' as const, symbol: 'BTC-USD', qty: '0.01' }];

  it('refuses missing risk block by name and does not persist', async () => {
    const caller = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits,
      strategies: createMemoryStrategyRepository(),
    }).createCaller(signed());
    await expect(caller.studio.save({ name: 'alpha', blocks, cash: '10000', environment: 'paper' })).rejects.toMatchObject({
      message: expect.stringContaining(QUANT_STUDIO_RISK_BLOCK_REQUIRED),
    });
    const listed = await caller.studio.list({ limit: 50 });
    expect(listed.strategies).toEqual([]);
  });

  it('refuses studio.save when cash is omitted — never invents 10000', async () => {
    const caller = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits,
      strategies: createMemoryStrategyRepository(),
    }).createCaller(signed());
    await expect(caller.studio.save({ name: 'alpha', blocks, risk, environment: 'paper' })).rejects.toMatchObject({
      message: expect.stringContaining(QUANT_CASH_UNSET),
    });
    const listed = await caller.studio.list({ limit: 50 });
    expect(listed.strategies).toEqual([]);
  });

  it('saves a no-code strategy then runs it through existing sandbox.run', async () => {
    const caller = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits,
      strategies: createMemoryStrategyRepository(),
    }).createCaller(signed());
    const saved = await caller.studio.save({
      name: 'alpha',
      blocks,
      risk,
      cash: '10000',
      environment: 'paper',
      clientStrategyId: 'client-alpha',
      idempotencyKey: 'idem-alpha',
    });
    expect(saved.risk.maxDrawdown).toBe('500');
    expect(typeof saved.risk.maxNotional).toBe('string');
    expect(typeof saved.cash).toBe('string');
    expect('pnl' in saved).toBe(false);
    expect(saved.source).toContain('oms.buy');

    const ran = await caller.sandbox.run({
      language: saved.language,
      source: saved.source,
      cash: saved.cash,
      environment: 'paper',
      idempotencyKey: 'idem-saved-source',
    });
    expect(ran.ok).toBe(true);
    expect(typeof ran.pnl).toBe('string');
    expect(ran.fills[0]?.qty).toBe('0.01');
  });
});

describe('svc-quant mount — backtest.run', () => {
  const walkForward = {
    inSampleFrom: '2026-01-01T00:00:00.000Z',
    inSampleTo: '2026-04-01T00:00:00.000Z',
    outOfSampleFrom: '2026-04-01T00:00:00.000Z',
    outOfSampleTo: '2026-07-01T00:00:00.000Z',
  };
  const costModel = {
    fees: { kind: 'venue-schedule', source: 'connect:venue-a:fee-schedule:v7' },
    slippage: { kind: 'order-book-replay', source: 'connect:data-lake:venue-a:depth:v3' },
    latency: { kind: 'measured-distribution', source: 'connect:venue-a:round-trip:2026-q2' },
  };
  const lake: BacktestLake = {
    wired: true,
    fills: () => [
      { ts: '2026-02-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.01', price: '50000' },
      { ts: '2026-05-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.02', price: '51000' },
    ],
  };

  async function owned(lakeOverride?: BacktestLake) {
    const caller = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits,
      strategies: createMemoryStrategyRepository(),
      ...(lakeOverride ? { lake: lakeOverride } : {}),
    }).createCaller(signed());
    const saved = await caller.studio.save({
      name: 'alpha',
      blocks: [{ side: 'buy' as const, symbol: 'BTC-USD', qty: '0.01' }],
      risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
      cash: '10000',
      environment: 'paper',
      clientStrategyId: `client-${crypto.randomUUID()}`,
      idempotencyKey: `idem-${crypto.randomUUID()}`,
    });
    return { caller, strategyId: saved.id, strategyVersion: saved.version };
  }

  it('refuses missing lake by name', async () => {
    const { caller, strategyId } = await owned();
    await expect(
      caller.backtest.run({
        strategyId,
        symbol: 'BTC-USD',
        walkForward,
        outOfSampleStatus: 'passed',
        costModel,
        strategyVariantCount: 1,
        environment: 'backtest',
        idempotencyKey: 'idem-lake',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining(QUANT_BACKTEST_LAKE_MISSING) });
  });

  it('refuses missing fills by name', async () => {
    const empty: BacktestLake = { wired: true, fills: () => [] };
    const { caller, strategyId } = await owned(empty);
    await expect(
      caller.backtest.run({
        strategyId,
        symbol: 'BTC-USD',
        walkForward,
        outOfSampleStatus: 'passed',
        costModel,
        strategyVariantCount: 1,
        environment: 'backtest',
        idempotencyKey: 'idem-fills',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining(QUANT_BACKTEST_FILLS_MISSING) });
  });

  it('refuses missing walk-forward by name', async () => {
    const { caller, strategyId } = await owned(lake);
    await expect(
      caller.backtest.run({
        strategyId,
        symbol: 'BTC-USD',
        outOfSampleStatus: 'passed',
        costModel,
        strategyVariantCount: 1,
        environment: 'backtest',
        idempotencyKey: 'idem-window',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining(QUANT_BACKTEST_WALK_FORWARD_REQUIRED) });
  });

  it('metrics from fills; OOS and cost-model refusals stay named', async () => {
    const { caller, strategyId, strategyVersion } = await owned(lake);
    await expect(
      caller.backtest.run({
        strategyId,
        symbol: 'BTC-USD',
        walkForward,
        costModel,
        strategyVariantCount: 1,
        environment: 'backtest',
        idempotencyKey: 'idem-oos',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('missing_out_of_sample_verdict') });

    const ran = await caller.backtest.run({
      strategyId,
      symbol: 'BTC-USD',
      walkForward,
      outOfSampleStatus: 'passed',
      costModel,
      strategyVariantCount: 1,
      environment: 'backtest',
      idempotencyKey: 'idem-metrics',
    });
    expect(ran.ok).toBe(true);
    expect(ran.strategyVersion).toBe(strategyVersion);
    expect(typeof ran.inSample.notional).toBe('string');
    expect(typeof ran.outOfSample.notional).toBe('string');
    expect(ran.outOfSample.fillCount).toBe(1);
    expect('pnl' in ran).toBe(false);
    expect(ran.live).toBe(false);
    expect(ran.simulated).toBe(true);
    expect(ran.environment).toBe('backtest');
    expect(ran.claimLabel).toBe('Historical simulation — not a forecast');
  });
});
describe('svc-quant mount — simulated is never live', () => {
  it('refuses sandbox.run without environment', async () => {
    const caller = createQuantRouter({ wired: true, venueVaultSet: false, limits }).createCaller(anonymous());
    await expect(
      caller.sandbox.run({ language: 'javascript', source: SAMPLE_JS, cash: '10000', idempotencyKey: 'idem-env' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(QUANT_ENVIRONMENT_REQUIRED),
    });
  });

  it('refuses sandbox.run when environment is live', async () => {
    const caller = createQuantRouter({ wired: true, venueVaultSet: false, limits }).createCaller(anonymous());
    await expect(
      caller.sandbox.run({ language: 'javascript', source: SAMPLE_JS, cash: '10000', environment: 'live', idempotencyKey: 'idem-live' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(QUANT_SIMULATED_AS_LIVE),
    });
  });

  it('refuses marketplace.claim that presents a run as live', async () => {
    const caller = createQuantRouter({ wired: true, venueVaultSet: false, limits }).createCaller(anonymous());
    await expect(
      caller.marketplace.claim({ runId: 'run_missing', environment: 'paper', presentedAs: 'live', idempotencyKey: 'idem-live-claim' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(QUANT_SIMULATED_AS_LIVE),
    });
  });

  it('rejects a client-supplied pnl in the claim schema', async () => {
    const caller = createQuantRouter({ wired: true, venueVaultSet: false, limits }).createCaller(signed());
    await expect(
      caller.marketplace.claim({
        runId: 'run_missing',
        idempotencyKey: 'idem-pnl',
        environment: 'paper',
        pnl: '12.5',
      } as never),
    ).rejects.toThrow(/pnl|Unrecognized/i);
  });
});

describe('svc-quant mounted request screening', () => {
  it('refuses an authenticated request before loading backtest fills when the sanctions list is unset', async () => {
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'on');
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', '');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', '');

    let fillReads = 0;
    const lake: BacktestLake = {
      wired: true,
      fills() {
        fillReads += 1;
        return [
          { ts: '2026-02-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.01', price: '50000' },
          { ts: '2026-05-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.02', price: '51000' },
        ];
      },
    };
    const router = createQuantRouter({ wired: true, venueVaultSet: false, limits, lake });
    const app = await mountQuant(router);
    const principal = {
      sub: '11111111-1111-4111-8111-111111111111',
      userId: '11111111-1111-4111-8111-111111111111',
      sid: '22222222-2222-4222-8222-222222222222',
      scopes: ['quant:read'],
      tier: 'none',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } satisfies Parameters<typeof encodePrincipal>[0];
    const raw = encodePrincipal(principal);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/trpc/backtest.run',
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        payload: {
          strategyId: 'alpha',
          symbol: 'BTC-USD',
          walkForward: {
            inSampleFrom: '2026-01-01T00:00:00.000Z',
            inSampleTo: '2026-04-01T00:00:00.000Z',
            outOfSampleFrom: '2026-04-01T00:00:00.000Z',
            outOfSampleTo: '2026-07-01T00:00:00.000Z',
          },
          outOfSampleStatus: 'passed',
          costModel: {
            fees: { kind: 'venue-schedule', source: 'fixture:fees' },
            slippage: { kind: 'order-book-replay', source: 'fixture:depth' },
            latency: { kind: 'measured-distribution', source: 'fixture:latency' },
          },
          strategyVariantCount: 1,
          environment: 'backtest',
        },
      });
      const body = response.json() as { error?: { message?: string; data?: { code?: string; httpStatus?: number } } };
      expect(response.statusCode).toBe(403);
      expect(body.error?.data).toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
      expect(body.error?.message).toContain('Sanctions screening list is unset');
      expect(body.error?.message).toContain('INTAFACED_SCREENING_FAIL_CLOSED');
      expect(fillReads).toBe(0);
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  });
});

describe('svc-quant router — cash is never invented', () => {
  it('has no decimal.default(10000) on studio.save or sandbox.run', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'router.ts'), 'utf8');
    expect(src).not.toMatch(/decimal\.default\(['"]10000['"]\)/);
    expect(src).toMatch(/cash:\s*decimal\.optional\(\)\.nullable\(\)/);
  });
});

describe('svc-quant health — liveness is not a custodial stamp', () => {
  it('answers ok + service and does not stamp custodial:false', async () => {
    const caller = createQuantRouter({ wired: true, venueVaultSet: false, limits }).createCaller(anonymous());
    const health = await caller.health();
    expect(health).toEqual({ ok: true, service: 'svc-quant' });
    expect(health).not.toHaveProperty('custodial');
  });

  it('router.ts health does not literal-stamp custodial:false', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'router.ts'), 'utf8');
    expect(src).not.toMatch(/custodial:\s*z\.literal\(false\)/);
    expect(src).not.toMatch(/custodial:\s*false\s+as const/);
  });
});
