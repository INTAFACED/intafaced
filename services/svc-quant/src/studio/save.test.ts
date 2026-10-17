import { describe, expect, it } from 'vitest';
import { QUANT_CASH_UNSET, QUANT_ENVIRONMENT_REQUIRED, QUANT_SIMULATED_AS_LIVE, QUANT_STUDIO_RISK_BLOCK_REQUIRED } from '../errors.js';
import { compileStudioSource, saveStudio } from './save.js';
import { createStudioStore } from './store.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const block = { side: 'buy' as const, symbol: 'BTC-USD', qty: '0.01' };
const risk = { maxDrawdown: '500', maxNotional: '10000', kill: '100' };

describe('studio.save — mandatory risk block', () => {
  it('refuses unset cash — never invents 10000', () => {
    const store = createStudioStore();
    expect(() => saveStudio({ name: 'alpha', blocks: [block], risk, environment: 'paper' }, store, ACCOUNT)).toThrow(QUANT_CASH_UNSET);
    expect(() => saveStudio({ name: 'alpha', blocks: [block], cash: null, risk, environment: 'paper' }, store, ACCOUNT)).toThrow(
      QUANT_CASH_UNSET,
    );
    expect(() => saveStudio({ name: 'alpha', blocks: [block], cash: '   ', risk, environment: 'paper' }, store, ACCOUNT)).toThrow(
      QUANT_CASH_UNSET,
    );
    expect(store.list(ACCOUNT)).toHaveLength(0);
  });

  it('refuses missing environment instead of defaulting to live', () => {
    const store = createStudioStore();
    expect(() => saveStudio({ name: 'alpha', blocks: [block], cash: '10000', risk }, store, ACCOUNT)).toThrow(QUANT_ENVIRONMENT_REQUIRED);
    expect(store.list(ACCOUNT)).toHaveLength(0);
  });

  it('refuses live environment on the studio surface', () => {
    const store = createStudioStore();
    expect(() => saveStudio({ name: 'alpha', blocks: [block], cash: '10000', risk, environment: 'live' }, store, ACCOUNT)).toThrow(
      QUANT_SIMULATED_AS_LIVE,
    );
  });

  it('refuses by name when the risk block is missing', () => {
    const store = createStudioStore();
    expect(() => saveStudio({ name: 'alpha', blocks: [block], cash: '10000', environment: 'paper' }, store, ACCOUNT)).toThrow(
      QUANT_STUDIO_RISK_BLOCK_REQUIRED,
    );
    expect(store.list(ACCOUNT)).toHaveLength(0);
  });

  it('refuses by name when maxDrawdown / maxNotional / kill is blank', () => {
    const store = createStudioStore();
    expect(() =>
      saveStudio(
        {
          name: 'alpha',
          blocks: [block],
          cash: '10000',
          environment: 'paper',
          risk: { maxDrawdown: '500', maxNotional: '10000', kill: '' },
        },
        store,
        ACCOUNT,
      ),
    ).toThrow(QUANT_STUDIO_RISK_BLOCK_REQUIRED);
    expect(() =>
      saveStudio(
        {
          name: 'alpha',
          blocks: [block],
          cash: '10000',
          environment: 'paper',
          risk: { maxDrawdown: '', maxNotional: '10000', kill: '100' },
        },
        store,
        ACCOUNT,
      ),
    ).toThrow(QUANT_STUDIO_RISK_BLOCK_REQUIRED);
    expect(() =>
      saveStudio(
        {
          name: 'alpha',
          blocks: [block],
          cash: '10000',
          environment: 'paper',
          risk: { maxDrawdown: '500', maxNotional: '  ', kill: '100' },
        },
        store,
        ACCOUNT,
      ),
    ).toThrow(QUANT_STUDIO_RISK_BLOCK_REQUIRED);
  });

  it('persists decimal-string risk and compiles blocks for sandbox.run — no invented return', () => {
    const store = createStudioStore();
    const saved = saveStudio({ name: 'alpha', blocks: [block], cash: '10000', risk, environment: 'paper' }, store, ACCOUNT);
    expect('ok' in saved).toBe(false);
    expect(saved.risk).toEqual(risk);
    expect(typeof saved.risk.maxDrawdown).toBe('string');
    expect(typeof saved.risk.maxNotional).toBe('string');
    expect(typeof saved.risk.kill).toBe('string');
    expect(saved.language).toBe('javascript');
    expect(saved.source).toBe('oms.buy("BTC-USD", "0.01");');
    expect(saved.cash).toBe('10000');
    expect('pnl' in saved).toBe(false);
    expect('return' in saved).toBe(false);
    expect(saved.live).toBe(false);
    expect(saved.simulated).toBe(true);
    expect(saved.environment).toBe('paper');
    expect(saved.claimLabel).toBe('Paper — not live performance');
    expect(store.get(ACCOUNT, saved.id)?.name).toBe('alpha');
  });

  it('compiles a visual block list into isolate source', () => {
    expect(
      compileStudioSource([
        { side: 'buy', symbol: 'BTC-USD', qty: '0.01' },
        { side: 'sell', symbol: 'ETH-USD', qty: '0.5' },
      ]),
    ).toBe('oms.buy("BTC-USD", "0.01");\noms.sell("ETH-USD", "0.5");');
  });
});
