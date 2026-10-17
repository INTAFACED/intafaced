import type { Sql } from 'postgres';
import type { AccountRef, Balance } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import type { PayFail } from './common.js';
import { STATEMENT_INSTANCE_CAP, STATEMENT_LEASE_SECONDS, listMerchantStatement } from './statement.js';

const USER = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4';
const RANGE = { limit: 20, from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' };

const fail: PayFail = (message, code) => {
  throw new Error(`${code}: ${message}`);
};

const ledger = {
  async balance(ref: AccountRef): Promise<Balance> {
    return { account: ref, accountId: 'clearing', amount: 0n };
  },
  async getTxByKey(): Promise<null> {
    return null;
  },
};

interface Lease {
  leaseId: string;
  expiresAt: number;
}

function merchantId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/**
 * In-memory stand-in for `INSERT ... ON CONFLICT DO UPDATE WHERE expires_at < now()`.
 * Postgres coverage of that statement is in the portal-reads database tests.
 */
function leaseSql(options?: { onScan?: (merchantId: string) => void; block?: { gate: Promise<void>; onEntered: () => void } }): {
  sql: Sql;
  leases: Map<string, Lease>;
  deletes: () => number;
} {
  const leases = new Map<string, Lease>();
  let deletes = 0;
  let entered = 0;
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    if (text.includes('merchant_statement_leases')) {
      const merchantId = String(values[0]);
      const leaseId = String(values[1]);
      if (text.includes('DELETE')) {
        deletes += 1;
        const row = leases.get(merchantId);
        if (row?.leaseId === leaseId) leases.delete(merchantId);
        return [];
      }
      const existing = leases.get(merchantId);
      if (existing && !(existing.expiresAt < Date.now())) return [];
      leases.set(merchantId, { leaseId, expiresAt: Date.now() + STATEMENT_LEASE_SECONDS * 1000 });
      return [{ lease_id: leaseId }];
    }
    if (text.includes('FROM pay.merchants')) return [{ user_id: USER }];
    if (text.includes("e.event = 'captured'")) {
      options?.onScan?.(String(values[0]));
      if (options?.block) {
        entered += 1;
        if (entered === STATEMENT_INSTANCE_CAP) options.block.onEntered();
        if (entered <= STATEMENT_INSTANCE_CAP) await options.block.gate;
      }
      return [];
    }
    if (text.includes('FROM pay.settlements')) return [];
    if (text.includes("e.event = 'refund.posted'")) return [];
    if (text.includes('chargeback.opening_planned')) return [];
    if (text.includes('pay.payout_admissions')) return [];
    throw new Error(text);
  }) as unknown as Sql;
  return { sql, leases, deletes: () => deletes };
}

function list(sql: Sql, id: string) {
  return listMerchantStatement(sql, ledger, { merchantId: id, ...RANGE }, fail);
}

describe('statement lease', () => {
  it('refuses another merchant once this process is at the statement cap', async () => {
    expect(STATEMENT_INSTANCE_CAP).toBe(2);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened!: () => void;
    const bothIn = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const { sql, leases } = leaseSql({ block: { gate, onEntered: () => opened() } });
    const ids = Array.from({ length: STATEMENT_INSTANCE_CAP + 1 }, (_, index) => merchantId(index + 1));
    const running = ids.slice(0, STATEMENT_INSTANCE_CAP).map((id) => list(sql, id));
    const extra = ids[STATEMENT_INSTANCE_CAP]!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bothIn,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('statement scans did not enter')), 1_000);
        }),
      ]);
      await expect(list(sql, extra)).rejects.toThrow(/pay\.statement_busy/);
      expect(leases.has(extra)).toBe(false);
      expect([...leases.keys()].sort()).toEqual(ids.slice(0, STATEMENT_INSTANCE_CAP).sort());
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await Promise.allSettled(running);
    }
    expect(leases.size).toBe(0);
    const after = await list(sql, extra);
    expect(after.items).toEqual([]);
    expect(after.runningBalances).toBe('within_range');
  });

  it('releases the lease when the scan throws and leaves another merchant leased', async () => {
    const mine = merchantId(1);
    const other = merchantId(2);
    let throwOnScan = true;
    const { sql, leases, deletes } = leaseSql({
      onScan: () => {
        if (throwOnScan) throw new Error('scan failed');
      },
    });
    leases.set(other, { leaseId: 'other-lease', expiresAt: Date.now() + 60_000 });
    await expect(list(sql, mine)).rejects.toThrow('scan failed');
    expect(leases.has(mine)).toBe(false);
    expect(leases.get(other)?.leaseId).toBe('other-lease');
    expect(deletes()).toBe(1);
    throwOnScan = false;
    const again = await list(sql, mine);
    expect(again.items).toEqual([]);
    expect(leases.has(mine)).toBe(false);
    expect(leases.get(other)?.leaseId).toBe('other-lease');
  });

  it('refuses a live lease and takes over an expired one', async () => {
    expect(STATEMENT_LEASE_SECONDS).toBe(60);
    const mine = merchantId(1);
    const live = leaseSql();
    live.leases.set(mine, { leaseId: 'live-lease', expiresAt: Date.now() + 60_000 });
    await expect(list(live.sql, mine)).rejects.toThrow(/pay\.statement_busy/);
    expect(live.leases.get(mine)?.leaseId).toBe('live-lease');
    expect(live.deletes()).toBe(0);

    let seen: string | undefined;
    const watching = leaseSql({
      onScan: (id) => {
        seen = watching.leases.get(id)?.leaseId;
      },
    });
    watching.leases.set(mine, { leaseId: 'stale-lease', expiresAt: Date.now() - 1_000 });
    const page = await list(watching.sql, mine);
    expect(page.runningBalances).toBe('within_range');
    expect(seen).toBeTruthy();
    expect(seen).not.toBe('stale-lease');
    expect(watching.leases.has(mine)).toBe(false);
  });
});
