import { describe, expect, it } from 'vitest';
import { TradeError } from '../spot/types.js';
import { assertBotVerification, loadBotVerificationPolicy } from './bots-verification.js';
import { gateAlgoCreate, type AlgoCreateGateInput } from './create-gate.js';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TradeError);
    return (e as TradeError).code;
  }
  throw new Error('expected a refusal');
};

describe('bot verification gate (CB-bots-10)', () => {
  it('is required by default; a blank level is not set, never open', () => {
    expect(loadBotVerificationPolicy({})).toEqual({ mode: 'required', level: null });
    expect(loadBotVerificationPolicy({ TRADE_BOTS_VERIFICATION_LEVEL: '  ' })).toEqual({ mode: 'required', level: null });
    expect(loadBotVerificationPolicy({ TRADE_BOTS_VERIFICATION_LEVEL: 'full' })).toEqual({ mode: 'required', level: 'full' });
    expect(loadBotVerificationPolicy({ TRADE_BOTS_VERIFICATION: 'off' })).toEqual({ mode: 'off' });
  });

  it('refuses boot on an unknown switch or level, including none', () => {
    expect(() => loadBotVerificationPolicy({ TRADE_BOTS_VERIFICATION: 'on' })).toThrow(/required.*off/);
    expect(() => loadBotVerificationPolicy({ TRADE_BOTS_VERIFICATION: '' })).toThrow(/required.*off/);
    expect(() => loadBotVerificationPolicy({ TRADE_BOTS_VERIFICATION_LEVEL: 'none' })).toThrow(/basic, full, institutional/);
    expect(() => loadBotVerificationPolicy({ TRADE_BOTS_VERIFICATION_LEVEL: 'gold' })).toThrow(/basic, full, institutional/);
  });

  it('blank level refuses every tier', () => {
    for (const tier of ['none', 'basic', 'full', 'institutional'] as const) {
      expect(code(() => assertBotVerification({ mode: 'required', level: null }, tier))).toBe('trade.bots_verification_level_not_set');
    }
  });

  it('below the level refuses and names it; at or above passes; off passes', () => {
    const full = { mode: 'required', level: 'full' } as const;
    expect(code(() => assertBotVerification(full, 'basic'))).toBe('trade.bots_verification_insufficient');
    expect(code(() => assertBotVerification(full, 'none'))).toBe('trade.bots_verification_insufficient');
    try {
      assertBotVerification(full, 'basic');
    } catch (e) {
      expect((e as TradeError).data).toEqual({ required: 'full' });
    }
    expect(() => assertBotVerification(full, 'full')).not.toThrow();
    expect(() => assertBotVerification(full, 'institutional')).not.toThrow();
    expect(() => assertBotVerification({ mode: 'off' }, 'none')).not.toThrow();
  });

  it('gateAlgoCreate checks verification first: a refusal reads and writes nothing', async () => {
    const explode = new Proxy(
      {},
      {
        get() {
          throw new Error('nothing may be read before the verification gate');
        },
      },
    );
    const ctx = {
      sql: explode,
      ledger: explode,
      perks: explode,
      feeSchedule: explode,
      markPolicy: explode,
      market: explode,
      input: explode,
      verification: { policy: { mode: 'required', level: 'full' }, tier: 'basic' },
    } as unknown as AlgoCreateGateInput;
    await expect(gateAlgoCreate(ctx)).rejects.toMatchObject({ code: 'trade.bots_verification_insufficient' });
    const blank = { ...ctx, verification: { policy: { mode: 'required', level: null }, tier: 'full' } } as unknown as AlgoCreateGateInput;
    await expect(gateAlgoCreate(blank)).rejects.toMatchObject({ code: 'trade.bots_verification_level_not_set' });
  });
});
