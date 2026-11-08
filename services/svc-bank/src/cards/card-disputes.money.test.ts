/**
 * J-bank-27 (BK-cdisp-02, BK-cdisp-03): card disputes over real rows. The queue and its state filter, the timeline with
 * every transition, actor and time; evidence after submission kept with its time; arbitration an explicit state; the
 * partner's provisional credit asked once and recorded with the partner's reference, the cardholder's available rising once
 * by exactly that amount as the partner reports it; who bears the fraud loss recorded from the partner's terms or "not
 * known", never the partner by default; the owner's dispute cap refusing above its limit and refusing by name when blank;
 * and nothing posted to the ledger at any step.
 *
 * PG-hard: a missing database fails the suite. CI uses TEST_DATABASE_URL; without it, Testcontainers `postgres:16-alpine`.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CardService } from './card-service.js';
import { CardDisputeService, parseDisputeCap, type DisputeCap } from './card-disputes.js';
import { cardSim, noCardIssuer, type CardIssuerAdapter } from './issuer.js';
import { NOTHING_REPORTED, type CardPartnerTerms } from './partner-terms.js';
import { BankError } from '../errors.js';

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

const SILENT: CardPartnerTerms = { ...NOTHING_REPORTED, balances: { USDT: '30' } };
const REPORTED: CardPartnerTerms = {
  ...SILENT,
  lossLiability: { bearer: 'programme', terms: 'TEST terms: the programme bears card fraud' },
};
const CAP: DisputeCap = parseDisputeCap('{"USDT":"100"}');
const OPERATOR = 'support-operator-a';

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (error) {
    if (error instanceof BankError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('card disputes (J-bank-27, PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let issuer: CardIssuerAdapter;
  let terms: CardPartnerTerms;
  let cards: CardService;
  const disputes = (cap: DisputeCap = CAP, adapter: CardIssuerAdapter = issuer) =>
    new CardDisputeService(sql, { issuer: adapter, partnerTerms: () => terms, simulated: () => true, cap });

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 60_000);

  beforeEach(async () => {
    ledger = new MemoryLedger();
    terms = SILENT;
    issuer = cardSim({ partner: SILENT });
    cards = new CardService(sql, ledger, { issuer });
    await sql`TRUNCATE bank.card_settlements, bank.card_conversions, bank.card_cashback, bank.card_authorizations CASCADE`;
  });

  /** A cardholder with one captured payment of `amount` USDT, ready to dispute. */
  async function captured(amount: string): Promise<{ userId: string; cardId: string; ref: string }> {
    const userId = randomUUID();
    await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: `fund:${userId}` }));
    const card = await cards.issue({ cardId: randomUUID(), userId, assetId: 'USDT', perAuthorizationLimit: amt('500') });
    const ref = `auth-${randomUUID()}`;
    await cards.authorize({ cardId: card.id, authorizationRef: ref, amount: amt(amount) });
    await cards.capture({ cardId: card.id, authorizationRef: ref, amount: amt(amount) });
    return { userId, cardId: card.id, ref };
  }
  const open = async (amount: string, caseKey = `case-${randomUUID()}`) => {
    const p = await captured(amount);
    const c = await disputes().open({
      caseKey,
      cardId: p.cardId,
      authorizationRef: p.ref,
      amount,
      reason: 'TEST: not recognised',
      actor: OPERATOR,
    });
    return { ...p, c, caseKey };
  };

  it('opens a case on a settled capture only, once per key and per payment; the queue filters by state', async () => {
    const { c, cardId, ref, caseKey } = await open('50');
    expect(c).toMatchObject({ state: 'opened', amount: '50', assetId: 'USDT', test: true, decision: null });
    expect(c.events).toEqual([
      expect.objectContaining({ sequence: 1, kind: 'opened', fromState: null, toState: 'opened', actor: OPERATOR }),
    ]);
    // The same key and figures is the same case; other figures, or a second case on the payment, refuse.
    const again = await disputes().open({
      caseKey,
      cardId,
      authorizationRef: ref,
      amount: '50',
      reason: 'TEST: not recognised',
      actor: OPERATOR,
    });
    expect(again.id).toBe(c.id);
    expect(
      await code(
        disputes().open({ caseKey, cardId, authorizationRef: ref, amount: '40', reason: 'TEST: not recognised', actor: OPERATOR }),
      ),
    ).toBe('bank.card_dispute_invalid');
    expect(
      await code(
        disputes().open({ caseKey: `other-${randomUUID()}`, cardId, authorizationRef: ref, amount: '50', reason: 'x', actor: OPERATOR }),
      ),
    ).toBe('bank.card_dispute_invalid');
    // More than was captured, or a payment with no capture, is not disputable.
    const p = await captured('20');
    expect(
      await code(
        disputes().open({
          caseKey: `k-${randomUUID()}`,
          cardId: p.cardId,
          authorizationRef: p.ref,
          amount: '21',
          reason: 'x',
          actor: OPERATOR,
        }),
      ),
    ).toBe('bank.card_dispute_not_disputable');
    const held = `auth-${randomUUID()}`;
    await cards.authorize({ cardId: p.cardId, authorizationRef: held, amount: amt('5') });
    expect(
      await code(
        disputes().open({
          caseKey: `k-${randomUUID()}`,
          cardId: p.cardId,
          authorizationRef: held,
          amount: '5',
          reason: 'x',
          actor: OPERATOR,
        }),
      ),
    ).toBe('bank.card_dispute_not_disputable');

    const second = await open('10');
    await disputes().addEvidence({ disputeId: second.c.id, stepKey: `ev-${randomUUID()}`, description: 'TEST receipt', actor: OPERATOR });
    await disputes().submitRepresentment({
      disputeId: second.c.id,
      stepKey: `rep-${randomUUID()}`,
      description: 'TEST rep',
      actor: OPERATOR,
    });
    const opened = (await disputes().list('opened')).rows.map((d) => d.id);
    const represented = (await disputes().list('representment')).rows.map((d) => d.id);
    expect(opened).toContain(c.id);
    expect(opened).not.toContain(second.c.id);
    expect(represented).toEqual([second.c.id]);
    expect((await disputes().list()).rows.map((d) => d.id)).toEqual(expect.arrayContaining([c.id, second.c.id]));
  });

  it('keeps evidence after submission with its time, makes arbitration an explicit state, and refuses out-of-order steps', async () => {
    const { c } = await open('50');
    expect(
      await code(disputes().submitRepresentment({ disputeId: c.id, stepKey: `rep-${randomUUID()}`, description: 'r', actor: OPERATOR })),
    ).toBe('bank.card_dispute_state');
    expect(await code(disputes().escalateToArbitration({ disputeId: c.id, stepKey: `arb-${randomUUID()}`, actor: OPERATOR }))).toBe(
      'bank.card_dispute_state',
    );
    const ev = `ev-${randomUUID()}`;
    await disputes().addEvidence({ disputeId: c.id, stepKey: ev, description: 'TEST receipt', actor: OPERATOR });
    // A retried step is the same step.
    await disputes().addEvidence({ disputeId: c.id, stepKey: ev, description: 'TEST receipt', actor: OPERATOR });
    await disputes().submitRepresentment({
      disputeId: c.id,
      stepKey: `rep-${randomUUID()}`,
      description: 'TEST rep',
      actor: 'support-operator-b',
    });
    await disputes().addEvidence({ disputeId: c.id, stepKey: `late-${randomUUID()}`, description: 'TEST late letter', actor: OPERATOR });
    const arb = await disputes().escalateToArbitration({ disputeId: c.id, stepKey: `arb-${randomUUID()}`, actor: OPERATOR });
    expect(arb.state).toBe('arbitration');
    expect(arb.events.map((e) => [e.kind, e.fromState, e.toState, e.actor, e.afterSubmission])).toEqual([
      ['opened', null, 'opened', OPERATOR, false],
      ['evidence', 'opened', 'opened', OPERATOR, false],
      ['representment', 'opened', 'representment', 'support-operator-b', false],
      ['evidence', 'representment', 'representment', OPERATOR, true],
      ['arbitration', 'representment', 'arbitration', OPERATOR, false],
    ]);
    for (const e of arb.events) expect(Number.isNaN(Date.parse(e.at))).toBe(false);
    // The timeline is append-only.
    await expect(sql`UPDATE bank.card_dispute_events SET actor = 'x' WHERE dispute_id = ${c.id}`).rejects.toThrow(/append-only/);
  });

  it("asks the partner's provisional credit once: the cardholder's available rises once by exactly the amount, and nothing posts", async () => {
    const { c, userId } = await open('50');
    const before = await issuer.cardholderBalances!({ userId });
    const entries = ledger.journal().length;
    const credited = await disputes().grantProvisionalCredit({ disputeId: c.id, actor: OPERATOR });
    expect(credited.provisionalCredit).toMatchObject({ state: 'credited', amount: '50' });
    expect(credited.provisionalCredit.partnerRef).toMatch(/^TEST-card-sim-credit-[0-9a-f]{16}$/);
    // A second ask is the same credit.
    const again = await disputes().grantProvisionalCredit({ disputeId: c.id, actor: OPERATOR });
    expect(again.provisionalCredit.partnerRef).toBe(credited.provisionalCredit.partnerRef);
    expect(before).toEqual({ USDT: '30' });
    expect(await issuer.cardholderBalances!({ userId })).toEqual({ USDT: '80' });
    // Another cardholder's figure is untouched.
    expect(await issuer.cardholderBalances!({ userId: randomUUID() })).toEqual({ USDT: '30' });
    expect(credited.events.filter((e) => e.kind === 'provisional_credit')).toHaveLength(1);
    expect(ledger.journal().length).toBe(entries);
  });

  it('records who bears the fraud loss from the partner, or "not known"; never the partner by default', async () => {
    const silent = await open('50');
    const closedSilent = await disputes().decide({ disputeId: silent.c.id, outcome: 'merchant', actor: OPERATOR });
    expect(closedSilent.state).toBe('closed');
    expect(closedSilent.decision).toMatchObject({ outcome: 'merchant', lossStatus: 'not_known', lossBearer: null, lossTerms: null });
    expect(closedSilent.events.at(-1)).toMatchObject({ kind: 'closed', toState: 'closed', actor: OPERATOR });
    expect(closedSilent.events.at(-1)!.detail).toContain('who bears the fraud loss is not known');

    terms = REPORTED;
    const reported = await open('40');
    await disputes().grantProvisionalCredit({ disputeId: reported.c.id, actor: OPERATOR });
    const closed = await disputes().decide({ disputeId: reported.c.id, outcome: 'cardholder', actor: OPERATOR });
    expect(closed.decision).toMatchObject({
      outcome: 'cardholder',
      lossStatus: 'reported',
      lossBearer: 'programme',
      lossTerms: 'TEST terms: the programme bears card fraud',
      creditSettlement: 'final',
    });
    // A closed case takes no further step, and the same decision again returns it.
    expect((await disputes().decide({ disputeId: reported.c.id, outcome: 'cardholder', actor: OPERATOR })).id).toBe(reported.c.id);
    expect(await code(disputes().decide({ disputeId: reported.c.id, outcome: 'merchant', actor: OPERATOR }))).toBe(
      'bank.card_dispute_state',
    );
    expect(
      await code(disputes().addEvidence({ disputeId: reported.c.id, stepKey: `ev-${randomUUID()}`, description: 'x', actor: OPERATOR })),
    ).toBe('bank.card_dispute_state');
    // The database refuses a reported loss with no bearer.
    await expect(sql`UPDATE bank.card_disputes SET loss_bearer = NULL WHERE id = ${reported.c.id}`).rejects.toThrow(
      /card_disputes_loss_shape/,
    );
  });

  it('a decision for the merchant has the partner reverse its provisional credit', async () => {
    const { c, userId } = await open('50');
    await disputes().grantProvisionalCredit({ disputeId: c.id, actor: OPERATOR });
    expect(await issuer.cardholderBalances!({ userId })).toEqual({ USDT: '80' });
    const closed = await disputes().decide({ disputeId: c.id, outcome: 'merchant', actor: OPERATOR });
    expect(closed.decision).toMatchObject({ creditSettlement: 'reversed' });
    expect(closed.decision!.creditSettlementPartnerRef).toMatch(/^TEST-card-sim-reversed-/);
    expect(await issuer.cardholderBalances!({ userId })).toEqual({ USDT: '30' });
  });

  it('enforces the dispute cap: above it refuses, blank refuses by name, and a merchant decision needs none', async () => {
    const big = await open('250');
    expect(await code(disputes().grantProvisionalCredit({ disputeId: big.c.id, actor: OPERATOR }))).toBe('bank.card_dispute_cap_exceeded');
    expect(await code(disputes().decide({ disputeId: big.c.id, outcome: 'cardholder', actor: OPERATOR }))).toBe(
      'bank.card_dispute_cap_exceeded',
    );
    expect((await disputes().get(big.c.id)).state).toBe('opened');
    // Exactly at the cap is within it.
    const atCap = await open('100');
    await disputes().grantProvisionalCredit({ disputeId: atCap.c.id, actor: OPERATOR });
    expect((await disputes().decide({ disputeId: atCap.c.id, outcome: 'cardholder', actor: OPERATOR })).state).toBe('closed');

    const blank = await open('10');
    expect(await code(disputes(null).grantProvisionalCredit({ disputeId: blank.c.id, actor: OPERATOR }))).toBe(
      'bank.card_dispute_cap_unset',
    );
    expect(await code(disputes(null).decide({ disputeId: blank.c.id, outcome: 'cardholder', actor: OPERATOR }))).toBe(
      'bank.card_dispute_cap_unset',
    );
    // An asset the cap leaves out is not published either.
    expect(
      await code(disputes(parseDisputeCap('{"USDC":"100"}')).decide({ disputeId: blank.c.id, outcome: 'cardholder', actor: OPERATOR })),
    ).toBe('bank.card_dispute_cap_unset');
    expect((await disputes(null).decide({ disputeId: big.c.id, outcome: 'merchant', actor: OPERATOR })).state).toBe('closed');
  });

  it('a partner that cannot answer the credit leaves the ask recorded; the case does not close on a guess and a retry is the same credit', async () => {
    const { c, userId } = await open('50');
    let fail = true;
    const flaky: CardIssuerAdapter = {
      ...issuer,
      provisionalCredit: async (input) => {
        if (fail) throw new Error('partner down');
        return issuer.provisionalCredit!(input);
      },
    };
    await expect(disputes(CAP, flaky).grantProvisionalCredit({ disputeId: c.id, actor: OPERATOR })).rejects.toThrow('partner down');
    const asked = await disputes(CAP, flaky).get(c.id);
    expect(asked.provisionalCredit).toMatchObject({ state: 'asked', amount: null, partnerRef: null });
    expect(await code(disputes(CAP, flaky).decide({ disputeId: c.id, outcome: 'cardholder', actor: OPERATOR }))).toBe(
      'bank.card_dispute_state',
    );
    fail = false;
    const credited = await disputes(CAP, flaky).grantProvisionalCredit({ disputeId: c.id, actor: OPERATOR });
    expect(credited.provisionalCredit.state).toBe('credited');
    expect(await issuer.cardholderBalances!({ userId })).toEqual({ USDT: '80' });
  });

  it('with no card partner, a credit refuses by name and nothing is recorded', async () => {
    const { c } = await open('50');
    expect(await code(disputes(CAP, noCardIssuer).grantProvisionalCredit({ disputeId: c.id, actor: OPERATOR }))).toBe(
      'bank.no_card_issuer',
    );
    const { provisionalCredit, ...rest } = await disputes().get(c.id);
    void rest;
    expect(provisionalCredit.partnerRef).toBeNull();
  });

  it('a decision for the cardholder needs the partner’s credit first; once a decision is pinned no credit is asked and no other outcome is taken', async () => {
    const { c } = await open('50');
    expect(await code(disputes().decide({ disputeId: c.id, outcome: 'cardholder', actor: OPERATOR }))).toBe('bank.card_dispute_state');
    expect((await disputes().get(c.id)).state).toBe('opened');
    // A decision pinned and then interrupted (the partner call or the write failed) holds its outcome.
    await sql`UPDATE bank.card_disputes SET decision_requested_outcome = 'merchant' WHERE id = ${c.id}`;
    expect(await code(disputes().grantProvisionalCredit({ disputeId: c.id, actor: OPERATOR }))).toBe('bank.card_dispute_state');
    expect(await code(disputes().decide({ disputeId: c.id, outcome: 'cardholder', actor: OPERATOR }))).toBe('bank.card_dispute_state');
    expect((await disputes().decide({ disputeId: c.id, outcome: 'merchant', actor: OPERATOR })).decision).toMatchObject({
      outcome: 'merchant',
    });
  });

  it('a partner credit of another amount than asked is not recorded', async () => {
    const { c, userId } = await open('50');
    const odd: CardIssuerAdapter = {
      ...issuer,
      provisionalCredit: async (input) => ({ ...(await issuer.provisionalCredit!(input)), amount: '500' }),
    };
    expect(await code(disputes(CAP, odd).grantProvisionalCredit({ disputeId: c.id, actor: OPERATOR }))).toBe(
      'bank.card_dispute_partner_mismatch',
    );
    expect((await disputes().get(c.id)).provisionalCredit).toMatchObject({ state: 'asked', amount: null, partnerRef: null });
    void userId;
  });

  it('a step key is one step: the same key for another step refuses, and a typed key cannot take a key the service writes', async () => {
    const { c } = await open('50');
    const k = `ev-${randomUUID()}`;
    await disputes().addEvidence({ disputeId: c.id, stepKey: k, description: 'TEST receipt', actor: OPERATOR });
    expect(await code(disputes().submitRepresentment({ disputeId: c.id, stepKey: k, description: 'r', actor: OPERATOR }))).toBe(
      'bank.card_dispute_invalid',
    );
    // A support key that spells the decision's own key lives under `step:`, so the decision still closes the case.
    await disputes().addEvidence({ disputeId: c.id, stepKey: `card-dispute-decision:${c.id}`, description: 'TEST', actor: OPERATOR });
    expect((await disputes().decide({ disputeId: c.id, outcome: 'merchant', actor: OPERATOR })).state).toBe('closed');
  });

  it('two opens of the same case at once are one case', async () => {
    const p = await captured('30');
    const caseKey = `case-${randomUUID()}`;
    const input = { caseKey, cardId: p.cardId, authorizationRef: p.ref, amount: '30', reason: 'TEST', actor: OPERATOR };
    const [x, y] = await Promise.all([disputes().open(input), disputes().open(input)]);
    expect(x.id).toBe(y.id);
    expect(x.events.filter((e) => e.kind === 'opened')).toHaveLength(1);
  });

  it('parses the cap: blank is unpublished and malformed refuses to start', () => {
    expect(parseDisputeCap(undefined)).toBeNull();
    expect(parseDisputeCap('  ')).toBeNull();
    expect(() => parseDisputeCap('{"USDC":"0"}')).toThrow(/BANK_CARD_DISPUTE_CAP_JSON/);
    expect(() => parseDisputeCap('{"usdc":"10"}')).toThrow(/BANK_CARD_DISPUTE_CAP_JSON/);
    expect(() => parseDisputeCap('nope')).toThrow(/not JSON/);
    expect(parseDisputeCap('{"USDC":"100.00"}')?.get('USDC')).toBe('100.00');
  });
});
