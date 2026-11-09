/**
 * The wallets an account linked, for other services (`POST /internal/linked-wallets`, `linkedWalletsSchema`). Identity
 * holds which wallets an account linked by their own signature (`wallet_identities`); svc-agents asks here when the person
 * chooses one as the payment method for their agent's runs, and again before each run, so a wallet unlinked since is
 * never read (J-agents-02 #4). Only the services listed may ask. Nothing is written.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { LINKED_WALLETS_PATH, linkedWalletsRequestSchema, type LinkedWallets, type ServiceBodyBindMode } from '@intafaced/contracts';
import { serviceOfRequest, type IdentityS2s } from '../s2s-door.js';
import { securityLockHolds } from './security-lock.js';

/** The services allowed to list an account's linked wallets. */
export const LINKED_WALLET_READERS: ReadonlySet<string> = new Set(['svc-agents']);

/** An account that is missing, not active or under a security lock lists no wallet, as for a signature check. */
export async function linkedWallets(sql: Sql, userId: string): Promise<LinkedWallets> {
  const [user] = await sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${userId}`;
  if (user?.status !== 'active' || (await securityLockHolds(sql, userId))) return { state: 'account_inactive' };
  const rows = await sql<Array<{ address: string; created_at: Date }>>`
    SELECT address, created_at FROM wallet_identities WHERE user_id = ${userId} ORDER BY created_at, address`;
  return {
    state: 'usable',
    wallets: rows.map((row) => ({ address: row.address.toLowerCase(), linkedAt: new Date(row.created_at).toISOString() })),
  };
}

export function registerLinkedWalletsRoute(
  app: FastifyInstance,
  opts: {
    read: (userId: string) => Promise<LinkedWallets>;
    internalSecret: string | undefined;
    bodyBind?: ServiceBodyBindMode;
    s2s?: IdentityS2s;
  },
): void {
  app.post(LINKED_WALLETS_PATH, async (req, reply) => {
    const { service } = serviceOfRequest(req, opts.internalSecret, opts.bodyBind, opts.s2s);
    if (service === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    if (!LINKED_WALLET_READERS.has(service)) {
      return reply.code(403).send({ error: 'this service may not list linked wallets', code: 'identity.linked_wallet_reader_refused' });
    }
    const parsed = linkedWalletsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid linked-wallet read', code: 'identity.linked_wallets_request_invalid' });
    }
    return opts.read(parsed.data.userId);
  });
}
