import type postgres from 'postgres';
import { listProjectedCopyLeaderFixtures } from './copy-leader-fixtures-project.js';

export type CopyLeaderFixture = {
  readonly leaderId: string;
  readonly realisedPnl: string | null;
  readonly closedTrades: number | null;
  readonly winningTrades: number | null;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly source: string;
};

export type CopyLeaderFixturesStore = {
  listFixtures(): Promise<readonly CopyLeaderFixture[]>;
  publishFixture(fixture: CopyLeaderFixture): Promise<void>;
  materializeProjectedFixtures(): Promise<number>;
};

type FixtureRow = {
  leader_id: string;
  realised_pnl: string | null;
  closed_trades: number | null;
  winning_trades: number | null;
  window_start: Date;
  window_end: Date;
  source: string;
};

function rowToFixture(row: FixtureRow): CopyLeaderFixture {
  return {
    leaderId: row.leader_id,
    realisedPnl: row.realised_pnl,
    closedTrades: row.closed_trades,
    winningTrades: row.winning_trades,
    windowStart: row.window_start.toISOString(),
    windowEnd: row.window_end.toISOString(),
    source: row.source,
  };
}

export function createCopyLeaderFixturesStore(sql: postgres.Sql): CopyLeaderFixturesStore {
  const store: CopyLeaderFixturesStore = {
    async listFixtures() {
      const rows = await sql<FixtureRow[]>`
        SELECT leader_id, realised_pnl, closed_trades, winning_trades, window_start, window_end, source
        FROM trade.copy_leader_fixtures
        ORDER BY leader_id
      `;
      if (rows.length > 0) return rows.map(rowToFixture);
      return listProjectedCopyLeaderFixtures(sql);
    },
    async publishFixture(fixture) {
      await sql`
        INSERT INTO trade.copy_leader_fixtures (
          leader_id, realised_pnl, closed_trades, winning_trades, window_start, window_end, source
        )
        VALUES (
          ${fixture.leaderId},
          ${fixture.realisedPnl},
          ${fixture.closedTrades},
          ${fixture.winningTrades},
          ${fixture.windowStart}::timestamptz,
          ${fixture.windowEnd}::timestamptz,
          ${fixture.source}
        )
        ON CONFLICT (leader_id) DO UPDATE SET
          realised_pnl = EXCLUDED.realised_pnl,
          closed_trades = EXCLUDED.closed_trades,
          winning_trades = EXCLUDED.winning_trades,
          window_start = EXCLUDED.window_start,
          window_end = EXCLUDED.window_end,
          source = EXCLUDED.source,
          published_at = now()
      `;
    },
    async materializeProjectedFixtures() {
      const projected = await listProjectedCopyLeaderFixtures(sql);
      for (const fixture of projected) {
        // A projection always carries null realised PnL and winning-trade count.
        // Those nulls must not replace an operator-published figure. A first
        // insert still stores null. Realised PnL stays the decimal string.
        await sql`
          INSERT INTO trade.copy_leader_fixtures AS existing (
            leader_id, realised_pnl, closed_trades, winning_trades, window_start, window_end, source
          )
          VALUES (
            ${fixture.leaderId},
            ${fixture.realisedPnl},
            ${fixture.closedTrades},
            ${fixture.winningTrades},
            ${fixture.windowStart}::timestamptz,
            ${fixture.windowEnd}::timestamptz,
            ${fixture.source}
          )
          ON CONFLICT (leader_id) DO UPDATE SET
            realised_pnl = COALESCE(EXCLUDED.realised_pnl, existing.realised_pnl),
            closed_trades = EXCLUDED.closed_trades,
            winning_trades = COALESCE(EXCLUDED.winning_trades, existing.winning_trades),
            window_start = EXCLUDED.window_start,
            window_end = EXCLUDED.window_end,
            source = EXCLUDED.source,
            published_at = now()
        `;
      }
      return projected.length;
    },
  };
  return store;
}
