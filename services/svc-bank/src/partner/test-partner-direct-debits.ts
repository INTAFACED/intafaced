import { BankError } from '../errors.js';
import type { PartnerMoveRequest } from './partner-bank.js';
import type {
  PartnerDirectDebitFailure,
  PartnerDirectDebitRefund,
  PartnerDirectDebitReport,
  PartnerDirectDebits,
  PartnerMandate,
  PartnerMandateLine,
} from './partner-direct-debits.js';
import { MAX_MOVES, partnerDown, TEST_PARTNER_LABEL, type TestPartnerBook } from './test-partner-book.js';
import type { TestPartnerSwitches } from './test-partner-switches.js';

/** The TEST partner's own reason code for a collection on a mandate the person blocked with it. */
export const TEST_PARTNER_DD_BLOCKED = 'test_partner.dd_mandate_blocked';

/** The prefix of a direct debit collection's partner move key (`direct-debits.ts` collectionPartnerKey). */
const DD_COLLECTION_KEY = 'bank.dd.collection:';

/** The mandate and collection a direct debit collection's partner key names, or null for any other move. */
function ddCollectionOf(key: string): { mandateId: string; collectionId: string } | null {
  if (!key.startsWith(DD_COLLECTION_KEY)) return null;
  const [mandateId, collectionId, ...rest] = key.slice(DD_COLLECTION_KEY.length).split(':');
  return mandateId && collectionId && rest.length === 0 ? { mandateId, collectionId } : null;
}

export interface TestPartnerDirectDebitDesk {
  /** The TEST partner as the bank a direct debit collects from: it keeps each mandate's block (J-bank-06 #4). */
  readonly directDebits: PartnerDirectDebits;
  /** Every direct debit it answers for, read straight from its book (J-bank-28 #4). */
  report(): PartnerDirectDebitReport;
  /** Gives a collected debit back under the scheme's refund guarantee, once (J-bank-28 #4). */
  refund(userId: string, mandateId: string, collectionId: string): PartnerDirectDebitRefund;
  /** A collection's move the partner refuses for want of money is on its record as a refused collection. */
  refusedForFunds(request: PartnerMoveRequest): void;
}

/** The TEST partner's direct debits: mandates, their blocks, refused collections and refunds, on its one book. */
export function testPartnerDirectDebitDesk(
  book: TestPartnerBook,
  switches: (userId: string) => TestPartnerSwitches,
): TestPartnerDirectDebitDesk {
  /** Each mandate the person blocked with the partner, by person and mandate, with the partner's time for it. */
  const ddBlocks = new Map<string, Date>();
  /** Each mandate the partner knows, by person and mandate, with when it first heard of it (J-bank-28 #4). */
  const ddKnown = new Map<string, { readonly userId: string; readonly mandateId: string; readonly knownAt: Date }>();
  /** Each collection the partner refused, by person, mandate and collection: one collection is one refusal. */
  const ddFailures = new Map<string, PartnerDirectDebitFailure>();
  /** Each refund the partner made, by person, mandate and collection: one collection is refunded once. */
  const ddRefunds = new Map<string, PartnerDirectDebitRefund>();

  const knowMandate = (userId: string, mandateId: string) => {
    const key = `${userId}|${mandateId}`;
    if (!ddKnown.has(key) && ddKnown.size < MAX_MOVES) ddKnown.set(key, Object.freeze({ userId, mandateId, knownAt: new Date() }));
  };
  const ddRefused = (userId: string, mandateId: string, collectionId: string, code: string) => {
    knowMandate(userId, mandateId);
    const key = `${userId}|${mandateId}|${collectionId}`;
    if (!ddFailures.has(key) && ddFailures.size < MAX_MOVES) {
      ddFailures.set(key, Object.freeze({ userId, mandateId, collectionId, code, at: new Date() }));
    }
  };
  const mandate = (userId: string, mandateId: string): PartnerMandate => {
    const blockedAt = ddBlocks.get(`${userId}|${mandateId}`) ?? null;
    return Object.freeze({
      mandateId,
      blocked: blockedAt !== null,
      blockedAt,
      refusalCode: blockedAt ? TEST_PARTNER_DD_BLOCKED : null,
      label: TEST_PARTNER_LABEL,
    });
  };

  return {
    refusedForFunds(request) {
      const dd = ddCollectionOf(request.key);
      if (dd) ddRefused(request.from.userId, dd.mandateId, dd.collectionId, 'bank.partner_insufficient_funds');
    },
    directDebits: {
      label: TEST_PARTNER_LABEL,
      async block(userId, mandateId) {
        const key = `${userId}|${mandateId}`;
        if (!ddBlocks.has(key)) {
          if (switches(userId).down) throw partnerDown();
          if (ddBlocks.size >= MAX_MOVES) throw partnerDown();
          ddBlocks.set(key, new Date());
        }
        knowMandate(userId, mandateId);
        return mandate(userId, mandateId);
      },
      async unblock(userId, mandateId) {
        const key = `${userId}|${mandateId}`;
        if (ddBlocks.has(key)) {
          if (switches(userId).down) throw partnerDown();
          ddBlocks.delete(key);
        }
        return mandate(userId, mandateId);
      },
      async mandate(userId, mandateId, forCollection) {
        if (switches(userId).down) throw partnerDown();
        knowMandate(userId, mandateId);
        const answer = mandate(userId, mandateId);
        if (forCollection !== undefined && answer.blocked) ddRefused(userId, mandateId, forCollection, answer.refusalCode!);
        return answer;
      },
      async setUp(userId, mandateId) {
        if (switches(userId).down) throw partnerDown();
        knowMandate(userId, mandateId);
      },
    },
    report() {
      const mandates: PartnerMandateLine[] = [...ddKnown.values()].map((m) => {
        const blockedAt = ddBlocks.get(`${m.userId}|${m.mandateId}`) ?? null;
        return Object.freeze({ ...m, state: blockedAt ? 'blocked' : 'active', blockedAt });
      });
      return Object.freeze({
        label: TEST_PARTNER_LABEL,
        asOf: new Date(),
        mandates,
        failures: [...ddFailures.values()],
        refunds: [...ddRefunds.values()],
      });
    },
    refund(userId, mandateId, collectionId) {
      const key = `${userId}|${mandateId}|${collectionId}`;
      const done = ddRefunds.get(key);
      if (done) return done;
      const collected = book.byKey.get(`${DD_COLLECTION_KEY}${mandateId}:${collectionId}`);
      if (!collected || collected.from.userId !== userId) {
        throw new BankError('The partner collected nothing on that debit, so there is nothing to refund.', 'bank.dd_refund_not_collected');
      }
      if (ddRefunds.size >= MAX_MOVES) throw partnerDown();
      // The partner's own move back, keyed so a retry is the same refund; it shares the move book's checks and record.
      const refundKey = `bank.dd.refund:${mandateId}:${collectionId}`;
      const back = book.byKey.get(refundKey) ?? book.transfer(refundKey, collected.to, collected.from, collected.amount);
      const refund: PartnerDirectDebitRefund = Object.freeze({
        userId,
        mandateId,
        collectionId,
        assetId: back.to.assetId,
        amount: back.amount,
        moveId: back.id,
        refundedAt: back.movedAt,
      });
      ddRefunds.set(key, refund);
      return refund;
    },
  };
}
