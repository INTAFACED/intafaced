import { compare, div, formatAmount, isNegative, mul, parseAmount, sub, sum, ZERO, type Amount } from '@intafaced/ledger-client/money';
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
  // Net funding is floored at zero: taking profits out never makes room past the cap itself.
  const net = isNegative(sub(movedIn, movedOut)) ? ZERO : sub(movedIn, movedOut);
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
// THE ORDER CHECK — pure, on the venue's record and what we signed
// ════════════════════════════════════════════════════════════════════════════

/** The venue's record the order check reads, each as the venue reported it. */
export interface AgentCapSnapshot {
  readonly markets: readonly UserVenueMarket[];
  readonly balances: readonly UserVenueBalance[];
  readonly openOrders: readonly UserVenueOrder[];
  readonly positions: readonly UserVenuePosition[];
  /** The account's leverage on a perpetual, in bps of 1x, as the venue records it; `known: false` when it reports none. */
  readonly leverage: (symbol: string) => MaybeKnown<number>;
}

/** An order the agent key signed whose venue answer is not yet settled. */
export interface PendingAgentOrder {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly reduceOnly: boolean;
  /** Amount × price as signed, in the cap's asset. */
  readonly notional: Amount;
}

/** What the agent key signed that the venue's record may not show yet. */
export interface AgentCapPending {
  /** Signed orders and amends, by venue client order id. */
  readonly orders: ReadonlyMap<string, PendingAgentOrder>;
  /** Signed leverage changes not yet settled. Each may still land, so the lowest counts. */
  readonly leverage: readonly { readonly symbol: string; readonly leverageBps: number }[];
}

/** The mark of one unit of `asset`, in the cap's asset. `known: false` when there is none. */
export type AgentCapMarks = (asset: string) => MaybeKnown<Amount>;

export interface AgentCapCheck {
  /** What this action commits, in the cap's asset. */
  readonly commitment: Amount;
  /** What the account has in use, with what was signed and not yet settled; `null` when not measured (nothing to add). */
  readonly inUse: Amount | null;
  /** `cap - inUse`, floored at zero; `null` when not measured. */
  readonly room: Amount | null;
}

const ONE_X = 10_000;
const BPS_OF_1X = parseAmount(String(ONE_X));
const NOTHING: AgentCapCheck = { commitment: ZERO, inUse: null, room: null };

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

function maxOf(values: readonly Amount[]): Amount {
  return values.reduce((m, v) => (compare(v, m) > 0 ? v : m), ZERO);
}

/**
 * Refuse, before the agent key signs, an agent action the cap does not allow.
 * Returns the figures it judged on. Throws `VenueRefusalError`:
 *   · `agent_outside_capped_account` — not this cap's agent key, or not its sub-account;
 *   · `agent_cap_inactive` — revoked or expired (a cancel still passes);
 *   · `agent_cap_unmeasured` — the action adds commitment and "in use" can't be measured;
 *   · `agent_cap_exceeded` — the order's commitment is more than the room left, or a
 *     leverage cut would raise what is in use past the cap;
 *   · `unknown_order` — an amend of no resting order, or one naming another market.
 * Owner actions never come here: they are the person's own signatures.
 *
 * What is counted, all in the cap's asset:
 *   · a resting order: the most of the venue's lock, the order's own commitment
 *     at the lowest leverage that may apply, and our reservation for it (an
 *     amend we signed may not have landed, and a venue may report no lock);
 *   · a signed order the venue does not show: its reservation;
 *   · a position: the most of its venue margin and its notional at the mark
 *     over the lowest leverage that may apply;
 *   · every other holding at its mark.
 * The lowest leverage that may apply on a perpetual is the least of the
 * venue's record (1x when it reports none) and every signed, unsettled
 * leverage change, so a cut signed before or after an order is always counted.
 */
export function checkAgentOrderWithinCap(
  prepared: PreparedVenueAction,
  cap: AgentCap,
  snapshot: AgentCapSnapshot,
  marks: AgentCapMarks,
  pending: AgentCapPending,
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

  if (intent.kind === 'cancel_order') return NOTHING;

  if (cap.revokedAt !== null)
    refuse(account, 'agent_cap_inactive', `the person revoked this agent at ${cap.revokedAt.toISOString()}; only cancels are allowed`);
  if (cap.validUntil !== null && now.getTime() >= cap.validUntil.getTime()) {
    refuse(account, 'agent_cap_inactive', `this agent's cap expired at ${cap.validUntil.toISOString()}; only cancels are allowed`);
  }
  if (intent.kind !== 'place_order' && intent.kind !== 'amend_order' && intent.kind !== 'update_leverage') {
    // Withdrawals and approvals are owner-only; assertSignerMaySign refused them above.
    refuse(account, 'agent_outside_capped_account', `an agent key cannot sign ${intent.kind}`);
  }

  const marketOf = (symbol: string): UserVenueMarket => {
    const m = snapshot.markets.find((x) => x.symbol === symbol);
    if (!m) refuse(account, 'unknown_market', `${symbol} is not listed for this account`);
    if (m.quoteAsset !== cap.asset)
      refuse(account, 'agent_cap_unmeasured', `${symbol} is quoted in ${m.quoteAsset}; this cap is counted in ${cap.asset}`);
    return m;
  };

  const levCut = intent.kind === 'update_leverage' ? intent : null;
  if (levCut && (!Number.isInteger(levCut.leverageBps) || levCut.leverageBps < ONE_X)) {
    refuse(account, 'agent_cap_unmeasured', `a leverage of ${levCut.leverageBps} bps is below 1x`);
  }
  const leverageOf = (symbol: string): number => {
    const venue = snapshot.leverage(symbol);
    // The venue's leverage read; else the leverage its position on the market reports; else 1x.
    const position = snapshot.positions.find((p) => p.symbol === symbol);
    let lev = venue.known ? venue.value : position ? position.leverageBps : ONE_X;
    if (!Number.isInteger(lev) || lev < ONE_X)
      refuse(account, 'agent_cap_unmeasured', `the venue reports a leverage of ${lev} bps on ${symbol}, below 1x`);
    for (const p of pending.leverage) if (p.symbol === symbol && p.leverageBps < lev) lev = p.leverageBps;
    if (levCut && levCut.symbol === symbol && levCut.leverageBps < lev) lev = levCut.leverageBps;
    return lev;
  };
  const commits = (o: { symbol: string; side: 'buy' | 'sell'; reduceOnly: boolean; notional: Amount }): Amount => {
    const m = marketOf(o.symbol);
    if (m.kind === 'spot') return o.side === 'buy' ? o.notional : ZERO; // reduce-only means nothing on spot: a buy spends quote
    if (o.reduceOnly) return ZERO;
    return div(mul(o.notional, BPS_OF_1X, 'ceil'), parseAmount(String(leverageOf(o.symbol))), 'ceil');
  };

  // ── what this action commits ───────────────────────────────────────────
  let commitment = ZERO;
  let replaced: UserVenueOrder | null = null;
  if (intent.kind === 'amend_order') {
    const cloid = venueClientOrderId(account.venueId, intent.clientOrderKey);
    replaced = snapshot.openOrders.find((o) => o.venueClientOrderId === cloid) ?? null;
    if (!replaced) refuse(account, 'unknown_order', `no resting order with client id ${cloid} on this account`);
    if (replaced.symbol !== intent.symbol)
      refuse(account, 'unknown_order', `order ${cloid} rests on ${replaced.symbol}, not ${intent.symbol}`);
    commitment = commits({
      symbol: replaced.symbol,
      side: replaced.side,
      reduceOnly: replaced.reduceOnly,
      notional: mul(intent.amount, intent.price, 'ceil'),
    });
  } else if (intent.kind === 'place_order') {
    commitment = commits({
      symbol: intent.symbol,
      side: intent.side,
      reduceOnly: intent.reduceOnly,
      notional: mul(intent.amount, intent.price, 'ceil'),
    });
  } else {
    // A leverage change commits nothing itself; a cut is judged by what it does to everything in use below.
    marketOf(intent.symbol);
    const venue = snapshot.leverage(intent.symbol);
    const before = venue.known ? venue.value : ONE_X;
    const lowestPending = pending.leverage.filter((p) => p.symbol === intent.symbol).reduce((m, p) => Math.min(m, p.leverageBps), before);
    if (intent.leverageBps >= lowestPending) return NOTHING;
  }
  if (!levCut && compare(commitment, ZERO) === 0) return NOTHING;

  // ── what is in use ─────────────────────────────────────────────────────
  const self = prepared.venueClientOrderId;
  const parts: Amount[] = [];
  const live = new Set<string>();
  for (const o of snapshot.openOrders) {
    if (o.venueClientOrderId !== null) live.add(o.venueClientOrderId);
    if (o === replaced || (self !== null && o.venueClientOrderId === self)) continue; // this action replaces it
    const lock = o.lockedAsset === cap.asset ? o.locked : ZERO;
    const own = commits({ symbol: o.symbol, side: o.side, reduceOnly: o.reduceOnly, notional: mul(o.remaining, o.price, 'ceil') });
    const res = o.venueClientOrderId !== null ? pending.orders.get(o.venueClientOrderId) : undefined;
    parts.push(maxOf([lock, own, res ? commits(res) : ZERO]));
  }
  for (const [id, res] of pending.orders) {
    if (id !== self && !live.has(id)) parts.push(commits(res));
  }
  for (const p of snapshot.positions) {
    const m = marketOf(p.symbol);
    const atLev =
      m.kind === 'perpetual'
        ? div(
            mul(mul(p.size, p.markPrice, 'ceil'), BPS_OF_1X, 'ceil'),
            parseAmount(String(Math.min(p.leverageBps, leverageOf(p.symbol)))),
            'ceil',
          )
        : ZERO;
    parts.push(maxOf([p.margin, atLev]));
  }
  for (const b of snapshot.balances) {
    if (b.asset === cap.asset || compare(b.total, ZERO) === 0) continue;
    const mark = marks(b.asset);
    if (!mark.known) {
      refuse(
        account,
        'agent_cap_unmeasured',
        `the account holds ${formatAmount(b.total)} ${b.asset} and its mark in ${cap.asset} is not known, so the room under the cap is not known`,
      );
    }
    parts.push(mul(b.total, mark.value, 'ceil'));
  }
  const inUse = sum(parts);
  const left = sub(cap.cap, inUse);
  const room = isNegative(left) ? ZERO : left;
  if (levCut) {
    if (compare(inUse, cap.cap) > 0) {
      refuse(
        account,
        'agent_cap_exceeded',
        `at ${levCut.leverageBps / ONE_X}x on ${levCut.symbol} the account would have ${formatAmount(inUse)} ${cap.asset} in use, past the cap of ${formatAmount(cap.cap)} ${cap.asset}`,
      );
    }
    return { commitment: ZERO, inUse, room };
  }
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
  /** Signed orders not yet settled, by venue client order id. */
  readonly #orders = new Map<string, PendingAgentOrder>();
  /** Signed leverage changes not yet settled, by the action's nonce. */
  readonly #leverage = new Map<string, { readonly symbol: string; readonly leverageBps: number }>();
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
   * Release what a signed action reserved once the venue's answer is definite
   * and its record shows the result (an order resting, filled or refused; a
   * leverage change applied or refused). Key: the order's venue client order
   * id, or a leverage change's nonce. Never after a `definite: false` answer:
   * read back first. Until settled, a reservation counts, so a filled order is
   * counted twice for a moment (more refused, never less).
   */
  settle(key: string): void {
    this.#orders.delete(key);
    this.#leverage.delete(key);
  }

  async #checkAndSign(prepared: PreparedVenueAction, cap: AgentCap) {
    const { account, intent } = prepared;
    const [markets, balances, openOrders, positions] = await Promise.all([
      this.#venue.markets(account),
      this.#venue.balances(account),
      this.#venue.openOrders(account),
      this.#venue.positions(account),
    ]);
    const perps = new Set(markets.value.filter((m) => m.kind === 'perpetual').map((m) => m.symbol));
    const symbols = new Set<string>();
    if (intent.kind === 'place_order' || intent.kind === 'amend_order' || intent.kind === 'update_leverage') symbols.add(intent.symbol);
    for (const o of openOrders.value) symbols.add(o.symbol);
    for (const p of positions.value) symbols.add(p.symbol);
    for (const o of this.#orders.values()) symbols.add(o.symbol);
    const levRead = this.#venue.leverage?.bind(this.#venue);
    const levs = new Map<string, number>();
    if (levRead) {
      await Promise.all(
        [...symbols]
          .filter((s) => perps.has(s))
          .map(async (s) => {
            const r = await levRead(account, s);
            if (r.value) levs.set(s, r.value.leverageBps);
          }),
      );
    }
    const snapshot: AgentCapSnapshot = {
      markets: markets.value,
      balances: balances.value,
      openOrders: openOrders.value,
      positions: positions.value,
      leverage: (s) => (levs.has(s) ? { known: true, value: levs.get(s)! } : { known: false }),
    };
    const pending: AgentCapPending = { orders: this.#orders, leverage: [...this.#leverage.values()] };
    const check = checkAgentOrderWithinCap(prepared, cap, snapshot, this.#marks, pending, this.#now());
    const signature = await this.#signRaw(prepared);
    assertSignatureMatches(prepared, signature);
    if (intent.kind === 'update_leverage') {
      this.#leverage.set(prepared.nonce, { symbol: intent.symbol, leverageBps: intent.leverageBps });
    } else if ((intent.kind === 'place_order' || intent.kind === 'amend_order') && prepared.venueClientOrderId !== null) {
      const resting = openOrders.value.find((o) => o.venueClientOrderId === prepared.venueClientOrderId);
      const side = intent.kind === 'place_order' ? intent.side : resting!.side;
      const reduceOnly = intent.kind === 'place_order' ? intent.reduceOnly : resting!.reduceOnly;
      this.#orders.set(prepared.venueClientOrderId, {
        symbol: intent.symbol,
        side,
        reduceOnly,
        notional: mul(intent.amount, intent.price, 'ceil'),
      });
    }
    return { signature, check };
  }
}
