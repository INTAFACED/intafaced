/**
 * ONE PERSON'S VENUE EQUITY IN ONE ASSET, FOR svc-campaigns (J-campaigns-13 #2 #4):
 * `GET /internal/venue/equity?userId=<id>&asset=<asset>`.
 *
 * An airdrop's snapshot and a reward pool's minimum balance read the person's equity on the venue, never a copy we keep.
 * This read takes the venue accounts whose owner wallet signed an action this person prepared through the door
 * (`ownerSignedAccounts`), reads each account's balances from the venue, and adds up the total the venue reports in the
 * asset (margin and an unrealised result included where the venue counts them in it, so it may be negative). A person
 * with no such account holds 0 there. Each account is listed with its own total and the venue's as-of time; the answer's
 * as-of time is the oldest of them. Read only: it prepares, sends and posts nothing.
 *
 * Only svc-campaigns may call it (service credentials). The door off answers 503 `trade.venue.door_off`; the venue down
 * or refusing answers 503 with its typed code, never 0, so a read that failed is never "no equity". Amounts are decimal
 * strings.
 */
import type { FastifyInstance } from 'fastify';
import { add, formatAmount, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import { VenueRefusalError, type UserVenueAccount, type UserVenueBalance } from '@intafaced/venue-contracts';
import { builderFeeVenueAccount } from '../builder-fee/builder-fee-store.js';
import type { PreparedActionStore } from './prepared-action-store.js';

export const INTERNAL_EQUITY_CALLERS: ReadonlySet<string> = new Set(['svc-campaigns']);
const USER_ID = /^[A-Za-z0-9_:.@-]{1,128}$/;
const ASSET = /^[A-Z0-9]{2,12}$/;

export interface EquityRead {
  readonly venueId: string;
  readonly asset: string;
  readonly asOf: string;
  readonly equity: string;
  readonly accounts: readonly { readonly venueAccount: string; readonly equity: string; readonly asOf: string }[];
}

/** The venue reads this needs: its id and an account's balances. A `UserVenue` is one. */
export interface EquityVenue {
  readonly venue: { readonly id: string };
  balances(account: UserVenueAccount): Promise<{ readonly value: readonly UserVenueBalance[]; readonly asOf: Date }>;
}

export interface EquityDeps {
  readonly venue: () => Promise<EquityVenue>;
  readonly store: Pick<PreparedActionStore, 'ownerSignedAccounts'>;
  readonly now: () => Date;
}

/** The person's equity in `asset` across their venue accounts. */
export async function readEquity(deps: EquityDeps, userId: string, asset: string): Promise<EquityRead> {
  const venue = await deps.venue();
  const venueId = venue.venue.id;
  const accounts = await deps.store.ownerSignedAccounts(userId, venueId);
  let total: Amount = ZERO;
  let oldest: Date | null = null;
  const lines: { venueAccount: string; equity: string; asOf: string }[] = [];
  for (const { owner, subAccount } of accounts) {
    const account = { venueId, owner, subAccount };
    const read = await venue.balances(account);
    let equity: Amount = ZERO;
    for (const b of read.value) if (b.asset === asset) equity = add(equity, b.total);
    total = add(total, equity);
    if (!oldest || read.asOf < oldest) oldest = read.asOf;
    lines.push({ venueAccount: builderFeeVenueAccount(account), equity: formatAmount(equity), asOf: read.asOf.toISOString() });
  }
  lines.sort((a, b) => a.venueAccount.localeCompare(b.venueAccount));
  return { venueId, asset, asOf: (oldest ?? deps.now()).toISOString(), equity: formatAmount(total), accounts: lines };
}

export function registerInternalEquity(
  app: FastifyInstance,
  deps: {
    equity: Omit<EquityDeps, 'venue'> & { venue: (() => Promise<EquityVenue>) | null };
    secret: string;
    s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode };
  },
): void {
  app.get<{ Querystring: { userId?: string; asset?: string } }>('/internal/venue/equity', async (req, reply) => {
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
    if (!INTERNAL_EQUITY_CALLERS.has(caller))
      return reply.code(403).send({ error: 'this equity read is for svc-campaigns only', code: 'trade.equity_read_forbidden' });
    const userId = (req.query.userId ?? '').trim();
    const asset = (req.query.asset ?? '').trim();
    if (!USER_ID.test(userId) || !ASSET.test(asset))
      return reply.code(400).send({ error: 'userId and an asset are required', code: 'trade.equity_read_input' });
    const venue = deps.equity.venue;
    if (!venue) return reply.code(503).send({ error: 'the venue door is off', code: 'trade.venue.door_off' });
    try {
      return await readEquity({ ...deps.equity, venue }, userId, asset);
    } catch (err) {
      const code = err instanceof VenueRefusalError ? `trade.venue.${err.refusal.code}` : 'trade.venue.venue_down';
      return reply.code(503).send({ error: 'the venue could not be read', code });
    }
  });
}
