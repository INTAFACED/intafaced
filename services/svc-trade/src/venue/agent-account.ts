import { compare, formatAmount, parseAmount, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { AuthError, isApiKeyPrincipal, type Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import {
  AgentCapError,
  assertAgentCapWithinCeiling,
  agentFundingRoom,
  assertAgentFundingWithinCap,
  hasSubAccountReads,
  isTestVenue,
  type AgentCap,
  type AgentDrainBounds,
  type AsOf,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueBalance,
  type UserVenueSubAccountReads,
  type VenueIntent,
  type VenueRefusal,
  type VenueSignature,
} from '@intafaced/venue-contracts';
import { agentAddressFor } from './agent-key.js';
import { netFunding, type AgentAccountRecord, type AgentAccountStore, type AgentMoveRecord } from './agent-account-store.js';
import type { UserVenueDoor } from './user-venue-door.js';

/**
 * THE AGENT ACCOUNT (J-agents-21 #1 #3 #4 #5 #13 #14; spec AG-outside-01, the venue form of OWNER 183 (1)).
 *
 * The person's own outside assistant trades on an agent account: a venue sub-account under the person's own wallet,
 * opened and funded only by the person's own signed actions. INTAFACED holds and moves nothing: every action here is
 * prepared by the venue through the user-venue door, signed by the person's wallet, and sent once under its business
 * key; the ledger posts nothing (the venue is the record of the sub-account's balances).
 *
 * Why here, beside the door, and not in svc-agents: the door holds the one-prepared-action-per-key store, the venue
 * connection and identity's step-up, and the agent key's capped signer must sit where agent orders are signed. The cap
 * is held here before the wallet is ever asked to sign a move in, and the plain door refuses to open or move into a
 * sub-account at all (`AGENT_ACCOUNT_INTENTS`), so no move reaches the venue around it.
 *
 * Creating one (#3), in order, each the person's own signature on their main venue account:
 *   1. `create_sub_account` under `agent:account:<accountId>:create`: the venue opens the sub-account;
 *   2. `approve_agent` on the sub-account under `agent:account:<accountId>:approve`: the agent permission, for the key
 *      INTAFACED holds for this account (agent-key.ts), which can trade the sub-account and nothing else;
 *   3. `sub_account_transfer` into it under `agent:move:<accountId>`: the first funding the person confirmed.
 * The agent account is open only when the venue's record shows that first move. A signature the person rejects is
 * never submitted, so it moves nothing, and the account is not open; `abandon` ends it before the first move is signed.
 *
 * The cap (agent-cap.ts): the person's moves in, less their moves out, never pass it. A move is stored under the
 * account's row lock before it is prepared, and a move in counts until the venue refuses it, so a retry or two moves at
 * once can't slip past. Gains inside the account don't count; the most the person can lose is what they put in.
 *
 * Crash points (whose funds are stranded?): none of ours, ever. Before a move is signed nothing has moved; once signed,
 * its bytes are stored before they are sent, and `advance` reads the venue's own transfer record by the signed nonce,
 * so a lost answer is read back, never re-asked. Funds only ever sit in the person's own main account or their own
 * sub-account under the same wallet, which they can always move back.
 */

export type AgentAccountCode =
  | 'agents.account_ceiling_unset'
  | 'agents.account_cap_above_ceiling'
  | 'agents.account_cap_exceeded'
  | 'agents.account_cap_invalid'
  | 'agents.account_asset_unset'
  | 'agents.account_funding_asset'
  | 'agents.agent_key_unset'
  | 'agents.account_unknown'
  | 'agents.account_key_reused'
  | 'agents.account_not_open'
  | 'agents.account_not_opening'
  | 'agents.account_action_unknown'
  | 'agents.account_action_signed'
  | 'agents.account_close_open_position'
  | 'agents.account_close_open_order'
  | 'agents.account_close_balance'
  | 'agents.account_close_move_pending'
  | 'agents.account_request_invalid'
  | 'agents.account_venue_no_sub_accounts'
  // The assistant's connection and orders (agent-orders.ts, J-agents-21 #6 #7 #10).
  | 'agents.key_unknown'
  | 'agents.key_revoked'
  | 'agents.key_not_agent'
  | 'agents.key_scope_not_trade'
  | 'agents.key_read_unavailable'
  | 'agents.key_already_connected'
  | 'agents.key_not_connected'
  | 'agents.order_needs_agent_key'
  | 'agents.order_request_invalid'
  | 'agents.order_perp_not_yet'
  | 'agents.order_cap_exceeded'
  | 'agents.order_cap_refused'
  | 'agents.order_bound_unset'
  | 'agents.price_bound_unset'
  | 'agents.markets_unset'
  | 'agents.order_above_bound'
  | 'agents.price_past_bound'
  | 'agents.market_not_allowed';

export class AgentAccountError extends Error {
  constructor(
    readonly code: AgentAccountCode,
    message: string,
    readonly status: number,
    /** What the refusal names: the room left, the ceiling, the open position. */
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AgentAccountError';
  }
}

/** The owner values the agent account reads. `null` is blank; each blank one refuses with its own code. */
export interface AgentAccountValues {
  /** The most any person's cap may be (`TRADE_AGENT_ACCOUNT_CEILING`). Blank refuses every create. */
  readonly ceiling: Amount | null;
  /** The one asset an agent account is funded in and its cap counted in (`TRADE_AGENT_ACCOUNT_ASSET`). */
  readonly asset: string | null;
  /** The secret the agent keys derive from (`TRADE_AGENT_KEY_SEED`). Blank refuses every create. */
  readonly keySeed: string | null;
  /** The drain bounds every agent order is held to before the agent key signs (agent-cap.ts). */
  readonly bounds: AgentDrainBounds;
}

export const AGENT_ACCOUNT_STEP_UP_SCOPE = 'trade.step_up.venue.agentAccount' as const;

export interface AgentAccountsDeps {
  readonly door: UserVenueDoor;
  readonly store: AgentAccountStore;
  readonly stepUp: StepUpCheck;
  readonly values: AgentAccountValues;
  readonly now: () => Date;
}

/** What the wallet is asked to sign next, if anything. */
export interface NextSignature {
  readonly actionKey: string;
  readonly step: 'open_sub_account' | 'approve_agent' | 'move_in' | 'move_out';
  readonly prepared: PreparedVenueAction;
  /** True when this action was signed and sent and its answer is not yet known: re-send it, never sign a new one. */
  readonly signed: boolean;
}

export interface AgentMoveView {
  readonly moveId: string;
  readonly actionKey: string;
  readonly direction: AgentMoveRecord['direction'];
  readonly amount: Amount;
  readonly state: AgentMoveRecord['state'];
}

export interface AgentAccountView {
  readonly accountId: string;
  readonly status: AgentAccountRecord['status'];
  readonly owner: string;
  readonly subAccount: string | null;
  readonly name: string;
  readonly asset: string;
  readonly cap: Amount;
  readonly agentAddress: string;
  /** The person's moves in less moves out, as the cap counts them. */
  readonly netFunding: Amount;
  /** What the person may still move in. */
  readonly room: Amount;
  readonly moves: readonly AgentMoveView[];
  /** The sub-account's balances as the venue reports them; `null` before the sub-account exists. */
  readonly balances: AsOf<readonly UserVenueBalance[]> | null;
  readonly next: NextSignature | null;
  /** Why the account could not open (the venue's own refusal), when it was abandoned for one. */
  readonly refusal: VenueRefusal | null;
  readonly test: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

const createKey = (accountId: string) => `agent:account:${accountId}:create`;
const approveKey = (accountId: string) => `agent:account:${accountId}:approve`;
export const moveKey = (moveId: string) => `agent:move:${moveId}`;

function invalid(message: string): never {
  throw new AgentAccountError('agents.account_request_invalid', message, 400);
}

export function capErrorAs(error: unknown): never {
  if (error instanceof AgentCapError) {
    const room =
      error.room === null ? {} : { [error.code === 'agents.account_cap_above_ceiling' ? 'ceiling' : 'room']: formatAmount(error.room) };
    throw new AgentAccountError(error.code as AgentAccountCode, error.detail, 422, room);
  }
  throw error;
}

/** The agent account is the person's own, from an interactive session: never an API key (the assistant's) or a sub-account. */
export function assertPerson(principal: Principal): void {
  if (isApiKeyPrincipal(principal) || principal.sub_account) {
    throw new AuthError(
      "an agent account is the person's own: it is made and funded from their signed-in session, never an API key",
      'scope.interactive_only',
    );
  }
}

function uuid(value: unknown, label: string): string {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_RE.test(v)) invalid(`${label} must be a UUID the client chose once for this action`);
  return v;
}

function positive(value: unknown, label: string): Amount {
  let amount: Amount;
  if (typeof value === 'bigint') amount = value;
  else if (typeof value === 'string' && /^[0-9]+(\.[0-9]+)?$/.test(value.trim())) {
    try {
      amount = parseAmount(value.trim());
    } catch {
      invalid(`${label} must be a decimal string`);
    }
  } else invalid(`${label} must be a decimal string (never a JSON number)`);
  if (compare(amount, ZERO) <= 0) throw new AgentAccountError('agents.account_cap_invalid', `${label} must be above zero`, 422);
  return amount;
}

export class AgentAccounts {
  constructor(private readonly deps: AgentAccountsDeps) {}

  /** The owner's terms every agent account is held to, and whether they are set. */
  terms() {
    const v = this.deps.values;
    return {
      ceiling: v.ceiling === null ? null : formatAmount(v.ceiling),
      asset: v.asset,
      bounds: {
        maxOrderNotional: v.bounds.maxOrderNotional === null ? null : formatAmount(v.bounds.maxOrderNotional),
        worstPriceBps: v.bounds.worstPriceBps === null ? null : formatAmount(v.bounds.worstPriceBps),
        markets: v.bounds.markets,
      },
    };
  }

  private async venue(): Promise<UserVenue & UserVenueSubAccountReads> {
    const venue = await this.deps.door.venue();
    if (!hasSubAccountReads(venue)) {
      throw new AgentAccountError(
        'agents.account_venue_no_sub_accounts',
        `${venue.venue.displayName} offers no sub-accounts, so no agent account can be made there`,
        422,
      );
    }
    return venue;
  }

  private main(a: AgentAccountRecord): UserVenueAccount {
    return { venueId: a.venueId, owner: a.owner, subAccount: null };
  }

  private subOf(a: AgentAccountRecord): UserVenueAccount {
    return { venueId: a.venueId, owner: a.owner, subAccount: a.subAccount };
  }

  private capOf(a: AgentAccountRecord): AgentCap {
    return { account: this.subOf(a), agentAddress: a.agentAddress, asset: a.asset, cap: a.cap, validUntil: null, revokedAt: null };
  }

  private async account(principal: Principal, accountId: string): Promise<AgentAccountRecord> {
    const a = await this.deps.store.find(principal.userId, uuid(accountId, 'accountId'));
    if (!a) throw new AgentAccountError('agents.account_unknown', `no agent account ${accountId} on this login`, 404);
    return a;
  }

  /**
   * #1 #3 #5: create an agent account with a cap and its first funding. Every refusal of the owner's terms (a blank
   * ceiling, a cap above it, the wrong asset, a first funding past the cap) comes before step-up, before anything is
   * stored and before the venue or the wallet is asked. Then identity's step-up, then the account and its first move are
   * stored, and the first signature is prepared. A second create with the same id and terms is the same account.
   */
  async create(
    principal: Principal,
    req: { accountId?: unknown; owner?: unknown; asset?: unknown; cap?: unknown; fund?: unknown; stepUpApprovalId?: string | null },
  ): Promise<AgentAccountView> {
    assertPerson(principal);
    const v = this.deps.values;
    const accountId = uuid(req.accountId, 'accountId');
    const owner = typeof req.owner === 'string' ? req.owner.trim().toLowerCase() : '';
    if (!ADDRESS_RE.test(owner)) invalid('owner must be the wallet address of the venue account (0x and 40 hex)');
    const cap = positive(req.cap, 'cap');
    const fund = positive(req.fund, 'fund');
    if (v.ceiling === null) {
      throw new AgentAccountError(
        'agents.account_ceiling_unset',
        'the owner has published no ceiling for agent accounts, so none can be made',
        422,
      );
    }
    if (v.asset === null) {
      throw new AgentAccountError('agents.account_asset_unset', 'the owner has published no funding asset for agent accounts', 422);
    }
    if (req.asset !== v.asset) {
      throw new AgentAccountError('agents.account_funding_asset', `an agent account is funded only in ${v.asset}`, 422, { asset: v.asset });
    }
    try {
      assertAgentCapWithinCeiling(cap, v.ceiling, v.asset);
    } catch (error) {
      capErrorAs(error);
    }
    if (v.keySeed === null) {
      throw new AgentAccountError(
        'agents.agent_key_unset',
        'the agent key secret is not set (owner value blank), so no agent can be approved',
        422,
      );
    }
    const venue = await this.venue();
    const record: AgentAccountRecord = {
      userId: principal.userId,
      accountId,
      venueId: venue.venue.id,
      owner,
      subAccount: null,
      // Unique per owner on the venue (an open whose answer was lost is read back by it): the id's random tail.
      name: `assistant-${accountId.replace(/-/g, '').slice(-12)}`,
      asset: v.asset,
      cap,
      agentAddress: agentAddressFor(v.keySeed, principal.userId, accountId),
      fundAmount: fund,
      status: 'opening',
      createdAt: this.deps.now(),
      openedAt: null,
      closedAt: null,
    };
    try {
      assertAgentFundingWithinCap(this.capOf(record), ZERO, ZERO, fund);
    } catch (error) {
      capErrorAs(error);
    }
    const existing = await this.deps.store.find(principal.userId, accountId);
    if (existing) {
      if (existing.owner !== owner || existing.cap !== cap || existing.fundAmount !== fund || existing.asset !== v.asset) {
        throw new AgentAccountError(
          'agents.account_key_reused',
          `agent account ${accountId} was made with other terms; a new account needs a new id`,
          409,
        );
      }
      return this.advance(principal, accountId);
    }
    // The first move's id is the account's: an id the person already used for a move is a reused key, refused before
    // step-up is spent.
    if (await this.deps.store.findMove(principal.userId, accountId)) {
      throw new AgentAccountError(
        'agents.account_key_reused',
        `${accountId} was already used for a move; a new account needs a new id`,
        409,
      );
    }
    await this.deps.stepUp.require({
      scope: AGENT_ACCOUNT_STEP_UP_SCOPE,
      userId: principal.userId,
      sessionId: principal.sid,
      approvalId: req.stepUpApprovalId,
      fields: { accountId, owner, asset: v.asset, cap: formatAmount(cap), fund: formatAmount(fund) },
      requestId: `venue.agentAccount:${accountId}`,
    });
    await this.deps.store.insertOnce(record, {
      userId: principal.userId,
      accountId,
      moveId: accountId,
      direction: 'into_sub_account',
      amount: fund,
      state: 'pending',
      createdAt: record.createdAt,
    });
    return this.advance(principal, accountId);
  }

  /** The person's agent accounts, each with what the venue reports and what is next to sign. */
  async list(principal: Principal): Promise<readonly AgentAccountView[]> {
    assertPerson(principal);
    const rows = await this.deps.store.list(principal.userId);
    return Promise.all(rows.map((a) => this.advance(principal, a.accountId)));
  }

  /** Prepare (or re-use) one of this account's actions through the door. */
  private async prepare(principal: Principal, a: AgentAccountRecord, account: UserVenueAccount, intent: VenueIntent, actionKey: string) {
    const answer = await this.deps.door.prepare(
      principal,
      { owner: account.owner, subAccount: account.subAccount, signer: { role: 'owner', address: a.owner }, intent, actionKey },
      { agentAccount: true },
    );
    return answer;
  }

  /** Read one move's state from the venue's record, by its signed nonce; settle it once the record is definite. */
  private async settleMove(principal: Principal, a: AgentAccountRecord, m: AgentMoveRecord): Promise<AgentMoveRecord> {
    if (m.state !== 'pending') return m;
    const stored = await this.deps.door.stored(principal, moveKey(m.moveId));
    if (!stored?.signature) return m;
    const outcome = stored.lastOutcome;
    if (outcome?.definite && !outcome.accepted) {
      await this.deps.store.settleMove(principal.userId, m.moveId, 'refused');
      return { ...m, state: 'refused' };
    }
    if (!stored.lastOutcome) return m; // signed, never sent: nothing can have moved
    const venue = await this.venue();
    const record = await venue.transfer(this.main(a), stored.prepared.nonce);
    if (record.value) {
      await this.deps.store.settleMove(principal.userId, m.moveId, 'done');
      return { ...m, state: 'done' };
    }
    return m;
  }

  private async nextFor(
    principal: Principal,
    a: AgentAccountRecord,
    step: NextSignature['step'],
    account: UserVenueAccount,
    intent: VenueIntent,
    key: string,
  ): Promise<NextSignature> {
    const answer = await this.prepare(principal, a, account, intent, key);
    return { actionKey: answer.actionKey, step, prepared: answer.prepared, signed: answer.signed };
  }

  /**
   * Bring the account's record up to the venue's: read back each signed action, settle moves, and say what the wallet is
   * asked to sign next. Reads only, and prepares at most one action, which is stored before it is returned.
   */
  async advance(principal: Principal, accountId: string): Promise<AgentAccountView> {
    assertPerson(principal);
    let a = await this.account(principal, accountId);
    let next: NextSignature | null = null;
    let refusal: VenueRefusal | null = null;
    const venue = await this.venue();
    const main = this.main(a);

    if (a.status === 'opening') {
      // 1. The sub-account.
      if (a.subAccount === null) {
        const stored = await this.deps.door.stored(principal, createKey(a.accountId));
        const o = stored?.lastOutcome ?? null;
        if (o?.definite && o.accepted && o.venueRef) a = await this.deps.store.update(a.userId, a.accountId, { subAccount: o.venueRef });
        else if (o) {
          // Any other answer to a sent open (accepted without the venue's id, lost, or refused after an earlier send may
          // have landed): the venue's own list says whether it opened, by the name, which is unique per owner.
          const found = (await venue.subAccounts(main)).value.find((s) => s.name === a.name);
          if (found) a = await this.deps.store.update(a.userId, a.accountId, { subAccount: found.subAccount });
          else if (o.definite && !o.accepted) {
            refusal = o.refusal;
            a = await this.abandoned(a);
          }
        }
        if (a.status === 'opening' && a.subAccount === null) {
          next = await this.nextFor(
            principal,
            a,
            'open_sub_account',
            main,
            { kind: 'create_sub_account', name: a.name, subAccountKey: createKey(a.accountId) },
            createKey(a.accountId),
          );
        }
      }
      // 2. The agent permission on the sub-account.
      if (a.status === 'opening' && a.subAccount !== null && next === null) {
        const agents = (await venue.agents(this.subOf(a))).value;
        if (!agents.some((x) => x.address.toLowerCase() === a.agentAddress)) {
          const stored = await this.deps.door.stored(principal, approveKey(a.accountId));
          const o = stored?.lastOutcome ?? null;
          if (o?.definite && !o.accepted) {
            refusal = o.refusal;
            a = await this.abandoned(a);
          } else {
            next = await this.nextFor(
              principal,
              a,
              'approve_agent',
              this.subOf(a),
              { kind: 'approve_agent', agentAddress: a.agentAddress, agentName: a.name, validUntil: null },
              approveKey(a.accountId),
            );
          }
        }
      }
      // 3. The first funding move. The account opens when the venue's record shows it.
      if (a.status === 'opening' && a.subAccount !== null && next === null) {
        const first = (await this.deps.store.moves(a.userId, a.accountId)).find((m) => m.moveId === a.accountId);
        if (!first) throw new Error(`agent account ${a.accountId} has no first move`);
        const settled = await this.settleMove(principal, a, first);
        if (settled.state === 'done') {
          a = await this.deps.store.update(a.userId, a.accountId, { status: 'open', openedAt: this.deps.now() });
        } else if (settled.state === 'refused') {
          refusal = (await this.refusalOf(principal, moveKey(first.moveId))) ?? null;
          a = await this.abandoned(a);
        } else {
          next = await this.nextFor(principal, a, 'move_in', main, this.transfer(a, first), moveKey(first.moveId));
        }
      }
    }

    // Moves after opening: settle each pending one from the venue's record; the oldest pending is next to sign.
    let moves = await this.deps.store.moves(a.userId, a.accountId);
    if (a.status === 'open' || a.status === 'closed') {
      moves = await Promise.all(moves.map((m) => this.settleMove(principal, a, m)));
      const pending = moves.find((m) => m.state === 'pending');
      if (pending && next === null && a.status === 'open') {
        next = await this.nextFor(
          principal,
          a,
          pending.direction === 'into_sub_account' ? 'move_in' : 'move_out',
          main,
          this.transfer(a, pending),
          moveKey(pending.moveId),
        );
      }
    }
    if (a.status === 'abandoned' && refusal === null) {
      refusal =
        (await this.refusalOf(principal, createKey(a.accountId))) ??
        (await this.refusalOf(principal, approveKey(a.accountId))) ??
        (await this.refusalOf(principal, moveKey(a.accountId)));
    }
    return this.view(a, moves, next, refusal, isTestVenue(venue.venue), a.subAccount ? await venue.balances(this.subOf(a)) : null);
  }

  private async refusalOf(principal: Principal, key: string): Promise<VenueRefusal | null> {
    const o = (await this.deps.door.stored(principal, key))?.lastOutcome;
    return o?.definite && !o.accepted ? o.refusal : null;
  }

  private async abandoned(a: AgentAccountRecord): Promise<AgentAccountRecord> {
    const first = (await this.deps.store.moves(a.userId, a.accountId)).find((m) => m.moveId === a.accountId);
    if (first?.state === 'pending') await this.deps.store.settleMove(a.userId, first.moveId, 'refused');
    return this.deps.store.update(a.userId, a.accountId, { status: 'abandoned' });
  }

  private transfer(a: AgentAccountRecord, m: AgentMoveRecord): VenueIntent {
    if (a.subAccount === null) throw new Error(`agent account ${a.accountId} has no sub-account yet`);
    return {
      kind: 'sub_account_transfer',
      subAccount: a.subAccount,
      direction: m.direction,
      asset: a.asset,
      amount: m.amount,
      moveKey: moveKey(m.moveId),
    };
  }

  private view(
    a: AgentAccountRecord,
    moves: readonly AgentMoveRecord[],
    next: NextSignature | null,
    refusal: VenueRefusal | null,
    test: boolean,
    balances: AsOf<readonly UserVenueBalance[]> | null,
  ): AgentAccountView {
    const { movedIn, movedOut } = netFunding(moves);
    const { net, room } = agentFundingRoom(a.cap, movedIn, movedOut);
    return {
      accountId: a.accountId,
      status: a.status,
      owner: a.owner,
      subAccount: a.subAccount,
      name: a.name,
      asset: a.asset,
      cap: a.cap,
      agentAddress: a.agentAddress,
      netFunding: net,
      room,
      moves: moves.map((m) => ({
        moveId: m.moveId,
        actionKey: moveKey(m.moveId),
        direction: m.direction,
        amount: m.amount,
        state: m.state,
      })),
      balances,
      next,
      refusal,
      test,
    };
  }

  /**
   * Send one of this account's actions with the wallet's signature (through the door, which checks the bytes recover to
   * the wallet and stores the first signature before anything is sent), then advance.
   */
  async submit(principal: Principal, accountId: string, actionKey: unknown, signature: VenueSignature): Promise<AgentAccountView> {
    assertPerson(principal);
    const a = await this.account(principal, accountId);
    const key = typeof actionKey === 'string' ? actionKey.trim() : '';
    const moves = await this.deps.store.moves(a.userId, a.accountId);
    const mine = key === createKey(a.accountId) || key === approveKey(a.accountId) || moves.some((m) => moveKey(m.moveId) === key);
    if (!mine)
      throw new AgentAccountError(
        'agents.account_action_unknown',
        `${JSON.stringify(key)} is not an action of agent account ${a.accountId}`,
        404,
      );
    if (a.status === 'abandoned' || a.status === 'closed') {
      throw new AgentAccountError(
        'agents.account_not_open',
        `agent account ${a.accountId} is ${a.status}: nothing more is sent for it`,
        409,
      );
    }
    const move = moves.find((m) => moveKey(m.moveId) === key);
    if (move && move.state !== 'pending') {
      throw new AgentAccountError('agents.account_not_open', `move ${move.moveId} is already ${move.state}`, 409);
    }
    await this.deps.door.submit(principal, key, signature, { agentAccount: true });
    return this.advance(principal, accountId);
  }

  /**
   * The person rejected a signature while opening: end the account. Only before the first move is signed, so its bytes
   * can never be sent afterwards; a sub-account the venue already opened stays empty under the person's wallet.
   */
  async abandon(principal: Principal, accountId: string): Promise<AgentAccountView> {
    assertPerson(principal);
    const a = await this.account(principal, accountId);
    if (a.status !== 'opening')
      throw new AgentAccountError('agents.account_not_opening', `agent account ${a.accountId} is ${a.status}`, 409);
    if ((await this.deps.door.stored(principal, moveKey(a.accountId)))?.signature) {
      throw new AgentAccountError(
        'agents.account_action_signed',
        'the first move is signed, so the account is read back from the venue, not abandoned',
        409,
      );
    }
    await this.abandoned(a);
    return this.advance(principal, accountId);
  }

  /**
   * #4: move more in. The cap is checked under the account's row lock, against every move in that is not refused, BEFORE
   * the move is stored or prepared, so a move past the cap refuses `agents.account_cap_exceeded` naming the room left and
   * the wallet is never asked. Within the cap, the move is stored, then prepared for the wallet.
   */
  async fund(principal: Principal, accountId: string, req: { moveId?: unknown; amount?: unknown }): Promise<AgentAccountView> {
    return this.move(principal, accountId, req, 'into_sub_account');
  }

  /** #14: move back to the main account. Never past what the venue holds free there; the venue refuses more. */
  async withdraw(principal: Principal, accountId: string, req: { moveId?: unknown; amount?: unknown }): Promise<AgentAccountView> {
    return this.move(principal, accountId, req, 'out_of_sub_account');
  }

  private async move(
    principal: Principal,
    accountId: string,
    req: { moveId?: unknown; amount?: unknown },
    direction: AgentMoveRecord['direction'],
  ) {
    assertPerson(principal);
    const a = await this.account(principal, accountId);
    const moveId = uuid(req.moveId, 'moveId');
    const amount = positive(req.amount, 'amount');
    if (await this.deps.store.find(principal.userId, moveId)) {
      throw new AgentAccountError('agents.account_key_reused', `${moveId} is an agent account's id; a move needs its own id`, 409);
    }
    const record: AgentMoveRecord = {
      userId: a.userId,
      accountId: a.accountId,
      moveId,
      direction,
      amount,
      state: 'pending',
      createdAt: this.deps.now(),
    };
    const { move } = await this.deps.store.reserveMove(record, (locked, moves) => {
      if (locked.status !== 'open')
        throw new AgentAccountError('agents.account_not_open', `agent account ${locked.accountId} is ${locked.status}`, 409);
      if (moves.some((m) => m.state === 'pending')) {
        throw new AgentAccountError(
          'agents.account_close_move_pending',
          'a move of this account is still waiting for the wallet or the venue',
          409,
        );
      }
      if (direction === 'into_sub_account') {
        const { movedIn, movedOut } = netFunding(moves);
        try {
          assertAgentFundingWithinCap(this.capOf(locked), movedIn, movedOut, amount);
        } catch (error) {
          capErrorAs(error);
        }
      }
    });
    if (move.accountId !== a.accountId || move.direction !== direction || move.amount !== amount) {
      throw new AgentAccountError('agents.account_key_reused', `move ${moveId} was asked with other terms; a new move needs a new id`, 409);
    }
    return this.advance(principal, accountId);
  }

  /**
   * #5: change the cap. Above the owner's ceiling refuses `agents.account_cap_above_ceiling` naming the ceiling, and the
   * cap stays. Within it the cap is written under the account's row lock; lowering it below what is funded moves nothing,
   * and funding stays refused until the net funding is under it (agent-cap.ts).
   */
  async setCap(principal: Principal, accountId: string, req: { cap?: unknown }): Promise<AgentAccountView> {
    assertPerson(principal);
    const a = await this.account(principal, accountId);
    const cap = positive(req.cap, 'cap');
    if (this.deps.values.ceiling === null) {
      throw new AgentAccountError('agents.account_ceiling_unset', 'the owner has published no ceiling for agent accounts', 422);
    }
    try {
      assertAgentCapWithinCeiling(cap, this.deps.values.ceiling, a.asset);
    } catch (error) {
      capErrorAs(error);
    }
    await this.deps.store.lockedUpdate(a.userId, a.accountId, async (locked) => {
      if (locked.status !== 'open') {
        throw new AgentAccountError('agents.account_not_open', `agent account ${locked.accountId} is ${locked.status}`, 409);
      }
      return { cap };
    });
    return this.advance(principal, accountId);
  }

  /**
   * #13 #14: close. Refused, naming it, while the venue's record shows an open position, a resting order, a balance, or
   * a move still waiting. Closing moves nothing; the empty sub-account stays under the person's wallet.
   */
  async close(principal: Principal, accountId: string): Promise<AgentAccountView> {
    assertPerson(principal);
    const a = await this.account(principal, accountId);
    if (a.status !== 'open') throw new AgentAccountError('agents.account_not_open', `agent account ${a.accountId} is ${a.status}`, 409);
    // Settle every move from the venue's record first, then judge and write under the account's row lock, which
    // `reserveMove` also takes: no move can be asked for between the check and the close.
    await this.advance(principal, accountId);
    const venue = await this.venue();
    const sub = this.subOf(a);
    await this.deps.store.lockedUpdate(a.userId, a.accountId, async (locked, moves) => {
      if (locked.status !== 'open')
        throw new AgentAccountError('agents.account_not_open', `agent account ${locked.accountId} is ${locked.status}`, 409);
      if (moves.some((m) => m.state === 'pending')) {
        throw new AgentAccountError(
          'agents.account_close_move_pending',
          'a move of this account is still waiting for the wallet or the venue',
          409,
        );
      }
      const [positions, orders, balances] = await Promise.all([venue.positions(sub), venue.openOrders(sub), venue.balances(sub)]);
      const position = positions.value.find((p) => compare(p.size, ZERO) !== 0);
      if (position) {
        throw new AgentAccountError(
          'agents.account_close_open_position',
          `close the open ${position.side} of ${formatAmount(position.size)} on ${position.symbol} first`,
          409,
          { symbol: position.symbol, side: position.side, size: formatAmount(position.size) },
        );
      }
      const order = orders.value[0];
      if (order) {
        throw new AgentAccountError(
          'agents.account_close_open_order',
          `cancel the resting ${order.side} order on ${order.symbol} first`,
          409,
          {
            symbol: order.symbol,
            side: order.side,
            venueClientOrderId: order.venueClientOrderId,
          },
        );
      }
      const held = balances.value.find((b) => compare(b.total, ZERO) !== 0);
      if (held) {
        throw new AgentAccountError(
          'agents.account_close_balance',
          `move the ${formatAmount(held.total)} ${held.asset} back to your main account first`,
          409,
          {
            asset: held.asset,
            total: formatAmount(held.total),
          },
        );
      }
      return { status: 'closed', closedAt: this.deps.now() };
    });
    return this.advance(principal, accountId);
  }
}

/**
 * Read the agent account's owner values. Blank is `null` (and refuses where it is used); a set value that is malformed
 * stops the boot, never a guess.
 */
export function parseAgentAccountValues(env: {
  TRADE_AGENT_ACCOUNT_CEILING?: string;
  TRADE_AGENT_ACCOUNT_ASSET?: string;
  TRADE_AGENT_KEY_SEED?: string;
  TRADE_AGENT_MAX_ORDER_NOTIONAL?: string;
  TRADE_AGENT_WORST_PRICE_BPS?: string;
  TRADE_AGENT_MARKETS?: string;
}): AgentAccountValues {
  const amount = (name: string, raw: string | undefined): Amount | null => {
    const text = (raw ?? '').trim();
    if (text === '') return null;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(text)) throw new Error(`${name} must be a positive decimal, got ${JSON.stringify(raw)}`);
    const value = parseAmount(text);
    if (compare(value, ZERO) <= 0) throw new Error(`${name} must be above zero`);
    return value;
  };
  const asset = (env.TRADE_AGENT_ACCOUNT_ASSET ?? '').trim();
  if (asset !== '' && !/^[A-Z0-9]{2,16}$/.test(asset))
    throw new Error(`TRADE_AGENT_ACCOUNT_ASSET must be an asset symbol, got ${JSON.stringify(asset)}`);
  const markets = (env.TRADE_AGENT_MARKETS ?? '').trim();
  const list = markets === '' ? null : markets.split(',').map((m) => m.trim());
  if (list?.some((m) => !/^[A-Z0-9]+-[A-Z0-9]+$/.test(m)))
    throw new Error(`TRADE_AGENT_MARKETS must be comma-separated venue symbols, got ${JSON.stringify(markets)}`);
  const seed = env.TRADE_AGENT_KEY_SEED ?? '';
  // 10000 bps or more would let a sell name a price of zero: the bound would bound nothing.
  const belowWholeMark = (bps: Amount | null) => {
    if (bps !== null && compare(bps, parseAmount('10000')) >= 0) throw new Error('TRADE_AGENT_WORST_PRICE_BPS must be below 10000');
    return bps;
  };
  return {
    ceiling: amount('TRADE_AGENT_ACCOUNT_CEILING', env.TRADE_AGENT_ACCOUNT_CEILING),
    asset: asset === '' ? null : asset,
    keySeed: seed.trim() === '' ? null : seed,
    bounds: {
      maxOrderNotional: amount('TRADE_AGENT_MAX_ORDER_NOTIONAL', env.TRADE_AGENT_MAX_ORDER_NOTIONAL),
      worstPriceBps: belowWholeMark(amount('TRADE_AGENT_WORST_PRICE_BPS', env.TRADE_AGENT_WORST_PRICE_BPS)),
      markets: list,
    },
  };
}
