/**
 * Send to a bank account over a bank rail (BK-xfer-02, J-bank-04 #1) through the mounted router: each rail's own form,
 * the step-up scope, and the intent kept refused with `rail.bank`, nothing held or posted. Funds are TEST deposits on a
 * MemoryLedger. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';

const SECRET = 'bank-rail-sends-edge-secret-long-enough';
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const STEPPED = ['bank:read', 'bank:write', 'trade:withdraw'];
const PLAIN = ['bank:read', 'bank:write'];
const errorOf = (err: unknown) => ({
  code: (err as { code?: string }).code,
  bank: (err as { cause?: { code?: string } }).cause?.code,
});

// TEST recipients: a routing number with a valid check digit, the IBAN registry's German example.
const ACH = { holderName: 'Ada TEST', routingNumber: '021000021', accountNumber: '000123456789', accountType: 'checking' };
const SEPA = { holderName: 'Ada TEST', iban: 'DE89 3704 0044 0532 0130 00', transferType: 'standard' };

describe('send to a bank account over a bank rail (J-bank-04 #1)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let space: string;
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

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

  let cooling: string | undefined = '24';
  const services = () => createBankServices(sql, ledger, memoryLedgerHistory(ledger), { payeeCoolingHours: cooling ?? '' });

  beforeEach(async () => {
    await sql`TRUNCATE bank.rail_send_intents, bank.rail_payees, bank.spaces CASCADE`;
    cooling = '24';
    ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({ userId: ADA, assetId: 'USDT', amount: parseAmount('50'), rail: 'test', railRef: 'rail-send-fund-ada' }),
    );
    space = (await services().spaces.ensurePrimary(ADA, 'USDT')).id;
  });

  function as(userId: string, scopes = STEPPED) {
    const raw = encodePrincipal({
      sub: userId,
      userId,
      sid: randomUUID(),
      scopes,
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal);
    return createBankRouter(services()).createCaller(
      edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  const refused = async (call: Promise<unknown>) => {
    try {
      await call;
    } catch (err) {
      return errorOf(err);
    }
    throw new Error('expected a refusal');
  };
  const nothingMoved = async () => {
    expect(ledger.journal()).toHaveLength(1);
    expect((await ledger.balance(userAvailable(ADA, 'USDT'))).amount).toBe(parseAmount('50'));
  };
  // An `undefined` in `over` leaves that key out, so a send to a saved recipient carries no rail or recipient.
  const send = (over: Record<string, unknown> = {}, userId = ADA, scopes = STEPPED) =>
    as(userId, scopes).railSends.send(
      Object.fromEntries(
        Object.entries({ requestId: randomUUID(), fromSpaceId: space, amount: '20', rail: 'ach', recipient: ACH, ...over }).filter(
          ([, value]) => value !== undefined,
        ),
      ) as Parameters<ReturnType<typeof as>['railSends']['send']>[0],
    );

  it('lists the five rails, each with its own form, and no partner on any of them', async () => {
    const { rails } = await as(ADA, PLAIN).railSends.requirements();
    expect(rails.map((row) => row.rail)).toEqual(['ach', 'wire', 'instant', 'sepa', 'proxy']);
    expect(rails.every((row) => row.partner === null && row.blocker === 'rail.bank')).toBe(true);
    const names = Object.fromEntries(rails.map((row) => [row.rail, row.fields.map((field) => field.name)]));
    expect(names).toEqual({
      ach: ['holderName', 'routingNumber', 'accountNumber', 'accountType'],
      wire: ['holderName', 'routingNumber', 'accountNumber', 'bankName'],
      instant: ['holderName', 'routingNumber', 'accountNumber'],
      sepa: ['holderName', 'iban', 'bic', 'transferType'],
      proxy: ['aliasType', 'alias'],
    });
    expect(rails.find((row) => row.rail === 'sepa')!.fields.find((field) => field.name === 'bic')!.required).toBe(false);
  });

  it('keeps the send refused with rail.bank, masked, nothing held or posted; the same id is the same intent', async () => {
    const requestId = randomUUID();
    const first = await send({ requestId });
    expect(first).toMatchObject({
      requestId,
      fromSpaceId: space,
      assetId: 'USDT',
      amount: '20',
      rail: 'ach',
      recipient: 'Ada TEST · …6789',
      status: 'refused',
      refusalCode: 'rail.bank',
    });
    // Spacing, case and key order do not change the ask.
    const reordered = { accountType: 'checking', accountNumber: '0001 2345 6789', routingNumber: '0210-00021', holderName: ' Ada TEST ' };
    expect(await send({ requestId, amount: '20.0', recipient: reordered })).toEqual(first);
    const sepa = await send({ rail: 'sepa', recipient: SEPA, amount: '1' });
    expect(sepa.recipient).toBe('Ada TEST · …3000');
    const proxy = await send({ rail: 'proxy', recipient: { aliasType: 'email', alias: 'Ada.Test@Example.com' } });
    expect(proxy.recipient).toBe('email a…@example.com');
    expect((await as(ADA, PLAIN).railSends.list({ limit: 10 })).map((row) => row.requestId)).toEqual([
      proxy.requestId,
      sepa.requestId,
      requestId,
    ]);
    const [stored] = await sql<
      { recipient: Record<string, string> }[]
    >`SELECT recipient FROM bank.rail_send_intents WHERE id = ${requestId}`;
    expect(stored!.recipient).toEqual({ ...ACH, accountNumber: '000123456789' });
    await nothingMoved();
  });

  it('needs the step-up scope: a plain session is refused and nothing is kept', async () => {
    expect((await refused(send({}, ADA, PLAIN))).code).toBe('FORBIDDEN');
    expect(await sql`SELECT 1 FROM bank.rail_send_intents`).toHaveLength(0);
  });

  it("refuses each rail's malformed fields by name, and keeps nothing", async () => {
    const bad: Array<[string, Record<string, string>]> = [
      ['ach', { ...ACH, routingNumber: '021000022' }],
      // A check digit that adds up, but no Federal Reserve prefix, or nothing at all.
      ['ach', { ...ACH, routingNumber: '500000005' }],
      ['ach', { ...ACH, routingNumber: '000000000' }],
      ['ach', { ...ACH, accountNumber: '12' }],
      ['ach', { ...ACH, accountType: 'brokerage' }],
      ['ach', { ...ACH, holderName: '' }],
      ['ach', { ...ACH, iban: 'DE89370400440532013000' }],
      ['wire', { holderName: 'Ada TEST', routingNumber: '021000021', accountNumber: '123456789' }],
      ['sepa', { ...SEPA, iban: 'DE89 3704 0044 0532 0130 01' }],
      ['sepa', { ...SEPA, bic: 'NOT A BIC' }],
      ['proxy', { aliasType: 'phone', alias: '0049 30 1234' }],
      ['proxy', { aliasType: 'email', alias: 'nobody' }],
    ];
    for (const [rail, recipient] of bad) {
      expect(await refused(send({ rail, recipient }))).toEqual({ code: 'BAD_REQUEST', bank: 'bank.rail_send_invalid' });
    }
    for (const amount of ['0', '0.000']) {
      expect((await refused(send({ amount }))).bank).toBe('bank.rail_send_invalid');
    }
    expect(await sql`SELECT 1 FROM bank.rail_send_intents`).toHaveLength(0);
    // The optional BIC and a phone alias pass when well formed.
    expect((await send({ rail: 'sepa', recipient: { ...SEPA, bic: 'cobadeffxxx' } })).refusalCode).toBe('rail.bank');
    expect((await send({ rail: 'proxy', recipient: { aliasType: 'phone', alias: '+49 30 1234567' } })).recipient).toBe('phone …4567');
  });

  it('checks everything a send checks, keeping nothing, and refuses more than the space holds', async () => {
    const ask = { fromSpaceId: space, amount: '50', rail: 'ach' as const, recipient: ACH };
    expect(await as(ADA, PLAIN).railSends.check(ask)).toEqual({ assetId: 'USDT', amount: '50', available: '50' });
    expect(await refused(as(ADA, PLAIN).railSends.check({ ...ask, amount: '50.000000000000000001' }))).toEqual({
      code: 'PRECONDITION_FAILED',
      bank: 'bank.rail_send_over_available',
    });
    expect((await refused(as(ADA, PLAIN).railSends.check({ ...ask, recipient: { ...ACH, accountNumber: '1' } }))).bank).toBe(
      'bank.rail_send_invalid',
    );
    expect((await refused(send({ amount: '50.1' }))).bank).toBe('bank.rail_send_over_available');
    expect(await sql`SELECT 1 FROM bank.rail_send_intents`).toHaveLength(0);
    await nothingMoved();
  });

  it("someone else's space, an unknown one or an archived one is refused; the same id on other terms is a conflict", async () => {
    expect((await refused(send({}, BOB))).bank).toBe('bank.space_not_found');
    expect((await refused(send({ fromSpaceId: randomUUID() }))).bank).toBe('bank.space_not_found');
    const requestId = randomUUID();
    await send({ requestId });
    expect(await refused(send({ requestId, amount: '21' }))).toEqual({ code: 'BAD_REQUEST', bank: 'bank.rail_send_conflict' });
    expect((await refused(send({ requestId, recipient: { ...ACH, accountType: 'savings' } }))).bank).toBe('bank.rail_send_conflict');
    // The space is checked first: someone else's space is not found, whatever the id.
    expect((await refused(send({ requestId }, BOB))).bank).toBe('bank.space_not_found');
    const bobs = (await services().spaces.ensurePrimary(BOB, 'USDT')).id;
    expect((await refused(send({ requestId, fromSpaceId: bobs }, BOB))).bank).toBe('bank.rail_send_conflict');
    expect(await as(BOB, PLAIN).railSends.list({ limit: 10 })).toEqual([]);
    await sql`UPDATE bank.spaces SET archived_at = now() WHERE id = ${space}`;
    expect((await refused(send({}))).bank).toBe('bank.space_archived');
    expect(await sql`SELECT 1 FROM bank.rail_send_intents`).toHaveLength(1);
    await nothingMoved();
  });

  describe('the recipient book (J-bank-04 #2)', () => {
    const SEPA_DE = { holderName: 'Bea TEST', iban: 'DE89 3704 0044 0532 0130 00', transferType: 'instant' };
    const add = (over: Record<string, unknown> = {}, userId = ADA, scopes = STEPPED) =>
      as(userId, scopes).railSends.addPayee({
        nickname: 'Bea in Berlin',
        country: 'DE',
        rail: 'sepa',
        recipient: SEPA_DE,
        ...over,
      } as Parameters<ReturnType<typeof as>['railSends']['addPayee']>[0]);
    const back = (payeeId: string, hours: number) =>
      sql`UPDATE bank.rail_payees SET created_at = now() - make_interval(hours => ${hours}) WHERE id = ${payeeId}`;

    it("takes each country's own rails, checks the form as a send does, and lists the countries", async () => {
      const { countries } = await as(ADA, PLAIN).railSends.requirements();
      expect(countries.find((row) => row.country === 'US')!.rails).toEqual(['ach', 'wire', 'instant', 'proxy']);
      expect(countries.find((row) => row.country === 'DE')!.rails).toEqual(['sepa', 'proxy']);
      expect(countries.find((row) => row.country === 'GB')).toBeUndefined();
      for (const over of [
        { country: 'US' }, // SEPA is not a US form
        { country: 'FR' }, // a German IBAN is not an account in France
        { country: 'GB' },
        { rail: 'ach', recipient: ACH }, // ACH is not a German form
        { recipient: { ...SEPA_DE, iban: 'DE89 3704 0044 0532 0130 01' } },
        { nickname: ' ' },
      ]) {
        expect(await refused(add(over))).toEqual({ code: 'BAD_REQUEST', bank: 'bank.rail_send_invalid' });
      }
      expect((await refused(add({}, ADA, PLAIN))).code).toBe('FORBIDDEN');
      // The check before the code answers the same, keeping nothing.
      const ask = { nickname: 'Bea in Berlin', country: 'DE', rail: 'sepa' as const, recipient: SEPA_DE };
      expect(await as(ADA, PLAIN).railSends.checkPayee(ask)).toEqual({ ...ask, recipient: 'Bea TEST · …3000' });
      expect((await refused(as(ADA, PLAIN).railSends.checkPayee({ ...ask, country: 'FR' }))).bank).toBe('bank.rail_send_invalid');
      expect(await sql`SELECT 1 FROM bank.rail_payees`).toHaveLength(0);
      const us = await add({ nickname: 'Ada at home', country: 'us', rail: 'ach', recipient: ACH });
      expect(us).toMatchObject({ country: 'US', rail: 'ach', recipient: 'Ada TEST · …6789' });
      // The same US account over another rail is the same destination, inside the same window.
      const asWire = { holderName: 'Ada TEST', routingNumber: ACH.routingNumber, accountNumber: ACH.accountNumber, bankName: 'TEST Bank' };
      expect((await refused(send({ rail: 'wire', recipient: asWire }))).bank).toBe('bank.payee_cooling_active');
    });

    it('a new recipient shows "cannot check" with rail.bank and the end of its window; the same account again is the same one', async () => {
      const first = await add();
      expect(first).toMatchObject({
        nickname: 'Bea in Berlin',
        country: 'DE',
        rail: 'sepa',
        recipient: 'Bea TEST · …3000',
        verification: 'cannot_check',
        verificationRail: 'rail.bank',
        cooling: { state: 'active' },
      });
      expect(Date.parse(first.cooling.endsAt!) - Date.parse(first.addedAt)).toBe(24 * 3_600_000);
      // Spacing and a new nickname or holder name do not make a second recipient, nor restart the window.
      expect(
        (await add({ nickname: 'Bea', recipient: { ...SEPA_DE, holderName: 'B TEST', iban: 'de89370400440532013000' } })).payeeId,
      ).toBe(first.payeeId);
      expect(await as(ADA, PLAIN).railSends.payees({ limit: 10 })).toEqual([first]);
      expect(await as(BOB, PLAIN).railSends.payees({ limit: 10 })).toEqual([]);
    });

    it('a send to it refuses inside the window with the end time, and goes on to rail.bank once the window has passed', async () => {
      const payee = await add();
      const toPayee = { payeeId: payee.payeeId, rail: undefined, recipient: undefined };
      const inside = await refused(send(toPayee));
      expect(inside).toEqual({ code: 'PRECONDITION_FAILED', bank: 'bank.payee_cooling_active' });
      await expect(send(toPayee)).rejects.toThrow(payee.cooling.endsAt!);
      expect((await refused(as(ADA, PLAIN).railSends.check({ fromSpaceId: space, amount: '5', payeeId: payee.payeeId }))).bank).toBe(
        'bank.payee_cooling_active',
      );
      // Typing the same account in by hand is the same destination, with the same window.
      expect((await refused(send({ rail: 'sepa', recipient: { ...SEPA_DE, holderName: 'Someone TEST' } }))).bank).toBe(
        'bank.payee_cooling_active',
      );
      expect(await sql`SELECT 1 FROM bank.rail_send_intents`).toHaveLength(0);
      await back(payee.payeeId, 24);
      expect((await as(ADA, PLAIN).railSends.payees({ limit: 1 }))[0]!.cooling.state).toBe('open');
      const requestId = randomUUID();
      const kept = await send({ ...toPayee, requestId });
      expect(kept).toMatchObject({ rail: 'sepa', recipient: 'Bea TEST · …3000', refusalCode: 'rail.bank' });
      // A send already kept is answered as kept, even once the window is no longer published.
      cooling = '';
      expect(await send({ ...toPayee, requestId })).toEqual(kept);
      await nothingMoved();
    });

    it('a blank window refuses every send to a saved recipient by name; zero is no wait', async () => {
      const payee = await add();
      await back(payee.payeeId, 1000);
      cooling = '';
      expect((await as(ADA, PLAIN).railSends.payees({ limit: 1 }))[0]!.cooling).toEqual({ state: 'unset', endsAt: null });
      expect(await refused(send({ payeeId: payee.payeeId, rail: undefined, recipient: undefined }))).toEqual({
        code: 'PRECONDITION_FAILED',
        bank: 'bank.payee_cooling_unset',
      });
      // A window no date can hold is not a published window either.
      cooling = '99999999999';
      expect((await as(ADA, PLAIN).railSends.payees({ limit: 1 }))[0]!.cooling.state).toBe('unset');
      cooling = 'soon';
      expect((await refused(send({ payeeId: payee.payeeId, rail: undefined, recipient: undefined }))).bank).toBe(
        'bank.payee_cooling_unset',
      );
      cooling = '0';
      const fresh = await add({ recipient: { ...SEPA_DE, iban: 'FR14 2004 1010 0505 0001 3M02 606' }, country: 'FR' });
      expect(fresh.cooling.state).toBe('open');
      expect((await send({ payeeId: fresh.payeeId, rail: undefined, recipient: undefined })).refusalCode).toBe('rail.bank');
    });

    it("someone else's recipient or a removed one is not found; a changed account is a new recipient whose window starts again", async () => {
      const payee = await add();
      await back(payee.payeeId, 48);
      expect((await refused(send({ payeeId: payee.payeeId, rail: undefined, recipient: undefined }, BOB))).bank).toBe(
        'bank.payee_not_found',
      );
      expect((await refused(as(BOB).railSends.removePayee({ payeeId: payee.payeeId }))).bank).toBe('bank.payee_not_found');
      await as(ADA).railSends.removePayee({ payeeId: payee.payeeId });
      expect((await refused(send({ payeeId: payee.payeeId, rail: undefined, recipient: undefined }))).bank).toBe('bank.payee_not_found');
      expect(await as(ADA, PLAIN).railSends.payees({ limit: 10 })).toEqual([]);
      const again = await add();
      expect(again.payeeId).not.toBe(payee.payeeId);
      expect(again.cooling.state).toBe('active');
    });

    it('an invite is refused by name: no email delivery is connected', async () => {
      expect(await refused(as(ADA).railSends.invitePayee({ email: 'bea@example.com' }))).toEqual({
        code: 'PRECONDITION_FAILED',
        bank: 'bank.payee_invite_unwired',
      });
      expect((await refused(as(ADA).railSends.invitePayee({ email: 'bea' }))).bank).toBe('bank.rail_send_invalid');
    });
  });
});
