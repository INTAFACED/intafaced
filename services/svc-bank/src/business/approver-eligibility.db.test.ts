import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext } from '@intafaced/contracts';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import { BUSINESS_ROLES, roleCan, type BusinessMemberRole } from './business-policy.js';

/**
 * W-withdraw-11: the approver check svc-pay asks for. Eligible only when the account is open, the person is on the team and
 * their role holds `approve`; the door answers svc-pay and nobody else.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ADMIN = '11111111-1111-4111-8111-111111111111';
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const edge = createEdgeContext({ secret: 'a-bank-approver-eligibility-test-secret-32', serviceName: 'svc-bank' });

describe('approver eligibility', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let bank: BankServices;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset');
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.business_payroll_lines, bank.business_payroll_runs,
               bank.business_approvals, bank.business_members, bank.business_accounts,
               bank.business_member_commands, bank.transfer_executions, bank.scheduled_transfers, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    const ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC', recipients: memoryRecipientState() });
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  async function open() {
    return bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Team Co',
      assetId: 'USDT',
      spendThreshold: parseAmount('100'),
      creatorUserId: ADMIN,
    });
  }

  it('answers for every role exactly as the capability table says', async () => {
    const account = await open();
    const roles = BUSINESS_ROLES.filter((r) => r !== 'admin');
    for (const [i, role] of roles.entries()) {
      await bank.business.addMember({ accountId: account.id, actorUserId: ADMIN, userId: uid(i + 1), role });
    }
    for (const [i, role] of roles.entries()) {
      const answer = await bank.business.approverEligibility(account.id, uid(i + 1));
      expect(answer).toEqual(
        roleCan(role as BusinessMemberRole, 'approve') ? { state: 'eligible', role } : { state: 'role_cannot_approve', role },
      );
    }
    expect(await bank.business.approverEligibility(account.id, ADMIN)).toEqual({ state: 'eligible', role: 'admin' });
  });

  it('refuses someone who is not on the team, an unknown account and a closed one', async () => {
    const account = await open();
    expect(await bank.business.approverEligibility(account.id, uid(99))).toEqual({ state: 'not_a_member' });
    expect(await bank.business.approverEligibility(randomUUID(), ADMIN)).toEqual({ state: 'no_such_account' });
    await sql`UPDATE bank.business_accounts SET status = 'closed' WHERE id = ${account.id}::uuid`;
    expect(await bank.business.approverEligibility(account.id, ADMIN)).toEqual({ state: 'account_closed' });
  });

  it('serves svc-pay only: another service is forbidden and no service is unauthorized', async () => {
    const account = await open();
    const call = (service: string | null) =>
      createBankRouter(bank)
        .createCaller({ ...edge({ headers: {}, id: 'req-1' }), service } as never)
        .business.approverEligibility({ accountId: account.id, userId: ADMIN });
    await expect(call('svc-pay')).resolves.toEqual({ state: 'eligible', role: 'admin' });
    await expect(call('svc-trade')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(call(null)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
