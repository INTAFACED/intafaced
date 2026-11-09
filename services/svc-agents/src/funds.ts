/**
 * The funds a run is checked against before the engine is called (OWNER 107, J-agents-02 #4).
 *
 * Two readings answer it. With no payment method chosen, the person's available balance in the fee asset, as the
 * ledger records it (`kind: 'ledger'`): today's path, unchanged. With a wallet chosen for an own agent (OWNER 226:
 * people pay from their own wallets), that wallet's balance of the payment token as the chain reports it, with the
 * block it was read at and that block's time (`kind: 'wallet'`). A reading that cannot be made throws `FundsUnreadError`
 * naming the method and a short reason; any other throw is an unread ledger balance. Either way the run refuses
 * `agents.funds_unread` and nothing is claimed, held, called or billed: an unknown balance is not a covered one.
 */
import { formatAmount, type Amount } from '@intafaced/ledger-client';

export type FundsMethod = { readonly kind: 'wallet'; readonly address: string };

export type FundsReading =
  | { readonly kind: 'ledger'; readonly available: Amount }
  | {
      readonly kind: 'wallet';
      /** In the fee asset's Amount scale. */
      readonly available: Amount;
      /** The token the figure is in, as the chain names it (its own `symbol()`), so the figure is never relabelled. */
      readonly token: string;
      readonly method: FundsMethod;
      readonly source: { readonly kind: 'chain'; readonly chainId: number; readonly block: bigint };
      /** ISO time of `source.block`, from the block itself. */
      readonly asOf: string;
      /**
       * The person's available balance on the platform, in the fee asset. A run is still billed there (its windows seal
       * to the ledger), so a wallet run must be covered by both: the wallet the person chose and the balance the bill
       * is charged to. Read with the wallet; absent only on a reading made before it is added (the chain adapter's own).
       */
      readonly billed?: Amount;
    };

/** Why a wallet's amount could not be read. The page words each one. */
export const FUNDS_UNREAD_REASONS = [
  'payment_token_unset',
  'wallet_unlinked',
  'account_inactive',
  'identity_unreachable',
  'chain_unreachable',
  'chain_mismatch',
  'method_unread',
] as const;
export type FundsUnreadReason = (typeof FUNDS_UNREAD_REASONS)[number];

export class FundsUnreadError extends Error {
  constructor(
    readonly method: FundsMethod | null,
    readonly reason: FundsUnreadReason,
  ) {
    super(`funds unread: ${reason}`);
    this.name = 'FundsUnreadError';
  }
}

/**
 * What the runtime reads. `agentId` is the session's agent (`own.<id>` for a person's own agent), so a payment method
 * chosen for that agent is the one read. A plain `Amount` is a ledger reading.
 */
export interface FundsPort {
  available(userId: string, assetId: string, agentId?: string): Promise<Amount | FundsReading>;
}

export type FundsOutcome =
  | { readonly ok: true; readonly reading: FundsReading }
  | { readonly ok: false; readonly method: FundsMethod | null; readonly reason: FundsUnreadReason | null };

/** Runs one read; never throws. */
export async function readFunds(read: () => Promise<Amount | FundsReading>): Promise<FundsOutcome> {
  try {
    const answer = await read();
    return { ok: true, reading: typeof answer === 'bigint' ? { kind: 'ledger', available: answer } : answer };
  } catch (err) {
    return err instanceof FundsUnreadError
      ? { ok: false, method: err.method, reason: err.reason }
      : { ok: false, method: null, reason: null };
  }
}

/**
 * Whether a reading covers `amount` after `owed` (what the person already owes on the platform), and if not, the
 * outcome the refusal names. A ledger reading: its balance net of what is owed. A wallet reading: the wallet's figure
 * must cover the run (the refusal then names the wallet), and the platform balance the run is billed to must cover it
 * net of what is owed (the refusal then names that balance, as today). A wallet reading with no billed balance never
 * covers: a run nobody can be billed for does not start.
 */
export function fundsShortfall(reading: FundsReading, owed: Amount, amount: Amount): FundsOutcome | null {
  if (reading.kind === 'ledger') return reading.available - owed < amount ? { ok: true, reading } : null;
  if (reading.available < amount) return { ok: true, reading };
  if (reading.billed === undefined) return { ok: false, method: null, reason: null };
  if (reading.billed - owed < amount) return { ok: true, reading: { kind: 'ledger', available: reading.billed } };
  return null;
}

type Params = Record<string, string | number>;

/**
 * The words' parameters of a funds refusal. A ledger reading keeps today's `{ worstCase, asset }`. A wallet reading
 * adds the method (`method`, `address`), the figure (`available`, in `token`, the chain's own name for it), its source (`source`, `chainId`,
 * `block`) and as-of time (`asOf`). An unread wallet adds the method and `reason`.
 */
export function fundsRefusalParams(worstCase: string, asset: string, outcome: FundsOutcome): Params {
  const base: Params = { worstCase, asset };
  if (outcome.ok) {
    const r = outcome.reading;
    if (r.kind === 'ledger') return base;
    return {
      ...base,
      method: r.method.kind,
      address: r.method.address,
      available: formatAmount(r.available),
      token: r.token,
      source: r.source.kind,
      chainId: r.source.chainId,
      block: r.source.block.toString(),
      asOf: r.asOf,
    };
  }
  if (outcome.method === null) return outcome.reason === null ? base : { ...base, reason: outcome.reason };
  return { ...base, method: outcome.method.kind, address: outcome.method.address, reason: outcome.reason ?? 'method_unread' };
}
