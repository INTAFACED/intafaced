/**
 * The per-account gated list (D-ops-01): every listed futures contract, marked open or blocked for this account, with
 * every reason it is blocked and the first one named.
 *
 * It is a read and never opens a door: the open path runs its own gates (`derivatives-access.ts`, the exposure
 * switch). The checks here are the same functions, asked one by one so the trader sees every reason at once instead
 * of one per attempt. A check that fails for a reason it cannot name is `trade.gated_list_unknown` and blocks (fail
 * closed).
 *
 * Order of the first reason: the futures plane, the order path (the book switch and the price band), the contract's
 * own state, the proved email, the identity level. The account checks are read once and apply to every contract. No
 * agreement, quiz or notice is a reason (owner decision 2026-10-27, until launch prep).
 */
import type { Market } from '../spot/types.js';
import { isDerivativesAccessError } from './derivatives-access.js';

export const GATED_LIST_UNKNOWN = 'trade.gated_list_unknown' as const;
export const GATED_MARKET_NOT_ORDERABLE = 'trade.market_not_orderable' as const;

export interface GatedBlocker {
  readonly code: string;
  readonly message: string;
}

export interface GatedContract {
  readonly symbol: string;
  readonly marketId: string;
  readonly open: boolean;
  /** The first blocking reason, or null when open. */
  readonly code: string | null;
  readonly message: string | null;
  readonly blockers: readonly GatedBlocker[];
}

export interface GatedListSubject {
  readonly userId: string;
  readonly tier: string | null;
  readonly region: string | null;
}

export interface GatedListDeps {
  /** Listed markets; only futures are listed here. */
  markets(): Promise<readonly Market[]>;
  /** The futures plane's refusal (`trade.futures_disabled`) or null when exposure can grow. */
  planeRefusal(): GatedBlocker | null;
  /** Why no opening order can be placed on this deployment (book switched off, price band unset), or null. */
  orderPathRefusal(): GatedBlocker | null;
  /** The same switch the market board publishes as `orderable`. */
  orderable(market: Market): boolean;
  /** The same email proof every new opening order needs. */
  emailProved(userId: string): Promise<boolean>;
  /** The derivatives access gate the open runs: the identity level. */
  checkAccess(subject: GatedListSubject): Promise<void>;
}

const EMAIL_REQUIRED: GatedBlocker = {
  code: 'trade.email_proof_required',
  message: 'Prove your email before placing an order.',
};

const UNKNOWN: GatedBlocker = { code: GATED_LIST_UNKNOWN, message: 'This check could not be read, so the contract is shown as blocked.' };

/** A thrown gate refusal as a blocker; anything it cannot name is unknown and still blocks. */
async function blockerOf(check: () => Promise<void>): Promise<GatedBlocker | null> {
  try {
    await check();
    return null;
  } catch (err) {
    if (isDerivativesAccessError(err)) return { code: err.code, message: err.message };
    return UNKNOWN;
  }
}

function marketBlocker(market: Market, orderable: boolean): GatedBlocker | null {
  if (market.status !== 'active') return { code: `trade.market_${market.status}`, message: `This contract is ${market.status}.` };
  if (!orderable) return { code: GATED_MARKET_NOT_ORDERABLE, message: 'This contract does not take orders now.' };
  return null;
}

export async function readGatedList(deps: GatedListDeps, subject: GatedListSubject): Promise<GatedContract[]> {
  const markets = (await deps.markets()).filter((market) => market.kind === 'futures');
  const plane = deps.planeRefusal();
  const path = deps.orderPathRefusal();
  const [email, access] = await Promise.all([
    deps.emailProved(subject.userId).then(
      (proved) => (proved ? null : EMAIL_REQUIRED),
      () => UNKNOWN,
    ),
    blockerOf(() => deps.checkAccess(subject)),
  ]);
  return markets
    .map((market) => {
      const blockers = [plane, path, marketBlocker(market, deps.orderable(market)), email, access].filter(
        (blocker): blocker is GatedBlocker => blocker !== null,
      );
      const first = blockers[0] ?? null;
      return {
        symbol: market.symbol,
        marketId: market.id,
        open: first === null,
        code: first?.code ?? null,
        message: first?.message ?? null,
        blockers,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}
