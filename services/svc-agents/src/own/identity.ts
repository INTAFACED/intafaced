import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import type { OwnAgentIssuedToken, OwnAgentToken, OwnAgentTokenCaller } from '@intafaced/contracts';
import { OwnAgentRefusal } from './catalog.js';
import type { OwnAccountDirectory } from './publishing.js';

/**
 * Each own agent's identity (AG-identity-01; J-agents-03 #5): a token of its own, issued to its owner, scoped to the
 * agent's saved tools, expiring after the owner's set lifetime. Only the token's hash is kept. A call made with the
 * token is refused once it is revoked or expired, or while its owner's account is not active (read from identity at
 * each call, never copied). Nothing here moves value.
 */

/** Every token starts with this, so a leaked one is recognisable as an agent's. */
const TOKEN_PREFIX = 'agt_';
/** The most an owner may set a token's lifetime to: one year, in minutes. */
export const OWN_TOKEN_LIFETIME_MAX_MINUTES = 525_600;

const hashOf = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex');

interface Row {
  agent_id: string;
  owner_id: string;
  scopes: string[];
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

const COLUMNS = 'agent_id, owner_id, scopes, issued_at, expires_at, revoked_at';

function view(row: Row, now: Date): OwnAgentToken {
  return {
    agentId: row.agent_id,
    ownerId: row.owner_id,
    scopes: row.scopes,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    state: row.revoked_at ? 'revoked' : row.expires_at.getTime() <= now.getTime() ? 'expired' : 'active',
  };
}

/** The owner's token lifetime, in whole minutes; blank refuses and none is invented. */
export function tokenLifetime(minutes: number | null | undefined): number {
  if (minutes === null || minutes === undefined) throw new OwnAgentRefusal('agents.identity.lifetime_unset');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > OWN_TOKEN_LIFETIME_MAX_MINUTES) {
    throw new OwnAgentRefusal('agents.identity.lifetime_unset');
  }
  return minutes;
}

export class OwnIdentityStore {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The agent's latest token, or null when none was issued. The agent is the caller's (checked by the route). */
  async latest(ownerId: string, agentId: string): Promise<OwnAgentToken | null> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM agents.own_agent_tokens
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY issued_at DESC, id
       LIMIT 1
    `;
    return rows[0] ? view(rows[0], this.now()) : null;
  }

  /**
   * Issues the agent a new token for `lifetimeMinutes`, scoped to `scopes`, revoking any live one before it. The secret
   * is returned this once and never kept. A frozen, closed or unread owner refuses first, and nothing changes. The owner
   * is read before the write, so a freeze landing in between still leaves a token; its every call reads the owner again.
   */
  async issue(
    ownerId: string,
    agentId: string,
    scopes: readonly string[],
    lifetimeMinutes: number,
    accounts: OwnAccountDirectory | null,
  ): Promise<OwnAgentIssuedToken> {
    const minutes = tokenLifetime(lifetimeMinutes);
    await assertOwnerActive(ownerId, accounts);
    const secret = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + minutes * 60_000);
    const row = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'agents.own.token:' + agentId}))`;
      await tx`
        UPDATE agents.own_agent_tokens SET revoked_at = ${issuedAt}, updated_at = now()
         WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND revoked_at IS NULL
      `;
      const inserted = await tx<Row[]>`
        INSERT INTO agents.own_agent_tokens (agent_id, owner_id, token_hash, scopes, issued_at, expires_at)
        VALUES (${agentId}, ${ownerId}, ${hashOf(secret)}, ${tx.json([...scopes])}, ${issuedAt}, ${expiresAt})
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
      return inserted[0]!;
    });
    return { token: view(row, issuedAt), secret };
  }

  /** Revokes the agent's live token; the next call made with it fails. With none live it refuses, and nothing changes. */
  async revoke(ownerId: string, agentId: string): Promise<OwnAgentToken> {
    // The app's clock, as issue and expiry use, so a token's times never come from two clocks.
    const revokedAt = this.now();
    const rows = await this.sql<Row[]>`
      UPDATE agents.own_agent_tokens SET revoked_at = ${revokedAt}, updated_at = now()
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND revoked_at IS NULL
      RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    if (!rows[0]) throw new OwnAgentRefusal('agents.identity.no_live_token');
    return view(rows[0], this.now());
  }

  /**
   * A call the agent makes with its own token: who it acts as, or the refusal. Unknown, revoked and expired tokens are
   * refused by name; then the owner's account is read from identity, and a frozen, closed or unread owner refuses.
   */
  async call(secret: string, accounts: OwnAccountDirectory | null): Promise<OwnAgentTokenCaller> {
    if (!secret.startsWith(TOKEN_PREFIX)) throw new OwnAgentRefusal('agents.identity.token_unknown');
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM agents.own_agent_tokens WHERE token_hash = ${hashOf(secret)}
    `;
    const row = rows[0];
    if (!row) throw new OwnAgentRefusal('agents.identity.token_unknown');
    const token = view(row, this.now());
    if (token.state === 'revoked') throw new OwnAgentRefusal('agents.identity.token_revoked');
    if (token.state === 'expired') throw new OwnAgentRefusal('agents.identity.token_expired');
    await assertOwnerActive(token.ownerId, accounts);
    return { agentId: token.agentId, ownerId: token.ownerId, scopes: token.scopes, expiresAt: token.expiresAt };
  }
}

/**
 * The owner's account read from identity: a frozen, closed or unread owner refuses by name. A call checks it on every
 * use, and issuing checks it too, so a frozen or closed owner cannot mint a token for later.
 */
export async function assertOwnerActive(ownerId: string, accounts: OwnAccountDirectory | null): Promise<void> {
  const read = accounts ? await accounts.readAccount(ownerId) : ({ status: 'unread' } as const);
  if (read.status !== 'ok') throw new OwnAgentRefusal('agents.identity.owner_unread');
  if (read.account.status === 'frozen') throw new OwnAgentRefusal('agents.identity.owner_frozen');
  if (read.account.status !== 'active') throw new OwnAgentRefusal('agents.identity.owner_inactive');
}
