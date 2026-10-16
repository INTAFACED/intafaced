import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { VenueUnavailableError } from '@intafaced/venue-contracts';
import { conversionLimitPrice, roundDownToStep, roundUpToTick } from './service.js';
import { classifyPlaceFailure } from './place-error.js';

const venue = (reason: 'malformed' | 'not_ready' | 'rate_limited' | 'no_depth' | 'unreachable', message: string) =>
  new VenueUnavailableError('binance-spot', reason, message);

describe('classifyPlaceFailure', () => {
  it('treats a local refusal as not sent', () => {
    expect(classifyPlaceFailure(venue('rate_limited', 'binance-spot local window full (retry in 1000ms)'))).toBe('pre_send');
    expect(classifyPlaceFailure(venue('malformed', 'limit order requires price'))).toBe('pre_send');
    expect(classifyPlaceFailure(venue('not_ready', 'spot has no reduceOnly'))).toBe('pre_send');
    expect(classifyPlaceFailure(venue('no_depth', 'binance-spot USD/USDT: book is not payout-grade'))).toBe('pre_send');
    expect(classifyPlaceFailure(venue('unreachable', 'placeOrder code -1121 (Invalid symbol)'))).toBe('pre_send');
    expect(classifyPlaceFailure(venue('unreachable', 'placeOrder retCode 170121 (Invalid symbol)'))).toBe('pre_send');
  });

  it('treats a definite venue refusal as rejected', () => {
    expect(classifyPlaceFailure(venue('unreachable', 'placeOrder code -1013 (Filter failure: MIN_NOTIONAL)'))).toBe('rejected');
    expect(classifyPlaceFailure(venue('unreachable', 'placeOrder code -2010 (insufficient balance)'))).toBe('rejected');
    expect(classifyPlaceFailure(venue('unreachable', 'placeOrder retCode 170131 (Insufficient balance)'))).toBe('rejected');
    expect(classifyPlaceFailure(venue('unreachable', 'placeOrder retCode 170140 (Order value exceeded lower limit)'))).toBe('rejected');
    expect(classifyPlaceFailure(venue('unreachable', 'placeOrder retCode 170134 (Order price has too many decimals)'))).toBe('rejected');
  });

  it('keeps a timeout, a 5xx, and an unrecognised answer as ambiguous', () => {
    expect(classifyPlaceFailure(new Error('venue timeout'))).toBe('ambiguous');
    expect(classifyPlaceFailure(venue('unreachable', 'placeOrder HTTP 502'))).toBe('ambiguous');
    expect(classifyPlaceFailure(venue('unreachable', 'placeOrder timed out — outcome unknown, not a fill'))).toBe('ambiguous');
    expect(classifyPlaceFailure(venue('unreachable', 'placeOrder retCode 170141 (Duplicate clientOrderId)'))).toBe('ambiguous');
    expect(classifyPlaceFailure(venue('unreachable', 'placeOrder code -1000 (unknown)'))).toBe('ambiguous');
  });
});

describe('conversion limit grid', () => {
  it('raises a 1:1 floor by a known 1% commission and the next 0.01 tick', () => {
    const amount = parseAmount('100');
    const price = roundUpToTick(conversionLimitPrice(amount, amount, parseAmount('0.01')), parseAmount('0.01'));
    expect(formatAmount(price)).toBe('1.02');
    const unrounded = conversionLimitPrice(amount, amount, parseAmount('0.01'));
    expect(unrounded > parseAmount('1.01')).toBe(true);
    expect(unrounded < parseAmount('1.02')).toBe(true);
  });

  it('rounds quantity down to the step and leaves a price that is already on the tick', () => {
    expect(formatAmount(roundDownToStep(parseAmount('100'), parseAmount('30')))).toBe('90');
    expect(formatAmount(roundUpToTick(parseAmount('1'), parseAmount('0.01')))).toBe('1');
  });
});
