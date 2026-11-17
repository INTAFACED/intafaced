/**
 * J-bank-30 (BK-salary-01, -02, -03): salary paid in by direct deposit at the TEST partner bank, over Postgres. The money is
 * the partner's: a credit is one pay-in there, a split leg one partner move into a space, a reversal one move out, each
 * under its business key and read back once, and the ledger posts nothing. Enters through the router where a customer
 * would, and through the service where the payroll network's signed job doors would. Uses TEST_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import { memoryPartyHandles } from '../transfers/party-handles.js';
import { testPartner, testPartnerAccountDetails, type TestPartner } from '../partner/test-partner.js';
import { PayrollSimRefusedError, payrollPartnerFor } from './payroll-sim.js';
import { creditKey, reverseKey, splitKey } from './salary-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 's'.repeat(32);
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SID = '99999999-9999-4999-8999-999999999999';
const EMPLOYER = 'TEST Employer Ltd';
const HOLDER = 'TEST Ada Lovelace';
const DEV = { APP_ENV: 'test', NODE_ENV: 'test' };

describe('salary by direct deposit (J-bank-30)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let partner: TestPartner;
  let bank: BankServices;
  let recordsDir: string;
  let now: Date;

  function make(over: { currencies?: string; payroll?: boolean; reversalDays?: string; minCredit?: string } = {}) {
    const payroll = over.payroll === false ? null : payrollPartnerFor('payroll-sim', partner, DEV, recordsDir);
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      spaceLimit: '5',
      handles: memoryPartyHandles({ [ADA]: 'ada', [BOB]: 'bob' }),
      incomeSorterMinCredit: 'minCredit' in over ? over.minCredit : '1',
      testPartner: partner,
      payrollPartner: payroll,
      directDepositReversalDays: 'reversalDays' in over ? over.reversalDays : '5',
      accountDetails: {
        currencies: 'currencies' in over ? over.currencies : 'EUR,GBP,USD',
        partnerFor: testPartnerAccountDetails(partner),
      },
    });
    // The service reads its clock through the options; the test moves it for the window.
    (bank.salary as unknown as { options: { now?: () => Date } }).options.now = () => now;
  }

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset');
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.salary_split_legs, bank.salary_credits, bank.income_sorter_run_legs, bank.income_sorter_runs,
               bank.income_sorter_legs, bank.income_sorters, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    partner = testPartner();
    recordsDir = mkdtempSync(join(tmpdir(), 'jb30-payroll-'));
    now = new Date();
    make();
    partner.set(ADA, { custody: 'off', accountDetails: 'issued', holderName: HOLDER });
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  function caller(userId: string, scopes = ['bank:read', 'bank:write']) {
    const principal = { sub: userId, userId, sid: SID, scopes, tier: 'full', mfa: true } as Principal;
    const raw = encodePrincipal({ ...principal, expiresAt: new Date(Date.now() + 60_000) } as Principal);
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
    return createBankRouter(bank).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      return (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
    }
    return 'resolved';
  };
  const held = (spaceId: string | null = null) =>
    partner.bank.balance({ userId: ADA, assetId: 'USD', spaceId }).then((b) => formatAmount(b.amount!));
  const send = (networkId: string, amount: string, holderName = HOLDER) =>
    bank.salary.credit({
      networkId,
      accountDetailsId: `test-partner:${ADA}:USD`,
      amount,
      currency: 'USD',
      originatorName: EMPLOYER,
      holderName,
    });
  const savings = async () => {
    const space = await bank.spaces.create({ userId: ADA, assetId: 'USD', name: 'Savings', lockedUntil: null });
    await bank.spaces.ensurePrimary(ADA, 'USD', 'Main');
    return space;
  };
  const split10 = (spaceId: string) =>
    caller(ADA).sorter.create({ sorterId: randomUUID(), assetId: 'USD', legs: [{ spaceId, shareBp: 1000 }] });

  it('#1 refuses the details while the owner lists no currency, and says rail.bank with no payroll network', async () => {
    make({ currencies: '' });
    expect(await codeOf(caller(ADA).salary.details())).toBe('bank.account_details_currencies_unset');
    make({ payroll: false });
    expect(await codeOf(caller(ADA).salary.details())).toBe('rail.bank');
    expect(await codeOf(send('net-none', '10'))).toBe('rail.bank');
  });

  it('#2 shows the TEST details with the holder name, and the employer form with the same details', async () => {
    const details = await caller(ADA).salary.details();
    expect(details).toMatchObject({ partnerBank: 'TEST partner bank', holderName: HOLDER });
    const usd = details.currencies.find((c) => c.currency === 'USD')!;
    expect(usd.sets[0]).toMatchObject({ id: `test-partner:${ADA}:USD`, partnerBank: 'TEST partner bank' });
    const form = await caller(ADA).salary.form({ currency: 'USD' });
    expect(form).toMatchObject({ holderName: HOLDER, accountNumber: usd.sets[0]!.accountNumber, partnerBank: 'TEST partner bank' });
    expect(form.text).toContain(`Account holder: ${HOLDER}`);
    expect(form.text).toContain(`Account number: ${usd.sets[0]!.accountNumber}`);
    partner.set(ADA, { holderName: null });
    expect(await codeOf(caller(ADA).salary.form({ currency: 'USD' }))).toBe('bank.direct_deposit_holder_unknown');
  });

  it('#3 #4 #5 credits once at the partner, splits 10% into Savings once, and a replay posts nothing', async () => {
    const space = await savings();
    await split10(space.id);
    const first = await send('net-1', '2000.00');
    expect(first.replayed).toBe(false);
    expect(first.credit).toMatchObject({ state: 'received', originatorName: EMPLOYER, amount: 2_000n * 10n ** 18n });
    expect(first.credit.legs).toMatchObject([{ status: 'settled', amount: 200n * 10n ** 18n, spaceId: space.id }]);
    expect(await held(null)).toBe('1800');
    expect(await held(space.id)).toBe('200');
    expect((await partner.bank.moveByKey(creditKey('net-1')))!.id).toBe(first.credit.creditMoveId);
    expect((await partner.bank.moveByKey(splitKey('net-1', 0)))!.amount).toBe(200n * 10n ** 18n);

    const again = await send('net-1', '2000.00');
    expect(again.replayed).toBe(true);
    expect(await held(null)).toBe('1800');
    expect(await held(space.id)).toBe('200');
    expect(partner.record(ADA).moves.filter((m) => m.key.startsWith('salary:'))).toHaveLength(2);
    expect(await caller(ADA).salary.credits({ limit: 10 })).toHaveLength(1);
    expect(await codeOf(send('net-1', '2001'))).toBe('bank.direct_deposit_conflict');
    // The ledger posts nothing for money the partner holds.
    expect(ledger.journal()).toHaveLength(0);
  });

  it('#6 returns a credit that names another account holder, crediting nothing', async () => {
    await bank.spaces.ensurePrimary(ADA, 'USD', 'Main');
    const back = await send('net-2', '75', 'TEST Somebody Else');
    expect(back.credit).toMatchObject({ state: 'returned', refusalCode: 'bank.direct_deposit_name_mismatch', creditMoveId: null });
    expect(await held(null)).toBe('0');
    expect(await partner.bank.moveByKey(creditKey('net-2'))).toBeNull();
    // Case and spacing do not make a different name.
    expect((await send('net-3', '5', '  test ada   LOVELACE ')).credit.state).toBe('received');
  });

  it('#7 reverses inside the window: split legs come back first, then the whole credit leaves once', async () => {
    const space = await savings();
    await split10(space.id);
    await send('net-4', '2000');
    const reversed = await bank.salary.reverse('net-4');
    expect(reversed).toMatchObject({ state: 'reversed' });
    expect(reversed.legs[0]).toMatchObject({ status: 'unsplit' });
    expect(await held(null)).toBe('0');
    expect(await held(space.id)).toBe('0');
    expect((await partner.bank.moveByKey(reverseKey('net-4')))!.amount).toBe(2_000n * 10n ** 18n);
    // Asked again, the same reversal: nothing more moves.
    expect((await bank.salary.reverse('net-4')).reversalMoveId).toBe(reversed.reversalMoveId);
    expect(partner.record(ADA).moves.filter((m) => m.key === reverseKey('net-4'))).toHaveLength(1);
  });

  it('#7 refuses a reversal the account cannot pay, outside the window, unpublished, or of a returned credit', async () => {
    await bank.spaces.ensurePrimary(ADA, 'USD', 'Main');
    await send('net-5', '500');
    await partner.bank.move({
      key: 'test:spend',
      from: { userId: ADA, assetId: 'USD', spaceId: null },
      to: { userId: 'partner:test-merchant', assetId: 'USD', spaceId: null },
      amount: 400n * 10n ** 18n,
    });
    expect(await codeOf(bank.salary.reverse('net-5'))).toBe('bank.direct_deposit_reversal_insufficient');
    expect(await held(null)).toBe('100');

    await send('net-6', '50');
    now = new Date(Date.now() + 6 * 86_400_000);
    expect(await codeOf(bank.salary.reverse('net-6'))).toBe('bank.direct_deposit_reversal_window');
    make({ reversalDays: '' });
    (bank.salary as unknown as { options: { now?: () => Date } }).options.now = () => new Date();
    expect(await codeOf(bank.salary.reverse('net-6'))).toBe('bank.direct_deposit_reversal_window_unset');

    await send('net-7', '5', 'TEST Nobody');
    make();
    expect(await codeOf(bank.salary.reverse('net-7'))).toBe('bank.direct_deposit_not_received');
    expect(await codeOf(bank.salary.reverse('net-unknown'))).toBe('bank.direct_deposit_not_found');
  });

  it('#8 the rail desk reads matches: the network credits minus reversals equal what the app showed', async () => {
    await bank.spaces.ensurePrimary(ADA, 'USD', 'Main');
    await send('net-8', '2000');
    await send('net-9', '500');
    await send('net-10', '9', 'TEST Nobody');
    await bank.salary.reverse('net-9');
    const ops = caller(ADA, ['admin:read']).ops.salaryRails();
    const desk = await ops;
    expect(desk.partner!.lines).toEqual([
      {
        currency: 'USD',
        network: { credits: '2500', reversals: '500' },
        app: { credits: '2500', reversals: '500' },
        matches: true,
        difference: '0',
      },
    ]);
    // A row the network never carried is a difference, named.
    await sql`
      INSERT INTO bank.salary_credits (network_id, user_id, account_details_id, asset_id, amount, originator_name, holder_name, state, credit_move_id, received_at)
      VALUES ('net-ghost', ${ADA}, 'x', 'USD', 7, ${EMPLOYER}, ${HOLDER}, 'received', 'ghost', now())
    `;
    expect((await caller(ADA, ['admin:read']).ops.salaryRails()).partner!.lines[0]).toMatchObject({ matches: false, difference: '-7' });
    rmSync(recordsDir, { recursive: true, force: true });
  });

  it('refuses a credit to details nobody holds, or to a person whose money is not at the partner', async () => {
    expect(
      await codeOf(
        bank.salary.credit({
          networkId: 'net-x',
          accountDetailsId: `test-partner:${BOB}:USD`,
          amount: '1',
          currency: 'USD',
          originatorName: EMPLOYER,
          holderName: HOLDER,
        }),
      ),
    ).toBe('bank.direct_deposit_details_unknown');
    partner.set(ADA, { custody: 'on' });
    expect(await codeOf(send('net-y', '1'))).toBe('bank.partner_unset');
    expect(await sql`SELECT 1 FROM bank.salary_credits`).toHaveLength(0);
  });

  it('refuses to start payroll-sim outside dev/test or without the TEST partner', () => {
    expect(() => payrollPartnerFor('payroll-sim', partner, { APP_ENV: 'production' })).toThrow(PayrollSimRefusedError);
    expect(() => payrollPartnerFor('payroll-sim', null, DEV)).toThrow(PayrollSimRefusedError);
    expect(() => payrollPartnerFor('none', partner, DEV, 'relative/dir')).toThrow(PayrollSimRefusedError);
    expect(payrollPartnerFor('none', partner, DEV)).toBeNull();
  });
});
