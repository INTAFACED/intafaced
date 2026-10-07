import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { startBasketParent } from './oms-basket-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const MATCHING_OPEN = { venueHalted: false } as const;
const MATCHING_HALTED = { venueHalted: true } as const;
const JOBS_ON = { enabled: true } as const;
const JOBS_OFF = { enabled: false } as const;
const CREDIT = '100';
const REMAINING = '1.25';
const NOW = new Date('2026-09-01T12:00:00.000Z');
const LEGS = [
  { name: 'BTC', qty: '0.5' },
  { name: 'ETH', qty: '2' },
] as const;

function base(over: Partial<Parameters<typeof startBasketParent>[0]> = {}) {
  return {
    parentClientOrderId: 'p-basket',
    kind: 'basket',
    approved: true,
    legs: [...LEGS],
    partialFailurePolicy: 'refuse_all',
    credit: CREDIT,
    remaining: REMAINING,
    operatorId: OP,
    jobs: JOBS_ON,
    matchingVenueHalt: MATCHING_OPEN,
    now: NOW,
    ...over,
  };
}

describe('startBasketParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(startBasketParent(base({ parentClientOrderId: undefined }))).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(startBasketParent(base({ parentClientOrderId: '   ' }))).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
  });

  it('jobs unwired / jobs_off refuse even when already approved', () => {
    expect(startBasketParent(base({ jobs: undefined }))).toMatchObject({
      ok: false,
      reason: 'jobs_gate_unwired',
    });
    expect(startBasketParent(base({ jobs: JOBS_OFF }))).toMatchObject({
      ok: false,
      reason: 'jobs_off',
    });
  });

  it('refuses omitted kind and twap / vwap / pov with not_live', () => {
    expect(startBasketParent(base({ kind: undefined }))).toMatchObject({
      ok: false,
      reason: 'missing_kind',
    });
    expect(startBasketParent(base({ kind: 'twap' }))).toMatchObject({ ok: false, reason: 'not_live' });
    expect(startBasketParent(base({ kind: 'vwap' }))).toMatchObject({ ok: false, reason: 'not_live' });
    expect(startBasketParent(base({ kind: 'pov' }))).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses already-running parent with already_started', () => {
    expect(startBasketParent(base({ status: 'running' }))).toMatchObject({
      ok: false,
      reason: 'already_started',
    });
  });

  it('refuses paper / omitted approved with not_approved', () => {
    expect(startBasketParent(base({ approved: undefined, status: 'paper' }))).toMatchObject({
      ok: false,
      reason: 'not_approved',
    });
    expect(startBasketParent(base({ approved: undefined, status: undefined }))).toMatchObject({
      ok: false,
      reason: 'not_approved',
    });
  });

  it('refuses status paper even when approved is true, and does not start', () => {
    const result = startBasketParent(base({ approved: true, status: 'paper' }));
    expect(result).toMatchObject({
      ok: false,
      reason: 'not_approved',
    });
    expect(result).not.toMatchObject({ started: true, status: 'running' });
  });

  it('refuses missing / whitespace operator', () => {
    expect(startBasketParent(base({ operatorId: undefined }))).toMatchObject({
      ok: false,
      reason: 'missing_operator',
    });
    expect(startBasketParent(base({ operatorId: '   ' }))).toMatchObject({
      ok: false,
      reason: 'missing_operator',
    });
  });

  it('refuses omitted / empty legs', () => {
    expect(startBasketParent(base({ legs: undefined }))).toMatchObject({
      ok: false,
      reason: 'missing_legs',
    });
    expect(startBasketParent(base({ legs: [] }))).toMatchObject({ ok: false, reason: 'missing_legs' });
    expect(startBasketParent(base({ legs: null }))).toMatchObject({ ok: false, reason: 'missing_legs' });
  });

  it('refuses unnamed legs rather than silently weakening', () => {
    expect(startBasketParent(base({ legs: [{ name: '   ', qty: '1' }] }))).toMatchObject({
      ok: false,
      reason: 'missing_leg_name',
    });
    expect(startBasketParent(base({ legs: [{ qty: '1' }] }))).toMatchObject({
      ok: false,
      reason: 'missing_leg_name',
    });
  });

  it('refuses duplicate leg names rather than merging qty', () => {
    expect(
      startBasketParent(
        base({
          legs: [
            { name: 'BTC', qty: '1' },
            { name: 'BTC', qty: '2' },
          ],
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'duplicate_leg_name' });
  });

  it('refuses omitted / null / whitespace leg qty with missing_qty (never invent size)', () => {
    expect(startBasketParent(base({ legs: [{ name: 'BTC' }] }))).toMatchObject({
      ok: false,
      reason: 'missing_qty',
    });
    expect(startBasketParent(base({ legs: [{ name: 'BTC', qty: null }] }))).toMatchObject({
      ok: false,
      reason: 'missing_qty',
    });
    expect(startBasketParent(base({ legs: [{ name: 'BTC', qty: '   ' }] }))).toMatchObject({
      ok: false,
      reason: 'missing_qty',
    });
  });

  it("refuses 'not-an-amount' / 0 leg qty with qty_invalid", () => {
    expect(startBasketParent(base({ legs: [{ name: 'BTC', qty: 'not-an-amount' }] }))).toMatchObject({
      ok: false,
      reason: 'qty_invalid',
    });
    expect(startBasketParent(base({ legs: [{ name: 'BTC', qty: '0' }] }))).toMatchObject({
      ok: false,
      reason: 'qty_invalid',
    });
  });

  it('refuses omitted / blank partial-failure policy rather than invent remaining flatten', () => {
    expect(startBasketParent(base({ partialFailurePolicy: undefined }))).toMatchObject({
      ok: false,
      reason: 'missing_partial_failure_policy',
    });
    expect(startBasketParent(base({ partialFailurePolicy: null }))).toMatchObject({
      ok: false,
      reason: 'missing_partial_failure_policy',
    });
    expect(startBasketParent(base({ partialFailurePolicy: '   ' }))).toMatchObject({
      ok: false,
      reason: 'missing_partial_failure_policy',
    });
  });

  it('refuses flatten_remaining / continue — never invent remaining flatten', () => {
    expect(startBasketParent(base({ partialFailurePolicy: 'flatten_remaining' }))).toMatchObject({
      ok: false,
      reason: 'flatten_remaining_refused',
    });
    expect(startBasketParent(base({ partialFailurePolicy: 'continue' }))).toMatchObject({
      ok: false,
      reason: 'flatten_remaining_refused',
    });
  });

  it('refuses omitted / null / whitespace credit with credit_blank', () => {
    expect(startBasketParent(base({ credit: undefined }))).toMatchObject({
      ok: false,
      reason: 'credit_blank',
    });
    expect(startBasketParent(base({ credit: null }))).toMatchObject({ ok: false, reason: 'credit_blank' });
    expect(startBasketParent(base({ credit: '   ' }))).toMatchObject({ ok: false, reason: 'credit_blank' });
  });

  it("refuses 'not-an-amount' credit with credit_invalid", () => {
    expect(startBasketParent(base({ credit: 'not-an-amount' }))).toMatchObject({
      ok: false,
      reason: 'credit_invalid',
    });
  });

  it('refuses omitted / null / whitespace remaining with missing_residual', () => {
    expect(startBasketParent(base({ remaining: undefined }))).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
    expect(startBasketParent(base({ remaining: null }))).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
    expect(startBasketParent(base({ remaining: '   ' }))).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
  });

  it('matching halt-all refuses venue_halted; missing halt source refuses venue_halt_unavailable', () => {
    expect(startBasketParent(base({ matchingVenueHalt: MATCHING_HALTED }))).toMatchObject({
      ok: false,
      reason: 'venue_halted',
    });
    expect(startBasketParent(base({ matchingVenueHalt: undefined }))).toMatchObject({
      ok: false,
      reason: 'venue_halt_unavailable',
    });
  });

  it('happy basket: named legs + refuse_all + credit — not paper, no matching, no fills', () => {
    const result = startBasketParent(base({ status: 'approved' }));
    expect(result).toEqual({
      ok: true,
      started: true,
      parentClientOrderId: 'p-basket',
      kind: 'basket',
      status: 'running',
      legs: [
        { name: 'BTC', qty: formatAmount(parseAmount('0.5')) },
        { name: 'ETH', qty: formatAmount(parseAmount('2')) },
      ],
      partialFailurePolicy: 'refuse_all',
      credit: formatAmount(parseAmount(CREDIT)),
      residual: { remaining: formatAmount(parseAmount(REMAINING)) },
      startedAt: NOW.toISOString(),
    });
    expect(result).not.toHaveProperty('paper');
    expect(result).not.toHaveProperty('matching');
    expect(result).not.toHaveProperty('fills');
    expect(result).not.toHaveProperty('executions');
  });

  it('happy rebalance: same refuse-closed parent, kind rebalance', () => {
    const result = startBasketParent(base({ kind: 'rebalance', parentClientOrderId: 'p-rebal' }));
    expect(result).toMatchObject({
      ok: true,
      started: true,
      parentClientOrderId: 'p-rebal',
      kind: 'rebalance',
      status: 'running',
      partialFailurePolicy: 'refuse_all',
    });
    expect(result).not.toHaveProperty('paper');
  });
});
