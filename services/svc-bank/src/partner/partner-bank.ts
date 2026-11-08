import { movesCustomerBalance, parseCustodyLayer, type Amount, type CustodyLayerState, type LedgerClient } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';

/**
 * PARTNER-HELD BANK MONEY (OWNER 226; CUSTODY-DELTA §3).
 *
 * INTAFACED holds no customer money at launch: a person's currency accounts and spaces are held by the partner bank,
 * under its licence. This is the port svc-bank reads and moves that money through. No partner is named, so the only
 * implementation is the TEST partner bank (`test-partner.ts`), labelled TEST.
 *
 *   - A balance is what the partner reports, with its label and the time it reported it. One it does not report is
 *     null, read as "not known", never 0.
 *   - A move is ONE partner instruction under a business key (`bank.transfer.<keySpace>:<id>:<occurrence>`, the same key
 *     the custodial path posts the ledger under). The partner deduplicates on the key: a retry after a lost reply is
 *     the same move, answered with the first one, never a second; a different move under the same key is refused.
 *   - Nothing here posts to the ledger. The ledger records only what INTAFACED itself owes or is owed, and is never
 *     authoritative over the partner's figures.
 *
 * Which path runs for a person is `PartnerCustody.bankFor(userId)`: the partner for a person whose money it holds,
 * null for the custodial layer (the journeys marked Later), exactly as before.
 */

/** One of a person's accounts at the partner: the main balance in a currency (`spaceId` null) or one named space. */
export interface PartnerAccountRef {
  readonly userId: string;
  readonly assetId: string;
  readonly spaceId: string | null;
}

/** A space as svc-bank knows it, mapped to the partner's account: a primary space is the main balance. */
export function partnerAccountFor(space: {
  readonly id: string;
  readonly userId: string;
  readonly assetId: string;
  readonly kind: 'primary' | 'named';
}): PartnerAccountRef {
  return { userId: space.userId, assetId: space.assetId, spaceId: space.kind === 'primary' ? null : space.id };
}

export interface PartnerBalance {
  readonly account: PartnerAccountRef;
  /** As the partner reports it; null when it has not said ("not known", never 0). */
  readonly amount: Amount | null;
  /** When the partner reported it. */
  readonly asOf: Date;
  /** Whose figure this is, e.g. "TEST partner bank". */
  readonly label: string;
}

export interface PartnerMoveRequest {
  /** The business key. One key is one move at the partner, however many times it is sent. */
  readonly key: string;
  readonly from: PartnerAccountRef;
  readonly to: PartnerAccountRef;
  readonly amount: Amount;
}

export interface PartnerMove {
  /** The partner's own reference for the move. */
  readonly id: string;
  readonly key: string;
  readonly from: PartnerAccountRef;
  readonly to: PartnerAccountRef;
  readonly amount: Amount;
  readonly movedAt: Date;
  readonly label: string;
}

export interface PartnerMovesQuery {
  readonly limit: number;
  /** Only moves older than this partner reference (newest first paging). */
  readonly before?: string;
  readonly assetId?: string;
}

export interface PartnerBank {
  readonly label: string;
  /** One account's balance as the partner reports it. */
  balance(account: PartnerAccountRef): Promise<PartnerBalance>;
  /** Every account the partner holds for the person, in every currency. */
  balances(userId: string): Promise<PartnerBalance[]>;
  /**
   * Make one move under its key. Refuses before anything moves: `bank.partner_unavailable` (not answering),
   * `bank.partner_insufficient_funds` (the source does not hold it), `bank.partner_move_conflict` (another move under
   * this key). `bank.partner_reply_lost` means the move may have been made and the outcome is not known: retry it under
   * the same key, which answers with the move if it was made and makes it once if not.
   */
  move(request: PartnerMoveRequest): Promise<PartnerMove>;
  /** The move made under a key, or null when the partner has none. */
  moveByKey(key: string): Promise<PartnerMove | null>;
  /** The person's moves (either side), newest first. */
  moves(userId: string, query: PartnerMovesQuery): Promise<PartnerMove[]>;
}

/** Which path holds a person's bank money: the partner, or (null) the custodial layer as before. */
export interface PartnerCustody {
  bankFor(userId: string): PartnerBank | null;
}

/** No partner holds anyone's money here: every person is on the custodial layer, exactly as before. */
export const custodialOnly: PartnerCustody = Object.freeze({ bankFor: () => null });

/** The amount, or a typed refusal when the partner has not reported it: never read a missing figure as 0. */
export function reportedAmount(balance: PartnerBalance): Amount {
  if (balance.amount === null) {
    throw new BankError(`${balance.label} has not reported this balance, so it is not known.`, 'bank.partner_balance_not_known');
  }
  return balance.amount;
}

/** The two sides of a move are held in different places, so no single partner instruction can make it. */
export function partnerCustodyMismatch(): BankError {
  return new BankError(
    'One side of this move is held at the partner bank and the other is not, so it cannot be made as one partner move. Nothing was sent or changed.',
    'bank.partner_custody_mismatch',
  );
}

/** Code for a customer-balance post refused because the custodial layer is off and no partner holds the money. */
export const NO_PARTNER_BANK_CODE = 'bank.no_partner_bank';

/**
 * svc-bank's own reading of the custody switch (`LEDGER_CUSTODY_LAYER`, the same value and parser svc-ledger uses).
 * Unset or blank is off. A value passed in wins; otherwise the live env.
 */
export function bankCustodyLayer(passed: CustodyLayerState | undefined): CustodyLayerState {
  return passed ?? parseCustodyLayer(process.env.LEDGER_CUSTODY_LAYER);
}

/**
 * The ledger as svc-bank's services see it. With the custodial layer off, a post that would move a customer balance is
 * refused here, by name, before any request reaches svc-ledger (which would refuse it too, `ledger.custody_layer_off`):
 * no partner bank holds this money and INTAFACED holds none. A partner-held person's money never reaches this: its
 * paths ask the partner and post nothing. With the layer on, every call passes through unchanged.
 */
export function custodyGuardedLedger<L extends Pick<LedgerClient, 'post'>>(ledger: L, layer: CustodyLayerState): L {
  if (layer === 'on') return ledger;
  return new Proxy(ledger, {
    get(target, prop, receiver) {
      if (prop !== 'post') {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (request: Parameters<LedgerClient['post']>[0]) => {
        if (movesCustomerBalance(request.entries)) {
          throw new BankError(
            'No banking partner holds this money, and INTAFACED holds no customer money, so nothing was moved.',
            NO_PARTNER_BANK_CODE,
          );
        }
        return target.post(request);
      };
    },
  });
}
