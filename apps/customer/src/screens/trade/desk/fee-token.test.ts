import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../../shared/api';
import { feeTokenChoice, feeTokenFetcher, type FeeToken } from './fee-token';

const TERMS = { asset: 'IFC', perUnit: { BTC: '50000', USDT: '2' } };
const ready = (data: FeeToken) => ({ status: 'ready' as const, data, asOf: 0 });
const LADDER = [
  { minStake: '0', discountBps: 0 },
  { minStake: '100', discountBps: 2000 },
];

describe('whether an order can pay its fee in the token', () => {
  const full = ready({ terms: TERMS, access: { staked: '150', discountBps: 2000 }, accessRefused: null, ladder: LADDER });

  it('is offered on a plain limit or market order, with the stake discount and the ladder', () => {
    for (const type of ['limit', 'market'] as const) {
      expect(feeTokenChoice(full, 'BTC', type, true)).toEqual({
        kind: 'offered',
        token: 'IFC',
        discountBps: 2000,
        staked: '150',
        ladder: LADDER,
      });
    }
  });

  it.each([
    ['no terms are published', ready({ terms: null, access: null, accessRefused: null, ladder: null }), 'BTC', 'limit', true, 'no_terms'],
    ['the schedule has not answered', { status: 'loading' as const }, 'BTC', 'limit', true, 'no_terms'],
    ['the order receives the token itself', full, 'IFC', 'limit', true, 'received'],
    ['no price is published for the fee asset', full, 'ETH', 'limit', true, 'no_price'],
    ['no one is signed in', full, 'BTC', 'limit', false, 'signed_out'],
    ['the order is a stop', full, 'BTC', 'stop_limit', true, 'order_type'],
    ['the order is a bracket', full, 'BTC', 'bracket', true, 'order_type'],
    [
      'the stake discount is not published',
      ready({ terms: TERMS, access: null, accessRefused: 'token.params_unset', ladder: null }),
      'BTC',
      'limit',
      true,
      'no_discount',
    ],
  ] as const)('is not offered when %s, and says why', (_name, source, receive, type, signedIn, reason) => {
    expect(feeTokenChoice(source, receive, type, signedIn)).toMatchObject({ kind: 'not_offered', reason });
  });
});

describe('the reads', () => {
  function api(answers: Record<string, unknown>) {
    const calls: string[] = [];
    const client = {
      rest: async (path: string) => {
        calls.push(path);
        return answers[path];
      },
      query: async (module: string, procedure: string) => {
        calls.push(`${module}.${procedure}`);
        return answers[`${module}.${procedure}`];
      },
    } as unknown as ApiClient;
    return { client, calls };
  }
  const signal = new AbortController().signal;

  it('reads the stake and the ladder only when terms are published and someone is signed in', async () => {
    const none = api({ '/fees/published': { ok: true, data: { feeToken: null } } });
    expect(await feeTokenFetcher(none.client, true)(signal)).toEqual({
      ok: true,
      data: { terms: null, access: null, accessRefused: null, ladder: null },
    });
    expect(none.calls).toEqual(['/fees/published']);

    const terms = api({
      '/fees/published': { ok: true, data: { feeToken: TERMS } },
      'token.accessOf': { ok: false, reason: 'error', message: 'unset', code: 'token.params_unset' },
      'token.feeDiscount.get': { ok: true, data: { schedule: { tiers: LADDER } } },
    });
    expect(await feeTokenFetcher(terms.client, true)(signal)).toEqual({
      ok: true,
      data: { terms: TERMS, access: null, accessRefused: 'token.params_unset', ladder: LADDER },
    });
    expect(await feeTokenFetcher(terms.client, false)(signal)).toMatchObject({ ok: true, data: { terms: TERMS, access: null } });
  });

  it('reads an unpublished schedule as no terms, and passes any other failure on', async () => {
    const blank = api({ '/fees/published': { ok: false, reason: 'error', message: 'blank', code: 'trade.fee_schedule_blank' } });
    expect(await feeTokenFetcher(blank.client, true)(signal)).toMatchObject({ ok: true, data: { terms: null } });
    const down = api({ '/fees/published': { ok: false, reason: 'error', message: 'down' } });
    expect(await feeTokenFetcher(down.client, true)(signal)).toMatchObject({ ok: false });
  });
});
