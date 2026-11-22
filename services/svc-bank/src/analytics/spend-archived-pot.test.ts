import { expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { MemoryLedger, parseAmount, recipes, subAccountAvailable, userAvailable } from '@intafaced/ledger-client';
import { SpaceService } from '../spaces/space-service.js';
import { memoryLedgerHistory } from './ledger-history.js';
import { SpendAnalytics } from './spend.js';

it('keeps the historical spend totals when an empty pot is archived', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const potId = '22222222-2222-4222-8222-222222222222';
  const assetId = 'USDT';
  const shared = { user_id: userId, asset_id: assetId, goal_target: null, locked_until: null, unlock_requested_at: null, unlocks_at: null };
  const main = { ...shared, id: userId, kind: 'primary', name: 'Main', archived_at: null };
  const pot = { ...shared, id: potId, kind: 'named', name: 'Rent', archived_at: null as Date | null };
  const query = async (parts: TemplateStringsArray) => {
    const text = parts.join('?');
    if (text.includes('archived_at IS NOT NULL')) return pot.archived_at ? [pot] : [];
    if (text.includes('archived_at IS NULL')) return pot.archived_at ? [main] : [main, pot];
    if (text.includes("kind = 'named'")) return [pot];
    if (text.includes('FROM bank.spaces')) return [main, pot];
    throw new Error(text);
  };
  const sql = query as Sql;
  const ledger = new MemoryLedger();
  const amount = parseAmount('10');
  await ledger.post(recipes.deposit({ userId, assetId, amount, rail: 'test', railRef: 'analytics-archive' }));
  const from = userAvailable(userId, assetId);
  const to = subAccountAvailable(potId, assetId);
  await ledger.post(recipes.bankTransfer({ transferId: 'into-pot', occurrence: 0, kind: 'manual', from, to, amount }));
  await ledger.post(recipes.bankTransfer({ transferId: 'out-of-pot', occurrence: 0, kind: 'manual', from: to, to: from, amount }));
  const analytics = new SpendAnalytics(new SpaceService(sql, ledger), memoryLedgerHistory(ledger));
  const input = { userId, assetId, range: { from: new Date(0), to: new Date(Date.now() + 60_000) } };
  const before = await analytics.spendSummary(input);
  expect(before).toMatchObject({ movements: 5, totalInflow: '30', totalOutflow: '20', net: '10' });
  pot.archived_at = new Date();
  expect(await analytics.spendSummary(input)).toEqual(before);
});
