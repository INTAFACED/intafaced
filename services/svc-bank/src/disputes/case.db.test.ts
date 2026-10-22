/**
 * PP-disputes-safety-01 — dispute cases. Postgres-hard: no skip; a missing TEST_DATABASE_URL fails the suite.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityItem } from '../activity/activity-service.js';
import { DisputeCases, disputeCaseId, disputeCaseKey, transitionDispute, type DisputeLineFacts } from './case.js';

const known: DisputeLineFacts = { isCardLine: () => 'no', isFullyRefunded: () => 'no' };

const USER = '11111111-1111-4111-8111-111111111111';
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function line(id: string, kind: ActivityItem['kind'] = 'payment'): ActivityItem {
  return {
    id,
    kind,
    direction: 'out',
    asset: 'USDT',
    amount: '10',
    postedAt: '2026-10-22T03:00:00Z',
    txId: 'tx',
    counterparty: null,
    spaceName: null,
  } as ActivityItem;
}
const input = { reasonCode: 'not_received', statement: 'It never arrived', linkedActivityIds: [] };

describe('dispute case (pure)', () => {
  it('PD-3: submitted cannot jump to a resolution', () => {
    expect.assertions(4);
    expect(() => transitionDispute('submitted', 'resolved_buyer')).toThrow(/cannot go/);
    expect(transitionDispute('submitted', 'under_review')).toBe('under_review');
    expect(() => transitionDispute('cancelled', 'submitted')).toThrow(/cannot go/);
    try {
      transitionDispute('submitted', 'resolved_seller');
    } catch (err) {
      expect(err).toMatchObject({ code: 'pay.dispute_transition_refused' });
    }
  });

  it('the case id is derived from the server key, stable and a uuid', () => {
    const k = disputeCaseKey(USER, 'tx-1:0');
    expect(k).toBe(`dispute:${USER}:tx-1:0`);
    expect(disputeCaseId(k)).toBe(disputeCaseId(k));
    expect(disputeCaseId(k)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(disputeCaseId(disputeCaseKey(USER, 'tx-2:0'))).not.toBe(disputeCaseId(k));
  });

  it('suite is not skip-green', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(new RegExp('describe\\.skip' + 'If|\\bit\\.skip\\(|describe\\.skip\\('));
  });
});

describe('dispute cases (Postgres)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('dispute cases are Postgres-hard: TEST_DATABASE_URL is unset');
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);
  beforeEach(async () => {
    await sql`TRUNCATE bank.dispute_cases, bank.dispute_reasons`;
  });

  const publish = () => sql`INSERT INTO bank.dispute_reasons (code, label) VALUES ('not_received', 'Not received')`;

  it('reason table missing -> refused with blocker; unknown code refuses', async () => {
    const cases = new DisputeCases(sql, known);
    await expect(cases.open(USER, line('tx-1:0'), input)).rejects.toMatchObject({ code: 'pay.dispute_reasons_unset' });
    await publish();
    await expect(cases.open(USER, line('tx-1:0'), { ...input, reasonCode: 'other' })).rejects.toMatchObject({
      code: 'pay.dispute_reason_unknown',
    });
    expect(await sql`SELECT 1 FROM bank.dispute_cases`).toHaveLength(0);
  });

  it('open twice -> same case id; a different statement on the same line conflicts', async () => {
    await publish();
    const cases = new DisputeCases(sql, known);
    const a = await cases.open(USER, line('tx-1:0'), input);
    const b = await cases.open(USER, line('tx-1:0'), input);
    expect(b).toEqual(a);
    expect(a).toMatchObject({ routedTo: 'case', status: 'submitted', caseId: disputeCaseId(disputeCaseKey(USER, 'tx-1:0')) });
    await expect(cases.open(USER, line('tx-1:0'), { ...input, statement: 'other' })).rejects.toMatchObject({
      code: 'pay.dispute_conflict',
    });
    expect(await sql`SELECT 1 FROM bank.dispute_cases`).toHaveLength(1);
  });

  it('pending charge -> refused pending; fully refunded -> already_refunded', async () => {
    await publish();
    await expect(new DisputeCases(sql, known).open(USER, line('h:0', 'order_hold'), input)).rejects.toThrow(/pending/);
    const refunded = new DisputeCases(sql, { isCardLine: () => 'no', isFullyRefunded: () => 'yes' });
    await expect(refunded.open(USER, line('tx-2:0'), input)).rejects.toThrow(/already_refunded/);
    expect(await sql`SELECT 1 FROM bank.dispute_cases`).toHaveLength(0);
  });

  it('card line -> issuer routing, no case', async () => {
    await publish();
    const card = new DisputeCases(sql, { isCardLine: () => 'yes', isFullyRefunded: () => 'no' });
    expect(await card.open(USER, line('tx-3:0'), input)).toEqual({ routedTo: 'card_issuer', activityId: 'tx-3:0' });
    expect(await sql`SELECT 1 FROM bank.dispute_cases`).toHaveLength(0);
  });

  it('facts fail closed: the production default (unknown) refuses, and an unknown refund fact refuses too', async () => {
    await publish();
    await expect(new DisputeCases(sql).open(USER, line('tx-4:0'), input)).rejects.toMatchObject({ code: 'pay.dispute_line_facts_unset' });
    const refundUnknown = new DisputeCases(sql, { isCardLine: () => 'no', isFullyRefunded: () => 'unknown' });
    await expect(refundUnknown.open(USER, line('tx-4:0'), input)).rejects.toMatchObject({ code: 'pay.dispute_line_facts_unset' });
    expect(await sql`SELECT 1 FROM bank.dispute_cases`).toHaveLength(0);
  });

  it('facts are an allow-list: an untyped adapter answer (undefined, true, false) refuses as unset', async () => {
    await publish();
    for (const odd of [undefined, true, false] as unknown as Array<'no'>) {
      const card = new DisputeCases(sql, { isCardLine: () => odd, isFullyRefunded: () => 'no' });
      await expect(card.open(USER, line('tx-8:0'), input)).rejects.toMatchObject({ code: 'pay.dispute_line_facts_unset' });
      const refund = new DisputeCases(sql, { isCardLine: () => 'no', isFullyRefunded: () => odd });
      await expect(refund.open(USER, line('tx-8:0'), input)).rejects.toMatchObject({ code: 'pay.dispute_line_facts_unset' });
    }
    expect(await sql`SELECT 1 FROM bank.dispute_cases`).toHaveLength(0);
  });

  it('a re-open with different linked lines conflicts', async () => {
    await publish();
    const cases = new DisputeCases(sql, known);
    await cases.open(USER, line('tx-5:0'), { ...input, linkedActivityIds: ['tx-6:0'] });
    await expect(cases.open(USER, line('tx-5:0'), { ...input, linkedActivityIds: ['tx-7:0'] })).rejects.toMatchObject({
      code: 'pay.dispute_conflict',
    });
    expect(await cases.open(USER, line('tx-5:0'), { ...input, linkedActivityIds: ['tx-6:0'] })).toMatchObject({ routedTo: 'case' });
  });
});
