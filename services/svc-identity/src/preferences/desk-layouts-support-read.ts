/**
 * One account's saved desk layouts, for svc-support's ticket lookup (`GET /internal/desk-layouts/:userId`,
 * `supportDeskLayoutsReadSchema`; C-ops-03 (a), J-charts-desk-19 #1). svc-support names the account from a ticket and
 * writes its audit row before it asks; only svc-support may ask. Read-only: nothing is written.
 *
 * An account with no `trade.desk.layouts` row has no saved layouts: `layouts: []`, never a 404. A stored value that is no
 * longer the shape is a 500, which svc-support reads as unread rather than as "none".
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from 'postgres';
import {
  SUPPORT_CHARTS_READERS,
  SUPPORT_DESK_LAYOUTS_PATH,
  type ServiceBodyBindMode,
  type SupportDeskLayoutsRead,
} from '@intafaced/contracts';
import { serviceOfRequest, type IdentityS2s } from '../s2s-door.js';
import { DESK_LAYOUTS_NAMESPACE, parseDeskLayoutsShape } from './desk-layouts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PreferenceValueRow = z.object({ value: z.unknown() });

/** The stored layouts, or none. Throws when the stored value is not the shape. */
export async function deskLayoutsFor(sql: Sql, userId: string): Promise<SupportDeskLayoutsRead> {
  const [row] = PreferenceValueRow.array().parse(
    await sql`SELECT value FROM user_preferences WHERE user_id = ${userId} AND namespace = ${DESK_LAYOUTS_NAMESPACE}`,
  );
  if (!row || row.value === null) return { userId, layouts: [], active: null };
  const value = parseDeskLayoutsShape(row.value);
  return { userId, layouts: value.layouts, active: value.active };
}

export function registerSupportDeskLayoutsRoute(
  app: FastifyInstance,
  opts: {
    read: (userId: string) => Promise<SupportDeskLayoutsRead>;
    internalSecret: string | undefined;
    bodyBind?: ServiceBodyBindMode;
    s2s?: IdentityS2s;
  },
): void {
  app.get<{ Params: { userId: string } }>(SUPPORT_DESK_LAYOUTS_PATH, async (req, reply) => {
    const { service } = serviceOfRequest(req, opts.internalSecret, opts.bodyBind, opts.s2s);
    if (service === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    if (!SUPPORT_CHARTS_READERS.some((reader) => reader === service)) {
      return reply.code(403).send({ error: 'this service may not read desk layouts', code: 'identity.desk_layouts_reader_refused' });
    }
    if (!UUID.test(req.params.userId)) {
      return reply.code(400).send({ error: 'invalid account id', code: 'identity.desk_layouts_request_invalid' });
    }
    return opts.read(req.params.userId.toLowerCase());
  });
}
