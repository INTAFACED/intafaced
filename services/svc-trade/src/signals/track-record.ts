/**
 * A signal provider's own trading record (CB-bots-api-signal-05, J-copy-bots-otc-22): how many fills of their own
 * orders this service settled, and when the first one was. svc-market reads it when a provider publishes a signal and
 * checks it against the owner's provider criteria. Nothing here moves money; it counts rows of `trade.fills`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import type { Sql } from 'postgres';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TrackRecord {
  readonly userId: string;
  readonly fills: number;
  readonly firstFillAt: string | null;
  readonly asOf: string;
}

export async function readTrackRecord(sql: Sql, userId: string, now: () => Date = () => new Date()): Promise<TrackRecord> {
  const [row] = await sql<Array<{ n: number; first: Date | null }>>`
    SELECT count(*)::int AS n, min(ts) AS first FROM trade.fills WHERE user_id = ${userId}`;
  return {
    userId,
    fills: row?.n ?? 0,
    firstFillAt: row?.first ? row.first.toISOString() : null,
    asOf: now().toISOString(),
  };
}

function callerOf(req: FastifyRequest, secret: string, s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode }): string | null {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  try {
    return verifyServiceRequest(req, { verifier: s2s?.verifier, mode: s2s?.mode, legacySecret: secret, bodyBindMode: 'require' }).service;
  } catch {
    return null;
  }
}

/** `GET /internal/track-record/:userId`, for svc-market only. An unreadable count is 503, never zero. */
export function registerTrackRecord(
  app: FastifyInstance,
  deps: { sql: Sql; secret: string; s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode }; now?: () => Date },
): void {
  app.get<{ Params: { userId: string } }>('/internal/track-record/:userId', async (req, reply) => {
    const caller = callerOf(req, deps.secret, deps.s2s);
    if (caller === null) return reply.code(401).send({ error: 'service credentials required', code: 'trade.unauthenticated' });
    if (caller !== 'svc-market') {
      return reply.code(403).send({ error: 'the track record is for the market service only', code: 'trade.track_record_forbidden' });
    }
    const userId = req.params.userId;
    if (!UUID.test(userId)) return reply.code(400).send({ error: 'user id is invalid', code: 'trade.track_record_input' });
    try {
      return await readTrackRecord(deps.sql, userId.toLowerCase(), deps.now);
    } catch {
      return reply.code(503).send({ error: 'track record unavailable', code: 'trade.track_record_unavailable' });
    }
  });
}
