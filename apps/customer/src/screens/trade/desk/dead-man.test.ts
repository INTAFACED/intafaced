import { describe, expect, it } from 'vitest';
import { deadManChoices, deadManRefusal, otherSeconds, refreshEveryMs } from './dead-man';

describe('dead-man switch choices', () => {
  it('offers the published timeouts above 0, smallest first, once each, and nothing when none are published', () => {
    expect(deadManChoices([120, 0, 10, 30, 10])).toEqual([10, 30, 120]);
    expect(deadManChoices(null)).toEqual([]);
    expect(deadManChoices(undefined)).toEqual([]);
  });

  it('reads a typed value only as whole seconds above 0', () => {
    expect(otherSeconds(' 7 ')).toBe(7);
    for (const bad of ['', '0', '-5', '1.5', '7s', '01']) expect(otherSeconds(bad)).toBeNull();
  });
});

describe('dead-man switch refusals', () => {
  const published = [10, 30];
  it('names an unpublished timeout, a sign-in that ends too soon, and an unpublished set apart', () => {
    expect(deadManRefusal('trade.cancel_all_after_rejected', 7, published)).toBe('timeout');
    expect(deadManRefusal('trade.cancel_all_after_rejected', 30, published)).toBe('session');
    expect(deadManRefusal('trade.cancel_all_after_unset', 10, null)).toBe('unset');
    expect(deadManRefusal(undefined, 10, published)).toBe('other');
  });
});

describe('dead-man switch refresh', () => {
  it('refreshes three times per timeout, never faster than once a second', () => {
    expect(refreshEveryMs(30)).toBe(10_000);
    expect(refreshEveryMs(1)).toBe(1000);
  });
});
