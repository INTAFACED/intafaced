/**
 * J-bank-23 through the real router (BK-bexp-03, BK-bexp-04, BK-bexp-05): a business keeps its books in order over the
 * TEST partner bank's record of its account. Connecting accounting software is switched off (`vendor.accounting`) and the
 * record is kept; the bank feed by file has every line. A coding rule's test run lists its matches and codes nothing; saved,
 * it codes them and each new matching line; a person codes in bulk and a rule never overwrites them. Each of the four
 * statement formats carries the partner statement's closing balance and line count and every line's id; the history window
 * and strong customer authentication refuse by name; a partner statement that disagrees gives no file. The ledger posts
 * nothing. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import { testPartner, type TestPartner } from '../partner/test-partner.js';
import { memoryBusinessDirectory, type DirectoryPerson } from './business-directory.js';

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
const MEMBER = id(2);
const PEOPLE: DirectoryPerson[] = [
  [OWNER, 'owner'],
  [MEMBER, 'member'],
].map(([userId, handle]) => ({ userId: userId!, handle: handle!, email: `${handle}@example.test`, status: 'active' as const }));

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

describe('business books (J-bank-23)', () => {
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
      TRUNCATE bank.business_line_codes, bank.business_coding_rules, bank.business_accounting_connections,
               bank.business_card_purchases, bank.business_cards, bank.business_card_limit_requests,
               bank.business_invites, bank.business_members, bank.business_accounts, bank.spaces
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

  const monthStart = () => new Date(new Date().toISOString().slice(0, 7) + '-01T00:00:00.000Z');
  const period = () => ({ from: monthStart().toISOString(), to: new Date(Date.now() + 60_000).toISOString() });

  /** The owner's EUR business with TEST 1000 at the partner, a viewer on the team, and a month of TEST card activity. */
  async function business() {
    const owner = as(OWNER);
    await owner.testPartner.set({ custody: 'off' });
    const accountId = randomUUID();
    await owner.business.create({ accountId, name: 'TEST Books Ltd', assetId: 'EUR', spendThreshold: '500' });
    await owner.testPartner.fundBusiness({ accountId, fundId: `fund-${accountId}`, amount: '1000' });
    const made = await owner.businessTeam.invite({ accountId, inviteId: randomUUID(), email: null, role: 'viewer' as never, roleId: null });
    await as(MEMBER).businessTeam.acceptInvite({ token: made.token! });
    const card = await owner.businessCards.issueCard({ accountId, cardId: randomUUID(), memberUserId: OWNER, perPurchaseLimit: '500' });
    const buy = (merchant: string, amount: string) =>
      owner.businessCards.testPurchase({ cardId: card.id, purchaseId: randomUUID(), merchant, amount });
    for (const [m, a] of [
      ['TESTSHOP Berlin', '12.50'],
      ['Other Cafe', '4.20'],
      ['TESTSHOP Online', '30'],
      ['testshop kiosk', '7.30'],
    ] as const) {
      await buy(m, a);
    }
    return { accountId, owner, member: as(MEMBER), buy };
  }

  it('#1 connecting accounting is switched off and its record kept; the bank feed by file has every line', async () => {
    const { accountId, owner, member } = await business();
    expect((await owner.businessBooks.overview({ accountId })).connection).toBeNull();
    const first = await owner.businessBooks.connectAccounting({ accountId });
    expect(first).toMatchObject({ status: 'switched_off', needs: 'vendor.accounting', requestedBy: OWNER, attempts: 1 });
    expect((await owner.businessBooks.connectAccounting({ accountId })).attempts).toBe(2);
    expect((await owner.businessBooks.overview({ accountId })).connection).toMatchObject({ status: 'switched_off', attempts: 2 });
    expect(await refused(member.businessBooks.connectAccounting({ accountId }))).toBe('bank.business_role_forbidden');

    const feed = await owner.businessBooks.exportStatement({ accountId, ...period(), format: 'csv', exportId: randomUUID() });
    const csv = Buffer.from(feed.bodyBase64, 'base64').toString('utf8');
    const lines = (await owner.businessBooks.lines({ accountId, ...period() })).items;
    expect(lines).toHaveLength(5); // the pay-in and four purchases
    for (const l of lines) expect(csv).toContain(l.id);
    expect(ledger.journal()).toEqual([]);
  });

  it('#2 a rule’s test run shows its 3 matches and codes nothing; saved, it codes them and a new matching line; bulk coding and GL codes', async () => {
    const { accountId, owner, member, buy } = await business();
    const tried = await owner.businessBooks.testRule({ accountId, ...period(), payeeContains: 'TESTSHOP' });
    expect(tried.matches.map((l) => l.payee).sort()).toEqual(['TESTSHOP Berlin', 'TESTSHOP Online', 'testshop kiosk']);
    expect((await sql`SELECT 1 FROM bank.business_line_codes`).length).toBe(0);
    expect(await refused(member.businessBooks.testRule({ accountId, ...period(), payeeContains: 'TESTSHOP' }))).toBe(
      'bank.business_role_forbidden',
    );

    const ruleId = randomUUID();
    await owner.businessBooks.saveRule({ accountId, ruleId, payeeContains: 'TESTSHOP', category: 'Supplies', glCode: '6100' });
    expect(await refused(owner.businessBooks.saveRule({ accountId, ruleId, payeeContains: 'TESTSHOP', category: 'Travel' }))).toBe(
      'bank.business_request_conflict',
    );
    let lines = (await owner.businessBooks.lines({ accountId, ...period() })).items;
    expect(lines.filter((l) => l.category === 'Supplies' && l.codedBy === 'rule' && l.glCode === '6100')).toHaveLength(3);

    // A new matching line is coded as it arrives.
    await buy('TESTSHOP Airport', '9.99');
    lines = (await owner.businessBooks.lines({ accountId, ...period() })).items;
    expect(lines.find((l) => l.payee === 'TESTSHOP Airport')).toMatchObject({ category: 'Supplies', codedBy: 'rule', ruleId });

    // Bulk: the pay-in and the cafe line at once, with a GL code; a person's code stands over a rule's.
    const payIn = lines.find((l) => l.payee === 'Pay-in')!;
    const cafe = lines.find((l) => l.payee === 'Other Cafe')!;
    const berlin = lines.find((l) => l.payee === 'TESTSHOP Berlin')!;
    const coded = await owner.businessBooks.codeLines({
      accountId,
      ...period(),
      lineIds: [payIn.id, cafe.id, berlin.id],
      category: 'Office',
      glCode: '6200',
    });
    expect(coded.items.map((l) => [l.category, l.glCode, l.codedBy])).toEqual([
      ['Office', '6200', 'person'],
      ['Office', '6200', 'person'],
      ['Office', '6200', 'person'],
    ]);
    lines = (await owner.businessBooks.lines({ accountId, ...period() })).items;
    expect(lines.find((l) => l.id === berlin.id)).toMatchObject({ category: 'Office', codedBy: 'person' });
    expect(
      await refused(owner.businessBooks.codeLines({ accountId, ...period(), lineIds: ['test-partner-move-nope'], category: 'X' })),
    ).toBe('bank.business_line_not_found');
    expect(await refused(owner.businessBooks.codeLines({ accountId, ...period(), lineIds: [cafe.id] }))).toBe(
      'bank.business_books_field_invalid',
    );
    expect(ledger.journal()).toEqual([]);
  });

  it('#3 four formats carry the partner statement’s closing balance and line count and each line id; window and SCA refuse', async () => {
    const { accountId, owner, member } = await business();
    const p = period();
    const theirs = await partner.bank.statement!(
      { userId: `business:${accountId}`, assetId: 'EUR', spaceId: null },
      { from: new Date(p.from), to: new Date(p.to) },
    );
    expect(theirs).toMatchObject({ opening: 0n, closing: parseAmount('946'), lines: 5 });
    const ids = (await owner.businessBooks.lines({ accountId, ...p })).items.map((l) => l.id);
    const text = async (format: 'csv' | 'mt940' | 'camt053' | 'qif') => {
      const f = await owner.businessBooks.exportStatement({ accountId, ...p, format, exportId: randomUUID() });
      expect(f).toMatchObject({ closing: '946', lineCount: 5, partner: { closing: '946', lines: 5 } });
      const body = Buffer.from(f.bodyBase64, 'base64').toString('utf8');
      for (const id of ids) expect(body).toContain(id);
      return body;
    };
    const csv = await text('csv');
    expect(csv).toContain('Closing balance,946');
    expect(csv).toContain('Line count,5');
    const mt = await text('mt940');
    expect(mt).toMatch(/:62F:C\d{6}EUR946,\r?$/m);
    expect(mt.match(/^:61:/gm)).toHaveLength(5);
    const camt = await text('camt053');
    expect(camt).toMatch(/<Cd>CLBD<\/Cd><\/CdOrPrtry><\/Tp><Amt Ccy="EUR">946<\/Amt><CdtDbtInd>CRDT<\/CdtDbtInd>/);
    expect(camt).toContain('<NbOfNtries>5</NbOfNtries>');
    const qif = await text('qif');
    const amounts = [...qif.matchAll(/^T(-?[\d.]+)$/gm)].map(
      (m) => parseAmount(m[1]!.replace(/^-/, '')) * (m[1]!.startsWith('-') ? -1n : 1n),
    );
    expect(amounts.slice(1)).toHaveLength(5);
    expect(amounts.reduce((t, a) => t + a, 0n)).toBe(parseAmount('946'));

    // A viewer exports nothing.
    expect(await refused(member.businessBooks.exportStatement({ accountId, ...p, format: 'csv', exportId: randomUUID() }))).toBe(
      'bank.business_role_forbidden',
    );
    // The history window: 400 days at the TEST partner.
    const day = 24 * 60 * 60 * 1000;
    const old = { from: new Date(Date.now() - 500 * day).toISOString(), to: new Date(Date.now() - 480 * day).toISOString() };
    expect(await refused(owner.businessBooks.exportStatement({ accountId, ...old, format: 'csv', exportId: randomUUID() }))).toBe(
      'bank.statement_history_window',
    );
    // Further back than 90 days needs a fresh strong customer authentication; this router has none wired, so it fails closed.
    const back = { from: new Date(Date.now() - 100 * day).toISOString(), to: p.to };
    expect(await refused(owner.businessBooks.exportStatement({ accountId, ...back, format: 'csv', exportId: randomUUID() }))).toBe(
      'bank.step_up_required',
    );
    expect(
      await refused(
        owner.businessBooks.exportStatement({ accountId, ...back, format: 'csv', exportId: randomUUID(), stepUpApprovalId: 'appr-1' }),
      ),
    ).toBe('bank.step_up_unavailable');

    // A partner statement that disagrees with its record gives no file.
    const real = partner.bank.statement!;
    (partner.bank as { statement: typeof real }).statement = async (account, range) => ({ ...(await real(account, range)), lines: 4 });
    expect(await refused(owner.businessBooks.exportStatement({ accountId, ...p, format: 'qif', exportId: randomUUID() }))).toBe(
      'bank.statement_mismatch',
    );
    expect(ledger.journal()).toEqual([]);
  });
});
