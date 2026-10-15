import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { ChangeService, type ChangeTarget } from './changes.js';

/** Shared setup for the control-room database tests. Every number here is a TEST VALUE, not a business number. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
export const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

export async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_control_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

export const SECRET = 'dev-only-svc-pay-control-test-secret-0123456789abcdef';
export const OWNER_A = '11111111-1111-4111-8111-111111111111';
export const OWNER_B = '22222222-2222-4222-8222-222222222222';
export const MAKER = '33333333-3333-4333-8333-333333333333';
export const FINANCE = '44444444-4444-4444-8444-444444444444';
export const FOUNDER_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const FOUNDER_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const DEST_A = { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' };
export const DEST_B = { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f02' };
export const DEST_C = { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f03' };

export function principal(userId: string, over: Partial<Principal> = {}): Principal {
  return {
    userId,
    sub: userId,
    sid: randomUUID(),
    scopes: [...SESSION_SCOPES, 'pay:read', 'pay:write', 'pay:payout'],
    mfa: true,
    tier: 'full',
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  } as Principal;
}

/** TEST VALUE tier: not a proposal for a real one. */
export const TEST_TIER = {
  id: 'test-tier',
  name: 'TEST VALUE tier',
  archetype: 'psp' as const,
  caps: [
    { kind: 'per_payment' as const, assetCode: 'USDT', limit: '100' },
    { kind: 'daily_intake' as const, assetCode: 'USDT', limit: '300' },
    { kind: 'monthly_intake' as const, assetCode: 'USDT', limit: '1000' },
    { kind: 'daily_payout' as const, assetCode: 'USDT', limit: '500' },
    { kind: 'beneficiaries_per_day' as const, limit: 2 },
  ],
  reserve: { rollingReserveBps: 1000, holdDays: 7 },
  approvalThresholds: [{ assetCode: 'USDT', amount: '50' }],
  founderThresholds: [{ assetCode: 'USDT', amount: '150' }],
  approvalTtlSeconds: 3600,
};

/** TEST VALUE global rule: 250 bps + 0.30 flat, 40 bps spread, platform keeps the fraction. */
export const TEST_GLOBAL_RULE = {
  assetCode: 'USDT',
  bands: [{ fromAmount: '0', feeBps: 250, flatFee: '0.3' }],
  spreadBps: 40,
  roundingBeneficiary: 'platform' as const,
};

async function currentVersion(sql: postgres.Sql, target: ChangeTarget): Promise<string> {
  if (target.scope === 'tier') {
    const r = await sql<Array<{ version: string }>>`SELECT version FROM pay.control_tiers WHERE id = ${target.change.tier.id}`;
    return r[0]?.version ?? '0';
  }
  const layer = target.scope === 'pricing' ? target.change.layer : 'merchant';
  const scopeId = target.scope === 'pricing' ? (target.change.scopeId ?? '') : target.merchantId;
  if (layer === 'merchant') {
    const r = await sql<Array<{ version: string }>>`SELECT version FROM pay.control_merchant_profiles WHERE merchant_id = ${scopeId}`;
    return r[0]?.version ?? '0';
  }
  const r = await sql<
    Array<{ v: string }>
  >`SELECT COALESCE(max(version), 0)::text AS v FROM pay.control_pricing_rules WHERE layer = ${layer} AND scope_id = ${scopeId}`;
  return r[0]!.v;
}

/** Submit as founder 1 and confirm as founder 2, the way a real change goes. Throws unless it ends `changed` or `noop`. */
export async function applyChange(changes: ChangeService, sql: postgres.Sql, target: ChangeTarget) {
  const requestId = randomUUID();
  const expectedVersion = await currentVersion(sql, target);
  const submitted = await changes.submit(FOUNDER_1, { requestId, target, reason: 'test setup', expectedVersion });
  if (submitted.outcome === 'noop') return submitted;
  if (submitted.outcome !== 'pending_second_approval') throw new Error(`setup change ${submitted.outcome}`);
  const done = await changes.confirm(FOUNDER_2, { requestId, decision: 'confirm', reason: 'test setup confirmed' });
  if (done.outcome !== 'changed') throw new Error(`setup confirm ${done.outcome}`);
  return done;
}

export async function resetControl(sql: postgres.Sql): Promise<void> {
  await truncatePayForTest(
    sql,
    'pay',
    `TRUNCATE pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants, pay.control_tiers, pay.control_pricing_rules, pay.control_changes, pay.control_audit RESTART IDENTITY CASCADE`,
  );
}
