import type { Sql } from 'postgres';
import { toFunctionSelector } from 'viem';
import {
  NAVIGATOR_ONCHAIN_MAINNET_CHAIN_IDS,
  NAVIGATOR_ONCHAIN_TEST_CHAIN_ID,
  navigatorAskIsTrade,
  type NavigatorOnchainBinding,
  type NavigatorOrder,
  type NavigatorOnchainBindInput,
  type NavigatorOnchainRefusal,
  type NavigatorOnchainSigner,
  type NavigatorTradeRefusal,
} from '@intafaced/contracts/agents-onchain';

/**
 * The Navigator acting on-chain through a session key the person can revoke (RC-agents-01, J-agents-19).
 *
 * What this service holds, and what it never does:
 * - the public address of the Navigator's on-chain signer (`AGENTS_NAVIGATOR_ONCHAIN_SIGNER`), never a key;
 * - a binding per (person, chain, smart account, session key): what the person prepared and whether they asked to
 *   revoke it. It is never a claim about the chain: granted, live, spent and revoked are read from the chain;
 * - the orders the Navigator sent through the key, inside the cap the person signed (onchain-trade.ts). Inside the cap
 *   it does not ask; above it the trade is refused before anything is signed; it never moves money out.
 * It moves no value through INTAFACED, holds no key, imports no ledger recipe and no svc-protocol code.
 */

/** A typed refusal: its code is the message of the error the route answers with. */
export class NavigatorOnchainError extends Error {
  constructor(
    readonly code: NavigatorOnchainRefusal | NavigatorTradeRefusal | 'agents.request_id_replay',
    readonly field?: string,
  ) {
    super(code);
    this.name = 'NavigatorOnchainError';
  }
}

/**
 * Which network a chain is to the Navigator: the test network is the one it may hold a key on; a mainnet refuses
 * `audit.external` (no external audit of the smart account exists); any other chain refuses as unsupported. With no
 * signer configured, every chain refuses `rail.crypto`: there is nothing to bind a key to.
 */
export function navigatorSigner(chainId: number, configured: string | null | undefined): Omit<NavigatorOnchainSigner, 'pools' | 'router'> {
  if ((NAVIGATOR_ONCHAIN_MAINNET_CHAIN_IDS as readonly number[]).includes(chainId)) throw new NavigatorOnchainError('audit.external');
  if (chainId !== NAVIGATOR_ONCHAIN_TEST_CHAIN_ID) throw new NavigatorOnchainError('agents.onchain_chain_unsupported');
  if (!configured) throw new NavigatorOnchainError('rail.crypto');
  return { signer: configured, chainId, network: 'testnet' };
}

/**
 * Selectors a session key may never hold: moving tokens out or approving anyone to. svc-protocol's grant check (its
 * FORBIDDEN_SIGNATURES, mirrored by the account contract) is the full rule and refuses first; this short list is the
 * second lock, so a binding can never record a scope with withdrawal power even if a caller skipped that check.
 */
const FORBIDDEN_SIGNATURES = [
  'transfer(address,uint256)',
  'transferFrom(address,address,uint256)',
  'approve(address,uint256)',
  'increaseAllowance(address,uint256)',
  'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  'setApprovalForAll(address,bool)',
  'safeTransferFrom(address,address,uint256)',
  'safeTransferFrom(address,address,uint256,bytes)',
] as const;
export const FORBIDDEN_SELECTORS: ReadonlySet<string> = new Set(FORBIDDEN_SIGNATURES.map((sig) => toFunctionSelector(sig).toLowerCase()));

/** A cap in wei: digits only, at most uint128. Blank or anything else refuses `agents.session_key_cap_unset`. */
const UINT128_MAX = (1n << 128n) - 1n;
export function capWei(raw: string | null | undefined): string {
  const text = raw?.trim() ?? '';
  if (!/^\d{1,39}$/.test(text) || BigInt(text) > UINT128_MAX)
    throw new NavigatorOnchainError('agents.session_key_cap_unset', 'spendLimitWei');
  return BigInt(text).toString();
}

export function bindKey(chainId: number, account: string, sessionKey: string): string {
  return `agents:onchain:navigator:${chainId}:${account.toLowerCase()}:${sessionKey.toLowerCase()}`;
}

type BindingRow = {
  id: string;
  chain_id: number;
  account: string;
  session_key: string;
  spend_limit_wei: string;
  valid_until: string;
  targets: string[];
  selectors: string[];
  spec_hash: string;
  bind_key: string;
  created_at: Date;
  updated_at: Date;
  revoke_requested_at: Date | null;
};

function bindingView(row: BindingRow): NavigatorOnchainBinding {
  return {
    id: row.id,
    chainId: row.chain_id,
    account: row.account,
    sessionKey: row.session_key,
    spendLimitWei: row.spend_limit_wei,
    validUntil: Number(row.valid_until),
    targets: row.targets,
    selectors: row.selectors,
    specHash: row.spec_hash,
    bindKey: row.bind_key,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revokeRequestedAt: row.revoke_requested_at ? row.revoke_requested_at.toISOString() : null,
  };
}

type OrderRow = {
  id: string;
  session_id: string;
  order_key: string;
  ask_text: string;
  chain_id: number;
  account: string;
  pool: string;
  token_in: string;
  token_in_symbol: string;
  token_out: string;
  token_out_symbol: string;
  amount_in_wei: string;
  min_out_wei: string;
  status: NavigatorOrder['status'];
  tx_hash: string | null;
  created_at: Date;
};

function orderView(row: OrderRow): NavigatorOrder {
  return {
    id: row.id,
    sessionId: row.session_id,
    orderKey: row.order_key,
    placedBy: 'assistant',
    text: row.ask_text,
    chainId: row.chain_id,
    account: row.account,
    pool: row.pool,
    tokenIn: row.token_in,
    tokenInSymbol: row.token_in_symbol,
    tokenOut: row.token_out,
    tokenOutSymbol: row.token_out_symbol,
    amountInWei: row.amount_in_wei,
    minOutWei: row.min_out_wei,
    status: row.status,
    txHash: row.tx_hash,
    createdAt: row.created_at.toISOString(),
  };
}

/** The statuses that hold part of the cap: everything but an order the chain reverted or the signer refused. */
const HOLDING = ['sending', 'sent', 'filled'] as const;

/** The person's bindings and the Navigator's orders. Every read and write names the signed-in person; no row of another is reachable. */
export class NavigatorOnchainStore {
  constructor(private readonly sql: Sql) {}

  private readonly bindingColumns = () => this.sql`
    id, chain_id, account, session_key, spend_limit_wei::text AS spend_limit_wei, valid_until::text AS valid_until, targets,
    selectors, spec_hash, bind_key, created_at, updated_at, revoke_requested_at
  `;

  /**
   * Records what the person prepared, once per key. The same scope again (a retry, or a reply lost after the write) is
   * the first row unchanged. A new scope for the same key (the person prepared another grant, as each Prepare grant
   * gives a new expiry and so a new scope hash) replaces what was prepared and clears an earlier revoke request: the
   * new grant is what they now intend to sign, and the chain still says whether it is live.
   */
  async bind(input: {
    userId: string;
    chainId: number;
    account: string;
    sessionKey: string;
    spendLimitWei: string;
    validUntil: number;
    targets: readonly string[];
    selectors: readonly string[];
    specHash: string;
  }): Promise<NavigatorOnchainBinding> {
    const key = bindKey(input.chainId, input.account, input.sessionKey);
    const targets = input.targets.map((t) => t.toLowerCase());
    const selectors = input.selectors.map((s) => s.toLowerCase());
    const specHash = input.specHash.toLowerCase();
    const rows = await this.sql<BindingRow[]>`
      INSERT INTO agents.navigator_onchain_bindings
        (user_id, chain_id, account, session_key, spend_limit_wei, valid_until, targets, selectors, spec_hash, bind_key)
      VALUES (${input.userId}, ${input.chainId}, ${input.account.toLowerCase()}, ${input.sessionKey.toLowerCase()},
              ${input.spendLimitWei}, ${input.validUntil}, ${this.sql.array(targets)}, ${this.sql.array(selectors)},
              ${specHash}, ${key})
      ON CONFLICT (user_id, bind_key) DO UPDATE SET
        spend_limit_wei = EXCLUDED.spend_limit_wei,
        valid_until = EXCLUDED.valid_until,
        targets = EXCLUDED.targets,
        selectors = EXCLUDED.selectors,
        spec_hash = EXCLUDED.spec_hash,
        updated_at = now(),
        revoke_requested_at = NULL
      WHERE agents.navigator_onchain_bindings.spec_hash <> EXCLUDED.spec_hash
      RETURNING ${this.bindingColumns()}
    `;
    if (rows[0]) return bindingView(rows[0]);
    // The same scope again: the row already says it.
    const found = await this.binding(input.userId, input.chainId, input.account, input.sessionKey);
    if (!found) throw new Error('navigator binding vanished between its write and its read');
    return found;
  }

  async binding(userId: string, chainId: number, account: string, sessionKey: string): Promise<NavigatorOnchainBinding | null> {
    const rows = await this.sql<BindingRow[]>`
      SELECT ${this.bindingColumns()} FROM agents.navigator_onchain_bindings
       WHERE user_id = ${userId} AND bind_key = ${bindKey(chainId, account, sessionKey)}
    `;
    return rows[0] ? bindingView(rows[0]) : null;
  }

  /** Marks the binding revoking, once: a second ask returns the first ask's time. No binding refuses as not found. */
  async requestRevoke(userId: string, chainId: number, account: string, sessionKey: string): Promise<NavigatorOnchainBinding> {
    const rows = await this.sql<BindingRow[]>`
      UPDATE agents.navigator_onchain_bindings
         SET revoke_requested_at = COALESCE(revoke_requested_at, now())
       WHERE user_id = ${userId} AND bind_key = ${bindKey(chainId, account, sessionKey)}
      RETURNING ${this.bindingColumns()}
    `;
    if (!rows[0]) throw new NavigatorOnchainError('agents.onchain_binding_not_found');
    return bindingView(rows[0]);
  }

  /** The person's newest Navigator binding on the chain for this key that they have not asked to revoke. */
  async liveBinding(userId: string, chainId: number, sessionKey: string): Promise<NavigatorOnchainBinding | null> {
    const rows = await this.sql<BindingRow[]>`
      SELECT ${this.bindingColumns()} FROM agents.navigator_onchain_bindings
       WHERE user_id = ${userId} AND chain_id = ${chainId} AND session_key = ${sessionKey.toLowerCase()}
         AND revoke_requested_at IS NULL
       ORDER BY updated_at DESC, id
       LIMIT 1
    `;
    return rows[0] ? bindingView(rows[0]) : null;
  }

  private readonly orderColumns = () => this.sql`
    id, session_id::text AS session_id, order_key, ask_text, chain_id, account, pool, token_in, token_in_symbol, token_out,
    token_out_symbol, amount_in_wei::text AS amount_in_wei, min_out_wei::text AS min_out_wei, status, tx_hash, created_at
  `;

  async order(userId: string, orderKey: string): Promise<NavigatorOrder | null> {
    const rows = await this.sql<OrderRow[]>`
      SELECT ${this.orderColumns()} FROM agents.navigator_orders WHERE user_id = ${userId} AND order_key = ${orderKey}
    `;
    return rows[0] ? orderView(rows[0]) : null;
  }

  /**
   * What the Navigator's orders under one grant hold of its cap, in wei: every person's orders on that account and grant,
   * since the cap is the account's, not one person's.
   */
  async heldWei(chainId: number, account: string, specHash: string, tx: Sql = this.sql): Promise<bigint> {
    const rows = await tx<Array<{ n: string }>>`
      SELECT coalesce(sum(amount_in_wei), 0)::text AS n FROM agents.navigator_orders
       WHERE chain_id = ${chainId} AND account = ${account.toLowerCase()}
         AND spec_hash = ${specHash.toLowerCase()} AND status IN ${tx(HOLDING)}
    `;
    return BigInt(rows[0]?.n ?? '0');
  }

  /**
   * Writes an order as sending, under the grant's lock, only if it fits in what is left of the cap. The same key again
   * is the first order. Nothing is written for an order above the cap.
   */
  async reserveOrder(input: {
    userId: string;
    sessionId: string;
    orderKey: string;
    text: string;
    chainId: number;
    account: string;
    sessionKey: string;
    specHash: string;
    pool: string;
    tokenIn: string;
    tokenInSymbol: string;
    tokenOut: string;
    tokenOutSymbol: string;
    amountInWei: bigint;
    minOutWei: bigint;
    capWei: bigint;
    chainSpentWei: bigint;
  }): Promise<{ kind: 'reserved'; order: NavigatorOrder } | { kind: 'existing'; order: NavigatorOrder } | { kind: 'over_cap' }> {
    const account = input.account.toLowerCase();
    const specHash = input.specHash.toLowerCase();
    // One lock per account and grant, across every person: the cap is the account's.
    const lock = `agents:navigator:cap:${input.chainId}:${account}:${specHash}`;
    return this.sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
      const found = await tx<OrderRow[]>`
        SELECT ${this.orderColumns()} FROM agents.navigator_orders WHERE user_id = ${input.userId} AND order_key = ${input.orderKey}
      `;
      if (found[0]) return { kind: 'existing' as const, order: orderView(found[0]) };
      const held = await this.heldWei(input.chainId, account, specHash, tx);
      if (held + input.chainSpentWei + input.amountInWei > input.capWei) return { kind: 'over_cap' as const };
      const rows = await tx<OrderRow[]>`
        INSERT INTO agents.navigator_orders
          (user_id, session_id, order_key, ask_text, chain_id, account, session_key, spec_hash, pool, token_in, token_in_symbol,
           token_out, token_out_symbol, amount_in_wei, min_out_wei)
        VALUES (${input.userId}, ${input.sessionId}, ${input.orderKey}, ${input.text}, ${input.chainId}, ${account},
                ${input.sessionKey.toLowerCase()}, ${specHash}, ${input.pool.toLowerCase()}, ${input.tokenIn.toLowerCase()},
                ${input.tokenInSymbol}, ${input.tokenOut.toLowerCase()}, ${input.tokenOutSymbol}, ${input.amountInWei.toString()},
                ${input.minOutWei.toString()})
        RETURNING ${this.orderColumns()}
      `;
      return { kind: 'reserved' as const, order: orderView(rows[0]!) };
    });
  }

  /** Moves an order on: sent with its hash, then filled or reverted as the chain's receipt says, or failed. */
  async settleOrder(
    userId: string,
    orderKey: string,
    status: 'sent' | 'filled' | 'reverted' | 'failed',
    txHash: string | null,
  ): Promise<NavigatorOrder> {
    const rows = await this.sql<OrderRow[]>`
      UPDATE agents.navigator_orders SET status = ${status}, tx_hash = COALESCE(${txHash}, tx_hash), updated_at = now()
       WHERE user_id = ${userId} AND order_key = ${orderKey}
      RETURNING ${this.orderColumns()}
    `;
    if (!rows[0]) throw new Error('navigator order vanished between its write and its update');
    return orderView(rows[0]);
  }

  async orders(userId: string, sessionId: string): Promise<NavigatorOrder[]> {
    const rows = await this.sql<OrderRow[]>`
      SELECT ${this.orderColumns()} FROM agents.navigator_orders
       WHERE user_id = ${userId} AND session_id = ${sessionId}
       ORDER BY created_at DESC, id
       LIMIT 100
    `;
    return rows.map(orderView);
  }
}

/** Checks a prepared grant before it is recorded. The session key is the configured signer, never the body's. */
export function preparedGrant(input: NavigatorOnchainBindInput): { spendLimitWei: string; validUntil: number } {
  const spendLimitWei = capWei(input.spendLimitWei);
  if (!input.validUntil) throw new NavigatorOnchainError('agents.session_key_expiry_unset', 'validUntil');
  if (input.selectors.some((s) => FORBIDDEN_SELECTORS.has(s.toLowerCase())))
    throw new NavigatorOnchainError('agents.session_key_selector_forbidden', 'selectors');
  return { spendLimitWei, validUntil: input.validUntil };
}

export { navigatorAskIsTrade };
