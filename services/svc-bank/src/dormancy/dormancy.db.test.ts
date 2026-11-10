/**
 * The dormancy fee (RC-bank-01, J-bank-16 #7), against Postgres and the TEST partner bank.
 *
 * PG-hard: a missing database fails the suite. CI uses TEST_DATABASE_URL; without it, Testcontainers `postgres:16-alpine`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PARTNER_FEES_OWNER, custodialOnly } from '../partner/partner-bank.js';
import { testPartner, testPartnerCustody, type TestPartner } from '../partner/test-partner.js';
import { DormancyService, parseDormancyRules } from './dormancy.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const RULES = parseDormancyRules(JSON.stringify([{ assetId: 'USDT', fee: '5', inactiveDays: 365, noticeLeadDays: 30, version: 'test-1' }]));
const DAY = 86_400_000;

describe('the dormancy fee (J-bank-16 #7, PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let partner: TestPartner;
  let dormancy: DormancyService;
  let user: string;

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
  }, 180_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 60_000);
  beforeEach(() => {
    partner = testPartner();
    dormancy = new DormancyService(db.sql, testPartnerCustody(partner), RULES);
    user = held();
  });

  function held(): string {
    const id = randomUUID();
    partner.set(id, { custody: 'off' });
    return id;
  }
  const fund = (amount: string, who = user) => partner.fund(who, { fundId: randomUUID(), assetId: 'USDT', amount: amt(amount) });
  const main = (who = user) => ({ userId: who, assetId: 'USDT', spaceId: null });
  const balance = async (who = user) => (await partner.bank.balance(main(who))).amount;
  /** Money leaves the person now, to another TEST person at the partner. */
  const spend = (amount: string, who = user) =>
    partner.bank.move({ key: `spend:${randomUUID()}`, from: main(who), to: main(randomUUID()), amount: amt(amount) });
  const quietUntil = () => new Date(Date.now() + 366 * DAY);
  const debitDay = (at: Date) => new Date(at.getTime() + 30 * DAY).toISOString().slice(0, 10);
  const due = (at: Date) => new Date(`${debitDay(at)}T00:01:00Z`);
  const chargeKey = (at: Date, who = user) => `fee:bank.dormancy:${who}:USDT:${debitDay(at)}`;

  it('notices a quiet account once, naming the fee and the debit date', async () => {
    await fund('20');
    const at = quietUntil();
    expect((await dormancy.run({ at, userIds: [user] })).noticed).toEqual([
      { userId: user, assetId: 'USDT', fee: '5', debitDate: debitDay(at) },
    ]);
    expect((await dormancy.run({ at, userIds: [user] })).noticed).toEqual([]);
    expect(await dormancy.notices(user)).toEqual([expect.objectContaining({ state: 'noticed', fee: '5', debitDate: debitDay(at) })]);
    // Too early for a debit: nothing settles.
    expect((await dormancy.run({ at: new Date(at.getTime() + DAY), userIds: [user] })).settled).toEqual([]);
  });

  it('gives no notice to an account active within the rule, or one that never moved', async () => {
    await fund('20');
    expect((await dormancy.run({ at: new Date(Date.now() + 100 * DAY), userIds: [user] })).noticed).toEqual([]);
    expect((await dormancy.run({ at: quietUntil(), userIds: [held()] })).noticed).toEqual([]);
  });

  it('passes over a person the partner does not hold money for, and posts nothing for them', async () => {
    const custodial = new DormancyService(db.sql, custodialOnly, RULES);
    await fund('20');
    expect(await custodial.run({ at: quietUntil(), userIds: [user] })).toEqual({ noticed: [], settled: [] });
    expect(await custodial.notices(user)).toEqual([]);
  });

  it('takes no fee after a full withdrawal: a zero balance on the debit date is skipped_zero', async () => {
    await fund('20');
    const at = quietUntil();
    await dormancy.run({ at, userIds: [user] });
    await spend('20');
    expect(await balance()).toBe(0n);
    const { settled } = await dormancy.run({ at: due(at), userIds: [user] });
    expect(settled).toEqual([{ userId: user, assetId: 'USDT', debitDate: debitDay(at), outcome: 'skipped_zero' }]);
    expect(await balance()).toBe(0n);
    expect(await partner.bank.moveByKey(chargeKey(at))).toBeNull();
    expect((await dormancy.notices(user))[0]).toMatchObject({ state: 'skipped_zero', partnerMoveId: null });
  });

  it('cancels the notice on activity after it', async () => {
    // Noticed an hour ago on a quiet account; the line below is after that notice.
    const at = new Date(Date.now() - 3_600_000);
    await fund('20');
    await dormancy.run({ at, userIds: [user] });
    const { settled } = await dormancy.run({ at: due(at), userIds: [user] });
    expect(settled[0]!.outcome).toBe('cancelled');
    expect(await balance()).toBe(amt('20'));
    expect(await partner.bank.moveByKey(chargeKey(at))).toBeNull();
  });

  it('skips a balance below the fee on the debit date without part-charging', async () => {
    await fund('6');
    const at = quietUntil();
    await dormancy.run({ at, userIds: [user] });
    await spend('3');
    const later = await dormancy.run({ at: due(at), userIds: [user] });
    expect(later.settled[0]!.outcome).toBe('skipped_insufficient');
    expect(await balance()).toBe(amt('3'));
  });

  it('gives no notice to an account holding less than the fee', async () => {
    await fund('4.99');
    expect((await dormancy.run({ at: quietUntil(), userIds: [user] })).noticed).toEqual([]);
  });

  it('decides nothing on a figure the partner has not given: no notice, and an open notice waits', async () => {
    await fund('20');
    const at = quietUntil();
    partner.set(user, { figures: 'unknown' });
    expect((await dormancy.run({ at, userIds: [user] })).noticed).toEqual([]);
    partner.set(user, { figures: 'live' });
    await dormancy.run({ at, userIds: [user] });
    partner.set(user, { figures: 'stale' });
    expect((await dormancy.run({ at: due(at), userIds: [user] })).settled).toEqual([]);
    expect((await dormancy.notices(user))[0]).toMatchObject({ state: 'noticed' });
    expect(await balance()).toBe(amt('20'));
  });

  it('adopts a fee the partner already took under the notice key, so a crash before the row was settled never re-judges it', async () => {
    await fund('7');
    const at = quietUntil();
    await dormancy.run({ at, userIds: [user] });
    const taken = await partner.bank.move({
      key: chargeKey(at),
      from: main(),
      to: { userId: PARTNER_FEES_OWNER, assetId: 'USDT', spaceId: null },
      amount: amt('5'),
    });
    expect((await dormancy.run({ at: due(at), userIds: [user] })).settled[0]!.outcome).toBe('charged');
    expect(await balance()).toBe(amt('2'));
    expect((await dormancy.notices(user))[0]).toMatchObject({ state: 'charged', partnerMoveId: taken.id });
  });

  it('survives a lost reply: the fee is taken once and the next run settles it', async () => {
    await fund('20');
    const at = quietUntil();
    await dormancy.run({ at, userIds: [user] });
    partner.set(user, { nextReply: 'lost' });
    await expect(dormancy.run({ at: due(at), userIds: [user] })).rejects.toMatchObject({ code: 'bank.partner_reply_lost' });
    expect((await dormancy.notices(user))[0]).toMatchObject({ state: 'noticed' });
    expect((await dormancy.run({ at: due(at), userIds: [user] })).settled[0]!.outcome).toBe('charged');
    expect(await balance()).toBe(amt('15'));
  });

  it('has the partner take the noticed fee once, under its key, and a replay takes nothing more', async () => {
    await fund('20');
    const at = quietUntil();
    await dormancy.run({ at, userIds: [user] });
    expect((await dormancy.run({ at: due(at), userIds: [user] })).settled[0]!.outcome).toBe('charged');
    expect((await dormancy.run({ at: due(at), userIds: [user] })).settled).toEqual([]);
    expect(await balance()).toBe(amt('15'));
    const move = await partner.bank.moveByKey(chargeKey(at));
    expect(move).toMatchObject({ amount: amt('5'), to: { userId: PARTNER_FEES_OWNER, assetId: 'USDT' } });
    expect((await dormancy.notices(user))[0]).toMatchObject({ state: 'charged', partnerMoveId: move!.id });
  });

  it('refuses bank.dormancy_rule_unset with no rule, and reads a rule not in shape as none', async () => {
    const none = new DormancyService(db.sql, testPartnerCustody(partner), parseDormancyRules(undefined));
    await expect(none.run({ at: quietUntil(), userIds: [user] })).rejects.toMatchObject({ code: 'bank.dormancy_rule_unset' });
    expect(
      parseDormancyRules(JSON.stringify([{ assetId: 'USDT', fee: 5, inactiveDays: 365, noticeLeadDays: 30, version: 'x' }])),
    ).toBeNull();
    expect(
      parseDormancyRules(JSON.stringify([{ assetId: 'USDT', fee: '0', inactiveDays: 365, noticeLeadDays: 30, version: 'x' }])),
    ).toBeNull();
  });
});
