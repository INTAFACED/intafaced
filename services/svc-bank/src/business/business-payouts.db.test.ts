/**
 * J-bank-21 through the real router (BK-bpay-01, BK-bpay-02, RC-bank-05): a business pays its team and contractors in
 * bulk from its account at the TEST partner bank. A CSV's invalid lines are its validation report and send nothing, and
 * nothing is held at import; a run is one partner instruction under its run key, sent once, even when the partner's
 * answer is lost; a second run cannot reuse or blank the key; at or above the business's threshold it needs a different
 * approver; an unfunded run sends nothing. A contractor batch writes its intent row first, follows the approval rules and
 * is one payout instruction, or with no partner rail is kept refused with `rail.bank`. Crypto payroll runs are signed by
 * the business's own wallet only. The ledger posts nothing. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import { partnerPayoutsAccount } from '../partner/partner-bank.js';
import { testPartner, type TestPartner } from '../partner/test-partner.js';
import { memoryBusinessDirectory, type DirectoryPerson } from './business-directory.js';
import { bulkPayKey, contractorBatchKey, cryptoPayrollKey, parseBulkCsv } from './business-payouts.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const SID = '99999999-9999-4999-8999-999999999999';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER = id(1);
const A1 = id(4);
const CONTRACTOR = id(8);
const PEOPLE: DirectoryPerson[] = [
  [OWNER, 'owner'],
  [A1, 'approver1'],
  [CONTRACTOR, 'contractor'],
].map(([userId, handle]) => ({ userId: userId!, handle: handle!, email: `${handle}@example.test`, status: 'active' as const }));

const IBANS = ['DE89370400440532013000', 'GB82WEST12345698765432', 'NL91ABNA0417164300'];
const CSV = [
  'name,iban,amount,currency,reference',
  `TEST Ana,${IBANS[0]},100.00,USDT,Nov`,
  `TEST Ben,${IBANS[1]},150.50,USDT,Nov`,
  `TEST Cy,${IBANS[2]},49.50,USDT,Nov`,
  `TEST Dee,FR1420041010050500013M02606,12.3.4,USDT,Nov`,
  `TEST Ana,${IBANS[0]},100.00,USDT,Nov`,
].join('\n');

/** A TEST wallet key, public and made for this test only, and its address. */
const KEY = keccak_256(new TextEncoder().encode('TEST J-bank-21 business wallet'));
const OTHER_KEY = keccak_256(new TextEncoder().encode('TEST J-bank-21 someone else'));
function addressOf(key: Uint8Array): string {
  const pub = secp256k1.getPublicKey(key, false);
  return `0x${Buffer.from(keccak_256(pub.subarray(1)).subarray(-20)).toString('hex')}`;
}
/** What a wallet's `personal_sign` returns: the EIP-191 digest signed, `r || s || v` with v 27/28. */
function personalSign(message: string, key: Uint8Array): string {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  const sig = secp256k1.sign(keccak_256(joined), key, { prehash: false, format: 'recovered' });
  // The library puts the recovery bit first.
  return `0x${Buffer.from(sig.subarray(1)).toString('hex')}${(27 + sig[0]!).toString(16)}`;
}

function principal(userId: string): Principal {
  return {
    sub: userId,
    userId,
    sid: SID,
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

const codeOf = (err: unknown) => (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
async function refused(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return codeOf(err);
  }
  throw new Error('expected a refusal');
}

describe('business bulk payments, contractors and crypto payroll (J-bank-21)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let partner: TestPartner;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.business_crypto_payslips, bank.business_crypto_payroll_runs, bank.business_crypto_payroll_members,
               bank.business_crypto_payrolls, bank.business_payroll_wallets, bank.business_payroll_wallet_offers,
               bank.business_contractor_invites, bank.business_contractor_batch_approvals, bank.business_contractor_batch_lines,
               bank.business_contractor_batches, bank.business_contractor_invoices, bank.business_contractors,
               bank.business_bulk_approvals, bank.business_bulk_issues, bank.business_bulk_lines, bank.business_bulk_runs,
               bank.business_payment_approvals, bank.business_payments, bank.business_payment_rules, bank.business_invites,
               bank.business_advisors, bank.business_members, bank.business_custom_roles, bank.business_departments,
               bank.business_accounts, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    partner = testPartner();
  });

  function as(userId: string) {
    const raw = encodePrincipal(principal(userId));
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
    return createBankRouter(
      createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        nativeAssetId: 'IFC',
        recipients: memoryRecipientState(),
        testPartner: partner,
        postingFreeze: { postingEnabled: async () => true },
        directory: memoryBusinessDirectory(PEOPLE),
        businessInviteMinutes: '2',
      }),
    ).createCaller(
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

  /** The owner's business, its money at the TEST partner (TEST `funded` USDT), threshold 500, an approver on the team. */
  async function business(funded = '1000', atPartner = true) {
    const owner = as(OWNER);
    if (atPartner) await owner.testPartner.set({ custody: 'off' });
    const accountId = randomUUID();
    await owner.business.create({ accountId, name: 'TEST Payroll Ltd', assetId: 'USDT', spendThreshold: '500' });
    if (atPartner) await owner.testPartner.fundBusiness({ accountId, fundId: `fund-${accountId}`, amount: funded });
    const made = await owner.businessTeam.invite({
      accountId,
      inviteId: randomUUID(),
      email: null,
      role: 'checker' as never,
      roleId: null,
    });
    await as(A1).businessTeam.acceptInvite({ token: made.token! });
    return { accountId, owner };
  }

  const BUSINESS = (accountId: string) => ({ userId: `business:${accountId}`, assetId: 'USDT', spaceId: null });
  const held = async (accountId: string) => (await partner.bank.balance(BUSINESS(accountId))).amount;
  const moves = (accountId: string) => partner.bank.moves(`business:${accountId}`, { limit: 50 });

  it('the CSV: three good lines, a bad amount and a duplicate give exactly two issues; a line in another asset is refused', () => {
    const { lines, issues } = parseBulkCsv(CSV, 'USDT');
    expect(lines.map((l) => l.line)).toEqual([1, 2, 3]);
    expect(issues.map((i) => [i.line, i.code])).toEqual([
      [4, 'amount_invalid'],
      [5, 'duplicate_line'],
    ]);
    const other = parseBulkCsv(`name,iban,amount,currency\nTEST Ana,${IBANS[0]},10,EUR`, 'USDT');
    expect(other.lines).toEqual([]);
    expect(other.issues.map((i) => i.code)).toEqual(['asset_mismatch']);
    expect(() => parseBulkCsv('who,what\nx,y', 'USDT')).toThrow(/columns/);
  });

  it('#1 importing holds nothing and moves nothing; #2 under the threshold it is one instruction, sent once', async () => {
    const { accountId, owner } = await business();
    const runId = randomUUID();
    const run = await owner.businessPayouts.importRun({ accountId, runId, csv: CSV });
    expect(run.status).toBe('draft');
    expect(run.total).toBe('300');
    expect(run.issues.map((i) => i.code)).toEqual(['amount_invalid', 'duplicate_line']);
    expect(await held(accountId)).toBe(parseAmount('1000'));
    expect(await moves(accountId)).toEqual([]);

    const sent = await owner.businessPayouts.confirmRun({ runId });
    expect(sent.status).toBe('sent');
    expect(sent.partnerKey).toBe(bulkPayKey(runId));
    expect(await held(accountId)).toBe(parseAmount('700'));
    // Confirmed again: the same run, still one instruction.
    expect((await owner.businessPayouts.confirmRun({ runId })).status).toBe('sent');
    const out = (await moves(accountId)).filter((m) => m.key === bulkPayKey(runId));
    expect(out).toHaveLength(1);
    expect(out[0]!.amount).toBe(parseAmount('300'));
    // The one instruction carries every valid line as its recipients, and nothing from the report.
    expect(out[0]!.payees?.map((p) => [p.name, p.iban, p.amount, p.reference])).toEqual([
      ['TEST Ana', IBANS[0], parseAmount('100'), 'Nov'],
      ['TEST Ben', IBANS[1], parseAmount('150.5'), 'Nov'],
      ['TEST Cy', IBANS[2], parseAmount('49.5'), 'Nov'],
    ]);
    expect(sent.partnerPayees).toBe(3);
    expect(ledger.journal()).toEqual([]);
  });

  it('the partner refuses an instruction whose recipients do not add up to it, and moves nothing', async () => {
    const { accountId } = await business();
    const from = BUSINESS(accountId);
    const key = `bank.business.bulk-pay:${randomUUID()}`;
    const payee = { name: 'TEST Ana', iban: IBANS[0]!, reference: null };
    const to = partnerPayoutsAccount('USDT');
    await expect(
      partner.bank.move({ key, from, to, amount: parseAmount('300'), payees: [{ ...payee, amount: parseAmount('100') }] }),
    ).rejects.toMatchObject({ code: 'bank.partner_amount_invalid' });
    await expect(partner.bank.move({ key, from, to, amount: parseAmount('300'), payees: [] })).rejects.toMatchObject({
      code: 'bank.partner_amount_invalid',
    });
    expect(await moves(accountId)).toEqual([]);
  });

  it('a second run cannot reuse or blank the run key', async () => {
    const { accountId, owner } = await business();
    const runId = randomUUID();
    await owner.businessPayouts.importRun({ accountId, runId, csv: CSV });
    expect(await refused(owner.businessPayouts.importRun({ accountId, runId, csv: `${CSV}\n` }))).toBe('bank.business_request_conflict');
    expect(await refused(owner.businessPayouts.importRun({ accountId, runId: '', csv: CSV }))).toBe('BAD_REQUEST');
    expect((await owner.businessPayouts.importRun({ accountId, runId, csv: CSV })).id).toBe(runId);
  });

  it('#2 at or above the threshold it waits for a different approver, then sends once', async () => {
    const { accountId, owner } = await business();
    const csv = `name,iban,amount,currency\nTEST Ana,${IBANS[0]},300,USDT\nTEST Ben,${IBANS[1]},200,USDT`;
    const runId = randomUUID();
    await owner.businessPayouts.importRun({ accountId, runId, csv });
    const waiting = await owner.businessPayouts.confirmRun({ runId });
    expect(waiting.status).toBe('awaiting_approval');
    expect(waiting.threshold).toBe('500');
    expect(await held(accountId)).toBe(parseAmount('1000'));
    expect(await refused(owner.businessPayouts.approveRun({ runId }))).toBe('bank.business_self_approve');
    const sent = await as(A1).businessPayouts.approveRun({ runId });
    expect(sent.status).toBe('sent');
    expect(await held(accountId)).toBe(parseAmount('500'));
    expect((await moves(accountId)).filter((m) => m.key === bulkPayKey(runId))).toHaveLength(1);
    expect(ledger.journal()).toEqual([]);
  });

  it('an unfunded run sends nothing and stays a draft; a lost answer is read back by its key and paid once', async () => {
    const { accountId, owner } = await business('100');
    const runId = randomUUID();
    await owner.businessPayouts.importRun({ accountId, runId, csv: CSV });
    expect(await refused(owner.businessPayouts.confirmRun({ runId }))).toBe('bank.bulk_run_unfunded');
    expect((await owner.businessPayouts.run({ runId })).status).toBe('draft');
    await owner.testPartner.fundBusiness({ accountId, fundId: `top-${accountId}`, amount: '900' });
    partner.set(`business:${accountId}`, { nextReply: 'lost' });
    expect(await refused(owner.businessPayouts.confirmRun({ runId }))).toBe('bank.partner_reply_lost');
    expect((await owner.businessPayouts.run({ runId })).status).toBe('sending');
    expect((await owner.businessPayouts.confirmRun({ runId })).status).toBe('sent');
    expect((await moves(accountId)).filter((m) => m.key === bulkPayKey(runId))).toHaveLength(1);
    expect(await held(accountId)).toBe(parseAmount('700'));
  });

  it('#3 #4 a contractor with an invoice of 500, paid as a batch under the approval rules, once', async () => {
    const { accountId, owner } = await business();
    await owner.businessTeam.addRule({ accountId, ruleId: randomUUID(), overAmount: '100', payee: null, paymentType: null, approvals: 1 });
    const contractorId = randomUUID();
    await owner.businessPayouts.addContractor({
      accountId,
      contractorId,
      name: 'TEST Dev Co',
      email: null,
      iban: IBANS[0]!,
      walletAddress: null,
    });
    const c = await owner.businessPayouts.addInvoice({
      contractorId,
      invoiceId: randomUUID(),
      number: 'TEST-INV-1',
      amount: '500.00',
      dueDate: null,
    });
    expect(c.invoices.map((i) => [i.number, i.amount, i.status])).toEqual([['TEST-INV-1', '500', 'open']]);
    expect(c.ibanLast4).toBe('3000');
    const batchId = randomUUID();
    const waiting = await owner.businessPayouts.payBatch({ accountId, batchId, invoiceIds: [c.invoices[0]!.id] });
    expect(waiting.status).toBe('awaiting_approval');
    expect(waiting.partnerKey).toBe(contractorBatchKey(batchId));
    expect(await held(accountId)).toBe(parseAmount('1000'));
    expect(await refused(owner.businessPayouts.approveBatch({ batchId }))).toBe('bank.business_self_approve');
    expect(await refused(owner.businessPayouts.payBatch({ accountId, batchId: randomUUID(), invoiceIds: [c.invoices[0]!.id] }))).toBe(
      'bank.contractor_invoice_not_open',
    );
    const sent = await as(A1).businessPayouts.approveBatch({ batchId });
    expect(sent.status).toBe('sent');
    expect(await held(accountId)).toBe(parseAmount('500'));
    const batchOut = (await moves(accountId)).filter((m) => m.key === contractorBatchKey(batchId));
    expect(batchOut).toHaveLength(1);
    expect(batchOut[0]!.payees?.map((p) => [p.name, p.iban, p.amount, p.reference])).toEqual([
      ['TEST Dev Co', IBANS[0], parseAmount('500'), 'TEST-INV-1'],
    ]);
    expect(sent.partnerPayees).toBe(1);
    expect((await owner.businessPayouts.contractors({ accountId }))[0]!.invoices[0]!.status).toBe('paid');
    expect(ledger.journal()).toEqual([]);
  });

  it('#4 with no partner payout rail the intent is kept, refused with rail.bank, and nothing moves', async () => {
    const { accountId, owner } = await business('0', false);
    const contractorId = randomUUID();
    await owner.businessPayouts.addContractor({
      accountId,
      contractorId,
      name: 'TEST Dev Co',
      email: null,
      iban: IBANS[1]!,
      walletAddress: null,
    });
    const c = await owner.businessPayouts.addInvoice({
      contractorId,
      invoiceId: randomUUID(),
      number: 'TEST-INV-2',
      amount: '500',
      dueDate: null,
    });
    const batch = await owner.businessPayouts.payBatch({ accountId, batchId: randomUUID(), invoiceIds: [c.invoices[0]!.id] });
    expect(batch.status).toBe('refused');
    expect(batch.refusalCode).toBe('rail.bank');
    expect((await owner.businessPayouts.contractors({ accountId }))[0]!.invoices[0]!.status).toBe('open');
    expect(ledger.journal()).toEqual([]);
  });

  it('#5 contractor self-onboarding once; each crypto payroll run is signed by the business’s own wallet only', async () => {
    const { accountId, owner } = await business();
    const invite = await owner.businessPayouts.createInvite({ accountId });
    expect(await as(CONTRACTOR).businessPayouts.inviteInfo({ token: invite.token })).toEqual({
      businessName: 'TEST Payroll Ltd',
      open: true,
    });
    const wallet = addressOf(OTHER_KEY);
    const joined = await as(CONTRACTOR).businessPayouts.joinAsContractor({
      token: invite.token,
      name: 'TEST Remote Dev',
      email: null,
      iban: null,
      walletAddress: wallet,
    });
    expect(
      await refused(
        as(A1).businessPayouts.joinAsContractor({ token: invite.token, name: 'x', email: null, iban: null, walletAddress: wallet }),
      ),
    ).toBe('bank.contractor_invite_used');
    const payrollId = randomUUID();
    const members = [{ contractorId: joined.contractorId, amount: '250' }];
    expect(
      await refused(owner.businessPayouts.createPayroll({ accountId, payrollId, name: 'TEST Monthly', dayOfMonth: 25, members })),
    ).toBe('bank.payroll_wallet_missing');
    const address = addressOf(KEY);
    const offer = await owner.businessPayouts.walletOffer({ accountId, address });
    expect(
      await refused(owner.businessPayouts.connectWallet({ offerId: offer.offerId, signature: personalSign(offer.message, OTHER_KEY) })),
    ).toBe('bank.payroll_signature_invalid');
    expect(
      (await owner.businessPayouts.connectWallet({ offerId: offer.offerId, signature: personalSign(offer.message, KEY) })).address,
    ).toBe(address);
    await owner.businessPayouts.createPayroll({ accountId, payrollId, name: 'TEST Monthly', dayOfMonth: 25, members });
    const prepared = await owner.businessPayouts.prepareRun({ payrollId, period: '2026-12' });
    const run = prepared.runs[0]!;
    expect(run.runKey).toBe(cryptoPayrollKey(payrollId, '2026-12'));
    expect(run.payslips.map((p) => [p.name, p.amount, p.walletAddress])).toEqual([['TEST Remote Dev', '250', wallet]]);
    expect((await owner.businessPayouts.prepareRun({ payrollId, period: '2026-12' })).runs).toHaveLength(1);
    expect(await refused(owner.businessPayouts.signRun({ runId: run.id, signature: personalSign(run.message, OTHER_KEY) }))).toBe(
      'bank.payroll_signature_invalid',
    );
    const signed = await owner.businessPayouts.signRun({ runId: run.id, signature: personalSign(run.message, KEY) });
    expect(signed.runs[0]!.status).toBe('signed');
    expect(signed.runs[0]!.walletAddress).toBe(address);

    // The business replaces its wallet: a run prepared for the old one is no longer signed by it.
    const later = (await owner.businessPayouts.prepareRun({ payrollId, period: '2027-01' })).runs.find((r) => r.period === '2027-01')!;
    const next = await owner.businessPayouts.walletOffer({ accountId, address: addressOf(OTHER_KEY) });
    await owner.businessPayouts.connectWallet({ offerId: next.offerId, signature: personalSign(next.message, OTHER_KEY) });
    expect(await refused(owner.businessPayouts.signRun({ runId: later.id, signature: personalSign(later.message, KEY) }))).toBe(
      'bank.payroll_wallet_missing',
    );
    // INTAFACED holds none of it: the partner balance and the ledger are untouched.
    expect(await held(accountId)).toBe(parseAmount('1000'));
    expect(ledger.journal()).toEqual([]);
  });
});
