import { describe, expect, it } from 'vitest';
import { nextWindowStart, overridePriceAt, withOverrides, type RouteOverride } from './route-changes.js';
import { parseRoutingTable } from './routing.js';

const config = (providerId: string) =>
  parseRoutingTable({
    routes: [
      { task: 'a.task', providerId, model: 'reasoning-md', maxOutputTokens: 100, price: { inputPerMillion: '1', outputPerMillion: '5' } },
      { task: 'b.task', providerId, model: 'fast-sm', maxOutputTokens: 50, price: { inputPerMillion: '0.25', outputPerMillion: '1.25' } },
    ],
  });

const AT = new Date('2026-11-16T10:07:00.000Z');
const FROM = new Date('2026-11-16T10:15:00.000Z');
const override: RouteOverride = {
  task: 'a.task',
  maxOutputTokens: 200,
  price: { inputPerMillion: 2_000_000_000_000_000_000n, outputPerMillion: 6_000_000_000_000_000_000n },
  priorPrice: { inputPerMillion: 1_000_000_000_000_000_000n, outputPerMillion: 5_000_000_000_000_000_000n },
  priceFrom: FROM,
};

describe('the founders’ layer over the configured routing table (J-agents-20)', () => {
  it('a confirmed change sets the ceiling at once and the rate only from the next window', () => {
    const before = withOverrides(config('primary'), [override], AT).routes[0]!;
    expect(before.maxOutputTokens).toBe(200);
    expect(before.price).toEqual(override.priorPrice);
    const after = withOverrides(config('primary'), [override], FROM).routes[0]!;
    expect(after.price).toEqual(override.price);
    expect(overridePriceAt(override, new Date(FROM.getTime() - 1))).toEqual(override.priorPrice);
  });

  it('leaves every other route as configured, and ignores a change for a task the configuration no longer has', () => {
    const table = withOverrides(config('primary'), [override, { ...override, task: 'gone.task' }], FROM);
    expect(table.routes.map((r) => r.task)).toEqual(['a.task', 'b.task']);
    expect(table.routes[1]).toEqual(config('primary').routes[1]);
  });

  it('a provider swapped in configuration serves new runs, with the founders’ change and the source unchanged (#4)', () => {
    const swapped = withOverrides(config('secondary'), [override], FROM).routes[0]!;
    expect(swapped.providerId).toBe('secondary');
    expect(swapped.model).toBe('reasoning-md');
    expect(swapped.maxOutputTokens).toBe(200);
    expect(swapped.price).toEqual(override.price);
  });

  it('a blank rate stays blank: the route refuses its metered runs', () => {
    const blank = withOverrides(config('primary'), [{ ...override, price: null }], FROM).routes[0]!;
    expect(blank.price).toBeNull();
  });

  it('the next window starts at the next whole window of the UTC day', () => {
    expect(nextWindowStart(AT, 15).toISOString()).toBe('2026-11-16T10:15:00.000Z');
    expect(nextWindowStart(new Date('2026-11-16T10:15:00.000Z'), 15).toISOString()).toBe('2026-11-16T10:30:00.000Z');
    expect(nextWindowStart(new Date('2026-11-16T23:59:59.999Z'), 60).toISOString()).toBe('2026-11-17T00:00:00.000Z');
  });
});
