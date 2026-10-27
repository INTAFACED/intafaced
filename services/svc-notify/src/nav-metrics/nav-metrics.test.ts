import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryNavMetricStore, windowDays } from './counts.js';
import { navMetricsRouter } from './router.js';

const SECRET = 'a-notify-nav-metrics-test-edge-secret';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-notify' });
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
function signed(scopes: string[]) {
  const raw = encodePrincipal({
    sub: '11111111-1111-4111-8111-111111111111',
    userId: '11111111-1111-4111-8111-111111111111',
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

const at = (iso: string) => () => new Date(iso);

describe('navigation counts: header search misses (HM-navigation-04)', () => {
  it('counts a miss from anyone, signed in or not, per UTC day, and keeps nothing else', async () => {
    const store = new MemoryNavMetricStore();
    const late = navMetricsRouter(store, at('2026-10-27T23:59:59Z'));
    await expect(late.createCaller(await anonymous()).searchMiss()).resolves.toEqual({ counted: true });
    await late.createCaller(await signed(['notify:read'])).searchMiss();
    await navMetricsRouter(store, at('2026-10-28T00:00:00Z'))
      .createCaller(await anonymous())
      .searchMiss();
    expect(await store.read('search_miss', '2026-10-01', '2026-10-31')).toEqual([
      { day: '2026-10-27', count: 2 },
      { day: '2026-10-28', count: 1 },
    ]);
  });

  it('takes no input, so neither the words nor the person can reach the count', async () => {
    const caller = navMetricsRouter(new MemoryNavMetricStore()).createCaller(await anonymous());
    await expect((caller.searchMiss as (input: unknown) => Promise<unknown>)({ query: 'secret words' })).resolves.toEqual({
      counted: true,
    });
  });

  it('lets founders read a window they name, marked a lower bound, and refuses a blank window', async () => {
    const store = new MemoryNavMetricStore();
    await store.count('search_miss', new Date('2026-10-20T10:00:00Z'));
    await store.count('search_miss', new Date('2026-10-27T10:00:00Z'));
    const desk = navMetricsRouter(store, at('2026-10-27T12:00:00Z')).createCaller(await signed(['admin:read']));
    await expect(desk.searchMisses({ days: 7 })).resolves.toEqual({
      kind: 'search_miss',
      from: '2026-10-21',
      to: '2026-10-27',
      days: [{ day: '2026-10-27', count: 1 }],
      lowerBound: true,
    });
    await expect(desk.searchMisses({})).rejects.toThrow('notify.nav_metrics_window_unset');
  });

  it('keeps the founders read from customers and from callers with no session', async () => {
    const router = navMetricsRouter(new MemoryNavMetricStore());
    await expect(router.createCaller(await signed(['notify:read'])).searchMisses({ days: 7 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(router.createCaller(await anonymous()).searchMisses({ days: 7 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('says counts are not kept when there is no store, never a count of zero', async () => {
    const router = navMetricsRouter(undefined);
    await expect(router.createCaller(await anonymous()).searchMiss()).rejects.toThrow('notify.nav_metrics_storage_unconfigured');
    await expect(router.createCaller(await signed(['admin:read'])).searchMisses({ days: 1 })).rejects.toThrow(
      'notify.nav_metrics_storage_unconfigured',
    );
  });

  it('names a window that ends today', () => {
    expect(windowDays(new Date('2026-03-01T05:00:00Z'), 2)).toEqual({ from: '2026-02-28', to: '2026-03-01' });
    expect(windowDays(new Date('2026-03-01T05:00:00Z'), 1)).toEqual({ from: '2026-03-01', to: '2026-03-01' });
  });
});
