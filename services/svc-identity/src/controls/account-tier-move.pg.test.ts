import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { AccountTierMoveInput, Context } from '@intafaced/contracts';
import { createTestDatabase } from '../fixture-truncate.testkit.js';
import { FounderControls, parseFounderPair } from './founder-controls.js';
import { approvedTierMove } from './tier-approval.testkit.js';
import { parseAccountTiers } from './account-tiers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));
const tokens = {
  secret: 'an-account-tier-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const available = await postgresAvailable(url);
const REASON = 'Customer qualifies for the plus tier';
const terms = { ratePercent: '1.5', monthlyFee: '4.99', feeAssetId: 'USD', dailyLimit: '1000', clearingDays: '2' };
const TIERS = parseAccountTiers(
  JSON.stringify([
    { id: 'standard', name: 'Standard', terms },
    { id: 'plus', name: 'Plus', terms: { ...terms, monthlyFee: '9.99' } },
    { id: 'premier', name: 'Premier', terms: { ...terms, monthlyFee: null } },
  ]),
)!;

if (!available) {
  describe.skip('account tier moves (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  let controls: FounderControls;
  let first: Context;
  let second: Context;
  let customer: Context;
  let target: string;

  const seed = async (): Promise<Context> => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const handle = `t${userId.replaceAll('-', '').slice(0, 16)}`;
    await db.sql`INSERT INTO users (id, handle, email, password_hash, totp_secret, totp_enrolled_at) VALUES (${userId}, ${handle}, ${`${handle}@example.com`}, ${'test-password-hash'}, ${'verified-test-factor'}, ${new Date()})`;
    await db.sql`INSERT INTO sessions (id, user_id, refresh_hash, mfa, expires_at) VALUES (${sessionId}, ${userId}, ${`refresh:${sessionId}`}, ${true}, ${new Date(Date.now() + 3600000)})`;
    const { token } = await issueAccessToken({ userId, sessionId, scopes: ['identity:read', 'identity:write'], mfa: true }, tokens);
    return { principal: await verifyAccessToken(token, tokens), service: null, region: 'DE', requestId: randomUUID() };
  };
  const id = (context: Context) => context.principal!.userId;
  const move = (tierId: string, expectedVersion = '0', userId = target, approvalId?: string): AccountTierMoveInput => ({
    requestId: randomUUID(),
    userId,
    tierId,
    reason: REASON,
    expectedVersion,
    ...(approvalId ? { approvalId } : {}),
  });
  const approved = async (by: Context, approver: string, input: AccountTierMoveInput): Promise<AccountTierMoveInput> => ({
    ...input,
    approvalId: await approvedTierMove(
      db.sql,
      { isFounder: (userId) => controls.isLiveFounder(userId) },
      {
        requesterId: id(by),
        approverId: approver,
        userId: input.userId,
        tierId: input.tierId,
        reason: input.reason,
        expectedVersion: input.expectedVersion,
      },
    ),
  });
  const approvalStatus = async (approvalId: string) =>
    (await db.sql<Array<{ status: string }>>`SELECT status FROM action_approvals WHERE approval_id = ${approvalId}`)[0]!.status;

  beforeEach(async () => {
    await db.truncateAll();
    first = await seed();
    second = await seed();
    customer = await seed();
    target = id(customer);
    controls = new FounderControls(db.sql, parseFounderPair(id(first), id(second)));
    expect(await controls.bootstrap()).toBe(true);
    controls.useAccountTiers(TIERS);
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('account tier moves', () => {
    it('lists the tiers, refuses a move without an approval, and moves once with a second founder; the history names both', async () => {
      expect(await controls.tiers(first)).toEqual({ configured: true, tiers: TIERS });
      expect(await controls.tierState(first, { userId: target })).toEqual({ userId: target, version: '0', tierId: null });
      const alone = await controls.tierMove(first, move('plus'));
      expect(alone).toMatchObject({ outcome: 'refused', code: 'identity.tier_requires_approver', current: { tierId: null } });

      const input = await approved(first, id(second), move('plus'));
      const moved = await controls.tierMove(first, input);
      expect(moved).toMatchObject({
        outcome: 'changed',
        actorUserId: id(first),
        approverUserId: id(second),
        before: { tierId: null, version: '0' },
        after: { tierId: 'plus', version: '1' },
      });
      expect(await approvalStatus(input.approvalId!)).toBe('CONSUMED');
      expect(await controls.tierMove(first, input)).toEqual(moved);
      expect(await controls.tierState(second, { userId: target })).toEqual({ userId: target, version: '1', tierId: 'plus' });

      const again = await controls.tierMove(first, await approved(first, id(second), move('plus', '1')));
      expect(again).toMatchObject({ outcome: 'refused', code: 'identity.tier_unchanged' });
      const back = await controls.tierMove(second, await approved(second, id(first), move('standard', '1')));
      expect(back).toMatchObject({ outcome: 'changed', before: { tierId: 'plus' }, after: { tierId: 'standard', version: '2' } });

      const history = await controls.tierHistory(first, { userId: target, limit: 10 });
      expect(history.map((row) => [row.outcome, row.tierId])).toEqual([
        ['changed', 'standard'],
        ['refused', 'plus'],
        ['changed', 'plus'],
        ['refused', 'plus'],
      ]);
    });

    it('refuses a tier with a blank term, naming it, and leaves the approval unspent', async () => {
      const input = await approved(first, id(second), move('premier'));
      const refused = await controls.tierMove(first, input);
      expect(refused).toMatchObject({ outcome: 'refused', code: 'identity.tier_terms_unset', blankTerms: ['monthlyFee'] });
      expect(await approvalStatus(input.approvalId!)).toBe('APPROVED');
      expect(await controls.tierState(first, { userId: target })).toMatchObject({ tierId: null, version: '0' });
    });

    it('refuses everything while the tiers are unset, and an unknown tier', async () => {
      controls.useAccountTiers(undefined);
      expect(await controls.tiers(first)).toEqual({ configured: false, code: 'identity.account_tiers_unset' });
      expect(await controls.tierMove(first, await approved(first, id(second), move('plus')))).toMatchObject({
        code: 'identity.account_tiers_unset',
      });
      controls.useAccountTiers(TIERS);
      expect(await controls.tierMove(first, await approved(first, id(second), move('gold')))).toMatchObject({
        code: 'identity.tier_unknown',
      });
    });

    it('binds the approval to the version, the tier and the reason', async () => {
      const stale = await approved(first, id(second), move('plus'));
      await controls.tierMove(first, await approved(first, id(second), move('standard')));
      expect(await controls.tierMove(first, stale)).toMatchObject({ outcome: 'conflict', current: { version: '1' } });
      expect(await controls.tierMove(first, { ...stale, requestId: randomUUID(), expectedVersion: '1' })).toMatchObject({
        code: 'identity.tier_approval_mismatch',
      });
      const forPlus = await approved(first, id(second), move('plus', '1'));
      expect(await controls.tierMove(first, { ...forPlus, requestId: randomUUID(), tierId: 'premier' })).toMatchObject({
        code: 'identity.tier_terms_unset',
      });
      expect(await controls.tierMove(first, { ...forPlus, requestId: randomUUID(), reason: 'Another reason entirely' })).toMatchObject({
        code: 'identity.tier_approval_mismatch',
      });
      expect(await approvalStatus(forPlus.approvalId!)).toBe('APPROVED');
    });

    it('needs the approver to be a live founder, and the actor to be one', async () => {
      const outsider = await seed();
      await expect(approved(first, id(outsider), move('plus'))).rejects.toMatchObject({ code: 'action_approval.founder_only' });
      const bySecond = await approved(first, id(second), move('plus'));
      await db.sql`UPDATE founder_operator_entitlements SET enabled = false WHERE user_id = ${id(second)}`;
      expect(await controls.tierMove(first, bySecond)).toMatchObject({ code: 'identity.tier_approval_mismatch' });
      await db.sql`UPDATE founder_operator_entitlements SET enabled = true WHERE user_id = ${id(second)}`;
      expect(await controls.tierMove(customer, move('plus'))).toMatchObject({ code: 'operator.denied', current: null });
      await expect(controls.tiers(customer)).rejects.toMatchObject({ code: 'operator.denied' });
    });

    it('refuses the actor’s own account and a closed account', async () => {
      expect(await controls.tierMove(first, await approved(first, id(second), move('plus', '0', id(first))))).toMatchObject({
        code: 'identity.tier_self_forbidden',
      });
      await db.sql`UPDATE users SET status = 'closed' WHERE id = ${target}`;
      expect(await controls.tierMove(first, await approved(first, id(second), move('plus')))).toMatchObject({
        code: 'identity.tier_account_closed',
      });
    });
  });
}
