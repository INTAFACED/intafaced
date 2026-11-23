import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError, type BankErrorCode } from '../errors.js';
import { assertPostingEnabled, type NoteRefusal, type PostingFreeze } from '../partner/partner-bank.js';
import { TEST_PARTNER_UNLISTED_DECLINE } from '../partner/test-partner.js';
import { type TestPartnerSwitches } from '../partner/test-partner-switches.js';
import { fundingFor } from './conversion.js';
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
  /** The asset the partner holds it in, when it says (a hold taken by a pay-from order always does). */
  readonly assetId?: string;
  /**
   * On a hold the partner took by a pay-from order (J-bank-29 #3, #4): the merchant's amount, the rate the partner held at
   * (one unit of `assetId` in `settlementAssetId`) and the rate's time, all as the partner reports them.
   */
  readonly conversion?: PartnerHoldConversion;
}

export interface PartnerHoldConversion {
  readonly settlementAssetId: string;
  readonly settlementAmount: string;
  readonly rate: string;
  readonly rateAsOf: string;
}

/** The partner's quote for one unit of an asset in a settlement asset, with the quote's own time. */
export interface PartnerRateQuote {
  readonly rate: string;
  readonly asOf: string;
}

/**
 * The partner's answer to a hold by a pay-from order. Approved: it held from the first asset in the order that covers the
 * payment at its own rate, and `hold` names the asset, the amount and the rate. Declined: no one asset covered it, and
 * nothing is held; `reason` is the partner's code (`bank.card_insufficient_funds` when no asset covers it).
 */
export type PartnerOrderHoldAnswer =
  | {
      readonly approved: true;
      readonly hold: PartnerHoldReport & { readonly assetId: string; readonly conversion: PartnerHoldConversion };
      readonly figures: PartnerCardFigures;
    }
  | { readonly approved: false; readonly reason: string; readonly order: readonly string[] };

export type PartnerHoldAnswer =
  | { readonly approved: true; readonly hold: PartnerHoldReport; readonly figures: PartnerCardFigures }
  /**
   * The partner's no, with its reason code: `bank.card_partner_insufficient_funds`, or any code of the partner's own,
   * which is recorded and shown as it came, raw when nothing here has words for it (J-bank-14 #6).
   */
  | { readonly approved: false; readonly reason: string; readonly figures: PartnerCardFigures };

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
  /**
   * What the partner has captured for this cardholder in this asset, as it reports it (J-bank-26 #5), or null when it
   * reports no such figure. A partner without this read leaves it out, and the figure reads "not known".
   */
  captured?(input: { userId: string; assetId: string }): Promise<string | null>;
  /**
   * The partner's quote for one unit of `assetId` in `settlementAssetId` (J-bank-29 #2), or null when it quotes none. A
   * partner without quotes leaves it out, and every rate reads "not known".
   */
  quote?(input: { assetId: string; settlementAssetId: string }): Promise<PartnerRateQuote | null>;
  /**
   * Hold `amount` of `settlementAssetId` from the first asset in `order` that covers it, at the partner's own rate, once
   * under `key` (J-bank-29 #3 to #5). One asset per authorisation: the partner never splits a payment across two. A partner
   * without this instruction leaves it out, and a card with a saved order holds in its own asset as before.
   */
  holdInOrder?(input: {
    key: string;
    userId: string;
    order: readonly string[];
    settlementAssetId: string;
    amount: string;
  }): Promise<PartnerOrderHoldAnswer>;
}

/** The partner said no to an instruction. Nothing moved at the partner. */
export class PartnerCardRefusal extends BankError {
  constructor(message: string, code: BankErrorCode) {
    super(message, code);
    this.name = 'PartnerCardRefusal';
  }
}

/**
 * THE POSTING FREEZE ON PARTNER CARD MONEY (floor 4; project-state #1790). svc-ledger's platform-wide posting freeze
 * stops partner card instructions too: every hold, capture, release and refund asks it first, and frozen, or a freeze
 * that cannot be read, refuses `bank.posting_frozen` before the partner is asked. That error is not a
 * `PartnerCardRefusal`: the partner never said no, so a capture, release or refund claim stays pending and is re-sent
 * under the same key once posting is back, never retired as if the partner had refused. A hold the freeze refuses is
 * a decline (`card-service.ts`, `commitPartnerHold`). Reads (figures, holdState) stay open, as they do on the ledger.
 */
export function freezeGuardedCardHolds(holds: PartnerCardHolds, freeze: PostingFreeze, note?: NoteRefusal): PartnerCardHolds {
  return Object.freeze({
    test: holds.test,
    figures: (input: { userId: string; assetId: string }) => holds.figures(input),
    holdState: (input: { holdKey: string }) => holds.holdState(input),
    ...(holds.captured ? { captured: holds.captured.bind(holds) } : {}),
    ...(holds.quote ? { quote: holds.quote.bind(holds) } : {}),
    ...(holds.holdInOrder
      ? {
          holdInOrder: async (input: Parameters<NonNullable<PartnerCardHolds['holdInOrder']>>[0]) => {
            await assertPostingEnabled(freeze, 'card_hold', note);
            return holds.holdInOrder!(input);
          },
        }
      : {}),
    hold: async (input: Parameters<PartnerCardHolds['hold']>[0]) => {
      await assertPostingEnabled(freeze, 'card_hold', note);
      return holds.hold(input);
    },
    capture: async (input: Parameters<PartnerCardHolds['capture']>[0]) => {
      await assertPostingEnabled(freeze, 'card_capture', note);
      return holds.capture(input);
    },
    release: async (input: Parameters<PartnerCardHolds['release']>[0]) => {
      await assertPostingEnabled(freeze, 'card_release', note);
      return holds.release(input);
    },
    refund: async (input: Parameters<PartnerCardHolds['refund']>[0]) => {
      await assertPostingEnabled(freeze, 'card_refund', note);
      return holds.refund(input);
    },
  });
}

/** The TEST partner card's hold time, a TEST figure (no partner has given one). */
export const TEST_CARD_HOLD_DAYS = 7;

/** The most holds and answers the TEST partner keeps; past this the oldest go, as the switches do. */
const MAX_KEPT = 50_000;

interface Book {
  available: Amount;
  held: Amount;
  /** This book's holds that still hold something: the only ones a hold time can run out. */
  readonly open: Set<Hold>;
}

interface Hold {
  readonly ref: string;
  readonly userId: string;
  readonly assetId: string;
  /** The book it holds from, kept on the hold so a book the map lets go of is never lost under an open hold. */
  readonly book: Book;
  readonly mode: CardCustodyMode;
  readonly amount: Amount;
  readonly expiresAt: Date;
  /** Set when the hold was taken by a pay-from order: the partner's rate and the merchant's amount. */
  readonly conversion: PartnerHoldConversion | null;
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
 * Past its bound the TEST partner lets go of its oldest records; a hold keeps its own book, so an open hold is never
 * orphaned, but a person whose book was let go of starts again from the TEST figure (a TEST artefact of a stack past
 * 50,000 people and assets, never a real partner's).
 *
 * Every instruction is answered once per key: a repeat of a key with the same body returns the first answer, and with a
 * different body refuses `bank.card_partner_key_conflict`. A refusal is not kept under its key, because nothing happened.
 */
export function testPartnerCardHolds(options: {
  readonly terms: () => CardPartnerTerms;
  /** The person's TEST partner switches (`cardHold: 'expired'` runs every open hold of theirs out). */
  readonly switches: (userId: string) => TestPartnerSwitches;
  /**
   * What else the TEST partner has credited this cardholder in this asset outside its card holds (its provisional dispute
   * credits, J-bank-15 #4, J-bank-27 #3), so its one spendable figure counts both. Absent is none.
   */
  readonly credited?: (userId: string, assetId: string) => Amount;
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
    const book: Book = { available: parseAmount(reported), held: 0n, open: new Set() };
    keep(books, id, book);
    return book;
  };

  const open = (h: Hold): Amount => h.amount - h.captured - h.released;
  /** After a move: a hold that holds nothing more leaves its book's open set. */
  const settle = (h: Hold): void => {
    if (open(h) === 0n) h.book.open.delete(h);
  };

  /** The partner gives an uncaptured hold back when its hold time runs out, or when the person's TEST switch says so. */
  const runOut = (h: Hold): void => {
    if (h.expired || h.captured > 0n || open(h) === 0n) return;
    if (clock() < h.expiresAt && options.switches(h.userId).cardHold !== 'expired') return;
    const back = open(h);
    h.book.held -= back;
    h.book.available += back;
    h.released += back;
    h.expired = true;
    settle(h);
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
      assetId: h.assetId,
      ...(h.conversion ? { conversion: h.conversion } : {}),
    };
  };

  /** The TEST partner's quote: its own TEST rate, stamped with its clock now. With any rates reported, the asset they are in is 1. */
  const quoteOf = (assetId: string, settlementAssetId: string): { rate: Amount; asOf: Date } | null => {
    const rates = options.terms().rates;
    if (!rates || rates.in !== settlementAssetId) return null;
    if (assetId === settlementAssetId) return { rate: parseAmount('1'), asOf: clock() };
    const raw = rates.perUnit[assetId];
    return raw === undefined ? null : { rate: parseAmount(raw), asOf: clock() };
  };

  /** What can be spent from a book now: its own figure and anything else the partner credited the cardholder. */
  const spendable = (userId: string, assetId: string, book: Book): Amount => book.available + (options.credited?.(userId, assetId) ?? 0n);

  const figuresOf = (userId: string, assetId: string): PartnerCardFigures => {
    const book = bookOf(userId, assetId);
    return {
      test: true,
      mode: options.terms().custodyMode,
      assetId,
      available: book ? formatAmount(spendable(userId, assetId, book)) : null,
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
      const book = books.get(`${userId}|${assetId}`);
      if (book) for (const h of [...book.open]) runOut(h);
      return figuresOf(userId, assetId);
    },

    captured: async ({ userId, assetId }) => {
      if (bookOf(userId, assetId) === null) return null;
      let sum = 0n;
      for (const h of holds.values()) if (h.userId === userId && h.assetId === assetId) sum += h.captured;
      return formatAmount(sum);
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
        if (options.switches(userId).cardDecline === 'unlisted') {
          return { approved: false, reason: TEST_PARTNER_UNLISTED_DECLINE, figures: figuresOf(userId, assetId) };
        }
        if (want > spendable(userId, assetId, book)) {
          return { approved: false, reason: 'bank.card_partner_insufficient_funds', figures: figuresOf(userId, assetId) };
        }
        book.available -= want;
        book.held += want;
        const h: Hold = {
          ref: ref(key),
          userId,
          assetId,
          book,
          mode,
          amount: want,
          expiresAt: new Date(clock().getTime() + TEST_CARD_HOLD_DAYS * 86_400_000),
          conversion: null,
          captured: 0n,
          released: 0n,
          refunded: 0n,
          expired: false,
        };
        keep(holds, key, h);
        book.open.add(h);
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
        h.book.held -= take;
        h.captured = take;
        settle(h);
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
        h.book.held -= back;
        h.book.available += back;
        h.released += back;
        settle(h);
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
        h.book.available += back;
        h.refunded += back;
        return { partnerRef: ref(key), amount, by: 'instruction', hold: report(h), figures: figuresOf(h.userId, h.assetId) };
      }),

    quote: async ({ assetId, settlementAssetId }) => {
      const q = quoteOf(assetId, settlementAssetId);
      return q ? { rate: formatAmount(q.rate), asOf: q.asOf.toISOString() } : null;
    },

    holdInOrder: async ({ key, userId, order, settlementAssetId, amount }) =>
      once(key, { op: 'holdInOrder', userId, order: order.join(','), settlementAssetId, amount }, (): PartnerOrderHoldAnswer => {
        const mode = options.terms().custodyMode;
        if (mode === null) {
          throw new PartnerCardRefusal(
            'The TEST card partner has not said whether it holds the crypto or pulls from the wallet. Nothing was held.',
            'bank.card_partner_mode_not_known',
          );
        }
        const spendFrom = options.terms().spendFrom ?? [];
        const merchant = parseAmount(amount);
        if (options.switches(userId).cardDecline === 'unlisted') {
          return { approved: false, reason: TEST_PARTNER_UNLISTED_DECLINE, order: [...order] };
        }
        // The first asset in the person's order that covers the whole payment at the partner's rate. One asset only.
        for (const assetId of order) {
          if (!spendFrom.includes(assetId)) continue;
          const book = bookOf(userId, assetId);
          const q = quoteOf(assetId, settlementAssetId);
          if (!book || !q) continue;
          for (const h of [...book.open]) runOut(h);
          const want = fundingFor(merchant, q.rate);
          if (want <= 0n || want > spendable(userId, assetId, book)) continue;
          book.available -= want;
          book.held += want;
          const conversion: PartnerHoldConversion = {
            settlementAssetId,
            settlementAmount: formatAmount(merchant),
            rate: formatAmount(q.rate),
            rateAsOf: q.asOf.toISOString(),
          };
          const h: Hold = {
            ref: ref(key),
            userId,
            assetId,
            book,
            mode,
            amount: want,
            expiresAt: new Date(clock().getTime() + TEST_CARD_HOLD_DAYS * 86_400_000),
            conversion,
            captured: 0n,
            released: 0n,
            refunded: 0n,
            expired: false,
          };
          keep(holds, key, h);
          book.open.add(h);
          return { approved: true, hold: { ...report(h), assetId, conversion }, figures: figuresOf(userId, assetId) };
        }
        return { approved: false, reason: 'bank.card_insufficient_funds', order: [...order] };
      }),

    holdState: async ({ holdKey }) => {
      const h = holds.get(holdKey);
      if (!h) return null;
      runOut(h);
      return report(h);
    },
  };
}
