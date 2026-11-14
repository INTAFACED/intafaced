/**
 * One of a person's own API keys, for svc-trade (`POST /internal/agent-keys/read`, `agentKeyReadSchema`; J-agents-21 #6).
 * Before svc-trade binds a key to an agent account it asks here that the key is the person's own, of kind `agent`, live,
 * and what scopes it holds. Asked with the person's id: another person's key answers `none`, as a key that does not exist
 * does, so nothing confirms that someone else's key exists. Only the services listed may ask. Nothing is written.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import {
  AGENT_KEY_CALLS_PATH,
  AGENT_KEY_READ_PATH,
  agentKeyCallsRequestSchema,
  agentKeyReadRequestSchema,
  type AgentKeyCalls,
  type AgentKeyRead,
  type ServiceBodyBindMode,
} from '@intafaced/contracts';
import { serviceOfRequest, type IdentityS2s } from '../s2s-door.js';
import { apiKeyExpired } from './expire-api-key.js';
import { ApiKeyCallsError, listApiKeyCalls } from './api-key-calls.js';

/** The services allowed to read a person's key for an agent account. */
export const AGENT_KEY_READERS: ReadonlySet<string> = new Set(['svc-trade']);

export async function readAgentKey(sql: Sql, userId: string, keyId: string): Promise<AgentKeyRead> {
  const rows = await sql<Array<{ id: string; kind: string; scopes: string[]; revoked: boolean; expires_at: Date | null }>>`
    SELECT id, kind, scopes, revoked, expires_at FROM api_keys WHERE id = ${keyId} AND user_id = ${userId} LIMIT 1`;
  const row = rows[0];
  if (!row) return { state: 'none' };
  return {
    state: 'found',
    keyId: row.id,
    kind: row.kind === 'agent' ? 'agent' : 'personal',
    scopes: [...(row.scopes ?? [])].sort(),
    revoked: row.revoked || apiKeyExpired(row.expires_at),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  };
}

/**
 * One of the person's own keys' call log, for the assistant connection's Activity (J-agents-21 #11; `AGENT_KEY_CALLS_PATH`):
 * the same rows the owner reads with `developerKeys.calls`. Anyone else's key answers `none`.
 */
export async function readAgentKeyCalls(sql: Sql, userId: string, keyId: string, limit: number): Promise<AgentKeyCalls> {
  try {
    const log = await listApiKeyCalls(sql, userId, { keyId, limit });
    return { state: 'found', keyId: log.keyId, asOf: log.asOf, calls: log.calls };
  } catch (err) {
    if (err instanceof ApiKeyCallsError) return { state: 'none' };
    throw err;
  }
}

export function registerAgentKeyReadRoute(
  app: FastifyInstance,
  opts: {
    read: (userId: string, keyId: string) => Promise<AgentKeyRead>;
    internalSecret: string | undefined;
    bodyBind?: ServiceBodyBindMode;
    s2s?: IdentityS2s;
  },
): void {
  app.post(AGENT_KEY_READ_PATH, async (req, reply) => {
    const { service } = serviceOfRequest(req, opts.internalSecret, opts.bodyBind, opts.s2s);
    if (service === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    if (!AGENT_KEY_READERS.has(service)) {
      return reply.code(403).send({ error: 'this service may not read agent keys', code: 'identity.agent_key_reader_refused' });
    }
    const parsed = agentKeyReadRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid agent key read', code: 'identity.agent_key_read_invalid' });
    }
    return opts.read(parsed.data.userId, parsed.data.keyId);
  });
}

/** `POST /internal/agent-keys/calls`: the key's call log, for the services in `AGENT_KEY_READERS` only. */
export function registerAgentKeyCallsRoute(
  app: FastifyInstance,
  opts: {
    read: (userId: string, keyId: string, limit: number) => Promise<AgentKeyCalls>;
    internalSecret: string | undefined;
    bodyBind?: ServiceBodyBindMode;
    s2s?: IdentityS2s;
  },
): void {
  app.post(AGENT_KEY_CALLS_PATH, async (req, reply) => {
    const { service } = serviceOfRequest(req, opts.internalSecret, opts.bodyBind, opts.s2s);
    if (service === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    if (!AGENT_KEY_READERS.has(service)) {
      return reply.code(403).send({ error: 'this service may not read agent keys', code: 'identity.agent_key_reader_refused' });
    }
    const parsed = agentKeyCallsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid agent key calls read', code: 'identity.agent_key_read_invalid' });
    }
    return opts.read(parsed.data.userId, parsed.data.keyId, parsed.data.limit);
  });
}
