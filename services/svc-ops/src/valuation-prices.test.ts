import { describe, expect, it } from 'vitest';
import { valuationPricesOutputSchema } from '@intafaced/contracts';
import { createValuationPricesRouter, valuationPricesFromEnv } from './valuation-prices.js';

const TEST_ENV = { APP_ENV: 'test' };
const at = () => new Date('2026-11-14T08:00:00.000Z');

describe('valuation.prices (the prices Home and Assets value holdings with)', () => {
  it('answers blank as unpublished, never a price of its own', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(valuationPricesFromEnv(raw, { APP_ENV: 'production' })).toEqual({ published: false, code: 'valuation.prices_unset' });
    }
  });

  it('reads the TEST list exactly, labelled TEST, with the time it was read', () => {
    const prices = valuationPricesFromEnv(' USDC=1, USDT=1 ,ETH=3000.123456789012345678', TEST_ENV, at);
    expect(prices).toEqual({
      published: true,
      test: true,
      source: 'TEST price list',
      asOf: '2026-11-14T08:00:00.000Z',
      prices: [
        { asset: 'USDC', usd: '1' },
        { asset: 'USDT', usd: '1' },
        { asset: 'ETH', usd: '3000.123456789012345678' },
      ],
    });
    expect(valuationPricesOutputSchema.parse(prices)).toEqual(prices);
  });

  it.each([[{ APP_ENV: 'production' }], [{ APP_ENV: 'staging' }], [{}], [{ APP_ENV: 'test', NODE_ENV: 'production' }]])(
    'refuses to start with a TEST list outside a test stack (%o)',
    (env) => {
      expect(() => valuationPricesFromEnv('USDC=1', env)).toThrow('ops.valuation_test_prices_outside_test');
    },
  );

  it.each(['USDC', 'USDC=0', 'USDC=-1', 'usdc=1', 'USDC=1e2', 'USDC=1=2', 'USDC=1,USDC=1', 'USDC=1,'])(
    'refuses a malformed list (%s) at boot',
    (raw) => {
      expect(() => valuationPricesFromEnv(raw, TEST_ENV)).toThrow();
    },
  );

  it('is a public read', async () => {
    const prices = valuationPricesFromEnv('USDC=1', TEST_ENV, at);
    await expect(
      createValuationPricesRouter(prices)
        .createCaller({} as never)
        .prices(),
    ).resolves.toEqual(prices);
  });
});
