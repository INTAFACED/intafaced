import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
  type QuantSignalRules,
} from '@intafaced/contracts';
import { createQuantRouter } from '../router.js';
import { compileSignalRules, signalSource, templateSource } from './modules.js';
import { createMemoryStrategyRepository } from './memory-repository.js';

const SECRET = 'a-quant-signal-rules-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const limits = { maxOps: 5_000, maxSource: 8_000 };
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '10', slow: '30' },
  sizing: { kind: 'quantity', value: '0.01' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};
const with_ = (patch: (r: QuantSignalRules) => QuantSignalRules) => patch(structuredClone(RULES));

function signed(userId: string) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read'],
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return edgeContext({
    headers: {
      'x-intafaced-region': 'DE',
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE'),
    },
    id: `req-${userId}`,
  });
}

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

function app() {
  return createQuantRouter({ wired: true, venueVaultSet: false, limits, strategies: createMemoryStrategyRepository() });
}

describe('signal rules compiler', () => {
  it('names the first blank required input and runs nothing', () => {
    expect(() => compileSignalRules(with_((r) => ({ ...r, symbol: '  ' })))).toThrow(/quant\.param_unset — symbol is blank/);
    expect(() => compileSignalRules(with_((r) => ({ ...r, signal: { ...r.signal, slow: '' } })))).toThrow(
      /quant\.param_unset — signal\.slow is blank/,
    );
    expect(() => compileSignalRules(with_((r) => ({ ...r, sizing: { ...r.sizing, value: '' } })))).toThrow(
      /quant\.sizing_rule_unset — sizing\.value is blank/,
    );
  });

  it('refuses values outside their range by name', () => {
    expect(() => compileSignalRules(with_((r) => ({ ...r, signal: { ...r.signal, fast: '30', slow: '30' } })))).toThrow(
      /quant\.param_out_of_range — signal\.slow must be more bars than signal\.fast/,
    );
    expect(() => compileSignalRules(with_((r) => ({ ...r, signal: { ...r.signal, slow: '1001' } })))).toThrow(
      /quant\.param_out_of_range — signal\.slow must be from 2 to 1000 bars/,
    );
    expect(() => compileSignalRules(with_((r) => ({ ...r, sizing: { kind: 'percent_equity', value: '100.5' } })))).toThrow(
      /quant\.param_out_of_range — sizing\.value must be at most 100/,
    );
    expect(() => compileSignalRules(with_((r) => ({ ...r, sizing: { ...r.sizing, value: '0' } })))).toThrow(
      /quant\.param_out_of_range — sizing\.value must be more than 0/,
    );
    expect(() => compileSignalRules(with_((r) => ({ ...r, exit: { stopLossPercent: '150', takeProfitPercent: '' } })))).toThrow(
      /quant\.param_out_of_range — exit\.stopLossPercent must be at most 100/,
    );
    expect(() => compileSignalRules(with_((r) => ({ ...r, signal: { ...r.signal, fast: '2.5' } })))).toThrow(
      /quant\.params_invalid — signal\.fast must be a whole number of bars/,
    );
    expect(() => compileSignalRules(with_((r) => ({ ...r, exit: { stopLossPercent: '', takeProfitPercent: '1'.repeat(39) } })))).toThrow(
      /quant\.param_out_of_range — exit\.takeProfitPercent is larger than an amount can be/,
    );
  });

  it('writes a template source with each blank number named, and a filled rule as the builder writes it', () => {
    const blank = { ...RULES, signal: { ...RULES.signal, fast: '', slow: '' }, sizing: { kind: 'quantity' as const, value: '' } };
    const source = templateSource(blank);
    expect(source.split('\n')[0]).toBe('// Starter template source, read only. Simulated: backtest and paper only.');
    expect(source).toContain('const slow = sma(closes, /* signal.slow: blank, you set it after Use */);');
    expect(source).toContain('oms.buy("BTC/USDT", size.quantity(/* sizing.value: blank, you set it after Use */));');
    expect(source).toContain('// Optional, blank in the template: exit.stopLossPercent, exit.takeProfitPercent.');
    // Filled in, the body is byte for byte the builder's, under its own header.
    const full = compileSignalRules(with_((r) => ({ ...r, exit: { stopLossPercent: '5', takeProfitPercent: '10' } }))).rules;
    const body = (text: string) => text.split('\n').slice(1).join('\n');
    expect(body(templateSource(full))).toBe(body(signalSource(full)));
  });

  it('generates the same source for the same rules, with exits only when set', () => {
    const plain = compileSignalRules(RULES);
    expect(plain.source).toBe(signalSource(plain.rules));
    expect(plain.source).toContain('const fast = sma(closes, 10);');
    expect(plain.source).toContain('const slow = sma(closes, 30);');
    expect(plain.source).toContain('oms.buy("BTC/USDT", size.quantity("0.01"));');
    expect(plain.source).not.toContain('exit.');
    const exits = compileSignalRules(with_((r) => ({ ...r, exit: { stopLossPercent: '5', takeProfitPercent: '' } })));
    expect(exits.source).toContain('exit.stopLoss("BTC/USDT", percent("5"));');
    expect(exits.source).not.toContain('takeProfit');
    expect(plain.inputs.filter((row) => row.required).map((row) => row.name)).toEqual([
      'symbol',
      'signal.fast',
      'signal.slow',
      'sizing.value',
    ]);
  });
});

describe('studio with signal rules', () => {
  const body = {
    name: 'cross',
    blocks: [],
    modules: RULES,
    risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
    cash: '10000',
    environment: 'paper' as const,
  };

  it('compile answers the source and declared inputs, and refuses a blank input by name', async () => {
    const a = app().createCaller(signed(ACCOUNT_A));
    const out = await a.studio.compile({ modules: RULES });
    expect(out.source).toBe(compileSignalRules(RULES).source);
    expect(out.inputs.map((row) => row.name)).toContain('signal.slow');
    await expect(a.studio.compile({ modules: with_((r) => ({ ...r, signal: { ...r.signal, fast: '' } })) })).rejects.toThrow(
      /quant\.param_unset — signal\.fast is blank/,
    );
    await expect(app().createCaller(anonymous()).studio.compile({ modules: RULES })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('saves signal rules as a version with the generated source, and refuses blocks and rules together', async () => {
    const a = app().createCaller(signed(ACCOUNT_A));
    const saved = await a.studio.save({ ...body, clientStrategyId: 'client-cross', idempotencyKey: 'studio.save:client-cross' });
    expect(saved.version).toBe(1);
    expect(saved.modules).toEqual(RULES);
    expect(saved.blocks).toEqual([]);
    expect(saved.source).toBe(compileSignalRules(RULES).source);

    await expect(
      a.studio.save({
        ...body,
        blocks: [{ side: 'buy', symbol: 'BTC/USDT', qty: '0.01' }],
        clientStrategyId: 'client-both',
        idempotencyKey: 'studio.save:client-both',
      }),
    ).rejects.toThrow(/order blocks or by signal rules, not both/);
    await expect(
      a.studio.save({ ...body, modules: null, clientStrategyId: 'client-none', idempotencyKey: 'studio.save:client-none' }),
    ).rejects.toThrow(/at least one block is required/);
    await expect(
      a.studio.update({
        ...body,
        id: saved.id,
        modules: with_((r) => ({ ...r, signal: { ...r.signal, slow: '' } })),
        idempotencyKey: `studio.update:${saved.id}:from-v1`,
      }),
    ).rejects.toThrow(/quant\.param_unset — signal\.slow is blank/);
    const revised = await a.studio.update({
      ...body,
      id: saved.id,
      modules: with_((r) => ({ ...r, signal: { ...r.signal, average: 'ema' } })),
      idempotencyKey: `studio.update:${saved.id}:from-v1`,
    });
    expect(revised.version).toBe(2);
    expect(revised.source).toContain('ema(closes, 10)');
    // The generated source is a view: the sandbox never runs it.
    await expect(a.studio.run({ id: saved.id, idempotencyKey: 'studio.run:cross', environment: 'paper' })).rejects.toThrow(
      /quant\.signal_rules_sandbox/,
    );
  });
});
