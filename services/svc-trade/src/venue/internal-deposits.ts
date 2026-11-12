/**
 * THE VENUE'S DEPOSITS FOR ONE WALLET, FOR svc-campaigns (J-campaigns-04 #2 #3): `GET /internal/venue/deposits?owner=0x…`.
 *
 * The welcome checklist's deposit task ticks from the venue's own record of a deposit into the venue account a
 * customer's connected wallet owns. svc-campaigns reads that record here, through the user-venue door, as the
 * customer's own `/api/v1/venue/deposits` reads it: the venue's list, never a copy we keep. Read only: it prepares,
 * sends and posts nothing.
 *
 * Only svc-campaigns may call it (service credentials). The door off answers 503 `trade.venue.door_off`; the venue down
 * or refusing answers 503 with its typed code, never an empty list, so a read that failed is never "no deposit". Amounts
 * are decimal strings (`encodeVenueWire`).
 */
import type { FastifyInstance } from 'fastify';
import { verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import { VenueRefusalError, encodeVenueWire, type AsOf, type UserVenueDeposit } from '@intafaced/venue-contracts';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const INTERNAL_DEPOSITS_CALLERS: ReadonlySet<string> = new Set(['svc-campaigns']);

export interface InternalDepositsDoor {
  account(owner: string): Promise<{ venueId: string; owner: string; subAccount: string | null }>;
  venue(): Promise<{
    deposits?: (account: { venueId: string; owner: string; subAccount: string | null }) => Promise<AsOf<readonly UserVenueDeposit[]>>;
  }>;
}

export function registerInternalVenueDeposits(
  app: FastifyInstance,
  deps: { door: InternalDepositsDoor | null; secret: string; s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode } },
): void {
  app.get<{ Querystring: { owner?: string } }>('/internal/venue/deposits', async (req, reply) => {
    let caller: string | null = null;
    try {
      caller =
        typeof deps.secret === 'string' && deps.secret.length > 0
          ? verifyServiceRequest(req, {
              verifier: deps.s2s?.verifier,
              mode: deps.s2s?.mode,
              legacySecret: deps.secret,
              bodyBindMode: 'require',
            }).service
          : null;
    } catch {
      caller = null;
    }
    if (caller === null) return reply.code(401).send({ error: 'service credentials required', code: 'trade.unauthenticated' });
    if (!INTERNAL_DEPOSITS_CALLERS.has(caller))
      return reply.code(403).send({ error: 'this deposit read is for svc-campaigns only', code: 'trade.deposit_read_forbidden' });
    const owner = (req.query.owner ?? '').trim();
    if (!ADDRESS.test(owner))
      return reply.code(400).send({ error: 'owner must be a wallet address (0x and 40 hex)', code: 'trade.deposit_read_input' });
    if (!deps.door) return reply.code(503).send({ error: 'the venue door is off', code: 'trade.venue.door_off' });
    try {
      const venue = await deps.door.venue();
      if (!venue.deposits) return reply.code(503).send({ error: 'this venue publishes no deposit list', code: 'trade.venue.not_offered' });
      return encodeVenueWire(await venue.deposits(await deps.door.account(owner)));
    } catch (err) {
      const code = err instanceof VenueRefusalError ? `trade.venue.${err.refusal.code}` : 'trade.venue.venue_down';
      return reply.code(503).send({ error: 'the venue could not be read', code });
    }
  });
}
