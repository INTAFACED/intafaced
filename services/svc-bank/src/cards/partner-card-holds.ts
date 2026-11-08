import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError, type BankErrorCode } from '../errors.js';
import type { TestPartnerSwitches } from '../partner/test-partner.js';
import type { CardCustodyMode, CardPartnerTerms } from './partner-terms.js';

/**
 * PARTNER-HELD CARD AUTHORISATIONS (OWNER 226; B3's decision on project-state #1790, seam B).
 *
 * INTAFACED launches holding no customer money: the card and its money sit with the card partner. For a person whose
 * money is partner-held (`custody: 'off'` on the TEST stack, `partner/test-partner.ts`), an approved authorisation is
 * held BY THE PARTNER, from the partner balance, and captured, released and refunded there, each once under a business
 * key derived from OUR authorisation id (`partnerCardKey`). The partner's figures are read back as it reports them.
 * INTAFACED's ledger posts nothing on this path: no `withdrawHold`, no `withdrawSettle`, no `withdrawReverse`, no
 * cashback (`card-service.ts` dispatches on the authorisation's own `held_by`).
 *
 * This is the port. A named partner implements it later; today only the TEST partner card does
 * (`testPartnerCardHolds`, below). Amounts on the port are decimal strings, as on any wire; never a `number`.
 *
 * WHICH ERRORS ARE ANSWERS. A `PartnerCardRefusal` is the partner saying no to an instruction: nothing moved there, so
 * the claim on our side may be retired and asked again. Anything else (a timeout, a dropped reply) may follow an
 * instruction the partner did carry out, so our claim stays pending and a retry re-sends the same key.
 */

/** The four instructions, and the one business key each is sent under. */
export type PartnerCardInstruction = 'hold' | 'capture' | 'release' | 'refund';

/** `card.partner.<instruction>:<authorisation uuid>`: our id, never the network's reference. */
export function partnerCardKey(instruction: PartnerCardInstruction, authorizationId: string): string {
  return `card.partner.${instruction}:${authorizationId}`;
}

/** What the partner reports for one cardholder and asset. Each null is "not known", never 0. */
export interface PartnerCardFigures {
  /** True on the TEST partner card: every surface that shows these says TEST. */
  readonly test: boolean;
  /** Whether the partner holds the person's crypto or the card pulls from their own wallet; null is "not known". */
  readonly mode: CardCustodyMode | null;
  readonly assetId: string;
  /** What the partner says can be spent now. In `wallet_pull` mode, the wallet's figure as the partner reports it. */
  readonly available: string | null;
  /** What the partner holds against open authorisations. */
  readonly held: string | null;
}

export type PartnerHoldStatus = 'held' | 'captured' | 'released' | 'expired';

/** One hold as the partner reports it. */
export interface PartnerHoldReport {
  readonly test: boolean;
  readonly partnerRef: string;
  readonly mode: CardCustodyMode;
  /**
   * `held`: the whole amount is held. `captured`: some was captured (any remainder is still held until released).
   * `released`: given back by an instruction. `expired`: given back by the partner when its hold time ran out.
   */
  readonly status: PartnerHoldStatus;
  readonly amount: string;
  readonly captured: string;
  readonly released: string;
  readonly refunded: string;
  /** Still held: amount less captured and released. */
  readonly open: string;
  /** When the partner's hold time runs out, as it reports it; null is "not known". */
  readonly expiresAt: string | null;
}

export type PartnerHoldAnswer =
  | { readonly approved: true; readonly hold: PartnerHoldReport; readonly figures: PartnerCardFigures }
  | { readonly approved: false; readonly reason: 'bank.card_partner_insufficient_funds'; readonly figures: PartnerCardFigures };

export interface PartnerMoveAnswer {
  /** The partner's own reference for this instruction. */
  readonly partnerRef: string;
  /** What this instruction moved, as the partner reports it. */
  readonly amount: string;
  /** `expiry` when the partner had already given the hold back because its hold time ran out. */
  readonly by: 'instruction' | 'expiry';
  readonly hold: PartnerHoldReport;
  readonly figures: PartnerCardFigures;
}

export interface PartnerCardHolds {
  readonly test: boolean;
  /** The partner's figures for this cardholder and asset. Reads only. */
  figures(input: { userId: string; assetId: string }): Promise<PartnerCardFigures>;
  /** Hold `amount` from the partner balance, once under `key`. */
  hold(input: { key: string; userId: string; assetId: string; amount: string }): Promise<PartnerHoldAnswer>;
  /** Capture `amount` of the hold named by `holdKey`, once under `key`. Above what is held, the partner refuses. */
  capture(input: { key: string; holdKey: string; amount: string }): Promise<PartnerMoveAnswer>;
  /** Give back whatever of the hold is still open, once under `key`. */
  release(input: { key: string; holdKey: string }): Promise<PartnerMoveAnswer>;
  /** Refund `amount` of what was captured, once under `key`. Above what was captured, the partner refuses. */
  refund(input: { key: string; holdKey: string; amount: string }): Promise<PartnerMoveAnswer>;
  /** The hold as the partner reports it now, or null when the partner has no record of it. */
  holdState(input: { holdKey: string }): Promise<PartnerHoldReport | null>;
}

/** The partner said no to an instruction. Nothing moved at the partner. */
export class PartnerCardRefusal extends BankError {
  constructor(message: string, code: BankErrorCode) {
    super(message, code);
    this.name = 'PartnerCardRefusal';
  }
}

/** The TEST partner card's hold time, a TEST figure (no partner has given one). */
export const TEST_CARD_HOLD_DAYS = 7;

/** The most holds and answers the TEST partner keeps; past this the oldest go, as the switches do. */
const MAX_KEPT = 50_000;

interface Book {
  available: Amount;
  held: Amount;
}

interface Hold {
  readonly ref: string;
  readonly userId: string;
  readonly assetId: string;
  readonly mode: CardCustodyMode;
  readonly amount: Amount;
  readonly expiresAt: Date;
  captured: Amount;
  released: Amount;
  refunded: Amount;
  expired: boolean;
}

/**
 * THE TEST PARTNER CARD (card-sim's partner, CUSTODY-DELTA §4). In this process only, like the TEST partner's switches:
 * it holds no money and stands in for no real partner, and a restart forgets every hold (a hold it no longer knows reads
 * `bank.card_partner_hold_not_found`, never a guess).
 *
 * Each cardholder's TEST partner balance starts at the figure the TEST partner card reports for the asset
 * (`BANK_CARD_SIM_PARTNER_JSON` `balances`); an asset it reports no figure for is "not known", and no hold can be asked
 * in it. In `wallet_pull` mode the same TEST figure stands for the person's own wallet as the partner reads it: the
 * card pulls from the wallet, the partner's answer says so, and INTAFACED holds nothing either way.
 *
 * Every instruction is answered once per key: a repeat of a key with the same body returns the first answer, and with a
 * different body refuses `bank.card_partner_key_conflict`. A refusal is not kept under its key, because nothing happened.
 */
export function testPartnerCardHolds(options: {
  readonly terms: () => CardPartnerTerms;
  /** The person's TEST partner switches (`cardHold: 'expired'` runs every open hold of theirs out). */
  readonly switches: (userId: string) => TestPartnerSwitches;
  readonly clock?: () => Date;
}): PartnerCardHolds {
  const clock = options.clock ?? (() => new Date());
  const books = new Map<string, Book>();
  const holds = new Map<string, Hold>();
  const answers = new Map<string, { body: string; answer: unknown }>();

  const keep = <V>(map: Map<string, V>, key: string, value: V) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_KEPT) map.delete(map.keys().next().value!);
  };

  const bookOf = (userId: string, assetId: string): Book | null => {
    const id = `${userId}|${assetId}`;
    const kept = books.get(id);
    if (kept) return kept;
    const reported = options.terms().balances?.[assetId];
    if (reported === undefined) return null;
    const book = { available: parseAmount(reported), held: 0n };
    keep(books, id, book);
    return book;
  };

  const open = (h: Hold): Amount => h.amount - h.captured - h.released;

  /** The partner gives an uncaptured hold back when its hold time runs out, or when the person's TEST switch says so. */
  const runOut = (h: Hold): void => {
    if (h.expired || h.captured > 0n || open(h) === 0n) return;
    if (clock() < h.expiresAt && options.switches(h.userId).cardHold !== 'expired') return;
    const book = books.get(`${h.userId}|${h.assetId}`)!;
    const back = open(h);
    book.held -= back;
    book.available += back;
    h.released += back;
    h.expired = true;
  };

  const report = (h: Hold): PartnerHoldReport => {
    const status: PartnerHoldStatus = h.expired ? 'expired' : h.captured > 0n ? 'captured' : h.released > 0n ? 'released' : 'held';
    return {
      test: true,
      partnerRef: h.ref,
      mode: h.mode,
      status,
      amount: formatAmount(h.amount),
      captured: formatAmount(h.captured),
      released: formatAmount(h.released),
      refunded: formatAmount(h.refunded),
      open: formatAmount(open(h)),
      expiresAt: h.expiresAt.toISOString(),
    };
  };

  const figuresOf = (userId: string, assetId: string): PartnerCardFigures => {
    const book = bookOf(userId, assetId);
    return {
      test: true,
      mode: options.terms().custodyMode,
      assetId,
      available: book ? formatAmount(book.available) : null,
      held: book ? formatAmount(book.held) : null,
    };
  };

  /** Answer `key` once: the same body replays, a different one refuses, a refusal is not kept. */
  const once = <T>(key: string, body: Record<string, string>, act: () => T): T => {
    const canonical = JSON.stringify(body);
    const prior = answers.get(key);
    if (prior) {
      if (prior.body !== canonical) {
        throw new PartnerCardRefusal(
          `The TEST card partner already answered ${key} for a different instruction. Nothing moved.`,
          'bank.card_partner_key_conflict',
        );
      }
      return prior.answer as T;
    }
    const answer = act();
    keep(answers, key, { body: canonical, answer });
    return answer;
  };

  const holdFor = (holdKey: string): Hold => {
    const h = holds.get(holdKey);
    if (!h) {
      throw new PartnerCardRefusal(
        `The TEST card partner has no record of ${holdKey} (it forgets on a restart). Nothing moved.`,
        'bank.card_partner_hold_not_found',
      );
    }
    runOut(h);
    return h;
  };

  const ref = (key: string) => `TEST-card-partner:${key}`;

  return {
    test: true,

    figures: async ({ userId, assetId }) => {
      for (const h of holds.values()) if (h.userId === userId && h.assetId === assetId) runOut(h);
      return figuresOf(userId, assetId);
    },

    hold: async ({ key, userId, assetId, amount }) =>
      once(key, { op: 'hold', userId, assetId, amount }, (): PartnerHoldAnswer => {
        const mode = options.terms().custodyMode;
        if (mode === null) {
          throw new PartnerCardRefusal(
            'The TEST card partner has not said whether it holds the crypto or pulls from the wallet. Nothing was held.',
            'bank.card_partner_mode_not_known',
          );
        }
        const book = bookOf(userId, assetId);
        if (!book) {
          throw new PartnerCardRefusal(
            `The TEST card partner reports no ${assetId} balance, so it cannot hold. Nothing was held.`,
            'bank.card_partner_balance_not_known',
          );
        }
        const want = parseAmount(amount);
        if (want > book.available) {
          return { approved: false, reason: 'bank.card_partner_insufficient_funds', figures: figuresOf(userId, assetId) };
        }
        book.available -= want;
        book.held += want;
        const h: Hold = {
          ref: ref(key),
          userId,
          assetId,
          mode,
          amount: want,
          expiresAt: new Date(clock().getTime() + TEST_CARD_HOLD_DAYS * 86_400_000),
          captured: 0n,
          released: 0n,
          refunded: 0n,
          expired: false,
        };
        keep(holds, key, h);
        return { approved: true, hold: report(h), figures: figuresOf(userId, assetId) };
      }),

    capture: async ({ key, holdKey, amount }) =>
      once(key, { op: 'capture', holdKey, amount }, (): PartnerMoveAnswer => {
        const h = holdFor(holdKey);
        if (h.captured > 0n || h.released > 0n) {
          throw new PartnerCardRefusal(
            `The TEST card partner says ${holdKey} is already ${h.expired ? 'expired' : h.captured > 0n ? 'captured' : 'released'}. Nothing moved.`,
            'bank.card_partner_hold_closed',
          );
        }
        const take = parseAmount(amount);
        if (take <= 0n || take > open(h)) {
          throw new PartnerCardRefusal(
            `The TEST card partner refused a capture of ${amount} against a hold of ${formatAmount(open(h))}. Nothing moved.`,
            'bank.card_partner_capture_exceeds_hold',
          );
        }
        const book = books.get(`${h.userId}|${h.assetId}`)!;
        book.held -= take;
        h.captured = take;
        return { partnerRef: ref(key), amount, by: 'instruction', hold: report(h), figures: figuresOf(h.userId, h.assetId) };
      }),

    release: async ({ key, holdKey }) =>
      once(key, { op: 'release', holdKey }, (): PartnerMoveAnswer => {
        const h = holdFor(holdKey);
        if (h.expired) {
          return {
            partnerRef: `${h.ref}:expired`,
            amount: formatAmount(h.released),
            by: 'expiry',
            hold: report(h),
            figures: figuresOf(h.userId, h.assetId),
          };
        }
        const back = open(h);
        if (back === 0n) {
          throw new PartnerCardRefusal(
            `The TEST card partner holds nothing more on ${holdKey}. Nothing moved.`,
            'bank.card_partner_hold_closed',
          );
        }
        const book = books.get(`${h.userId}|${h.assetId}`)!;
        book.held -= back;
        book.available += back;
        h.released += back;
        return {
          partnerRef: ref(key),
          amount: formatAmount(back),
          by: 'instruction',
          hold: report(h),
          figures: figuresOf(h.userId, h.assetId),
        };
      }),

    refund: async ({ key, holdKey, amount }) =>
      once(key, { op: 'refund', holdKey, amount }, (): PartnerMoveAnswer => {
        const h = holdFor(holdKey);
        const back = parseAmount(amount);
        if (back <= 0n || back > h.captured - h.refunded) {
          throw new PartnerCardRefusal(
            `The TEST card partner refused a refund of ${amount} against ${formatAmount(h.captured - h.refunded)} captured. Nothing moved.`,
            'bank.card_partner_refund_exceeds_capture',
          );
        }
        const book = books.get(`${h.userId}|${h.assetId}`)!;
        book.available += back;
        h.refunded += back;
        return { partnerRef: ref(key), amount, by: 'instruction', hold: report(h), figures: figuresOf(h.userId, h.assetId) };
      }),

    holdState: async ({ holdKey }) => {
      const h = holds.get(holdKey);
      if (!h) return null;
      runOut(h);
      return report(h);
    },
  };
}
