/**
 * ONE PERSON'S VENUE FILLS OF ORDERS PLACED THROUGH INTAFACED, FOR svc-campaigns (J-campaigns-11 #3 #4):
 * `GET /internal/venue/our-fills?userId=<id>&since=<iso>`.
 *
 * A trading competition counts volume from the venue's own fills, never from a copy we keep. This read takes the venue
 * accounts whose owner wallet signed an action this person prepared through the door (`ownerSignedAccounts`), reads each
 * account's fills from the venue since `since`, and keeps only a fill of an order our door stored and signed for that
 * account with our builder fee (`sentBuilderFeeOrders`, the builder-fee poster's own test), whose builder fee is above
 * zero: a fill placed through another front end, and a zero- or negative-fee fill, is left out. Each kept fill carries
 * the venue's own id and account, so a reader keeps it once however often it is read. Read only: it prepares, sends and
 * posts nothing.
 *
 * Only svc-campaigns may call it (service credentials). The door off answers 503 `trade.venue.door_off`; the venue down
 * or refusing answers 503 with its typed code, never an empty list, so a read that failed is never "no volume". Amounts
 * are decimal strings.
 */
import type { FastifyInstance } from 'fastify';
import { formatAmount, mul, type Amount } from '@intafaced/ledger-client/money';
import { verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import { VenueRefusalError, type UserVenueAccount, type UserVenueFill } from '@intafaced/venue-contracts';
import { builderFeeVenueAccount } from '../builder-fee/builder-fee-store.js';
import type { PreparedActionStore } from './prepared-action-store.js';

export const INTERNAL_OUR_FILLS_CALLERS: ReadonlySet<string> = new Set(['svc-campaigns']);
const USER_ID = /^[A-Za-z0-9_:.@-]{1,128}$/;

export interface OurFill {
  readonly fillId: string;
  /** The account part of the venue's key: the owner, or `<owner>/<subAccount>`. */
  readonly venueAccount: string;
  readonly symbol: string;
  /** The quote asset of the fill's market: what its notional is counted in. */
  readonly quoteAsset: string;
  /** Price times amount, in the quote asset. */
  readonly notional: string;
  readonly builderFee: string;
  readonly feeAsset: string;
  readonly filledAt: string;
}

export interface OurFillsRead {
  readonly venueId: string;
  readonly asOf: string;
  readonly value: readonly OurFill[];
}

/** The venue reads this needs: its id, its markets' quote assets and an account's fills. A `UserVenue` is one. */
export interface OurFillsVenue {
  readonly venue: { readonly id: string };
  markets(scope: null): Promise<{ readonly value: readonly { readonly symbol: string; readonly quoteAsset: string }[] }>;
  fills(account: UserVenueAccount, since: Date): Promise<{ readonly value: readonly UserVenueFill[] }>;
}

export interface OurFillsDeps {
  readonly venue: () => Promise<OurFillsVenue>;
  readonly store: Pick<PreparedActionStore, 'ownerSignedAccounts' | 'sentBuilderFeeOrders'>;
  readonly now: () => Date;
}

/** The fills a competition may count for one person, oldest first. */
export async function readOurFills(deps: OurFillsDeps, userId: string, since: Date): Promise<OurFillsRead> {
  const venue = await deps.venue();
  const venueId = venue.venue.id;
  const accounts = await deps.store.ownerSignedAccounts(userId, venueId);
  const quoteOf = new Map<string, string>();
  if (accounts.length > 0) for (const m of (await venue.markets(null)).value) quoteOf.set(m.symbol, m.quoteAsset);
  const out: OurFill[] = [];
  for (const { owner, subAccount } of accounts) {
    const account = { venueId, owner, subAccount };
    const fills = (await venue.fills(account, since)).value.filter((f) => f.builderFee > 0n && f.filledAt >= since);
    const ids = [...new Set(fills.map((f) => f.venueClientOrderId).filter((id): id is string => id !== null))];
    const ours = ids.length > 0 ? await deps.store.sentBuilderFeeOrders(venueId, account, ids) : new Set<string>();
    for (const f of fills) {
      if (f.venueClientOrderId === null || !ours.has(f.venueClientOrderId)) continue;
      const quoteAsset = quoteOf.get(f.symbol);
      // A market the venue no longer lists names no quote asset, so its notional cannot be counted in one.
      if (!quoteAsset) continue;
      const notional: Amount = mul(f.price, f.amount);
      if (notional <= 0n) continue;
      out.push({
        fillId: f.fillId,
        venueAccount: builderFeeVenueAccount(account),
        symbol: f.symbol,
        quoteAsset,
        notional: formatAmount(notional),
        builderFee: formatAmount(f.builderFee),
        feeAsset: f.feeAsset,
        filledAt: f.filledAt.toISOString(),
      });
    }
  }
  out.sort(
    (a, b) => a.filledAt.localeCompare(b.filledAt) || a.venueAccount.localeCompare(b.venueAccount) || a.fillId.localeCompare(b.fillId),
  );
  return { venueId, asOf: deps.now().toISOString(), value: out };
}

export function registerInternalOurFills(
  app: FastifyInstance,
  deps: {
    fills: Omit<OurFillsDeps, 'venue'> & { venue: (() => Promise<OurFillsVenue>) | null };
    secret: string;
    s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode };
  },
): void {
  app.get<{ Querystring: { userId?: string; since?: string } }>('/internal/venue/our-fills', async (req, reply) => {
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
    if (!INTERNAL_OUR_FILLS_CALLERS.has(caller))
      return reply.code(403).send({ error: 'this fill read is for svc-campaigns only', code: 'trade.fill_read_forbidden' });
    const userId = (req.query.userId ?? '').trim();
    const since = new Date(req.query.since ?? '');
    if (!USER_ID.test(userId) || Number.isNaN(since.getTime()))
      return reply.code(400).send({ error: 'userId and an ISO since are required', code: 'trade.fill_read_input' });
    const venue = deps.fills.venue;
    if (!venue) return reply.code(503).send({ error: 'the venue door is off', code: 'trade.venue.door_off' });
    try {
      return await readOurFills({ ...deps.fills, venue }, userId, since);
    } catch (err) {
      const code = err instanceof VenueRefusalError ? `trade.venue.${err.refusal.code}` : 'trade.venue.venue_down';
      return reply.code(503).send({ error: 'the venue could not be read', code });
    }
  });
}
