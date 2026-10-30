/**
 * Service directory for bank business screens.
 *
 * svc-bank asks here for a public handle or an exact active recipient. The
 * customer never calls this route. Emails are matched and never returned.
 * Frozen, closed and missing accounts are the same `{ found: false }`.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from 'postgres';
import { retainRawBody } from '@intafaced/contracts';
import { z } from 'zod';
import { serviceOfRequest, type IdentityS2s } from './s2s-door.js';

export const BUSINESS_DIRECTORY_HANDLES_PATH = '/internal/business-directory/handles';
export const BUSINESS_DIRECTORY_RECIPIENT_PATH = '/internal/business-directory/recipient';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BusinessDirectoryStore {
  handlesOf(userIds: readonly string[]): Promise<ReadonlyArray<{ userId: string; handle: string }>>;
  findActiveByHandle(handle: string): Promise<{ userId: string; handle: string } | null>;
  findActiveByEmail(email: string): Promise<{ userId: string; handle: string } | null>;
}

export function sqlBusinessDirectory(sql: Sql): BusinessDirectoryStore {
  return {
    async handlesOf(userIds) {
      const ids = [...new Set(userIds.filter((id) => UUID.test(id)))];
      if (ids.length === 0) return [];
      const rows = await sql<Array<{ id: string; handle: string }>>`
        SELECT id, handle FROM users WHERE id = ANY(${sql.array(ids)}::uuid[])
      `;
      return rows.map((row) => ({ userId: row.id, handle: row.handle }));
    },
    async findActiveByHandle(handle) {
      const rows = await sql<Array<{ id: string; handle: string }>>`
        SELECT id, handle FROM users WHERE handle = ${handle} AND status = 'active' AND handle_discoverable LIMIT 1
      `;
      const row = rows[0];
      return row ? { userId: row.id, handle: row.handle } : null;
    },
    async findActiveByEmail(email) {
      const rows = await sql<Array<{ id: string; handle: string }>>`
        SELECT id, handle FROM users WHERE email = ${email} AND status = 'active' LIMIT 1
      `;
      const row = rows[0];
      return row ? { userId: row.id, handle: row.handle } : null;
    },
  };
}

const handlesInput = z
  .object({
    userIds: z.array(z.string().min(1).max(128)).max(200),
  })
  .strict();

const recipientInput = z
  .object({
    handle: z.string().max(64).optional(),
    email: z.string().max(320).optional(),
  })
  .strict();

export function registerBusinessDirectoryRoutes(
  app: FastifyInstance,
  deps: {
    readonly internalSecret: string;
    /** Per-service keys (S2S v3). Unset keeps the shared secret alone. */
    readonly s2s?: IdentityS2s;
    readonly store: BusinessDirectoryStore;
    readonly installRawBody?: boolean;
  },
): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  async function caller(req: FastifyRequest, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    const { service } = serviceOfRequest(req, deps.internalSecret, 'require', deps.s2s);
    if (service === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    if (service !== 'svc-bank') {
      return reply.code(403).send({ error: 'this directory is for svc-bank', code: 'identity.forbidden' });
    }
    return null;
  }

  app.post(BUSINESS_DIRECTORY_HANDLES_PATH, async (req, reply) => {
    const refused = await caller(req, reply);
    if (refused) return refused;
    const parsed = handlesInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'userIds required', code: 'identity.directory_query' });
    const handles = await deps.store.handlesOf(parsed.data.userIds);
    return { handles };
  });

  app.post(BUSINESS_DIRECTORY_RECIPIENT_PATH, async (req, reply) => {
    const refused = await caller(req, reply);
    if (refused) return refused;
    const parsed = recipientInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'send a handle or an email', code: 'identity.directory_query' });
    const handle = parsed.data.handle?.trim() ?? '';
    const email = parsed.data.email?.trim() ?? '';
    if ((handle === '') === (email === '')) {
      return reply.code(400).send({ error: 'send a handle or an email, not both', code: 'identity.directory_query' });
    }
    const hit = handle !== '' ? await deps.store.findActiveByHandle(handle) : await deps.store.findActiveByEmail(email);
    if (!hit) return { found: false as const };
    return { found: true as const, userId: hit.userId, handle: hit.handle };
  });
}
