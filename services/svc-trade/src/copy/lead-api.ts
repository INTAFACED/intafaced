/**
 * The lead API (J-copy-bots-otc-07, CB-copy-21 and CB-copy-pro-share-14): an approved lead trades through a key that
 * carries `copy:lead`.
 *
 * - `POST /internal/copy/lead-check` answers svc-identity, before it mints a `copy:lead` key, whether the account is an
 *   approved lead: a listing in the `listed` state. Only svc-identity may ask; a failed read is 503, never "not a lead".
 * - `leadOrderGate` runs before a lead order takes the ordinary order path: the caller must still be a listed lead and
 *   the symbol one of the instruments on its listing. Everything after (tier, region, holds, the engine) is the
 *   ordinary `POST /api/v1/orders` path, so a lead order behaves exactly as one placed on the web.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** What the lead API needs of a leader's listing. Null: the account has no listing. */
export type LeadListingRead = (userId: string) => Promise<{ readonly state: string; readonly assets: readonly string[] } | null>;

export const LEAD_CHECK_PATH = '/internal/copy/lead-check';

function callerOf(req: FastifyRequest, secret: string, s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode }): string | null {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  try {
    return verifyServiceRequest(req, { verifier: s2s?.verifier, mode: s2s?.mode, legacySecret: secret, bodyBindMode: 'require' }).service;
  } catch {
    return null;
  }
}

/** Whether the account is an approved lead now: its listing is in the `listed` state. */
export async function isApprovedLead(read: LeadListingRead, userId: string): Promise<boolean> {
  return (await read(userId))?.state === 'listed';
}

export function registerLeadCheck(
  app: FastifyInstance,
  deps: { read: LeadListingRead; secret: string; s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode } },
): void {
  app.post(LEAD_CHECK_PATH, async (req, reply) => {
    const caller = callerOf(req, deps.secret, deps.s2s);
    if (caller === null) return reply.code(401).send({ error: 'service credentials required', code: 'trade.unauthenticated' });
    if (caller !== 'svc-identity') {
      return reply.code(403).send({ error: 'the lead check is for the identity service only', code: 'trade.copy_lead_check_forbidden' });
    }
    const userId = (req.body as { userId?: unknown } | null)?.userId;
    if (typeof userId !== 'string' || !UUID.test(userId)) {
      return reply.code(400).send({ error: 'lead check input is invalid', code: 'trade.copy_lead_check_input' });
    }
    try {
      return { asOf: new Date().toISOString(), lead: await isApprovedLead(deps.read, userId) };
    } catch {
      return reply.code(503).send({ error: 'lead check unavailable', code: 'trade.copy_lead_check_unavailable' });
    }
  });
}

/** A lead order's own refusal, or null when the order may take the ordinary path. */
export type LeadOrderRefusal = { readonly status: number; readonly body: Record<string, string> };

export function leadOrderGate(read: LeadListingRead) {
  return async (principal: Principal, symbol: unknown): Promise<LeadOrderRefusal | null> => {
    const listing = await read(principal.userId);
    if (listing?.state !== 'listed') {
      return {
        status: 403,
        body: {
          code: 'PermissionDenied',
          message: 'The lead API is only for an approved lead. This account is not listed as a lead.',
          intafacedCode: 'trade.copy_lead_not_listed',
        },
      };
    }
    if (typeof symbol !== 'string' || !listing.assets.includes(symbol)) {
      return {
        status: 400,
        body: {
          code: 'BadSymbol',
          message: `${typeof symbol === 'string' ? symbol : 'This instrument'} is not on your lead listing. A lead trades only the instruments its listing names.`,
          intafacedCode: 'trade.copy_lead_instrument_unlisted',
        },
      };
    }
    return null;
  };
}

export type LeadOrderGate = ReturnType<typeof leadOrderGate>;

/** Sends a lead refusal, or answers false so the ordinary order handler runs. */
export async function refuseLeadOrder(
  gate: LeadOrderGate | undefined,
  principal: Principal,
  body: unknown,
  reply: FastifyReply,
): Promise<boolean> {
  if (!gate) {
    await reply
      .code(503)
      .send({ code: 'ExchangeNotAvailable', message: 'the lead API is not mounted', intafacedCode: 'trade.copy_unavailable' });
    return true;
  }
  const refusal = await gate(principal, (body as { symbol?: unknown } | null)?.symbol);
  if (!refusal) return false;
  await reply.code(refusal.status).send(refusal.body);
  return true;
}
