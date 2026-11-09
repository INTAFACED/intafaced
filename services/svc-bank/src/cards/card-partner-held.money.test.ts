/**
 * PARTNER-HELD CARD AUTHORISATIONS (OWNER 226; seam B on project-state #1790), against Postgres and a real in-memory
 * ledger. With the person's TEST `custody: 'off'` switch set, the TEST partner card holds an approved authorisation from
 * the partner balance, captures, releases (on our instruction or its own expiry) and refunds, each once under a key
 * derived from the authorisation id, and THE LEDGER POSTS NOTHING. Without the switch, the custodial path runs exactly as
 * before. With the custodial layer off and no partner, nothing is written and the refusal names that no partner is set.
 *
 * The planted test is the first one in "custody off": put `recipes.withdrawHold` back on the partner path (drop the
 * `heldBy === 'partner'` dispatch in `commitHold`) and it fails on the ledger journal.
 *
 * PG-hard: TEST_DATABASE_URL is required; no skip.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { BankError } from '../errors.js';
import { testPartner, type TestPartner } from '../partner/test-partner.js';
import { createBankRouter } from '../router.js';
import { CardService } from './card-service.js';
import { cardSim } from './issuer.js';
import { PartnerCardRefusal, partnerCardKey, testPartnerCardHolds, type PartnerCardHolds } from './partner-card-holds.js';
import { NOTHING_REPORTED, type CardPartnerTerms } from './partner-terms.js';

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL) throw new Error('TEST_DATABASE_URL is unset: this money suite never skips');

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ADA = '11111111-1111-4111-8111-111111111111';
const SECRET = 'bank-card-partner-held-edge-secret-long';

/** The TEST partner card's answers, as the stack's profile gives them: it holds the crypto, 100 USDC each, TEST. */
const PARTNER: CardPartnerTerms = { ...NOTHING_REPORTED, custodyMode: 'partner_holds', spendFrom: ['USDC'], balances: { USDC: '100' } };

async function codeOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
  } catch (err) {
    return err instanceof BankError ? err.code : String(err);
  }
  return null;
}

describe('partner-held card authorisations (PG)', () => {
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let partner: TestPartner;
  let terms: CardPartnerTerms;
  let holds: PartnerCardHolds;
  let layer: 'on' | 'off';
  let cards: CardService;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'bank', url: DB_URL, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  /** One CardService wired as `createBankServices` wires it: the TEST partner's switch, then the custody switch. */
  function build(over: { holds?: PartnerCardHolds } = {}) {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      testPartner: partner,
      custodyLayer: layer,
      cards: {
        issuer: cardSim({ partner: terms }),
        ...(over.holds ? { partnerHolds: over.holds } : {}),
      },
    });
    return bank;
  }

  beforeEach(async () => {
    await sql`TRUNCATE bank.card_partner_refunds, bank.card_cashback, bank.card_settlements, bank.card_conversions, bank.card_authorizations, bank.cards RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    partner = testPartner();
    terms = PARTNER;
    layer = 'on';
    holds = testPartnerCardHolds({ terms: () => terms, switches: (u) => partner.switches(u) });
    cards = build({ holds }).cards;
  });

  const issue = (svc: CardService = cards, assetId = 'USDC') =>
    svc.issue({ cardId: randomUUID(), userId: ADA, assetId, perAuthorizationLimit: amt('1000') });

  /** Every ledger transaction this authorisation could have made on the custodial path: none may exist. */
  async function ledgerKeysFor(authorizationId: string) {
    const keys = [
      `withdraw.hold:${authorizationId}`,
      `withdraw.settle:${authorizationId}`,
      `withdraw.reverse:${authorizationId}`,
      `reward:bank.card.cashback:${authorizationId}`,
    ];
    const found = [];
    for (const k of keys) if (await ledger.getTxByKey(k)) found.push(k);
    return found;
  }

  describe('custody off: the partner holds it, and the ledger posts nothing', () => {
    beforeEach(() => {
      partner.set(ADA, { custody: 'off' });
    });

    it('PLANTED: an approved authorisation is held by the partner from the partner balance, and no ledger tx exists under its key', async () => {
      // A ledger balance the old path COULD hold from, so a planted `withdrawHold` would succeed and be seen here.
      await ledger.post(recipes.deposit({ userId: ADA, assetId: 'USDC', amount: amt('100'), rail: 'test', railRef: 'planted-fund' }));
      const before = ledger.journal().length;
      const card = await issue();
      const outcome = await cards
        .authorize({ cardId: card.id, authorizationRef: 'jb14-hold-1', amount: amt('40') })
        .catch((err: unknown) => err);
      const [row] = await sql<Array<{ id: string }>>`SELECT id FROM bank.card_authorizations WHERE authorization_ref = 'jb14-hold-1'`;

      // The ledger first: nothing posted, and nothing under any of this authorisation's custodial keys.
      expect(await ledgerKeysFor(row!.id)).toEqual([]);
      expect(ledger.journal()).toHaveLength(before);
      expect(outcome).not.toBeInstanceOf(Error);
      const auth = outcome as Awaited<ReturnType<CardService['authorize']>>;
      expect(auth).toMatchObject({
        decision: 'approved',
        status: 'settled',
        heldBy: 'partner',
        holdLedgerTxId: null,
        partnerMode: 'partner_holds',
      });
      expect(auth.partnerHoldRef).toBe(`TEST-card-partner:${partnerCardKey('hold', auth.id)}`);
      // The partner's figures, as it reports them.
      expect(await holds.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ test: true, available: '60', held: '40' });
      const view = await cards.partnerHeld(card.id, 10);
      expect(view.heldBy).toBe('partner');
      expect(view.authorizations).toEqual([
        expect.objectContaining({
          authorizationId: auth.id,
          report: expect.objectContaining({ status: 'held', amount: '40', open: '40' }),
        }),
      ]);
    });

    it('a redelivery holds once, and returns the first decision', async () => {
      const card = await issue();
      const first = await cards.authorize({ cardId: card.id, authorizationRef: 'jb14-redeliver', amount: amt('40') });
      const second = await cards.authorize({ cardId: card.id, authorizationRef: 'jb14-redeliver', amount: amt('40') });
      expect(second).toEqual(first);
      expect(await holds.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '60', held: '40' });
      expect(ledger.journal()).toHaveLength(0);
    });

    it('a short partner balance is a decline the partner gave, naming it, with nothing held', async () => {
      const card = await issue();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'jb14-short', amount: amt('100.5') });
      expect(auth).toMatchObject({ decision: 'declined', declineCode: 'bank.card_partner_insufficient_funds', heldBy: 'partner' });
      expect(await holds.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '100', held: '0' });
      expect(ledger.journal()).toHaveLength(0);
    });

    it('the partner’s own decline (its balance moved since the read) is recorded as the partner’s answer', async () => {
      const card = await issue();
      // Another authorisation took the balance at the partner between our read and our hold.
      const racing: PartnerCardHolds = {
        ...holds,
        hold: async (input) => {
          await holds.hold({ key: 'card.partner.hold:elsewhere', userId: ADA, assetId: 'USDC', amount: '90' });
          return holds.hold(input);
        },
      };
      const svc = build({ holds: racing }).cards;
      const auth = await svc.authorize({ cardId: card.id, authorizationRef: 'jb14-race', amount: amt('40') });
      expect(auth).toMatchObject({ decision: 'declined', declineCode: 'bank.card_partner_insufficient_funds', status: 'rejected' });
    });

    it('if the partner’s reply is lost, the row stays pending and a redelivery re-sends the same key, holding once', async () => {
      const card = await issue();
      let drops = 1;
      const lossy: PartnerCardHolds = {
        ...holds,
        hold: async (input) => {
          const answer = await holds.hold(input);
          if (drops-- > 0) throw new Error('socket hang up');
          return answer;
        },
      };
      const svc = build({ holds: lossy }).cards;
      await expect(svc.authorize({ cardId: card.id, authorizationRef: 'jb14-lost', amount: amt('40') })).rejects.toThrow('socket hang up');
      const [row] = await sql<Array<{ status: string; partner_hold_ref: string | null }>>`
        SELECT status, partner_hold_ref FROM bank.card_authorizations WHERE authorization_ref = 'jb14-lost'
      `;
      expect(row).toEqual({ status: 'pending', partner_hold_ref: null });
      const redriven = await svc.authorize({ cardId: card.id, authorizationRef: 'jb14-lost', amount: amt('40') });
      expect(redriven).toMatchObject({ decision: 'approved', status: 'settled', heldBy: 'partner' });
      expect(await holds.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '60', held: '40' });
      expect(ledger.journal()).toHaveLength(0);
    });

    it('captures at the partner, gives the rest back, and the ledger still posts nothing (no cashback, no round-up)', async () => {
      const card = await issue();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'jb14-capture', amount: amt('40') });
      const result = await cards.capture({ cardId: card.id, authorizationRef: 'jb14-capture', amount: amt('30') });
      expect(result).toMatchObject({
        heldBy: 'partner',
        captured: amt('30'),
        returned: amt('10'),
        captureLedgerTxId: null,
        reversalLedgerTxId: null,
        cashback: { status: 'refused', reason: 'bank.card_partner_held' },
        roundUp: { status: 'skipped', reason: 'bank.card_partner_held' },
      });
      expect(result.partner?.captureRef).toBe(`TEST-card-partner:${partnerCardKey('capture', auth.id)}`);
      expect(result.partner?.releaseRef).toBe(`TEST-card-partner:${partnerCardKey('release', auth.id)}`);
      expect(result.partner?.figures).toMatchObject({ available: '70', held: '0' });
      expect(ledger.journal()).toHaveLength(0);
      expect(await ledgerKeysFor(auth.id)).toEqual([]);
      // Captured once: a second capture is refused as closed, and the partner's figures did not move.
      expect(await codeOf(cards.capture({ cardId: card.id, authorizationRef: 'jb14-capture', amount: amt('30') }))).toBe(
        'bank.card_authorization_closed',
      );
      expect(await holds.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '70', held: '0' });
    });

    it('a capture above the authorised amount is refused by the partner, and one within it then captures', async () => {
      const card = await issue();
      await cards.authorize({ cardId: card.id, authorizationRef: 'jb14-over', amount: amt('40') });
      expect(await codeOf(cards.capture({ cardId: card.id, authorizationRef: 'jb14-over', amount: amt('40.01') }))).toBe(
        'bank.card_partner_capture_exceeds_hold',
      );
      const [claim] = await sql<Array<{ status: string; rejection_code: string }>>`
        SELECT s.status, s.rejection_code FROM bank.card_settlements s
          JOIN bank.card_authorizations a ON a.id = s.authorization_id WHERE a.authorization_ref = 'jb14-over'
      `;
      expect(claim).toEqual({ status: 'rejected', rejection_code: 'bank.card_partner_capture_exceeds_hold' });
      expect(await holds.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '60', held: '40' });
      const ok = await cards.capture({ cardId: card.id, authorizationRef: 'jb14-over', amount: amt('40') });
      expect(ok).toMatchObject({ captured: amt('40'), returned: 0n, partner: { releaseRef: null } });
      expect(ledger.journal()).toHaveLength(0);
    });

    it('releases on our instruction, once', async () => {
      const card = await issue();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'jb14-void', amount: amt('40') });
      const released = await cards.reverse({ cardId: card.id, authorizationRef: 'jb14-void' });
      expect(released).toMatchObject({
        returned: amt('40'),
        ledgerTxId: null,
        partner: { by: 'instruction', figures: { available: '100', held: '0' } },
      });
      expect(await codeOf(cards.reverse({ cardId: card.id, authorizationRef: 'jb14-void' }))).toBe('bank.card_authorization_closed');
      expect(await ledgerKeysFor(auth.id)).toEqual([]);
    });

    it('an uncaptured hold is given back by the partner after its hold time, as the partner reports, and recorded once', async () => {
      const card = await issue();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'jb14-expire', amount: amt('40') });
      partner.set(ADA, { cardHold: 'expired' });
      const view = await cards.partnerHeld(card.id, 10);
      expect(view.authorizations[0]?.report).toMatchObject({ status: 'expired', released: '40', open: '0' });
      expect(view.figures).toMatchObject({ available: '100', held: '0' });
      // A capture after expiry is the partner's no.
      expect(await codeOf(cards.capture({ cardId: card.id, authorizationRef: 'jb14-expire', amount: amt('1') }))).toBe(
        'bank.card_partner_hold_closed',
      );
      // Recording the expiry: the partner's answer says it was its own hold time, not our instruction.
      const recorded = await cards.reverse({ cardId: card.id, authorizationRef: 'jb14-expire' });
      expect(recorded).toMatchObject({ returned: amt('40'), ledgerTxId: null, partner: { by: 'expiry' } });
      expect(await ledgerKeysFor(auth.id)).toEqual([]);
    });

    it('a merchant refund is the partner’s, once per authorisation, never above what was captured', async () => {
      const card = await issue();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'jb14-refund', amount: amt('40') });
      expect(await codeOf(cards.refund({ cardId: card.id, authorizationRef: 'jb14-refund', amount: amt('5') }))).toBe(
        'bank.card_refund_nothing_captured',
      );
      await cards.capture({ cardId: card.id, authorizationRef: 'jb14-refund', amount: amt('40') });
      expect(await codeOf(cards.refund({ cardId: card.id, authorizationRef: 'jb14-refund', amount: amt('41') }))).toBe(
        'bank.card_partner_refund_exceeds_capture',
      );
      const refund = await cards.refund({ cardId: card.id, authorizationRef: 'jb14-refund', amount: amt('15') });
      expect(refund).toMatchObject({ refunded: amt('15'), partnerRef: `TEST-card-partner:${partnerCardKey('refund', auth.id)}` });
      expect(refund.figures).toMatchObject({ available: '75', held: '0' });
      const again = await cards.refund({ cardId: card.id, authorizationRef: 'jb14-refund', amount: amt('15') });
      expect(again.partnerRef).toBe(refund.partnerRef);
      expect(await holds.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '75' });
      expect(await codeOf(cards.refund({ cardId: card.id, authorizationRef: 'jb14-refund', amount: amt('10') }))).toBe(
        'bank.card_refund_amount_conflict',
      );
      expect(ledger.journal()).toHaveLength(0);
    });

    it('a capture whose reply was lost is re-sent by resumeSettlements under the same key, once', async () => {
      const card = await issue();
      let drops = 1;
      const lossy: PartnerCardHolds = {
        ...holds,
        capture: async (input) => {
          const answer = await holds.capture(input);
          if (drops-- > 0) throw new Error('timeout');
          return answer;
        },
      };
      const svc = build({ holds: lossy }).cards;
      await svc.authorize({ cardId: card.id, authorizationRef: 'jb14-resume', amount: amt('40') });
      await expect(svc.capture({ cardId: card.id, authorizationRef: 'jb14-resume', amount: amt('40') })).rejects.toThrow('timeout');
      const resumed = await svc.resumeSettlements({ cardId: card.id, authorizationRef: 'jb14-resume' });
      expect(resumed.resumed).toEqual([expect.objectContaining({ sequence: 0, kind: 'capture', outcome: 'settled' })]);
      expect(resumed.held).toBe(0n);
      expect(await holds.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '60', held: '0' });
      expect(ledger.journal()).toHaveLength(0);
    });

    it('wallet_pull: the card pulls from the person’s own wallet, as the partner answers, TEST, and INTAFACED holds nothing', async () => {
      terms = { ...PARTNER, custodyMode: 'wallet_pull' };
      const card = await issue();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'jb14-wallet', amount: amt('20') });
      expect(auth).toMatchObject({ decision: 'approved', heldBy: 'partner', partnerMode: 'wallet_pull' });
      const view = await cards.partnerHeld(card.id, 10);
      expect(view.figures).toMatchObject({ test: true, mode: 'wallet_pull' });
      expect(view.authorizations[0]?.report).toMatchObject({ test: true, mode: 'wallet_pull', status: 'held' });
      expect(ledger.journal()).toHaveLength(0);
    });

    it('the partner’s refusal to hold after our read is a decline naming its reason, not a pending row re-driven forever', async () => {
      const card = await issue();
      const refusing: PartnerCardHolds = {
        ...holds,
        hold: async () => {
          throw new PartnerCardRefusal('mode withdrawn', 'bank.card_partner_mode_not_known');
        },
      };
      const svc = build({ holds: refusing }).cards;
      const auth = await svc.authorize({ cardId: card.id, authorizationRef: 'jb14-refused', amount: amt('5') });
      expect(auth).toMatchObject({ decision: 'declined', declineCode: 'bank.card_partner_mode_not_known', status: 'rejected' });
      expect(ledger.journal()).toHaveLength(0);
    });

    it('resumeSettlements does not re-send a capture the partner refused', async () => {
      const card = await issue();
      await cards.authorize({ cardId: card.id, authorizationRef: 'jb14-noresend', amount: amt('40') });
      expect(await codeOf(cards.capture({ cardId: card.id, authorizationRef: 'jb14-noresend', amount: amt('41') }))).toBe(
        'bank.card_partner_capture_exceeds_hold',
      );
      const resumed = await cards.resumeSettlements({ cardId: card.id, authorizationRef: 'jb14-noresend' });
      expect(resumed).toMatchObject({ resumed: [], held: amt('40') });
    });

    it('on a converted card the merchant’s own ceiling is kept before the partner is asked', async () => {
      terms = { ...PARTNER, balances: { USDC: '100', BTC: '1' } };
      const NOW = new Date('2026-11-09T00:00:00Z');
      const rates = {
        marks: async (ids: readonly string[]) =>
          new Map(ids.map((assetId) => [assetId, { assetId, price: amt('50000'), asOf: NOW, quality: 'mid' as const }])),
      };
      const svc = new CardService(sql, ledger, {
        issuer: cardSim({ partner: terms }),
        rates,
        clock: () => NOW,
        heldBy: () => 'partner',
        partnerHolds: holds,
      });
      const card = await svc.issue({
        cardId: randomUUID(),
        userId: ADA,
        assetId: 'BTC',
        settlementAssetId: 'USDT',
        perAuthorizationLimit: amt('1'),
      });
      const auth = await svc.authorize({ cardId: card.id, authorizationRef: 'jb14-fx', amount: amt('100') });
      expect(auth).toMatchObject({ decision: 'approved', heldBy: 'partner' });
      expect(await codeOf(svc.capture({ cardId: card.id, authorizationRef: 'jb14-fx', amount: amt('100.000001') }))).toBe(
        'bank.card_capture_exceeds_authorization',
      );
      expect(await sql`SELECT 1 FROM bank.card_settlements WHERE authorization_id = ${auth.id}`).toHaveLength(0);
      const done = await svc.capture({ cardId: card.id, authorizationRef: 'jb14-fx', amount: amt('100') });
      expect(done).toMatchObject({ heldBy: 'partner', captured: auth.amount, returned: 0n });
      expect(ledger.journal()).toHaveLength(0);
    });

    it('a stolen card is closed and replaced even when the partner cannot release a hold it forgot', async () => {
      const card = await issue();
      await cards.authorize({ cardId: card.id, authorizationRef: 'jb14-stolen', amount: amt('10') });
      // A restart: the TEST partner forgets every hold.
      const forgetful = testPartnerCardHolds({ terms: () => terms, switches: (u) => partner.switches(u) });
      const svc = build({ holds: forgetful }).cards;
      const replacement = await svc.replace({ cardId: card.id, userId: ADA, replacementId: randomUUID(), reason: 'stolen' });
      expect(replacement.status).toBe('active');
      expect((await svc.card(card.id)).status).toBe('closed');
      expect(ledger.journal()).toHaveLength(0);
    });

    it('a stolen card whose release fails before it is claimed stays frozen and open, and the retried report releases it', async () => {
      const card = await issue();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'jb14-unclaimed', amount: amt('10') });
      // The same rows, read by a programme with no partner wired: the release fails in `requirePartnerHolds`, before any
      // claim row exists, so nothing would ever re-drive it if the error were dropped.
      const unwired = new CardService(sql, ledger, { issuer: cardSim({ partner: terms }), heldBy: () => 'partner' });
      const replacementId = randomUUID();
      expect(await codeOf(unwired.replace({ cardId: card.id, userId: ADA, replacementId, reason: 'stolen' }))).toBe(
        'bank.card_partner_holds_unset',
      );
      expect((await cards.card(card.id)).status).toBe('frozen');
      expect(await sql`SELECT 1 FROM bank.card_settlements WHERE authorization_id = ${auth.id}`).toHaveLength(0);
      // The retried report, with the partner wired, releases the hold and closes the card.
      await cards.replace({ cardId: card.id, userId: ADA, replacementId, reason: 'stolen' });
      expect((await cards.card(card.id)).status).toBe('closed');
      const [claim] = await sql<Array<{ kind: string; status: string }>>`
        SELECT kind, status FROM bank.card_settlements WHERE authorization_id = ${auth.id} AND sequence = 0
      `;
      expect(claim).toMatchObject({ kind: 'reversal', status: 'settled' });
      expect(ledger.journal()).toHaveLength(0);
    });

    it('a refund replayed returns the partner’s reference, and no figures it did not read', async () => {
      const card = await issue();
      await cards.authorize({ cardId: card.id, authorizationRef: 'jb14-replay', amount: amt('10') });
      await cards.capture({ cardId: card.id, authorizationRef: 'jb14-replay', amount: amt('10') });
      const first = await cards.refund({ cardId: card.id, authorizationRef: 'jb14-replay', amount: amt('4') });
      expect(first.figures).toMatchObject({ available: '94' });
      const replay = await cards.refund({ cardId: card.id, authorizationRef: 'jb14-replay', amount: amt('4') });
      expect(replay).toMatchObject({ partnerRef: first.partnerRef, figures: null });
    });

    it('the down migration refuses, changing nothing, while a partner-held row exists', async () => {
      const card = await issue();
      await cards.authorize({ cardId: card.id, authorizationRef: 'jb14-down', amount: amt('10') });
      const down = readFileSync(join(drizzle, '20261108231000_card_partner_held.down.sql'), 'utf8');
      await expect(sql.unsafe(down)).rejects.toThrow(/partner-held card rows exist/);
      const [row] = await sql<
        Array<{ money_book: string }>
      >`SELECT money_book FROM bank.card_authorizations WHERE authorization_ref = 'jb14-down'`;
      expect(row).toEqual({ money_book: 'partner' });
    });

    it('a partner that has not said its mode, or reports no balance, refuses before anything is written', async () => {
      terms = { ...PARTNER, custodyMode: null };
      const card = await issue();
      expect(await codeOf(cards.authorize({ cardId: card.id, authorizationRef: 'jb14-mode', amount: amt('1') }))).toBe(
        'bank.card_partner_mode_not_known',
      );
      terms = PARTNER;
      const btc = await issue(cards, 'BTC');
      expect(await codeOf(cards.authorize({ cardId: btc.id, authorizationRef: 'jb14-btc', amount: amt('1') }))).toBe(
        'bank.card_partner_balance_not_known',
      );
      expect(await sql`SELECT 1 FROM bank.card_authorizations`).toHaveLength(0);
    });

    it('a card programme with no partner that holds authorisations refuses by name, writing nothing', async () => {
      const svc = new CardService(sql, ledger, { issuer: cardSim({ partner: PARTNER }), heldBy: () => 'partner' });
      const card = await issue(svc);
      expect(await codeOf(svc.authorize({ cardId: card.id, authorizationRef: 'jb14-noport', amount: amt('1') }))).toBe(
        'bank.card_partner_holds_unset',
      );
      expect(await sql`SELECT 1 FROM bank.card_authorizations`).toHaveLength(0);
    });
  });

  describe('custody switch unset: the custodial layer, exactly as before', () => {
    async function funded() {
      await ledger.post(
        recipes.deposit({ userId: ADA, assetId: 'USDC', amount: amt('100'), rail: 'test', railRef: `fund:${randomUUID()}` }),
      );
    }

    it('holds, captures and reverses in the ledger, under the custodial keys', async () => {
      await funded();
      const card = await issue();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'later-1', amount: amt('40') });
      expect(auth).toMatchObject({ decision: 'approved', heldBy: 'ledger', partnerHoldRef: null, partnerMode: null });
      expect(auth.holdLedgerTxId).toBe((await ledger.getTxByKey(`withdraw.hold:${auth.id}`))?.id);
      const result = await cards.capture({ cardId: card.id, authorizationRef: 'later-1', amount: amt('30') });
      expect(result).toMatchObject({ heldBy: 'ledger', partner: null });
      expect(result.captureLedgerTxId).toBe((await ledger.getTxByKey(`withdraw.settle:${auth.id}`))?.id);
      expect(formatAmount((await ledger.balance(userAvailable(ADA, 'USDC'))).amount)).toBe('70');
      // The partner was never asked.
      expect(await holds.holdState({ holdKey: partnerCardKey('hold', auth.id) })).toBeNull();
      expect(await holds.figures({ userId: ADA, assetId: 'USDC' })).toMatchObject({ available: '100', held: '0' });
    });

    it('an authorisation held in the ledger stays in the ledger when the switch is flipped later', async () => {
      await funded();
      const card = await issue();
      const auth = await cards.authorize({ cardId: card.id, authorizationRef: 'later-flip', amount: amt('40') });
      partner.set(ADA, { custody: 'off' });
      const released = await cards.reverse({ cardId: card.id, authorizationRef: 'later-flip' });
      expect(released.ledgerTxId).toBe((await ledger.getTxByKey(`withdraw.reverse:${auth.id}`))?.id);
      expect(await holds.holdState({ holdKey: partnerCardKey('hold', auth.id) })).toBeNull();
    });

    it('a refund on a ledger-held card is not built, and says so', async () => {
      await funded();
      const card = await issue();
      await cards.authorize({ cardId: card.id, authorizationRef: 'later-refund', amount: amt('40') });
      await cards.capture({ cardId: card.id, authorizationRef: 'later-refund', amount: amt('40') });
      expect(await codeOf(cards.refund({ cardId: card.id, authorizationRef: 'later-refund', amount: amt('1') }))).toBe(
        'bank.card_refund_not_built',
      );
    });
  });

  describe('the custodial layer off and no partner set', () => {
    it('refuses `bank.partner_unset` before anything is written, rather than meeting the ledger’s raw refusal', async () => {
      layer = 'off';
      const svc = build({ holds }).cards;
      const card = await issue(svc);
      expect(await codeOf(svc.authorize({ cardId: card.id, authorizationRef: 'no-partner', amount: amt('1') }))).toBe('bank.partner_unset');
      expect(await sql`SELECT 1 FROM bank.card_authorizations`).toHaveLength(0);
      expect(ledger.journal()).toHaveLength(0);
    });

    it('a person with the TEST switch off is still partner-held with the layer off', async () => {
      layer = 'off';
      partner.set(ADA, { custody: 'off' });
      const svc = build({ holds }).cards;
      const card = await issue(svc);
      const auth = await svc.authorize({ cardId: card.id, authorizationRef: 'off-partner', amount: amt('5') });
      expect(auth).toMatchObject({ decision: 'approved', heldBy: 'partner' });
      expect(ledger.journal()).toHaveLength(0);
    });
  });

  describe('the doors a journey uses', () => {
    function as(bank: ReturnType<typeof createBankServices>, userId = ADA) {
      const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
      const raw = encodePrincipal({
        sub: userId,
        userId,
        sid: randomUUID(),
        scopes: ['bank:read', 'bank:write'],
        tier: 'full',
        mfa: true,
        expiresAt: new Date(Date.now() + 60_000),
      } as Principal);
      return createBankRouter(bank).createCaller(
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

    it('testPartner.set takes custody and cardHold; partnerHeld and the TEST merchant refund read and move only at the partner', async () => {
      // The composition root's own wiring: the TEST partner card is built from card-sim and the TEST partner.
      const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        testPartner: partner,
        custodyLayer: 'on',
        cards: { issuer: cardSim({ partner: PARTNER }) },
      });
      const caller = as(bank);
      expect(await caller.testPartner.set({ custody: 'off' })).toMatchObject({ custody: 'off', cardHold: 'live' });
      const card = await issue(bank.cards);
      const auth = await bank.cards.authorize({ cardId: card.id, authorizationRef: 'door-1', amount: amt('40') });
      await bank.cards.capture({ cardId: card.id, authorizationRef: 'door-1', amount: amt('40') });
      const view = await caller.cards.partnerHeld({ cardId: card.id, limit: 10 });
      expect(view).toMatchObject({
        heldBy: 'partner',
        figures: { test: true, assetId: 'USDC', available: '60', held: '0' },
        authorizations: [{ authorizationId: auth.id, amount: '40', report: { status: 'captured', captured: '40' } }],
      });
      const refunded = await caller.testPartner.cardRefund({ cardId: card.id, authorizationRef: 'door-1', amount: '10' });
      expect(refunded).toMatchObject({ refunded: '10', figures: { available: '70' } });
      const listed = await caller.cards.authorizations({ cardId: card.id, limit: 10 });
      expect(listed[0]).toMatchObject({ heldBy: 'partner', decision: 'approved' });
      expect(ledger.journal()).toHaveLength(0);
    });

    it('the TEST merchant refund refuses off the TEST stack', async () => {
      const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { cards: { issuer: cardSim({ partner: PARTNER }) } });
      const caller = as(bank);
      await expect(caller.testPartner.cardRefund({ cardId: randomUUID(), authorizationRef: 'door-2', amount: '1' })).rejects.toMatchObject({
        cause: { code: 'bank.test_partner_off' },
      });
    });
  });

  it('a partner refusal is the only error that rejects a claim', () => {
    expect(new PartnerCardRefusal('no', 'bank.card_partner_hold_closed')).toBeInstanceOf(BankError);
  });
});
