/**
 * Replay hold check.
 *
 * After the journal is in the book and before any new order can match, every
 * resting order is read against its ledger hold. The hold record is the
 * purposed `order:<id>` balance (packages/ledger-client). svc-matching has no
 * DATABASE_URL and does not post. A missing, short, or unreadable hold is
 * pulled through the normal cancel (`hold_unconfirmed`) so trade can release
 * what remains. If that cancel cannot land, the market stays halted. If the
 * ledger cannot be asked at all, the book does not open.
 */
import { accountPurpose, formatAmount, isValidOwnerId, mul, parseAmount, type Amount, type Balance } from '@intafaced/ledger-client';
import type { MatchingEngine } from './engine/engine.js';
import type { RestingHoldSubject } from './engine/types.js';

export type HoldVerdict = 'missing' | 'short' | 'unreadable';

export type HoldCheckCode = 'matching.hold_check_unreachable' | 'matching.hold_check_unwired';

export class HoldCheckUnreachable extends Error {
  readonly code: HoldCheckCode;

  constructor(code: HoldCheckCode, message: string) {
    super(message);
    this.name = 'HoldCheckUnreachable';
    this.code = code;
  }
}

export interface PulledRestingOrder {
  readonly orderId: string;
  readonly marketId: string;
  readonly verdict: HoldVerdict;
  readonly reason: 'hold_unconfirmed';
}

export interface HaltedRestingMarket {
  readonly marketId: string;
  readonly orderId: string;
  readonly verdict: HoldVerdict;
  readonly reason: string;
}

export type ReplayHoldGate =
  | {
      readonly open: true;
      readonly checked: number;
      readonly pulled: readonly PulledRestingOrder[];
      readonly halted: readonly HaltedRestingMarket[];
    }
  | {
      readonly open: false;
      readonly reason: HoldCheckCode;
      readonly checked: number;
      readonly pulled: readonly PulledRestingOrder[];
      readonly halted: readonly HaltedRestingMarket[];
    };

/** Read-only. `null` means no hold balance for this order. Throw HoldCheckUnreachable when the service itself cannot be asked. */
export interface ReplayHoldLookup {
  read(order: RestingHoldSubject): Promise<string | null>;
}

/**
 * Quote for buys (ceil, same as svc-trade `holdFor`), base quantity for sells.
 * Null when a buy has no limit to size the hold against — that order is not confirmed.
 */
export function requiredHoldAmount(order: RestingHoldSubject): Amount | null {
  const remaining = parseAmount(order.remaining);
  if (order.side === 'sell') return remaining;
  if (order.fundingPrice == null) return null;
  return mul(parseAmount(order.fundingPrice), remaining, 'ceil');
}

function classifyHold(hold: string | null, required: Amount): 'confirmed' | HoldVerdict {
  if (hold == null) return 'missing';
  let held: Amount;
  try {
    held = parseAmount(hold);
  } catch {
    return 'unreadable';
  }
  if (held <= 0n) return 'missing';
  if (held < required) return 'short';
  return 'confirmed';
}

/**
 * Confirm every resting order, then pull or halt. Does not match.
 * Unreachable fails closed: nothing already known-bad is undone, and admission closes
 * so a still-resting order cannot be matched.
 */
export async function enforceReplayHolds(engine: MatchingEngine, lookup: ReplayHoldLookup): Promise<ReplayHoldGate> {
  const subjects = engine.restingHoldSubjects();
  const pulled: PulledRestingOrder[] = [];
  const halted: HaltedRestingMarket[] = [];
  if (subjects.length === 0) return { open: true, checked: 0, pulled, halted };

  for (const order of subjects) {
    let verdict: 'confirmed' | HoldVerdict;
    try {
      const required = requiredHoldAmount(order);
      if (required == null) verdict = 'unreadable';
      else verdict = classifyHold(await lookup.read(order), required);
    } catch (err) {
      if (err instanceof HoldCheckUnreachable) {
        engine.closeAdmission(err.code);
        return { open: false, reason: err.code, checked: subjects.length, pulled, halted };
      }
      verdict = 'unreadable';
    }
    if (verdict === 'confirmed') continue;

    const cancel = await engine.cancel(order.marketId, order.orderId, 'hold_unconfirmed');
    if (cancel.cancelled && cancel.cancellation?.reason === 'hold_unconfirmed') {
      pulled.push({ orderId: order.orderId, marketId: order.marketId, verdict, reason: 'hold_unconfirmed' });
      continue;
    }
    const reason = `matching.hold_${verdict}`;
    engine.holdHalt(order.marketId, reason);
    halted.push({ marketId: order.marketId, orderId: order.orderId, verdict, reason });
  }

  return { open: true, checked: subjects.length, pulled, halted };
}

type HoldOwner = { readonly ownerType: 'user' | 'house'; readonly ownerId: string };

export function holdOwner(accountId: string): HoldOwner | null {
  if (accountId === 'house:market-maker') return { ownerType: 'house', ownerId: 'market-maker' };
  if (isValidOwnerId('user', accountId)) return { ownerType: 'user', ownerId: accountId };
  return null;
}

export interface ReplayHoldLedger {
  balances(ownerType: 'user' | 'house', ownerId: string): Promise<Balance[]>;
}

/**
 * Live `order:<id>` hold via ledger-client `balances`. Read-only.
 * Customer rests use the engine account id when it is a user UUID.
 * House seed rests use `house:market-maker`.
 */
export function createReplayHoldLookup(ledger: ReplayHoldLedger): ReplayHoldLookup {
  const seen = new Map<string, Balance[]>();
  return {
    async read(order) {
      const owner = holdOwner(order.accountId);
      if (!owner) throw new Error(`resting account ${order.accountId} is not a ledger owner; hold unreadable`);
      const key = `${owner.ownerType}\0${owner.ownerId}`;
      let rows = seen.get(key);
      if (!rows) {
        try {
          rows = await ledger.balances(owner.ownerType, owner.ownerId);
        } catch (err) {
          // Any failure of the balances call is the hold service not answering.
          // Do not treat it as one bad order — that would cancel the book.
          const detail = err instanceof Error ? err.message : 'ledger hold check unreachable';
          throw new HoldCheckUnreachable('matching.hold_check_unreachable', detail);
        }
        seen.set(key, rows);
      }
      const purpose = `order:${order.orderId}`;
      const holds = rows.filter((row) => row.account.kind === 'hold' && accountPurpose(row.account) === purpose);
      if (holds.length === 0) return null;
      if (holds.length > 1) throw new Error(`multiple ledger holds for order ${order.orderId}`);
      return formatAmount(holds[0]!.amount);
    },
  };
}

export function unwiredReplayHoldLookup(): ReplayHoldLookup {
  return {
    async read() {
      throw new HoldCheckUnreachable(
        'matching.hold_check_unwired',
        'LEDGER_URL is unset — svc-matching cannot read order holds and will not open a book that replayed resting orders',
      );
    },
  };
}
