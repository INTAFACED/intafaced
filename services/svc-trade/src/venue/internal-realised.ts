/**
 * ONE PERSON'S REALISED TRADING RESULT, FOR svc-bank's "pay yourself" (J-bank-31 #2 #7):
 * `GET /internal/venue/realised?userId=<id>&asset=<asset>&since=<iso>[&until=<iso>]`.
 *
 * Paying yourself moves what your trading realised, as the venue reports it, never a figure we keep. This read takes the
 * main venue accounts whose owner wallet signed an action this person prepared through the door (`ownerSignedAccounts`;
 * a sub-account's result is not withdrawable from the main account, so it is left out), reads each account's fills from
 * the venue in [since, until), and adds up the realised result the venue reports on each closing fill of a market quoted
 * in `asset` (an opening fill reports none). The sum may be negative: a week that lost money. Each account is listed with
 * its owner wallet, its own sum and the venue's as-of time; the answer's as-of time is the oldest of them. Read only: it
 * prepares, sends and posts nothing.
 *
 * Only svc-bank may call it (service credentials). The door off answers 503 `trade.venue.door_off`; the venue down or
 * refusing answers 503 with its typed code, never 0, so a read that failed is never "no profit". Amounts are decimal
 * strings.
 */
import type { FastifyInstance } from 'fastify';
import { add, formatAmount, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import { VenueRefusalError, type UserVenueAccount, type UserVenueFill } from '@intafaced/venue-contracts';
import type { PreparedActionStore } from './prepared-action-store.js';

export const INTERNAL_REALISED_CALLERS: ReadonlySet<string> = new Set(['svc-bank']);
const USER_ID = /^[A-Za-z0-9_:.@-]{1,128}$/;
const ASSET = /^[A-Z0-9]{2,12}$/;

export interface RealisedRead {
  readonly venueId: string;
  readonly asset: string;
  readonly since: string;
  readonly until: string;
  readonly asOf: string;
  readonly realised: string;
  readonly accounts: readonly { readonly owner: string; readonly realised: string; readonly asOf: string }[];
}

/** The venue reads this needs: its id, its markets' quote assets and an account's fills. A `UserVenue` is one. */
export interface RealisedVenue {
  readonly venue: { readonly id: string };
  markets(scope: null): Promise<{ readonly value: readonly { readonly symbol: string; readonly quoteAsset: string }[] }>;
  fills(account: UserVenueAccount, since: Date): Promise<{ readonly value: readonly UserVenueFill[]; readonly asOf: Date }>;
}

export interface RealisedDeps {
  readonly venue: () => Promise<RealisedVenue>;
  readonly store: Pick<PreparedActionStore, 'ownerSignedAccounts'>;
  readonly now: () => Date;
}

/** The person's realised result in `asset` on their main venue accounts, from `since` up to (not including) `until`. */
export async function readRealised(deps: RealisedDeps, userId: string, asset: string, since: Date, until: Date): Promise<RealisedRead> {
  const venue = await deps.venue();
  const venueId = venue.venue.id;
  const accounts = (await deps.store.ownerSignedAccounts(userId, venueId)).filter((a) => a.subAccount === null);
  const quoteOf = new Map<string, string>();
  if (accounts.length > 0) for (const m of (await venue.markets(null)).value) quoteOf.set(m.symbol, m.quoteAsset);
  let total: Amount = ZERO;
  let oldest: Date | null = null;
  const lines: { owner: string; realised: string; asOf: string }[] = [];
  for (const { owner } of accounts) {
    const read = await venue.fills({ venueId, owner, subAccount: null }, since);
    let realised: Amount = ZERO;
    for (const f of read.value) {
      if (f.realisedPnl === null || f.filledAt < since || f.filledAt >= until) continue;
      if (quoteOf.get(f.symbol) !== asset) continue;
      realised = add(realised, f.realisedPnl);
    }
    total = add(total, realised);
    if (!oldest || read.asOf < oldest) oldest = read.asOf;
    lines.push({ owner: owner.toLowerCase(), realised: formatAmount(realised), asOf: read.asOf.toISOString() });
  }
  lines.sort((a, b) => a.owner.localeCompare(b.owner));
  return {
    venueId,
    asset,
    since: since.toISOString(),
    until: until.toISOString(),
    asOf: (oldest ?? deps.now()).toISOString(),
    realised: formatAmount(total),
    accounts: lines,
  };
}

export function registerInternalRealised(
  app: FastifyInstance,
  deps: {
    realised: Omit<RealisedDeps, 'venue'> & { venue: (() => Promise<RealisedVenue>) | null };
    secret: string;
    s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode };
  },
): void {
  app.get<{ Querystring: { userId?: string; asset?: string; since?: string; until?: string } }>(
    '/internal/venue/realised',
    async (req, reply) => {
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
      if (!INTERNAL_REALISED_CALLERS.has(caller))
        return reply.code(403).send({ error: 'this realised read is for svc-bank only', code: 'trade.realised_read_forbidden' });
      const userId = (req.query.userId ?? '').trim();
      const asset = (req.query.asset ?? '').trim();
      const since = new Date(req.query.since ?? '');
      const now = deps.realised.now();
      const until = req.query.until ? new Date(req.query.until) : now;
      if (!USER_ID.test(userId) || !ASSET.test(asset) || Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || until < since)
        return reply
          .code(400)
          .send({ error: 'userId, an asset and a since time before until are required', code: 'trade.realised_read_input' });
      const venue = deps.realised.venue;
      if (!venue) return reply.code(503).send({ error: 'the venue door is off', code: 'trade.venue.door_off' });
      try {
        return await readRealised({ ...deps.realised, venue }, userId, asset, since, until > now ? now : until);
      } catch (err) {
        const code = err instanceof VenueRefusalError ? `trade.venue.${err.refusal.code}` : 'trade.venue.venue_down';
        return reply.code(503).send({ error: 'the venue could not be read', code });
      }
    },
  );
}
