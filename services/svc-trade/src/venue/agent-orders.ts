import { add, compare, div, parseAmount, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { isApiKeyPrincipal, type Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import type { TypedDataDefinition } from 'viem';
import {
  AgentCapError,
  CappedAgentSigner,
  VenueRefusalError,
  isTestVenue,
  type AgentCap,
  type AgentCapMarks,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UpdateLeverageIntent,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueOrder,
  type VenueRefusal,
  type VenueSignature,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import { AGENT_ACCOUNT_STEP_UP_SCOPE, AgentAccountError, assertPerson, capErrorAs, type AgentAccountValues } from './agent-account.js';
import type { AgentAccountRecord, AgentAccountStore } from './agent-account-store.js';
import type { AgentConnectionRecord, AgentConnectionStore } from './agent-connection-store.js';
import type { AgentKeyReader } from './agent-key-read-client.js';
import { agentKeyFor } from './agent-key.js';
import { AGENT_ORDER_PREFIX, orderOriginOf, UserVenueDoorError, type UserVenueDoor } from './user-venue-door.js';

/**
 * THE ASSISTANT'S TRADE PATH (J-agents-21 #6 #7 #8 #10; piece 1: svc-trade, spot; piece 2: perpetuals). The person's own outside assistant calls our
 * API with an `agent` API key the person made; the person binds that key to one of their open agent accounts; from then on
 * every order from that key is placed on that account's venue sub-account and nowhere else.
 *
 * Money (J-agents-21): INTAFACED holds and moves nothing, and the ledger posts nothing. The order locks and fills only on
 * the agent's venue sub-account, as the venue reports it. Before the agent key signs, `CappedAgentSigner` holds the order
 * to the person's cap and the owner's drain bounds (venue-contracts agent-cap.ts); the key it signs with is the venue
 * agent key derived for that account (agent-key.ts), which the venue lets trade that sub-account and nothing else (no
 * move, no withdrawal). The main venue account is never named: the account an order is prepared on is read from the
 * connection's agent account, never from the request.
 *
 * A perpetual (#8) opens isolated on the agent's venue account, at the leverage the assistant names: before the order,
 * the agent key sets that market's leverage and isolated margin on the sub-account (`update_leverage`, held to the cap and
 * the owner's market list like an order, sent once under `agent:leverage:<keyId>:<clientOrderId>`), unless the venue's
 * record already shows exactly that setting. The venue then takes the margin on the sub-account and nowhere else. A
 * reduce-only order (a close) changes no setting.
 *
 * Each order is sent once: it is stored under `agent:order:<keyId>:<clientOrderId>`, the assistant's own client order id
 * as the business key, and the venue's client order id derives from it. A retry with the same id reads the venue's record
 * by that client order id first and re-sends only the stored, signed bytes, never a new signature on a new nonce.
 *
 * Crash points (whose funds are stranded?): none, ever. Before the signature nothing exists outside our store. After it,
 * the bytes are stored before they are sent; a lost answer is read back by client order id; the order can only rest or
 * fill on the person's own sub-account, which their wallet controls.
 *
 * One signer per agent key, in this process (agent-cap.ts: "the service holding the agent key runs exactly one signer for
 * it"); its reservations for signed orders with no definite answer are in memory, and the venue's own record of resting
 * orders is read on every check.
 */

/** The scopes an assistant's key may hold, and the one it must: trading, never moving funds or settings. */
export const AGENT_KEY_TRADE_SCOPES: ReadonlySet<string> = new Set(['trade:read', 'trade:write']);

export const agentOrderKey = (keyId: string, clientOrderId: string) => `${AGENT_ORDER_PREFIX}${keyId}:${clientOrderId}`;
/** The business key of the leverage setting an assistant's perpetual order needs first (#8). */
export const agentLeverageKey = (keyId: string, clientOrderId: string) => `agent:leverage:${keyId}:${clientOrderId}`;
/** 1x in basis points of 1x, the unit a venue's leverage travels in. */
const ONE_X_BPS = 10_000;
const LEVERAGE_RE = /^[1-9][0-9]{0,2}$/;
export { orderOriginOf };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DECIMAL_RE = /^[0-9]+(\.[0-9]+)?$/;
const TWO = parseAmount('2');

/** The venue refused the assistant's order on its own record (not enough funds, say): its words, with the venue named. */
export class AgentVenueRefusal extends Error {
  constructor(
    readonly refusal: VenueRefusal,
    readonly venueName: string,
    readonly actionKey: string,
  ) {
    super(`${venueName} refused the order: ${refusal.detail}`);
    this.name = 'AgentVenueRefusal';
  }
}

export interface AgentConnectionView {
  readonly keyId: string;
  readonly accountId: string;
  readonly subAccount: string | null;
  readonly connectedAt: Date;
}

export interface AgentOrderView {
  readonly actionKey: string;
  readonly clientOrderId: string;
  /** `agent:<keyId>`: /trade/orders tags it "by your assistant". */
  readonly origin: string;
  readonly venueId: string;
  /** The agent's own venue sub-account: the only account this route ever names. */
  readonly account: { readonly owner: string; readonly subAccount: string };
  /** `accepted`: the venue's record of the order. `unknown`: sent, no definite answer yet; retry the same clientOrderId. */
  readonly state: 'accepted' | 'unknown';
  readonly order: UserVenueOrder | null;
  readonly asOf: Date | null;
  /** True when this answer is the venue's record of an order sent earlier under the same clientOrderId: nothing was sent now. */
  readonly replayed: boolean;
  readonly test: boolean;
}

export interface AgentOrdersDeps {
  readonly door: UserVenueDoor;
  readonly accounts: AgentAccountStore;
  readonly connections: AgentConnectionStore;
  readonly keys: AgentKeyReader;
  readonly stepUp: StepUpCheck;
  readonly values: AgentAccountValues;
  readonly now: () => Date;
}

function uuid(value: unknown, label: string): string {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_RE.test(v)) throw new AgentAccountError('agents.account_request_invalid', `${label} must be a UUID`, 400);
  return v;
}

function orderInvalid(message: string): never {
  throw new AgentAccountError('agents.order_request_invalid', message, 400);
}

function amountOf(value: unknown, label: string): Amount {
  let v: Amount;
  if (typeof value === 'bigint') v = value;
  else if (typeof value === 'string' && DECIMAL_RE.test(value.trim())) v = parseAmount(value.trim());
  else orderInvalid(`${label} must be a decimal string (never a JSON number)`);
  if (compare(v, ZERO) <= 0) orderInvalid(`${label} must be above zero`);
  return v;
}

/** The mid of a book's best bid and best ask; unknown when either side is empty (never a one-sided guess). */
function midOf(book: { bids: readonly { price: Amount }[]; asks: readonly { price: Amount }[] }) {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  return bid !== undefined && ask !== undefined
    ? { known: true as const, value: div(add(bid, ask), TWO, 'half-up') }
    : { known: false as const };
}

export class AgentOrders {
  /** One capped signer per agent key (by its address), so two orders from one key can't both fit in the same room. */
  private readonly signers = new Map<string, CappedAgentSigner>();
  /** The marks the signer for each key judges by, refreshed from the venue's books before each check. */
  private readonly holdingMarks = new Map<string, Map<string, Amount | null>>();
  private readonly orderMarks = new Map<string, Map<string, Amount | null>>();

  constructor(private readonly deps: AgentOrdersDeps) {}

  // ── the person binds their own agent key to their agent account (#6) ───────────────────────────────────────────

  /**
   * Bind one of the person's own `agent` API keys to one of their open agent accounts. The person's own session only
   * (never an API key: the assistant can't connect itself), with step-up, as every other agent-account write. Identity
   * says the key is theirs, an agent key, live, and holding trade scopes only, before step-up is spent. A key has one
   * active connection: the same key and account again is the same connection; another account refuses.
   */
  async connect(
    principal: Principal,
    accountId: string,
    req: { keyId?: unknown; stepUpApprovalId?: string | null },
  ): Promise<AgentConnectionView> {
    assertPerson(principal);
    const id = uuid(accountId, 'accountId');
    const keyId = uuid(req.keyId, 'keyId');
    const account = await this.deps.accounts.find(principal.userId, id);
    if (!account) throw new AgentAccountError('agents.account_unknown', `no agent account ${id} on this login`, 404);
    if (account.status !== 'open') {
      throw new AgentAccountError(
        'agents.account_not_open',
        `agent account ${id} is ${account.status}; only an open one can be connected`,
        409,
      );
    }
    const key = await this.deps.keys.read(principal.userId, keyId);
    if (key === null) {
      throw new AgentAccountError(
        'agents.key_read_unavailable',
        'the key could not be checked with identity just now; nothing was connected',
        503,
      );
    }
    if (key.state === 'none') throw new AgentAccountError('agents.key_unknown', `no API key ${keyId} on this login`, 404);
    if (key.revoked) throw new AgentAccountError('agents.key_revoked', `API key ${keyId} is revoked or past its end date`, 409);
    if (key.kind !== 'agent') {
      throw new AgentAccountError(
        'agents.key_not_agent',
        'only a key tagged Agent can trade an agent account; make one as an agent key',
        422,
      );
    }
    const extra = key.scopes.filter((s) => !AGENT_KEY_TRADE_SCOPES.has(s));
    if (extra.length > 0 || !key.scopes.includes('trade:write')) {
      throw new AgentAccountError(
        'agents.key_scope_not_trade',
        extra.length > 0
          ? `an assistant's key holds trade scopes only; this one also holds ${extra.join(', ')}`
          : "an assistant's key needs trade:write to place orders",
        422,
        { scopes: key.scopes },
      );
    }
    const existing = await this.deps.connections.active(keyId);
    if (existing) return this.connectedOrRefused(existing, principal.userId, id, account);
    await this.deps.stepUp.require({
      scope: AGENT_ACCOUNT_STEP_UP_SCOPE,
      userId: principal.userId,
      sessionId: principal.sid,
      approvalId: req.stepUpApprovalId,
      fields: { keyId, accountId: id },
      requestId: `venue.agentConnect:${keyId}`,
    });
    const stored = await this.deps.connections.connectOnce({
      keyId,
      userId: principal.userId,
      accountId: id,
      createdAt: this.deps.now(),
      endedAt: null,
    });
    return this.connectedOrRefused(stored, principal.userId, id, account);
  }

  private connectedOrRefused(c: AgentConnectionRecord, userId: string, accountId: string, a: AgentAccountRecord): AgentConnectionView {
    if (c.userId !== userId || c.accountId !== accountId) {
      throw new AgentAccountError('agents.key_already_connected', `API key ${c.keyId} already trades another agent account`, 409);
    }
    return { keyId: c.keyId, accountId: c.accountId, subAccount: a.subAccount, connectedAt: c.createdAt };
  }

  /** The person's keys that trade an agent account. */
  async connections(principal: Principal): Promise<readonly AgentConnectionView[]> {
    assertPerson(principal);
    const rows = await this.deps.connections.listActive(principal.userId);
    const out: AgentConnectionView[] = [];
    for (const c of rows) {
      const a = await this.deps.accounts.find(principal.userId, c.accountId);
      out.push({ keyId: c.keyId, accountId: c.accountId, subAccount: a?.subAccount ?? null, connectedAt: c.createdAt });
    }
    return out;
  }

  /**
   * #9: true when `principal` is an API key connected to one of its person's agent accounts. Such a key calls the
   * assistant's order route and nothing else on the venue door: no move, withdrawal, or read or action on any other
   * account (user-venue-rest.ts `refusedAgentKey`).
   */
  async confined(principal: Principal): Promise<boolean> {
    if (!isApiKeyPrincipal(principal) || principal.sub_account) return false;
    const keyId = (principal.kid ?? '').toLowerCase();
    if (!UUID_RE.test(keyId)) return false;
    const c = await this.deps.connections.active(keyId);
    return c !== null && c.userId === principal.userId;
  }

  // ── the assistant's order (#7 #10) ─────────────────────────────────────────────────────────────────────────────

  /** The connected key's agent account, open, or the typed refusal. */
  private async boundAccount(principal: Principal): Promise<{ keyId: string; account: AgentAccountRecord & { subAccount: string } }> {
    if (!isApiKeyPrincipal(principal) || principal.sub_account) {
      throw new AgentAccountError(
        'agents.order_needs_agent_key',
        "this route is the assistant's: it is called with the agent API key connected to an agent account",
        403,
      );
    }
    const keyId = (principal.kid ?? '').toLowerCase();
    const c = UUID_RE.test(keyId) ? await this.deps.connections.active(keyId) : null;
    if (!c || c.userId !== principal.userId) {
      throw new AgentAccountError('agents.key_not_connected', 'this API key is not connected to an agent account', 403);
    }
    const a = await this.deps.accounts.find(principal.userId, c.accountId);
    if (!a || a.status !== 'open' || a.subAccount === null) {
      throw new AgentAccountError(
        'agents.account_not_open',
        `the agent account this key trades is ${a?.status ?? 'gone'}; nothing is placed`,
        409,
        { accountId: c.accountId },
      );
    }
    return { keyId, account: a as AgentAccountRecord & { subAccount: string } };
  }

  private signerFor(a: AgentAccountRecord, venue: UserVenue, seed: string): CappedAgentSigner {
    let s = this.signers.get(a.agentAddress);
    if (!s) {
      const holding = new Map<string, Amount | null>();
      const priced = new Map<string, Amount | null>();
      const look =
        (m: Map<string, Amount | null>): AgentCapMarks =>
        (asset) => {
          const v = m.get(asset);
          return v === undefined || v === null ? { known: false } : { known: true, value: v };
        };
      const key = agentKeyFor(seed, a.userId, a.accountId);
      if (key.address.toLowerCase() !== a.agentAddress)
        throw new Error(`agent key of account ${a.accountId} does not derive to its approved address`);
      s = new CappedAgentSigner({
        sign: async (prepared: PreparedVenueAction): Promise<VenueSignature> => ({
          digest: prepared.digest,
          signature: await key.signTypedData(prepared.typedData as TypedDataDefinition),
          signedBy: key.address.toLowerCase(),
        }),
        venue,
        marks: look(holding),
        priceMarks: look(priced),
        bounds: this.deps.values.bounds,
        now: this.deps.now,
      });
      this.signers.set(a.agentAddress, s);
      this.holdingMarks.set(a.agentAddress, holding);
      this.orderMarks.set(a.agentAddress, priced);
    }
    return s;
  }

  /**
   * The marks the cap and the price bound judge by, from the venue's own books: the order's market for its price, and a
   * spot market quoted in the cap's asset for each other asset the sub-account holds. A side that is empty leaves the
   * mark unknown, and the signer then refuses `agent_cap_unmeasured`: never a guess.
   */
  private async refreshMarks(a: AgentAccountRecord, venue: UserVenue, sub: UserVenueAccount, symbol: string, baseAsset: string) {
    const holding = this.holdingMarks.get(a.agentAddress)!;
    const priced = this.orderMarks.get(a.agentAddress)!;
    const [markets, balances] = await Promise.all([venue.markets(sub), venue.balances(sub)]);
    const orderMid = midOf((await venue.book(symbol, 1)).value);
    priced.set(baseAsset, orderMid.known ? orderMid.value : null);
    for (const b of balances.value) {
      if (b.asset === a.asset || compare(b.total, ZERO) === 0) continue;
      const m = markets.value.find((x) => x.kind === 'spot' && x.baseAsset === b.asset && x.quoteAsset === a.asset);
      const mid = m ? midOf((await venue.book(m.symbol, 1)).value) : { known: false as const };
      holding.set(b.asset, mid.known ? mid.value : null);
    }
  }

  /**
   * #7 #8 #10: the assistant places a spot or perpetual order. Only on the connected key's own agent sub-account; held to
   * the cap and the owner's bounds before the agent key signs; sent once under `agent:order:<keyId>:<clientOrderId>`. An
   * opening perpetual names its leverage and opens isolated (`isolatedAt`). A venue refusal (not enough funds or margin)
   * is the venue's, named, and nothing is open.
   */
  async place(principal: Principal, req: Record<string, unknown>): Promise<AgentOrderView> {
    const { keyId, account: a } = await this.boundAccount(principal);
    const seed = this.deps.values.keySeed;
    if (seed === null)
      throw new AgentAccountError(
        'agents.agent_key_unset',
        'the agent key secret is not set (owner value blank), so nothing is signed',
        422,
      );
    const clientOrderId = typeof req.clientOrderId === 'string' ? req.clientOrderId.trim() : '';
    if (!CLIENT_ORDER_ID_RE.test(clientOrderId))
      orderInvalid('clientOrderId must be 1 to 64 letters, digits, - or _ that the assistant chose once for this order');
    const side = req.side;
    if (side !== 'buy' && side !== 'sell') orderInvalid('side must be buy or sell');
    const type = req.type ?? 'limit';
    if (type !== 'limit' && type !== 'market') orderInvalid('type must be limit or market');
    const timeInForce = req.timeInForce ?? (type === 'market' ? 'IOC' : 'GTC');
    if (timeInForce !== 'GTC' && timeInForce !== 'IOC' && timeInForce !== 'ALO') orderInvalid('timeInForce must be GTC, IOC or ALO');
    const symbol = typeof req.symbol === 'string' ? req.symbol.trim() : '';
    if (!/^\S{1,64}$/.test(symbol)) orderInvalid('symbol must be a venue market symbol');
    const amount = amountOf(req.amount, 'amount');
    const price = amountOf(req.price, 'price (on a market order, the worst price accepted)');
    if (req.reduceOnly !== undefined && typeof req.reduceOnly !== 'boolean') orderInvalid('reduceOnly must be true or false');
    const reduceOnly = req.reduceOnly === true;
    if (req.leverage !== undefined && (typeof req.leverage !== 'string' || !LEVERAGE_RE.test(req.leverage.trim())))
      orderInvalid('leverage must be a whole number of times, as a string ("3" is 3x)');
    const leverageBps = typeof req.leverage === 'string' ? Number(req.leverage.trim()) * ONE_X_BPS : null;

    const key = agentOrderKey(keyId, clientOrderId);
    const venue = await this.deps.door.venue();
    const sub: UserVenueAccount = { venueId: venue.venue.id, owner: a.owner, subAccount: a.subAccount };
    if (a.venueId !== venue.venue.id) {
      throw new AgentAccountError('agents.account_not_open', `agent account ${a.accountId} is on ${a.venueId}, not ${venue.venue.id}`, 409);
    }

    // A clientOrderId already signed is never signed again: the venue's record by its client order id first.
    const stored = await this.deps.door.stored(principal, key);
    if (stored?.signature) {
      // The same terms only: a different order under a used clientOrderId is a new order and needs a new id.
      const was = stored.prepared.intent;
      const same =
        was.kind === 'place_order' &&
        was.symbol === symbol &&
        was.side === side &&
        was.type === type &&
        was.amount === amount &&
        was.price === price &&
        was.timeInForce === timeInForce &&
        was.reduceOnly === reduceOnly;
      if (!same) {
        throw new UserVenueDoorError(
          `the clientOrderId ${clientOrderId} was already used for a different order; a new order needs a new clientOrderId`,
          'idempotency.conflict',
          409,
        );
      }
      return this.readBackOrResend(principal, a, keyId, clientOrderId, key, stored.signature, venue);
    }

    const market = (await venue.markets(sub)).value.find((m) => m.symbol === symbol);
    if (!market)
      throw new VenueRefusalError({
        venueId: venue.venue.id,
        code: 'unknown_market',
        detail: `${symbol} is not listed on ${venue.venue.displayName}`,
      });
    const perp = market.kind === 'perpetual';
    if (!perp && market.kind !== 'spot') orderInvalid(`${symbol} is a ${market.kind} market; an assistant trades spot and perpetuals`);
    if (!perp && reduceOnly) orderInvalid('reduceOnly is not taken on a spot order');
    if (!perp && leverageBps !== null) orderInvalid('leverage is not taken on a spot order');
    if (perp && !reduceOnly && leverageBps === null)
      orderInvalid('an opening perpetual order names its leverage ("leverage": "3"); it opens isolated on the agent account');
    if (perp && reduceOnly && leverageBps !== null) orderInvalid("a reduce-only order closes at the position's own leverage");
    const intent: PlaceUserOrderIntent = {
      kind: 'place_order',
      symbol,
      side,
      type,
      amount,
      price,
      timeInForce,
      reduceOnly,
      clientOrderKey: key,
      builderFee: null,
    };
    const signer = this.signerFor(a, venue, seed);
    const cap: AgentCap = { account: sub, agentAddress: a.agentAddress, asset: a.asset, cap: a.cap, validUntil: null, revokedAt: null };
    // #8: an opening perpetual is isolated at the named leverage on the sub-account, set first by the agent key.
    if (perp && leverageBps !== null) {
      await this.refreshMarks(a, venue, sub, symbol, market.baseAsset);
      await this.isolatedAt(
        principal,
        a,
        signer,
        cap,
        venue,
        sub,
        {
          kind: 'update_leverage',
          symbol,
          leverageBps,
          marginMode: 'isolated',
        },
        agentLeverageKey(keyId, clientOrderId),
      );
    }
    let prepared: PreparedVenueAction;
    try {
      prepared = (
        await this.deps.door.prepare(
          principal,
          { owner: a.owner, subAccount: a.subAccount, signer: { role: 'agent', address: a.agentAddress }, intent },
          { agentAccount: true },
        )
      ).prepared;
    } catch (error) {
      throw this.venueNamed(error, venue, key);
    }
    // The invariant this route keeps: the order names the bound agent sub-account and its agent key, nothing else.
    if (
      prepared.account.venueId !== sub.venueId ||
      prepared.account.owner.toLowerCase() !== a.owner ||
      prepared.account.subAccount !== a.subAccount ||
      prepared.signer.role !== 'agent' ||
      prepared.signer.address.toLowerCase() !== a.agentAddress
    ) {
      throw new Error(`agent order ${key} was prepared outside its agent sub-account; nothing is signed`);
    }

    await this.refreshMarks(a, venue, sub, symbol, market.baseAsset);
    let signature: VenueSignature;
    try {
      ({ signature } = await signer.sign(prepared, cap));
    } catch (error) {
      throw this.signRefusal(error, venue, key);
    }
    return this.send(principal, a, keyId, clientOrderId, key, signature, venue, false);
  }

  /** A refusal before the agent key signs: the cap's and the bounds' own codes, else the venue's, named. */
  private signRefusal(error: unknown, venue: UserVenue, key: string): unknown {
    if (error instanceof AgentCapError) capErrorAs(error);
    if (error instanceof VenueRefusalError && error.refusal.code.startsWith('agent_cap')) {
      return new AgentAccountError(
        error.refusal.code === 'agent_cap_exceeded' ? 'agents.order_cap_exceeded' : 'agents.order_cap_refused',
        error.refusal.detail,
        422,
        { capCode: error.refusal.code },
      );
    }
    return this.venueNamed(error, venue, key);
  }

  /**
   * #8: the market's leverage and isolated margin on the agent sub-account, as `want` names them, before an opening
   * perpetual order. Nothing is signed when the venue's record already shows exactly that. Otherwise the agent key signs
   * `update_leverage` (held to the cap and the owner's markets first) under `key`, stored before it is sent; a retry
   * re-sends the stored bytes, never a new signature. The order goes on only once the venue has accepted the setting.
   */
  private async isolatedAt(
    principal: Principal,
    a: AgentAccountRecord & { subAccount: string },
    signer: CappedAgentSigner,
    cap: AgentCap,
    venue: UserVenue,
    sub: UserVenueAccount,
    want: UpdateLeverageIntent,
    key: string,
  ): Promise<void> {
    const now = (await venue.leverage(sub, want.symbol)).value;
    if (now && now.leverageBps === want.leverageBps && now.marginMode === want.marginMode) return;
    let signature = (await this.deps.door.stored(principal, key))?.signature ?? null;
    if (!signature) {
      let prepared: PreparedVenueAction;
      try {
        prepared = (
          await this.deps.door.prepare(
            principal,
            { owner: a.owner, subAccount: a.subAccount, signer: { role: 'agent', address: a.agentAddress }, intent: want, actionKey: key },
            { agentAccount: true },
          )
        ).prepared;
      } catch (error) {
        throw this.venueNamed(error, venue, key);
      }
      if (
        prepared.account.venueId !== sub.venueId ||
        prepared.account.owner.toLowerCase() !== a.owner ||
        prepared.account.subAccount !== a.subAccount ||
        prepared.signer.role !== 'agent' ||
        prepared.signer.address.toLowerCase() !== a.agentAddress
      ) {
        throw new Error(`agent leverage ${key} was prepared outside its agent sub-account; nothing is signed`);
      }
      try {
        ({ signature } = await signer.sign(prepared, cap));
      } catch (error) {
        throw this.signRefusal(error, venue, key);
      }
    }
    let outcome: VenueSubmitOutcome;
    try {
      outcome = (await this.deps.door.submit(principal, key, signature, { agentAccount: true })).outcome;
    } catch (error) {
      throw this.venueNamed(error, venue, key);
    }
    const nonce = (await this.deps.door.stored(principal, key))?.prepared.nonce;
    if (!outcome.definite) {
      throw new AgentAccountError(
        'agents.order_leverage_unknown',
        `${venue.venue.displayName} has not answered the leverage setting yet; nothing was ordered. Send the same clientOrderId again`,
        503,
      );
    }
    if (nonce) signer.settle(nonce);
    if (!outcome.accepted) throw new AgentVenueRefusal(outcome.refusal, venue.venue.displayName, key);
  }

  private async send(
    principal: Principal,
    a: AgentAccountRecord & { subAccount: string },
    keyId: string,
    clientOrderId: string,
    key: string,
    signature: VenueSignature,
    venue: UserVenue,
    replayed: boolean,
  ): Promise<AgentOrderView> {
    let outcome: VenueSubmitOutcome;
    let wasReplay = replayed;
    try {
      const sent = await this.deps.door.submit(principal, key, signature, { agentAccount: true });
      outcome = sent.outcome;
      wasReplay = wasReplay || sent.replayed;
    } catch (error) {
      throw this.venueNamed(error, venue, key);
    }
    const stored = await this.deps.door.stored(principal, key);
    const cloid = stored?.prepared.venueClientOrderId ?? null;
    if (outcome.definite) {
      if (cloid) this.signers.get(a.agentAddress)?.settle(cloid);
      if (!outcome.accepted) throw new AgentVenueRefusal(outcome.refusal, venue.venue.displayName, key);
      return this.view(a, keyId, clientOrderId, key, venue, 'accepted', outcome.order ?? null, outcome.asOf, wasReplay);
    }
    return this.view(a, keyId, clientOrderId, key, venue, 'unknown', null, null, wasReplay);
  }

  /**
   * The same clientOrderId again, after its bytes were signed: read the venue's record by client order id. On it: that is
   * the answer, nothing is sent. Refused: the refusal. Not there yet: the stored bytes are sent again (the venue places one
   * order per client order id), never a new signature.
   */
  private async readBackOrResend(
    principal: Principal,
    a: AgentAccountRecord & { subAccount: string },
    keyId: string,
    clientOrderId: string,
    key: string,
    signature: VenueSignature,
    venue: UserVenue,
  ): Promise<AgentOrderView> {
    const read = await this.deps.door.orderByKey(principal, key);
    const cloid = read.venueClientOrderId;
    if (read.state === 'accepted') {
      if (cloid) this.signers.get(a.agentAddress)?.settle(cloid);
      return this.view(a, keyId, clientOrderId, key, venue, 'accepted', read.order, read.asOf, true);
    }
    if (read.state === 'refused' && read.refusal) {
      if (cloid) this.signers.get(a.agentAddress)?.settle(cloid);
      throw new AgentVenueRefusal(read.refusal, venue.venue.displayName, key);
    }
    return this.send(principal, a, keyId, clientOrderId, key, signature, venue, true);
  }

  /** A venue's own refusal (not down) becomes the venue-named refusal; anything else stays as it is. */
  private venueNamed(error: unknown, venue: UserVenue, key: string): unknown {
    if (error instanceof VenueRefusalError && error.refusal.code !== 'venue_down') {
      return new AgentVenueRefusal(error.refusal, venue.venue.displayName, key);
    }
    return error;
  }

  private view(
    a: AgentAccountRecord & { subAccount: string },
    keyId: string,
    clientOrderId: string,
    key: string,
    venue: UserVenue,
    state: AgentOrderView['state'],
    order: UserVenueOrder | null,
    asOf: Date | null,
    replayed: boolean,
  ): AgentOrderView {
    return {
      actionKey: key,
      clientOrderId,
      origin: `agent:${keyId}`,
      venueId: venue.venue.id,
      account: { owner: a.owner, subAccount: a.subAccount },
      state,
      order,
      asOf,
      replayed,
      test: isTestVenue(venue.venue),
    };
  }
}
