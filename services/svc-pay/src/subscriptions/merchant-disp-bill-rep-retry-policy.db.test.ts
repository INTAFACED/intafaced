import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryLedger } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';
import { SubscriptionRetryPolicyService } from './retry-policy.js';

/** M-bill-04 retry policy against a real Postgres. Every number below is a TEST VALUE, not an owner decision. */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const c = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_retry_policy_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: c.getConnectionUri(), stop: async () => void (await c.stop()) };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code: string }).code;
  }
  throw new Error('expected a refusal');
}

describe('M-bill-04 subscription retry policy (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let policy!: SubscriptionRetryPolicyService;
  let pay!: PayService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    pay = new PayService(sql, new MemoryLedger(), new RailRegistry([]), {});
    policy = new SubscriptionRetryPolicyService(sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  const merchant = async () => (await pay.createMerchant({ userId: `owner-${Math.random()}`, pricing: { feeBps: 0 } })).id;
  const unset = { attempts: null, spacingHours: null, finalAction: null };

  it('a merchant with no policy reads unset, version 0, auto-retry off: no default values', async () => {
    const m = await merchant();
    expect(await policy.get(m)).toEqual({ merchantId: m, status: 'unset', values: unset, autoRetry: false, version: 0, updatedAt: null });
  });

  it('blank policy -> enabling auto-retry refused, nothing written', async () => {
    const m = await merchant();
    expect(await codeOf(policy.set({ merchantId: m, values: unset, autoRetry: true, expectedVersion: 0 }, 'actor'))).toBe(
      'pay.subscription_retry_policy_unset',
    );
    const partial = { attempts: 2, spacingHours: 24, finalAction: null };
    expect(await codeOf(policy.set({ merchantId: m, values: partial, autoRetry: true, expectedVersion: 0 }, 'actor'))).toBe(
      'pay.subscription_retry_policy_unset',
    );
    expect((await policy.get(m)).version).toBe(0);
  });

  it('the database also refuses auto-retry on an incomplete row', async () => {
    const m = await merchant();
    await expect(
      sql`INSERT INTO pay.subscription_retry_policies (merchant_id, attempts, auto_retry, version, updated_by) VALUES (${m}, 2, true, 1, 'x')`,
    ).rejects.toThrow(/subscription_retry_policies_auto_needs_values/);
  });

  it('attempts above the charge-cycle bound of 3 are refused', async () => {
    const m = await merchant();
    const values = { attempts: 4, spacingHours: 24, finalAction: 'cancel' as const };
    expect(await codeOf(policy.set({ merchantId: m, values, autoRetry: false, expectedVersion: 0 }, 'actor'))).toBe(
      'pay.subscription_retry_policy_invalid',
    );
  });

  it('a complete policy can enable auto-retry; versions advance and history keeps each write', async () => {
    const m = await merchant();
    const values = { attempts: 3, spacingHours: 48, finalAction: 'mark_unpaid' as const };
    const a = await policy.set({ merchantId: m, values, autoRetry: false, expectedVersion: 0 }, 'actor-1');
    expect(a).toMatchObject({ status: 'set', autoRetry: false, version: 1, values });
    const b = await policy.set({ merchantId: m, values, autoRetry: true, expectedVersion: 1 }, 'actor-2');
    expect(b).toMatchObject({ status: 'set', autoRetry: true, version: 2 });
    const events = await sql<Array<{ version: number; actor_id: string; auto_retry: boolean }>>`
      SELECT version, actor_id, auto_retry FROM pay.subscription_retry_policy_events WHERE merchant_id = ${m} ORDER BY version`;
    expect(events).toEqual([
      { version: 1, actor_id: 'actor-1', auto_retry: false },
      { version: 2, actor_id: 'actor-2', auto_retry: true },
    ]);
  });

  it('a stale version is refused and writes nothing', async () => {
    const m = await merchant();
    const values = { attempts: 1, spacingHours: 24, finalAction: 'leave_past_due' as const };
    await policy.set({ merchantId: m, values, autoRetry: false, expectedVersion: 0 }, 'actor');
    expect(await codeOf(policy.set({ merchantId: m, values: unset, autoRetry: false, expectedVersion: 0 }, 'actor'))).toBe(
      'pay.subscription_retry_policy_conflict',
    );
    expect(await policy.get(m)).toMatchObject({ version: 1, values });
  });
});
