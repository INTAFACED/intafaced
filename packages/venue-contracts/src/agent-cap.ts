import { add, compare, div, formatAmount, isNegative, mul, parseAmount, sub, sum, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  assertSignatureMatches,
  assertSignerMaySign,
  venueClientOrderId,
  VenueRefusalError,
  type AsOf,
  type MaybeKnown,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueBalance,
  type UserVenueMarket,
  type UserVenueOrder,
  type UserVenuePosition,
  type VenueSignature,
} from './user-venue.js';

/**
 * THE AGENT CAP — the most an agent key may commit, checked before it signs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE CAP IS OURS, AND WHY IT BINDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A venue agent key (Hyperliquid `approveAgent`) can trade the account it was
 * approved for and nothing else: it can never withdraw or approve (the venue's
 * rule, and `assertSignerMaySign`). It has no amount limit of its own. So the
 * person's cap ("my assistant may use at most 200 USDC") is ours to enforce,
 * and it can only bind if the agent key never signs without asking us:
 * INTAFACED holds the venue agent key, the person's assistant calls our API
 * with its own scoped API key, and every action the venue key signs goes
 * through `CappedAgentSigner.sign` below. An assistant that held the venue
 * agent key itself could sign around any cap of ours, so it never gets it
 * (J-agents-21: "our copy of the venue agent key").
 *
 * Two checks, one cap (J-agents-21 "Money"):
 *   · **Funding.** The person's own moves into the agent's sub-account, less
 *     the moves out, never exceed the cap (`assertAgentFundingWithinCap`),
 *     checked before the person's wallet is asked to sign the move.
 *   · **Orders.** Every agent order's commitment, added to what the agent
 *     account already has in use, never exceeds the cap
 *     (`checkAgentOrderWithinCap`), checked before the agent key signs. This
 *     is the backstop when the sub-account holds more than the cap: profits,
 *     or a transfer the person made on the venue directly.
 *
 * What "in use" means, in the cap's asset (the quote, USDC), as the venue
 * reports it: quote locked by resting orders, the margin of open positions,
 * and every other asset the account holds valued at its mark. A holding with
 * no known mark makes "in use" unknown, and an order that adds commitment is
 * then refused `agent_cap_unmeasured`, never waved through on a guess.
 *
 * What an order commits: a spot buy, its amount at its limit (or worst) price;
 * a perpetual, that notional divided by the account's leverage on the market
 * as the venue records it, or the whole notional (1x) when the venue reports
 * none; a spot sell and any reduce-only order, nothing. A cancel commits
 * nothing and is allowed even after the cap is revoked, so a revoke can cancel
 * the agent's resting orders before its key is dropped.
 *
 * One signer per agent key. Two agent orders checked at once would each see
 * the other's commitment missing, so `CappedAgentSigner` runs one check at a
 * time per account and reserves each signed order's commitment until the
 * caller reports the venue's definite answer (`settle`). The reservation is
 * in memory: the service holding the agent key runs exactly one signer for it.
 */

// ════════════════════════════════════════════════════════════════════════════
// THE CAP
// ════════════════════════════════════════════════════════════════════════════

export interface AgentCap {
  /** The agent's own venue sub-account under the person's wallet. The only account the agent key may trade. */
  readonly account: UserVenueAccount;
  /** Lowercase address of the venue agent key INTAFACED holds for this agent. */
  readonly agentAddress: string;
  /** The asset the cap is counted in: the quote of every market the agent trades (USDC). */
  readonly asset: string;
  /** The person's cap, in `asset`. Never above the owner's ceiling (`assertAgentCapWithinCeiling`). */
  readonly cap: Amount;
  /** When the cap stops allowing new orders, or `null` for no expiry. */
  readonly validUntil: Date | null;
  /** When the person revoked the agent, or `null`. A revoked cap allows cancels only. */
  readonly revokedAt: Date | null;
}

export type AgentCapErrorCode =
  /** The owner has published no ceiling for agent accounts (floor 8: a blank owner value refuses). */
  | 'agents.account_ceiling_unset'
  /** The person asked for a cap above the owner's ceiling. */
  | 'agents.account_cap_above_ceiling'
  /** A move into the agent account would take the person's net funding past the cap. */
  | 'agents.account_cap_exceeded'
  /** A cap or move that is zero or negative. */
  | 'agents.account_cap_invalid';

export class AgentCapError extends Error {
  constructor(
    readonly code: AgentCapErrorCode,
    readonly detail: string,
    /** The room left under the cap, or the ceiling, where the refusal names one. */
    readonly room: Amount | null = null,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'AgentCapError';
  }
}

/**
 * Refuse a cap above the owner's ceiling, and refuse every cap when the
 * ceiling is blank. `ceiling` is the owner's published value, `null` when
 * blank; a TEST value stands in on test stacks only (floor 8).
 */
export function assertAgentCapWithinCeiling(cap: Amount, ceiling: Amount | null, asset: string): void {
  if (ceiling === null) {
    throw new AgentCapError('agents.account_ceiling_unset', 'the owner has published no ceiling for agent accounts, so none can be made');
  }
  if (compare(cap, ZERO) <= 0) {
    throw new AgentCapError('agents.account_cap_invalid', `a cap must be above zero, got ${formatAmount(cap)} ${asset}`);
  }
  if (compare(cap, ceiling) > 0) {
    throw new AgentCapError(
      'agents.account_cap_above_ceiling',
      `a cap of ${formatAmount(cap)} ${asset} is above the ceiling of ${formatAmount(ceiling)} ${asset}`,
      ceiling,
    );
  }
}

/**
 * Refuse a move into the agent account that would take the person's net
 * funding (moves in, less moves out) past the cap. Called before the person's
 * wallet is asked to sign the move. `movedIn` and `movedOut` are the person's
 * own moves the venue confirmed, from our records of them; a move whose answer
 * is not yet definite counts as moved in, so a retry cannot slip past.
 */
export function assertAgentFundingWithinCap(cap: AgentCap, movedIn: Amount, movedOut: Amount, move: Amount): void {
  if (compare(move, ZERO) <= 0) {
    throw new AgentCapError('agents.account_cap_invalid', `a move must be above zero, got ${formatAmount(move)} ${cap.asset}`);
  }
  const net = sub(movedIn, movedOut);
  const room = isNegative(sub(cap.cap, net)) ? ZERO : sub(cap.cap, net);
  if (compare(move, room) > 0) {
    throw new AgentCapError(
      'agents.account_cap_exceeded',
      `moving ${formatAmount(move)} ${cap.asset} would pass the cap of ${formatAmount(cap.cap)} ${cap.asset}; ${formatAmount(room)} ${cap.asset} of room is left`,
      room,
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// THE ORDER CHECK — pure, on the venue's record
// ════════════════════════════════════════════════════════════════════════════

/** The venue's record the order check reads, each as the venue reported it. */
export interface AgentCapSnapshot {
  readonly markets: readonly UserVenueMarket[];
  readonly balances: readonly UserVenueBalance[];
  readonly openOrders: readonly UserVenueOrder[];
  readonly positions: readonly UserVenuePosition[];
  /** The account's leverage on the order's market, in bps of 1x; `known: false` when the venue reports none. */
  readonly leverageBps: MaybeKnown<number>;
}

/** The mark of one unit of `asset`, in the cap's asset. `known: false` when there is none. */
export type AgentCapMarks = (asset: string) => MaybeKnown<Amount>;

export interface AgentCapCheck {
  /** What this action commits, in the cap's asset. */
  readonly commitment: Amount;
  /** What the account already has in use, plus signed orders the venue has not yet answered; `null` when not measured (nothing to add). */
  readonly inUse: Amount | null;
  /** `cap - inUse`, floored at zero; `null` when not measured. */
  readonly room: Amount | null;
}

const BPS_OF_1X = parseAmount('10000');

function refuse(
  account: UserVenueAccount,
  code:
    | 'agent_cap_exceeded'
    | 'agent_cap_inactive'
    | 'agent_cap_unmeasured'
    | 'agent_outside_capped_account'
    | 'unknown_market'
    | 'unknown_order',
  detail: string,
): never {
  throw new VenueRefusalError({ venueId: account.venueId, code, detail });
}

function sameAccount(a: UserVenueAccount, b: UserVenueAccount): boolean {
  return a.venueId === b.venueId && a.owner.toLowerCase() === b.owner.toLowerCase() && (a.subAccount ?? null) === (b.subAccount ?? null);
}

/**
 * Refuse, before the agent key signs, an agent action the cap does not allow.
 * Returns the figures it judged on. Throws `VenueRefusalError`:
 *   · `agent_outside_capped_account` — not this cap's agent key, or not its sub-account;
 *   · `agent_cap_inactive` — revoked or expired (a cancel still passes);
 *   · `agent_cap_unmeasured` — the order adds commitment and "in use" can't be measured;
 *   · `agent_cap_exceeded` — the order's commitment is more than the room left.
 * Owner actions never come here: they are the person's own signatures.
 */
export function checkAgentOrderWithinCap(
  prepared: PreparedVenueAction,
  cap: AgentCap,
  snapshot: AgentCapSnapshot,
  marks: AgentCapMarks,
  reserved: Amount,
  now: Date,
): AgentCapCheck {
  const { account, signer, intent } = prepared;
  if (signer.role !== 'agent' || signer.address.toLowerCase() !== cap.agentAddress.toLowerCase()) {
    refuse(
      account,
      'agent_outside_capped_account',
      `${signer.address.toLowerCase()} is not this cap's agent key (${cap.agentAddress.toLowerCase()})`,
    );
  }
  if (!sameAccount(account, cap.account)) {
    refuse(
      account,
      'agent_outside_capped_account',
      `the agent key may trade only its own sub-account (${cap.account.subAccount ?? 'main'}), not ${account.subAccount ?? 'main'}`,
    );
  }
  assertSignerMaySign(account, signer, intent);

  if (intent.kind === 'cancel_order') return { commitment: ZERO, inUse: null, room: null };

  if (cap.revokedAt !== null)
    refuse(account, 'agent_cap_inactive', `the person revoked this agent at ${cap.revokedAt.toISOString()}; only cancels are allowed`);
  if (cap.validUntil !== null && now.getTime() >= cap.validUntil.getTime()) {
    refuse(account, 'agent_cap_inactive', `this agent's cap expired at ${cap.validUntil.toISOString()}; only cancels are allowed`);
  }

  if (intent.kind === 'update_leverage') return { commitment: ZERO, inUse: null, room: null };
  if (intent.kind !== 'place_order' && intent.kind !== 'amend_order') {
    // Withdrawals and approvals are owner-only; assertSignerMaySign refused them above.
    refuse(account, 'agent_outside_capped_account', `an agent key cannot sign ${intent.kind}`);
  }

  const market = snapshot.markets.find((m) => m.symbol === intent.symbol);
  if (!market) refuse(account, 'unknown_market', `${intent.symbol} is not listed for this account`);
  if (market.quoteAsset !== cap.asset) {
    refuse(account, 'agent_cap_unmeasured', `${intent.symbol} is quoted in ${market.quoteAsset}; this cap is counted in ${cap.asset}`);
  }

  let replaced: UserVenueOrder | null = null;
  let side: 'buy' | 'sell';
  let reduceOnly: boolean;
  if (intent.kind === 'amend_order') {
    const cloid = venueClientOrderId(account.venueId, intent.clientOrderKey);
    replaced = snapshot.openOrders.find((o) => o.venueClientOrderId === cloid) ?? null;
    if (!replaced) refuse(account, 'unknown_order', `no resting order with client id ${cloid} on this account`);
    side = replaced.side;
    reduceOnly = replaced.reduceOnly;
  } else {
    side = intent.side;
    reduceOnly = intent.reduceOnly;
  }

  const notional = mul(intent.amount, intent.price, 'ceil');
  let commitment: Amount;
  if (reduceOnly) commitment = ZERO;
  else if (market.kind === 'spot') commitment = side === 'buy' ? notional : ZERO;
  else {
    const lev = snapshot.leverageBps.known ? snapshot.leverageBps.value : 10_000;
    if (!Number.isInteger(lev) || lev < 10_000)
      refuse(account, 'agent_cap_unmeasured', `the venue reports a leverage of ${lev} bps on ${intent.symbol}, below 1x`);
    commitment = div(mul(notional, BPS_OF_1X, 'ceil'), parseAmount(String(lev)), 'ceil');
  }
  if (compare(commitment, ZERO) === 0) return { commitment, inUse: null, room: null };

  const parts: Amount[] = [reserved];
  for (const o of snapshot.openOrders) {
    if (replaced && o === replaced) continue; // an amend replaces this order's lock
    if (o.lockedAsset === cap.asset) parts.push(o.locked);
  }
  for (const p of snapshot.positions) parts.push(p.margin);
  for (const b of snapshot.balances) {
    if (b.asset === cap.asset || compare(b.total, ZERO) === 0) continue;
    const mark = marks(b.asset);
    if (!mark.known)
      refuse(
        account,
        'agent_cap_unmeasured',
        `the account holds ${formatAmount(b.total)} ${b.asset} and its mark in ${cap.asset} is not known, so the room under the cap is not known`,
      );
    parts.push(mul(b.total, mark.value, 'ceil'));
  }
  const inUse = sum(parts);
  const left = sub(cap.cap, inUse);
  const room = isNegative(left) ? ZERO : left;
  if (compare(commitment, room) > 0) {
    refuse(
      account,
      'agent_cap_exceeded',
      `this order commits ${formatAmount(commitment)} ${cap.asset}; the cap is ${formatAmount(cap.cap)} ${cap.asset} and ${formatAmount(room)} ${cap.asset} of room is left`,
    );
  }
  return { commitment, inUse, room };
}

// ════════════════════════════════════════════════════════════════════════════
// THE SIGNER — the only way the agent key signs
// ════════════════════════════════════════════════════════════════════════════

/** The account's leverage read, as the venue records it (`null` when none is set). */
export interface AgentCapLeverageRead {
  leverage(account: UserVenueAccount, symbol: string): Promise<AsOf<{ readonly leverageBps: number } | null>>;
}

/** The reads the signer takes from the venue. `leverage` is optional until every venue publishes it; without it a perpetual counts at 1x. */
export type AgentCapVenue = Pick<UserVenue, 'markets' | 'balances' | 'openOrders' | 'positions'> & Partial<AgentCapLeverageRead>;

/** Signs a prepared action's digest with the agent key. Held privately by `CappedAgentSigner`. */
export type AgentKeySign = (prepared: PreparedVenueAction) => Promise<VenueSignature>;

/**
 * Holds one agent key's raw signing function and exposes it only through the
 * cap check. Construct one per agent key, in the one service that holds the
 * key; never pass the raw function anywhere else.
 */
export class CappedAgentSigner {
  readonly #signRaw: AgentKeySign;
  readonly #venue: AgentCapVenue;
  readonly #marks: AgentCapMarks;
  readonly #now: () => Date;
  /** Commitment of signed orders whose venue answer is not yet definite, by venue client order id. */
  readonly #reserved = new Map<string, Amount>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: {
    readonly sign: AgentKeySign;
    readonly venue: AgentCapVenue;
    readonly marks: AgentCapMarks;
    readonly now?: () => Date;
  }) {
    this.#signRaw = opts.sign;
    this.#venue = opts.venue;
    this.#marks = opts.marks;
    this.#now = opts.now ?? (() => new Date());
  }

  /**
   * Check `prepared` against `cap` on the venue's current record, then sign.
   * A refusal throws `VenueRefusalError` and the agent key never signs. Checks
   * run one at a time, so two orders can't both fit in the same room.
   */
  sign(prepared: PreparedVenueAction, cap: AgentCap): Promise<{ readonly signature: VenueSignature; readonly check: AgentCapCheck }> {
    const run = this.#queue.then(() => this.#checkAndSign(prepared, cap));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Release an order's reservation once the venue's answer is definite (accepted,
   * so the venue's record now carries it, or refused). Never after a
   * `definite: false` answer: read back first.
   */
  settle(venueClientOrderId: string): void {
    this.#reserved.delete(venueClientOrderId);
  }

  async #checkAndSign(prepared: PreparedVenueAction, cap: AgentCap) {
    const { account, intent } = prepared;
    const symbol =
      intent.kind === 'place_order' || intent.kind === 'amend_order' || intent.kind === 'update_leverage' ? intent.symbol : null;
    const [markets, balances, openOrders, positions, leverage] = await Promise.all([
      this.#venue.markets(account),
      this.#venue.balances(account),
      this.#venue.openOrders(account),
      this.#venue.positions(account),
      symbol && this.#venue.leverage ? this.#venue.leverage(account, symbol) : Promise.resolve(null),
    ]);
    const live = new Set(openOrders.value.map((o) => o.venueClientOrderId).filter((id): id is string => id !== null));
    const cloid = prepared.venueClientOrderId;
    let reserved = ZERO;
    for (const [id, amount] of this.#reserved) {
      // A reservation the venue now shows as resting is counted once, by the venue's lock.
      if (id !== cloid && !live.has(id)) reserved = add(reserved, amount);
    }
    const lev = leverage;
    const snapshot: AgentCapSnapshot = {
      markets: markets.value,
      balances: balances.value,
      openOrders: openOrders.value,
      positions: positions.value,
      leverageBps: lev && lev.value ? { known: true, value: lev.value.leverageBps } : { known: false },
    };
    const check = checkAgentOrderWithinCap(prepared, cap, snapshot, this.#marks, reserved, this.#now());
    const signature = await this.#signRaw(prepared);
    assertSignatureMatches(prepared, signature);
    if (cloid !== null && compare(check.commitment, ZERO) > 0) this.#reserved.set(cloid, check.commitment);
    return { signature, check };
  }
}
