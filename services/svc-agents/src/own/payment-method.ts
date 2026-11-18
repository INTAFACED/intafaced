/**
 * The payment method a person chooses for their own agent's runs (J-agents-02 #4; OWNER 226: people pay from their own
 * wallets, and INTAFACED holds no customer money).
 *
 * A method is one wallet the person linked by their own signature. Identity holds the links
 * (`POST /internal/linked-wallets`); this service keeps only the chosen address (`own_agent_payment_methods`) and asks
 * identity again when the person chooses and before every run, so a wallet unlinked since is never read. Before a run
 * the wallet's balance of the payment token is read from the chain (`chain-balance.ts`) and checked against the run's
 * worst case, as the platform balance is when no method is chosen.
 *
 * Nothing here moves value or holds a balance.
 */
import type { Sql } from 'postgres';
import {
  LINKED_WALLETS_PATH,
  linkedWalletsSchema,
  serviceCallSigner,
  type LinkedWallets,
  type OwnAgentPaymentMethod,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import type { Amount } from '@intafaced/ledger-client';
import type { ChainBalancePort } from '../chain-balance.js';
import { FundsUnreadError, type FundsMethod, type FundsPort, type FundsReading } from '../funds.js';
import { OwnAgentRefusal } from './catalog.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWN_SESSION_PREFIX = 'own.';

/** Identity's list of the wallets an account linked, or null when identity could not be asked or read. */
export interface LinkedWalletsPort {
  read(userId: string): Promise<LinkedWallets | null>;
}

const FETCH_MS = 3_000;

export function createIdentityLinkedWallets(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): LinkedWalletsPort {
  const target = `${baseUrl.replace(/\/+$/, '')}${LINKED_WALLETS_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-agents', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async read(userId) {
      const raw = JSON.stringify({ userId });
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...sign(raw, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
          },
          body: raw,
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_MS),
        });
      } catch {
        return null;
      }
      if (!response.ok) return null;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return null;
      }
      const parsed = linkedWalletsSchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    },
  };
}

type MethodRow = { kind: 'wallet'; address: string; chosen_at: Date };

/** The method chosen for one own agent of this owner, or null. */
export async function readPaymentMethod(sql: Sql, ownerId: string, agentId: string): Promise<MethodRow | null> {
  if (!UUID_RE.test(agentId)) return null;
  const rows = await sql<MethodRow[]>`
    SELECT kind, address, chosen_at FROM agents.own_agent_payment_methods WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
  `;
  return rows[0] ?? null;
}

function linkedView(linked: LinkedWallets | null): OwnAgentPaymentMethod['linked'] {
  return linked === null ? { state: 'unread' } : linked;
}

/** The owner's own agent must exist; another person's reads as not found. */
async function assertOwnAgent(sql: Sql, ownerId: string, agentId: string): Promise<void> {
  if (!UUID_RE.test(agentId)) throw new OwnAgentRefusal('agents.own.not_found');
  const rows = await sql`SELECT 1 FROM agents.own_agents WHERE owner_id = ${ownerId} AND id = ${agentId}`;
  if (rows.length === 0) throw new OwnAgentRefusal('agents.own.not_found');
}

export class OwnPaymentMethodStore {
  constructor(
    private readonly sql: Sql,
    private readonly wallets: LinkedWalletsPort | null,
  ) {}

  async get(ownerId: string, agentId: string): Promise<OwnAgentPaymentMethod> {
    await assertOwnAgent(this.sql, ownerId, agentId);
    const row = await readPaymentMethod(this.sql, ownerId, agentId);
    const linked = this.wallets ? await this.wallets.read(ownerId) : null;
    return {
      method: row ? { kind: 'wallet', address: row.address, chosenAt: row.chosen_at.toISOString() } : null,
      linked: linkedView(linked),
    };
  }

  /**
   * Chooses one of the person's linked wallets, checked through identity now, or clears the choice (`null`). A refusal
   * stores nothing and leaves the earlier choice as it was.
   */
  async set(ownerId: string, agentId: string, address: string | null): Promise<OwnAgentPaymentMethod> {
    await assertOwnAgent(this.sql, ownerId, agentId);
    if (address === null) {
      await this.sql`DELETE FROM agents.own_agent_payment_methods WHERE owner_id = ${ownerId} AND agent_id = ${agentId}`;
      return this.get(ownerId, agentId);
    }
    const wanted = address.toLowerCase();
    const linked = this.wallets ? await this.wallets.read(ownerId) : null;
    if (linked === null) throw new OwnAgentRefusal('agents.payment_method.wallets_unread');
    if (linked.state === 'account_inactive') throw new OwnAgentRefusal('agents.payment_method.account_inactive');
    if (!linked.wallets.some((wallet) => wallet.address === wanted)) {
      throw new OwnAgentRefusal('agents.payment_method.wallet_not_linked', { address: wanted });
    }
    await this.sql`
      INSERT INTO agents.own_agent_payment_methods (agent_id, owner_id, kind, address)
      VALUES (${agentId}, ${ownerId}, 'wallet', ${wanted})
      ON CONFLICT (agent_id) DO UPDATE
         SET kind = EXCLUDED.kind, address = EXCLUDED.address, chosen_at = now()
       WHERE agents.own_agent_payment_methods.owner_id = EXCLUDED.owner_id
    `;
    return this.get(ownerId, agentId);
  }
}

/**
 * The funds a run is checked against. A session of a person's own agent (`own.<id>`) with a wallet chosen reads that
 * wallet, after identity says it is still linked; every other session reads the ledger, exactly as before. With the
 * payment token blank (`chain` null) a wallet method refuses `payment_token_unset`, never a made-up figure.
 */
export function paymentMethodFunds(deps: {
  readonly sql: Sql;
  readonly ledger: (userId: string, assetId: string) => Promise<Amount>;
  readonly wallets: LinkedWalletsPort | null;
  readonly chain: ChainBalancePort | null;
  /** The wallet reading's deadline; tests shorten it. */
  readonly deadlineMs?: number;
}): FundsPort {
  return {
    async available(userId, assetId, agentId): Promise<Amount | FundsReading> {
      if (!agentId?.startsWith(OWN_SESSION_PREFIX)) return deps.ledger(userId, assetId);
      let row: MethodRow | null;
      try {
        row = await readPaymentMethod(deps.sql, userId, agentId.slice(OWN_SESSION_PREFIX.length));
      } catch {
        throw new FundsUnreadError(null, 'method_unread');
      }
      if (row === null) return deps.ledger(userId, assetId);
      const chosen = row;
      const method: FundsMethod = { kind: 'wallet', address: chosen.address };
      const chain = deps.chain;
      if (chain === null) throw new FundsUnreadError(method, 'payment_token_unset');
      const wallet = async (): Promise<FundsReading> => {
        const linked = deps.wallets ? await deps.wallets.read(userId) : null;
        if (linked === null) throw new FundsUnreadError(method, 'identity_unreachable');
        if (linked.state === 'account_inactive') throw new FundsUnreadError(method, 'account_inactive');
        if (!linked.wallets.some((w) => w.address === chosen.address)) throw new FundsUnreadError(method, 'wallet_unlinked');
        const reading = await chain.read(chosen.address);
        // The run is still billed to the platform balance, so that is read too: a run is admitted only when both cover
        // it (funds.ts fundsShortfall). A failed read is an unread balance, as on the ledger path.
        return { ...reading, billed: await deps.ledger(userId, assetId) };
      };
      return withDeadline(wallet(), deps.deadlineMs ?? FUNDS_READ_DEADLINE_MS, method);
    },
  };
}

/**
 * One deadline over a whole wallet reading (identity, the chain node's calls, the platform balance). The reading runs
 * under the person's spend lock (spend/store.ts), so a slow node must not hold it for the sum of every call's own
 * timeout: past the deadline the wallet is unread (`method_unread`: which of its reads was slow is not known, so no one
 * of them is blamed), the run refuses and the lock is let go. The
 * ledger path has its own client deadline and is untouched.
 */
export const FUNDS_READ_DEADLINE_MS = 5_000;

function withDeadline<T>(work: Promise<T>, ms: number, method: FundsMethod): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FundsUnreadError(method, 'method_unread')), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
