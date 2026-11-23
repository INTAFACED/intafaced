import { formatAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { partnerPayInsAccount, type PartnerAccountRef } from './partner-bank.js';
import type {
  PartnerCredit,
  PartnerPaidBy,
  PartnerPurchase,
  PartnerPurchaseHold,
  PartnerPurchaseHolds,
  PartnerPurchaseRelease,
  PartnerPurchases,
  PartnerReturn,
} from './partner-purchases.js';
import { moveConflict, partnerDown, TEST_PARTNER_LABEL, type TestPartnerBook } from './test-partner-book.js';
import type { TestPartnerSwitches } from './test-partner-switches.js';

/**
 * TEST: how long the TEST partner holds back a purchase paid through it before it can be withdrawn (J-wallet-01 #3), by
 * how it was paid. It holds back the whole purchase. Made up for test stacks; not a partner's terms or an owner decision.
 */
export const TEST_PURCHASE_HOLD_DAYS: Readonly<Record<PartnerPaidBy, number>> = Object.freeze({ card: 7, bank_pull: 3 });

export interface TestPartnerPurchaseDesk {
  /** The TEST partner as the ramp's partner: it credits a paid purchase and reports what it holds back of it. */
  readonly purchases: PartnerPurchases;
  /** What the partner still holds back of a person's main balance in one currency. A space holds no purchase. */
  heldBack(account: PartnerAccountRef): bigint;
}

/** The TEST partner's purchases (J-wallet-01 #3), credited to and held back on its one book. */
export function testPartnerPurchaseDesk(book: TestPartnerBook, switches: (userId: string) => TestPartnerSwitches): TestPartnerPurchaseDesk {
  /** Each purchase credited, by person and key: one key is one credit. */
  const purchased = new Map<string, PartnerCredit & { readonly assetId: string; readonly paidBy: PartnerPaidBy }>();
  /** Each person's purchase holds still open, and those released, oldest first. */
  const openHolds = new Map<string, PartnerPurchaseHold[]>();
  const releasedHolds = new Map<string, PartnerPurchaseRelease[]>();
  /** Each purchase returned, by person and key: one key is one return. */
  const returns = new Map<string, PartnerReturn>();

  /** Releases, once, every open hold of the person's that the partner says is past its release time. */
  const releaseDue = (userId: string, now: Date) => {
    const open = openHolds.get(userId) ?? [];
    const expired = switches(userId).purchaseHold === 'expired';
    const due = open.filter((h) => expired || h.releaseAt.getTime() <= now.getTime());
    if (due.length === 0) return;
    openHolds.set(
      userId,
      open.filter((h) => !due.includes(h)),
    );
    const done = releasedHolds.get(userId) ?? [];
    for (const h of due) done.push(Object.freeze({ ...h, releasedAt: now }));
    releasedHolds.set(userId, done);
  };

  return {
    heldBack(account) {
      if (account.spaceId !== null) return 0n;
      releaseDue(account.userId, new Date());
      let sum = 0n;
      for (const h of openHolds.get(account.userId) ?? []) if (h.assetId === account.assetId) sum += h.amount;
      return sum;
    },
    purchases: {
      label: TEST_PARTNER_LABEL,
      async credit(userId: string, purchase: PartnerPurchase): Promise<PartnerCredit> {
        // Per person, like a funding: one person's purchase key never collides with another's.
        const creditKey = `${userId}|${purchase.key}`;
        const prior = purchased.get(creditKey);
        if (prior) {
          if (prior.assetId !== purchase.assetId || prior.amount !== purchase.amount || prior.paidBy !== purchase.paidBy) {
            throw moveConflict(purchase.key);
          }
          return { id: prior.id, key: prior.key, amount: prior.amount, hold: prior.hold };
        }
        if (switches(userId).down) throw partnerDown();
        if (purchase.amount <= 0n) throw new BankError('A purchase needs an amount above zero.', 'bank.partner_amount_invalid');
        const account: PartnerAccountRef = { userId, assetId: purchase.assetId, spaceId: null };
        // One step, nothing awaited: the credit, its record and its hold are made together or not at all.
        const id = book.payIn(account, `pay-in:purchase:${creditKey}`, purchase.amount);
        const at = new Date();
        const hold: PartnerPurchaseHold = Object.freeze({
          // The hold shares its pay-in's number: one purchase, one credit, one hold.
          id: id.replace('test-partner-move-', 'test-partner-hold-'),
          purchaseKey: purchase.key,
          assetId: purchase.assetId,
          amount: purchase.amount,
          paidBy: purchase.paidBy,
          releaseAt: new Date(at.getTime() + TEST_PURCHASE_HOLD_DAYS[purchase.paidBy] * 86_400_000),
        });
        openHolds.set(userId, [...(openHolds.get(userId) ?? []), hold]);
        purchased.set(
          creditKey,
          Object.freeze({ id, key: purchase.key, amount: purchase.amount, hold, assetId: purchase.assetId, paidBy: purchase.paidBy }),
        );
        return { id, key: purchase.key, amount: purchase.amount, hold };
      },
      async returned(userId: string, purchase: PartnerPurchase): Promise<PartnerReturn> {
        const creditKey = `${userId}|${purchase.key}`;
        const credited = purchased.get(creditKey);
        if (!credited || credited.assetId !== purchase.assetId || credited.amount !== purchase.amount) {
          throw moveConflict(purchase.key);
        }
        const prior = returns.get(creditKey);
        if (prior) return prior;
        if (switches(userId).down) throw partnerDown();
        const account: PartnerAccountRef = { userId, assetId: purchase.assetId, spaceId: null };
        const has = book.amount(account);
        if (has < purchase.amount) {
          throw new BankError(
            `The partner reports ${formatAmount(has)} ${purchase.assetId}, less than the ${formatAmount(purchase.amount)} sent back. Nothing was taken.`,
            'bank.partner_insufficient_funds',
          );
        }
        // One step, nothing awaited: the amount leaves the balance, the purchase's hold goes, and the return is kept.
        book.add(account, -purchase.amount);
        openHolds.set(
          userId,
          (openHolds.get(userId) ?? []).filter((h) => h.purchaseKey !== purchase.key),
        );
        const id = book.nextId('move');
        const at = new Date();
        // On the partner's record as the pay-in going back to where it came from, listed with the pay-ins; never under a
        // move key, as nobody instructed it.
        book.note(
          userId,
          Object.freeze({
            id,
            key: `pay-in:return:${creditKey}`,
            from: Object.freeze({ ...account }),
            to: Object.freeze(partnerPayInsAccount(purchase.assetId)),
            amount: purchase.amount,
            movedAt: at,
            label: TEST_PARTNER_LABEL,
          }),
        );
        const back: PartnerReturn = Object.freeze({ id, key: purchase.key, amount: purchase.amount, returnedAt: at });
        returns.set(creditKey, back);
        return back;
      },
      async holds(userId: string): Promise<PartnerPurchaseHolds> {
        const now = switches(userId);
        if (now.down) throw partnerDown();
        if (now.purchaseHolds === 'not_reported') return Object.freeze({ label: TEST_PARTNER_LABEL, reported: false as const });
        const at = new Date();
        releaseDue(userId, at);
        return Object.freeze({
          label: TEST_PARTNER_LABEL,
          reported: true as const,
          asOf: at,
          holds: Object.freeze([...(openHolds.get(userId) ?? [])]),
          released: Object.freeze([...(releasedHolds.get(userId) ?? [])]),
        });
      },
    },
  };
}
