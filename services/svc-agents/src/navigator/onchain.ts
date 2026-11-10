import type { Sql } from 'postgres';
import { toFunctionSelector } from 'viem';
import {
  NAVIGATOR_ONCHAIN_MAINNET_CHAIN_IDS,
  NAVIGATOR_ONCHAIN_TEST_CHAIN_ID,
  navigatorAskIsTrade,
  type NavigatorApprovalRequest,
  type NavigatorOnchainBinding,
  type NavigatorOnchainBindInput,
  type NavigatorOnchainRefusal,
  type NavigatorOnchainSigner,
} from '@intafaced/contracts/agents-onchain';

/**
 * The Navigator acting on-chain through a session key the person can revoke (RC-agents-01, J-agents-19).
 *
 * What this service holds, and what it never does:
 * - the public address of the Navigator's on-chain signer (`AGENTS_NAVIGATOR_ONCHAIN_SIGNER`), never a key;
 * - a binding per (person, chain, smart account, session key): what the person prepared and whether they asked to
 *   revoke it. It is never a claim about the chain: granted, live, spent and revoked are read from the chain;
 * - approval requests for every trade the person asks the Navigator for. The Navigator never trades unasked, and a live
 *   session key changes nothing about that: the key is a ceiling, not consent.
 * It moves no value, builds no transaction (svc-protocol builds the unsigned calls the person's wallet signs), imports no
 * ledger recipe and no svc-protocol code.
 */

/** A typed refusal: its code is the message of the error the route answers with. */
export class NavigatorOnchainError extends Error {
  constructor(
    readonly code: NavigatorOnchainRefusal | 'agents.approval.ttl_unset' | 'agents.request_id_replay',
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
export function navigatorSigner(chainId: number, configured: string | null | undefined): NavigatorOnchainSigner {
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

type RequestRow = {
  id: string;
  session_id: string;
  request_key: string;
  tool: 'trade';
  ask_text: string;
  status: 'waiting' | 'expired';
  created_at: Date;
  expires_at: Date;
};

function requestView(row: RequestRow): NavigatorApprovalRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    requestKey: row.request_key,
    tool: row.tool,
    text: row.ask_text,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

/** The person's bindings and requests. Every read and write names the signed-in person; no row of another is reachable. */
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

  /** Whether the person has a Navigator binding they have not asked to revoke (on any chain). */
  async holdsUnrevoked(userId: string): Promise<boolean> {
    const rows = await this.sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM agents.navigator_onchain_bindings WHERE user_id = ${userId} AND revoke_requested_at IS NULL
    `;
    return rows[0]?.n !== '0';
  }

  private readonly requestColumns = () => this.sql`
    id, session_id::text AS session_id, request_key, tool, ask_text,
    CASE WHEN expires_at <= now() THEN 'expired' ELSE status END AS status, created_at, expires_at
  `;

  /** Holds one trade ask for the person. The same request id again is the first request; with other words it refuses. */
  async hold(input: {
    userId: string;
    sessionId: string;
    requestId: string;
    text: string;
    ttlSeconds: number;
  }): Promise<NavigatorApprovalRequest> {
    const key = `agents:approve:${input.sessionId}:${input.requestId}`;
    const inserted = await this.sql<RequestRow[]>`
      INSERT INTO agents.navigator_approval_requests (user_id, session_id, request_key, tool, ask_text, expires_at)
      VALUES (${input.userId}, ${input.sessionId}, ${key}, 'trade', ${input.text},
              now() + make_interval(secs => ${input.ttlSeconds}))
      ON CONFLICT (user_id, request_key) DO NOTHING
      RETURNING ${this.requestColumns()}
    `;
    if (inserted[0]) return requestView(inserted[0]);
    const rows = await this.sql<RequestRow[]>`
      SELECT ${this.requestColumns()} FROM agents.navigator_approval_requests WHERE user_id = ${input.userId} AND request_key = ${key}
    `;
    // The same id with other words is not a retry of this ask.
    if (!rows[0] || rows[0].ask_text !== input.text) throw new NavigatorOnchainError('agents.request_id_replay');
    return requestView(rows[0]);
  }

  async requests(userId: string, sessionId: string): Promise<NavigatorApprovalRequest[]> {
    const rows = await this.sql<RequestRow[]>`
      SELECT ${this.requestColumns()} FROM agents.navigator_approval_requests
       WHERE user_id = ${userId} AND session_id = ${sessionId}
       ORDER BY created_at DESC, id
       LIMIT 100
    `;
    return rows.map(requestView);
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
