/**
 * J-charts-desk-09 #7: one alert for every market in a watchlist, and a market added to the list later picked up on the next
 * sweep. The list comes from identity through a port; the listed markets by symbol from the market directory.
 */
import { describe, expect, it } from 'vitest';
import type { IdentityWatchlist, IdentityWatchlistsPort, IdentityWatchlistsResult } from '@intafaced/contracts';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { AlertService, NO_ALERT_LIMITS } from './service.js';
import { MemoryAlertStore } from './store.js';
import { runAlertSweepPass } from './sweep-driver.js';
import type { MarkSource } from './types.js';
import { MemoryWatchRuleStore, WatchRuleService, marketsOf } from './watch-rules.js';

const NOW = new Date('2026-11-07T08:00:00Z');
const DIRECTORY = new Map([
  ['BTC/USDT', 'm-btc'],
  ['ETH/USDT', 'm-eth'],
  ['IFC/USDT', 'm-ifc'],
]);

function rig(opts: { max?: number | null; lists?: IdentityWatchlist[] | null; directory?: Map<string, string> | null } = {}) {
  let lists: IdentityWatchlist[] | null =
    opts.lists === undefined ? [{ id: 'majors', name: 'TEST majors', symbols: ['BTC/USDT', 'ETH/USDT'] }] : opts.lists;
  let directory = opts.directory === undefined ? DIRECTORY : opts.directory;
  const reads: string[] = [];
  const port: IdentityWatchlistsPort = {
    async read({ userId }): Promise<IdentityWatchlistsResult> {
      reads.push(userId);
      return lists === null ? { state: 'unavailable', code: 'identity.watchlists_unavailable' } : { state: 'read', lists };
    },
  };
  // Far under every level, so nothing the sweep evaluates fires and frees a place.
  const marks: MarkSource = { kind: 'live', quote: async (_m, at) => ({ kind: 'ok', price: '1', at: at ?? new Date() }) };
  const alertStore = new MemoryAlertStore();
  const alerts = new AlertService(alertStore, marks, new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true }), undefined, {
    ...NO_ALERT_LIMITS,
    maxActivePrice: opts.max === undefined ? 20 : opts.max,
  });
  const store = new MemoryWatchRuleStore(alertStore);
  const rules = new WatchRuleService(alerts, store, port, async () => directory);
  return {
    alerts,
    rules,
    store,
    reads,
    setLists: (next: IdentityWatchlist[] | null) => (lists = next),
    setDirectory: (next: Map<string, string> | null) => (directory = next),
  };
}

const create = (r: ReturnType<typeof rig>, over: Partial<{ listId: string; targetPrice: string }> = {}) =>
  r.rules.create({ userId: 'u1', listId: 'majors', condition: 'greater_than', targetPrice: '100000', ...over }, NOW);

describe('watchlist alerts', () => {
  it('creates one alert per market of the list, with the same rule, and the rule covering them', async () => {
    const r = rig();
    const made = await create(r);
    expect(made.alerts.map((a) => a.marketId)).toEqual(['m-btc', 'm-eth']);
    for (const a of made.alerts)
      expect(a).toMatchObject({ userId: 'u1', condition: 'greater_than', targetPrice: '100000', status: 'active' });
    expect(made.rule).toMatchObject({ listId: 'majors', listName: 'TEST majors', markets: ['m-btc', 'm-eth'], status: 'active' });
    expect(await r.alerts.list('u1')).toHaveLength(2);
  });

  it('picks up a market added to the list on the next sweep, once', async () => {
    const r = rig();
    await create(r);
    r.setLists([{ id: 'majors', name: 'TEST majors', symbols: ['BTC/USDT', 'ETH/USDT', 'IFC/USDT'] }]);
    await runAlertSweepPass(
      r.alerts,
      {
        onComplete: () => undefined,
        onError: (err) => {
          throw err;
        },
      },
      r.rules,
    );
    const after = await r.alerts.list('u1');
    expect(after.map((a) => a.marketId).sort()).toEqual(['m-btc', 'm-eth', 'm-ifc']);
    expect(after.find((a) => a.marketId === 'm-ifc')).toMatchObject({ condition: 'greater_than', targetPrice: '100000', status: 'active' });
    // A second sweep adds nothing more.
    expect(await r.rules.sync(NOW)).toMatchObject({ added: 0 });
    expect(await r.alerts.list('u1')).toHaveLength(3);
    expect((await r.rules.list('u1'))[0]).toMatchObject({ markets: ['m-btc', 'm-eth', 'm-ifc'], lastSyncCode: null });
  });

  it('never adds back a market whose alert the person deleted, and never takes one away', async () => {
    const r = rig();
    const made = await create(r);
    await r.alerts.remove('u1', made.alerts[0]!.id);
    r.setLists([{ id: 'majors', name: 'TEST majors', symbols: ['ETH/USDT'] }]);
    expect(await r.rules.sync(NOW)).toMatchObject({ added: 0 });
    expect((await r.alerts.list('u1')).map((a) => a.marketId)).toEqual(['m-eth']);
  });

  it('adds nothing when identity gives no answer, and says so on the rule', async () => {
    const r = rig();
    await create(r);
    r.setLists(null);
    expect(await r.rules.sync(NOW)).toMatchObject({ added: 0, refusals: { 'identity.watchlists_unavailable': 1 } });
    expect((await r.rules.list('u1'))[0]!.lastSyncCode).toBe('identity.watchlists_unavailable');
    expect(await r.alerts.list('u1')).toHaveLength(2);
  });

  it('adds nothing for a deleted list, or while the markets cannot be read, and says which', async () => {
    const r = rig();
    await create(r);
    r.setLists([]);
    await r.rules.sync(NOW);
    expect((await r.rules.list('u1'))[0]!.lastSyncCode).toBe('alert.watchlist_not_found');
    r.setLists([{ id: 'majors', name: 'TEST majors', symbols: ['BTC/USDT', 'IFC/USDT'] }]);
    r.setDirectory(null);
    await r.rules.sync(NOW);
    expect((await r.rules.list('u1'))[0]!.lastSyncCode).toBe('alert.markets_unavailable');
    expect(await r.alerts.list('u1')).toHaveLength(2);
  });

  it('holds additions to the quota, all or none, and names the quota on the rule', async () => {
    const r = rig({ max: 3 });
    await create(r);
    r.setLists([{ id: 'majors', name: 'TEST majors', symbols: ['BTC/USDT', 'ETH/USDT', 'IFC/USDT', 'SOL/USDT'] }]);
    r.setDirectory(new Map([...DIRECTORY, ['SOL/USDT', 'm-sol']]));
    expect(await r.rules.sync(NOW)).toMatchObject({ added: 0, refusals: { 'alert.quota_reached': 1 } });
    expect(await r.alerts.list('u1')).toHaveLength(2);
    expect((await r.rules.list('u1'))[0]).toMatchObject({ markets: ['m-btc', 'm-eth'], lastSyncCode: 'alert.quota_reached' });
  });

  it('refuses a create past the quota, an unreadable list, a missing list and a list with nothing to watch, storing nothing', async () => {
    await expect(create(rig({ max: 1 }))).rejects.toMatchObject({ code: 'alert.quota_reached' });
    await expect(create(rig({ lists: null }))).rejects.toMatchObject({ code: 'identity.watchlists_unavailable' });
    await expect(create(rig(), { listId: 'other' })).rejects.toMatchObject({ code: 'alert.watchlist_not_found' });
    await expect(create(rig({ lists: [{ id: 'majors', name: 'TEST', symbols: ['NOPE/USDT'] }] }))).rejects.toMatchObject({
      code: 'alert.invalid_market',
    });
    await expect(create(rig(), { targetPrice: '' })).rejects.toMatchObject({ code: 'notify.price_unset' });
    const r = rig({ max: 1 });
    await expect(create(r)).rejects.toBeTruthy();
    expect(await r.alerts.list('u1')).toHaveLength(0);
    expect(await r.rules.list('u1')).toHaveLength(0);
  });

  it('stops following a stopped rule: a later addition is not picked up, and its alerts stay', async () => {
    const r = rig();
    const made = await create(r);
    await r.rules.stop('u1', made.rule.id, NOW);
    r.setLists([{ id: 'majors', name: 'TEST majors', symbols: ['BTC/USDT', 'ETH/USDT', 'IFC/USDT'] }]);
    expect(await r.rules.sync(NOW)).toMatchObject({ rules: 0, added: 0 });
    expect(await r.alerts.list('u1')).toHaveLength(2);
    expect(await r.rules.stop('u2', made.rule.id, NOW)).toBeNull();
  });

  it('reads each person once per sweep, however many rules they hold', async () => {
    const r = rig();
    await create(r);
    await create(r, { targetPrice: '90000' });
    r.reads.length = 0;
    await r.rules.sync(NOW);
    expect(r.reads).toEqual(['u1']);
  });

  it('applies an addition only to the rule as it was read, so two sweeps racing add once', async () => {
    const r = rig();
    const made = await create(r);
    const inputs = [{ userId: 'u1', marketId: 'm-ifc', kind: 'price' as const, direction: 'above' as const, targetPrice: '100000' }];
    expect(await r.store.addMarkets(made.rule, inputs, 20, NOW)).toHaveLength(1);
    expect(await r.store.addMarkets(made.rule, inputs, 20, NOW)).toBeNull();
    expect(await r.alerts.list('u1')).toHaveLength(3);
  });
});

describe('marketsOf', () => {
  it("keeps the list's order, each market once, leaving out unlisted symbols and covered markets", () => {
    const list = { id: 'x', name: 'x', symbols: ['ETH/USDT', 'NOPE/USDT', 'BTC/USDT', 'IFC/USDT'] };
    expect(marketsOf(list, DIRECTORY, ['m-btc'])).toEqual(['m-eth', 'm-ifc']);
  });
});
