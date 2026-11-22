/**
 * Production caller for ANALYTICS_REPLICA_LAG_SQL.
 *
 * One-shot readonly connection per replica URL. No pool, no writes, no ledger
 * tables. Connect/query failure → probe returns null (unknown), never invents 0.
 *
 * Kill: ANALYTICS_REPLICA_PROBE=off. Tests inject `connect`.
 */

import postgres from 'postgres';
import type { WarehouseLagProbe } from '@intafaced/contracts';
import { createSqlWarehouseLagProbe } from '@intafaced/contracts/ops-analytics-warehouse';

export type WarehouseLagSqlClient = {
  unsafe(sql: string): Promise<unknown> | unknown;
  end(opts?: { timeout?: number }): Promise<void> | void;
};

export type WarehouseLagConnect = (url: string) => WarehouseLagSqlClient;

const CONNECT_TIMEOUT_SECONDS = 2;
const STATEMENT_TIMEOUT_MS = 2_000;

function defaultConnect(url: string): WarehouseLagSqlClient {
  return postgres(url, {
    max: 1,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    idle_timeout: 1,
    max_lifetime: 8,
    prepare: false,
    connection: {
      statement_timeout: STATEMENT_TIMEOUT_MS,
      application_name: 'ops-analytics-lag-probe',
    },
  });
}

export function warehouseLagProbeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ANALYTICS_REPLICA_PROBE !== 'off';
}

/**
 * Production probe. `connect` is injectable so unit tests never open sockets.
 */
export function createEdgeWarehouseLagProbe(connect: WarehouseLagConnect = defaultConnect): WarehouseLagProbe {
  return createSqlWarehouseLagProbe(async ({ url, sql }) => {
    const client = connect(url);
    try {
      return await client.unsafe(sql);
    } finally {
      await client.end({ timeout: 1 });
    }
  });
}
