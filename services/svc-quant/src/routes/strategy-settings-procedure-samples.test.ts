import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
  type QuantSignalRules,
} from '@intafaced/contracts';
import type { ProcedureSample } from '@intafaced/contracts/procedure';
import { QUANT_STRATEGY_SETTINGS_PROCEDURES } from '@intafaced/contracts/quant-strategy-settings-procedures';
import { createQuantRouter } from '../router.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';

/**
 * The mounted side of each per-strategy settings record (`risk.*`, `notify.*`, `lifecycle.*`): sent through the production
 * Fastify adapter by a signed customer, a refused sample is answered 400 (the input is malformed), an accepted one never
 * is. Each refusal svc-quant sends leaves with the status its record lists, under the strict check that fails on one the
 * record does not list. The record's zod schema and its JSON export run the same samples in `@intafaced/contracts`.
 */

const SECRET = 'a-quant-settings-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });

function headers(): Record<string, string> {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  });
  return { 'x-intafaced-region': 'DE', [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE') };
}
const signed = () => edgeContext({ headers: headers(), id: 'req-settings-samples' } as never);

const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '1' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};

/** `index.ts`'s wiring from an empty environment: no database, so every call refuses `quant.database_url_unset`. */
const app = Fastify();

beforeAll(async () => {
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('PROCEDURE_REFUSALS_STRICT', '1');
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: createQuantRouter({ wired: true, venueVaultSet: false, limits: { maxOps: undefined, maxSource: undefined } }),
      createContext: ({ req }: { req: unknown }) => edgeContext(req as never),
    },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

type SettingsRecord = (typeof QUANT_STRATEGY_SETTINGS_PROCEDURES)[number];

async function send(record: SettingsRecord, input: unknown) {
  const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  return record.kind === 'query'
    ? app.inject({ method: 'GET', url, headers: headers() })
    : app.inject({
        method: 'POST',
        url,
        headers: { ...headers(), 'content-type': 'application/json' },
        payload: input === undefined ? '' : JSON.stringify(input),
      });
}

const cases = QUANT_STRATEGY_SETTINGS_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-quant's per-strategy settings routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else {
      expect(res.statusCode, res.body).toBe(412);
      expect(res.body).toContain('quant.database_url_unset');
    }
  });
});

describe('each refusal leaves with the status its record lists', () => {
  function wired() {
    const router = createQuantRouter({
      wired: true,
      venueVaultSet: false,
      limits: { maxOps: 5_000, maxSource: 8_000 },
      strategies: createMemoryStrategyRepository(),
    });
    return router.createCaller(signed());
  }
  async function saved(caller: ReturnType<typeof wired>) {
    const out = await caller.studio.save({
      name: 'TEST settings',
      blocks: [],
      modules: RULES,
      risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: 'client-settings',
      idempotencyKey: 'save-settings',
    });
    return out.id;
  }
  const refusal = async (call: Promise<unknown>) => {
    const err = (await call.then(
      () => null,
      (e: unknown) => e,
    )) as { code?: string; cause?: { code?: string } } | null;
    expect(err, 'the call was refused').not.toBeNull();
    return { status: err!.code, code: err!.cause?.code };
  };
  const listed = (record: SettingsRecord, code: string) => ({ status: record.refusals[code], code });

  it('a missing strategy refuses quant.studio_not_found on all seven', async () => {
    const caller = wired();
    const id = { strategyId: 's-missing' };
    const [rGet, rSet, rTrading, nGet, nSet, lGet, lPromote] = QUANT_STRATEGY_SETTINGS_PROCEDURES;
    const code = 'quant.studio_not_found';
    expect(await refusal(caller.risk.get(id))).toEqual(listed(rGet, code));
    expect(
      await refusal(
        caller.risk.set({
          ...id,
          caps: { depositPercent: '', maxPositionNotional: '', maxDailyLoss: '', equityFloor: '' },
          floorPolicy: '',
        }),
      ),
    ).toEqual(listed(rSet, code));
    expect(await refusal(caller.risk.trading({ ...id, on: true }))).toEqual(listed(rTrading, code));
    expect(await refusal(caller.notify.get(id))).toEqual(listed(nGet, code));
    expect(await refusal(caller.notify.set({ ...id, channels: [] }))).toEqual(listed(nSet, code));
    expect(await refusal(caller.lifecycle.get({ ...id, strategyVersion: 1 }))).toEqual(listed(lGet, code));
    expect(await refusal(caller.lifecycle.promote({ ...id, strategyVersion: 1, seq: 0 }))).toEqual(listed(lPromote, code));
  });

  it("each call's own refusals on a saved strategy", async () => {
    const caller = wired();
    const strategyId = await saved(caller);
    const [, rSet, rTrading, , nSet, , lPromote] = QUANT_STRATEGY_SETTINGS_PROCEDURES;
    expect(
      await refusal(
        caller.risk.set({
          strategyId,
          caps: { depositPercent: '0', maxPositionNotional: '', maxDailyLoss: '', equityFloor: '' },
          floorPolicy: '',
        }),
      ),
    ).toEqual(listed(rSet, 'quant.risk_cap_invalid'));
    expect(await refusal(caller.risk.trading({ strategyId, on: true }))).toEqual(listed(rTrading, 'quant.risk_cap_unset'));
    expect(await refusal(caller.notify.set({ strategyId, channels: ['webhook'] }))).toEqual(
      listed(nSet, 'quant.notify_channel_unavailable'),
    );
    expect(await refusal(caller.notify.set({ strategyId, channels: ['pigeon'] }))).toEqual(listed(nSet, 'quant.params_invalid'));
    expect(await refusal(caller.lifecycle.promote({ strategyId, strategyVersion: 1, seq: 0 }))).toEqual(
      listed(lPromote, 'quant.gate_criteria_unset'),
    );
  });
});
