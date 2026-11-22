import { expect, it } from 'vitest';
import { ActivityService, type LedgerPageEntry } from './activity-service.js';

it('opens both trade legs when the detail lookup page ends between them', async () => {
  const user = '11111111-1111-4111-8111-111111111111';
  const at = new Date('2026-10-13T00:00:00Z');
  const fill: LedgerPageEntry[] = [
    { txId: 'fill', entryId: '101', module: 'trade', reason: 'trade.fill', direction: 'debit', amount: '1', assetId: 'BTC', postedAt: at },
    {
      txId: 'fill',
      entryId: '100',
      module: 'trade',
      reason: 'trade.fill',
      direction: 'credit',
      amount: '100',
      assetId: 'USDT',
      postedAt: at,
    },
  ];
  const newer: LedgerPageEntry[] = Array.from({ length: 99 }, (_, i) => ({
    txId: `deposit-${i}`,
    entryId: String(200 - i),
    module: 'ledger',
    reason: 'deposit.credited',
    direction: 'debit',
    amount: '1',
    assetId: 'USDT',
    postedAt: new Date(at.getTime() + 100 - i),
  }));
  const activity = new ActivityService(
    { allNamedSpaces: async () => [] },
    {
      cursorSecret: 'activity-test-secret',
      pages: {
        async page({ cursor, limit }) {
          const before = cursor ? Number(Buffer.from(cursor, 'base64url').toString().slice(3)) : Infinity;
          const rows = [...newer, ...fill].filter((row) => Number(row.entryId) < before);
          const entries = rows.slice(0, limit);
          return { entries, nextCursor: rows.length > limit ? Buffer.from(`v2.${entries.at(-1)!.entryId}`).toString('base64url') : null };
        },
      },
    },
  );
  const page = await activity.list(user, { limit: 200 });
  const legs = page.items.filter((line) => line.txId === 'fill');
  expect(legs).toHaveLength(2);
  for (const item of legs) {
    // Each leg opens the whole fill: the BTC leg ends the first lookup page, the USDT leg starts the second.
    const detail = await activity.get(user, item.id);
    expect(detail.item.id).toBe(item.id);
    expect(detail.lines.map((line) => line.asset)).toEqual(['BTC', 'USDT']);
    expect(detail.complete).toBe(true);
  }
});
