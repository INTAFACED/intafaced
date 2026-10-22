/**
 * CB-copy-12 Postgres store. TEST_DATABASE_URL; does not start Docker.
 * Concurrent identical applies write one row; follows-master and copy-account reads hit trade.copy_follows.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';
import { CopyError } from './errors.js';
import type { CopyLeadLaw } from './lead-law.js';
import { LeaderApplicationService, SqlLeaderApplicationStore, ledgerFreeBalance, sqlFollowEligibility } from './leader-application.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const USER = '00000000-0000-4000-8000-0000000013a1';
const MASTER = '00000000-0000-4000-8000-0000000013b1';

const LAW: CopyLeadLaw = {
  spotMarkets: ['BTC/USDT'],
  futuresMarkets: null,
  verificationLevel: 'basic',
  balanceAsset: 'USDT',
  balanceThreshold: '0',
  resubmitDays: 30,
  missionTransferMinimum: null,
  missionDaysToList: null,
};
const INPUT = { mode: 'spot' as const, nickname: 'n', contact: 'c', tradingStyle: 's', markets: ['BTC/USDT'] };

function openDb(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is unset. CB-copy-12 SQL test does not start Docker.');
  return url;
}

describe('CB-copy-12 SqlLeaderApplicationStore', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: openDb(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);
  beforeEach(async () => {
    await truncateTradeExceptOrderEvents(db!.sql);
  });

  function service() {
    const sql = db!.sql;
    return new LeaderApplicationService(
      new SqlLeaderApplicationStore(sql),
      { ...sqlFollowEligibility(sql), verificationLevel: async () => 'full', freeBalance: ledgerFreeBalance(new MemoryLedger()) },
      LAW,
    );
  }

  it('two concurrent identical applies write exactly one row and return the same id', async () => {
    const s = service();
    const results = await Promise.all([s.apply(USER, INPUT), s.apply(USER, INPUT), s.apply(USER, INPUT)]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const [row] = await db!.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.copy_leader_applications`;
    expect(row!.n).toBe(1);
    const [stored] = await s.mine(USER);
    expect(stored!.idempotencyKey).toBe(`copy.leader_apply:${USER}:spot`);
    expect(stored!.markets).toEqual(['BTC/USDT']);
  });

  it('an ACTIVE follow in trade.copy_follows refuses trade.copy_lead_follows_master and writes nothing', async () => {
    await db!.sql`
      INSERT INTO trade.copy_follows (follow_id, follower_id, leader_id, region, permitted_markets,
        max_notional_per_order, max_aggregate_exposure, expires_at)
      VALUES ('f-1', ${USER}, ${MASTER}, 'SG', '["BTC/USDT"]'::jsonb, 10, 100, now() + interval '1 day')`;
    const err = await service()
      .apply(USER, INPUT)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CopyError);
    expect((err as CopyError).code).toBe('trade.copy_lead_follows_master');
    const [row] = await db!.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.copy_leader_applications`;
    expect(row!.n).toBe(0);
  });

  it('disapproval is stored with actor, reason and time; re-apply inside the window refuses', async () => {
    const s = service();
    const app = await s.apply(USER, INPUT);
    await s.decide(app.id, { state: 'disapproved', actorId: MASTER, reason: 'too new' });
    const [stored] = await s.mine(USER);
    expect(stored!.state).toBe('disapproved');
    expect(stored!.decidedBy).toBe(MASTER);
    expect(stored!.decisionReason).toBe('too new');
    expect(stored!.decidedAt).toBeInstanceOf(Date);
    await expect(s.apply(USER, INPUT)).rejects.toMatchObject({ code: 'trade.copy_lead_resubmit_too_early' });
  });

  it('free balance is read from the ledger available account', async () => {
    const ledger = new MemoryLedger();
    const read = await ledgerFreeBalance(ledger)(USER, 'USDT');
    expect(read).toBe(parseAmount('0'));
  });
});
