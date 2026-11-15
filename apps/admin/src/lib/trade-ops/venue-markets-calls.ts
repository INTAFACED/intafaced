import 'server-only';
import type { ActionApproval } from '@intafaced/contracts';
import { parseApproval } from './approvals-parse';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import { readMatchingApproval } from './matching-edge';
import { ok, refused, type Outcome } from './outcome';
import {
  VENUE_DELISTING_SCHEDULE_ACTION,
  VENUE_LIMITS_SET_ACTION,
  VENUE_LISTING_SET_ACTION,
  VENUE_MARKETS_TARGET_SERVICE,
  VENUE_ROUTING_SET_ACTION,
  venueDelistingPayloadHash,
  venueLimitsPayloadHash,
  venueLimitsTarget,
  venueListingPayloadHash,
  venueListingTarget,
  venueRoutingPayloadHash,
} from './venue-markets-hash';
import {
  checkDelistsAt,
  checkLimits,
  checkOpensAt,
  checkRouting,
  parseVenueMarketsView,
  reasonReady,
  VENUE_CHANGES,
  type VenueChange,
  type VenueMarketRow,
  type VenueMarketsView,
} from './venue-markets-model';

/**
 * The venue markets desk (J-cex-spot-16) through svc-edge: svc-trade `admin.venueMarkets.*` and identity's two-person
 * approvals. Server only; nothing here is retried.
 */

export const VENUE_MARKETS_POLICY_VERSION = 'trade-venue-markets-v1';

export const readVenueMarkets = (ctx: TradeCtx): Promise<Outcome<VenueMarketsView>> =>
  edgeCall(ctx, trpcSpec('trade', 'admin.venueMarkets.list', 'query', {}, parseVenueMarketsView));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const bad = (code: string, message: string) => refused(code, message, 400);

/** One change as the desk sends it: what will be written, its approval target, its door and the hash at a version. */
export interface VenueChangeRequest {
  readonly change: VenueChange;
  readonly symbol: string;
  readonly actionType: string;
  readonly targetId: string;
  readonly door: string;
  /** The version the desk reads now (`0` when there is none). */
  readonly currentVersion: string;
  readonly hashAt: (expectedVersion: string) => string;
  /** The door's own fields beside symbol, expectedVersion, reason, approvalId and operationId. */
  readonly fields: Record<string, string>;
  readonly reason: string;
}

/**
 * Reads the desk and checks one change before anything is filed or written: the market is on the desk (a listing or a
 * limit needs the venue to list it now; routing and a delisting need only our listing), the reason is
 * written, and a blank or malformed value refuses with svc-trade's own code (a limit above the venue's own refuses
 * `trade.venue_limit_above_venue`).
 */
export async function venueChangeRequest(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<VenueChangeRequest>> {
  const change = text(body.change) as VenueChange;
  if (!(VENUE_CHANGES as readonly string[]).includes(change)) return bad('trade_ops.bad_change', 'Choose what to change.');
  const symbol = text(body.symbol).trim();
  if (!/^[A-Z0-9][A-Z0-9/._-]{0,63}$/.test(symbol)) return bad('trade.venue_symbol_invalid', 'Choose a venue market.');
  const reason = text(body.reason).trim();
  if (!reasonReady(reason))
    return bad('trade_ops.reason_required', 'Write the reason for this change (12 to 500 characters). It is kept in the audit.');
  const read = await readVenueMarkets(ctx);
  if (read.kind !== 'ok') return read;
  const { venueId } = read.data;
  const row: VenueMarketRow | undefined = read.data.markets.find((m) => m.symbol === symbol);
  if (!row) return refused('trade.venue_market_unknown', `${symbol} is not a market the venue lists.`, 404);
  // As svc-trade: only a listing or a limit needs the venue to list the market now. A stop or a delisting stays proposable
  // for a market the venue no longer lists.
  if ((change === 'listing' || change === 'limits') && !row.venue.listed)
    return refused('trade.venue_market_unknown', `${symbol} is not a market the venue lists.`, 404);
  const listingVersion = String(row.listing?.version ?? 0);
  const base = { venueId, symbol, reason };

  if (change === 'listing') {
    const c = checkOpensAt(text(body.opensAt));
    if (!c.ok) return bad(c.code, c.message);
    return ok({
      change,
      symbol,
      reason,
      actionType: VENUE_LISTING_SET_ACTION,
      targetId: venueListingTarget(venueId, symbol),
      door: 'admin.venueMarkets.listingSet',
      currentVersion: listingVersion,
      hashAt: (v) => venueListingPayloadHash({ ...base, opensAt: c.value, expectedVersion: v }),
      fields: { opensAt: c.value },
    });
  }
  if (change === 'routing') {
    const c = checkRouting(text(body.routing));
    if (!c.ok) return bad(c.code, c.message);
    if (!row.listing) return bad('trade.venue_listing_missing', `${symbol} has no listing; list it first.`);
    return ok({
      change,
      symbol,
      reason,
      actionType: VENUE_ROUTING_SET_ACTION,
      targetId: venueListingTarget(venueId, symbol),
      door: 'admin.venueMarkets.routingSet',
      currentVersion: listingVersion,
      hashAt: (v) => venueRoutingPayloadHash({ ...base, routing: c.value, expectedVersion: v }),
      fields: { routing: c.value },
    });
  }
  if (change === 'delisting') {
    const c = checkDelistsAt(text(body.delistsAt));
    if (!c.ok) return bad(c.code, c.message);
    if (!row.listing) return bad('trade.venue_listing_missing', `${symbol} has no listing; list it first.`);
    return ok({
      change,
      symbol,
      reason,
      actionType: VENUE_DELISTING_SCHEDULE_ACTION,
      targetId: venueListingTarget(venueId, symbol),
      door: 'admin.venueMarkets.delistingSchedule',
      currentVersion: listingVersion,
      hashAt: (v) => venueDelistingPayloadHash({ ...base, delistsAt: c.value, expectedVersion: v }),
      fields: { delistsAt: c.value },
    });
  }
  const c = checkLimits({ maxOrderQty: text(body.maxOrderQty), maxOrderNotional: text(body.maxOrderNotional) }, row.venue);
  if (!c.ok) return bad(c.code, c.message);
  if (!row.listing) return bad('trade.venue_listing_missing', `${symbol} has no listing; list it first.`);
  return ok({
    change,
    symbol,
    reason,
    actionType: VENUE_LIMITS_SET_ACTION,
    targetId: venueLimitsTarget(venueId, symbol),
    door: 'admin.venueMarkets.limitsSet',
    currentVersion: String(row.limits?.version ?? 0),
    hashAt: (v) => venueLimitsPayloadHash({ ...base, ...c.value, expectedVersion: v }),
    fields: c.value,
  });
}

/** identity actionApproval.propose for one change, bound to its target, the version the desk read and the hash. */
export function proposeVenueChange(ctx: TradeCtx, req: VenueChangeRequest): Promise<Outcome<ActionApproval>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'identity',
      'actionApproval.propose',
      'mutation',
      {
        actionType: req.actionType,
        targetService: VENUE_MARKETS_TARGET_SERVICE,
        targetId: req.targetId,
        expectedVersion: req.currentVersion,
        payloadHash: req.hashAt(req.currentVersion),
        policyVersion: VENUE_MARKETS_POLICY_VERSION,
      },
      parseApproval,
    ),
  );
}

/**
 * The approved request `approvalId`, checked against exactly this change at the version it was bound to; anything else
 * refuses here and nothing is written (svc-trade checks it again when it consumes the approval).
 */
export async function approvedVenueChange(ctx: TradeCtx, approvalId: string, req: VenueChangeRequest): Promise<Outcome<ActionApproval>> {
  const approval = await readMatchingApproval(ctx, approvalId);
  if (approval.kind !== 'ok') return approval;
  const a = approval.data;
  if (a.status !== 'APPROVED')
    return refused(
      a.status === 'PENDING' ? 'action_approval.pending' : 'action_approval.not_approved',
      a.status === 'PENDING'
        ? 'This request is still waiting for a second founder. Nothing was written.'
        : `This request is ${a.status}, not APPROVED. Nothing was written.`,
      409,
    );
  if (a.actionType !== req.actionType || a.targetService !== VENUE_MARKETS_TARGET_SERVICE || a.targetId !== req.targetId)
    return refused('trade_ops.approval_mismatch', 'That approval is for a different change. Nothing was written.', 409);
  if (a.payloadHash !== req.hashAt(a.expectedVersion))
    return refused('trade_ops.approval_mismatch', 'That approval is for different values. Nothing was written.', 409);
  return approval;
}

/** The written version, as svc-trade answered it. */
export interface VenueWritten {
  readonly symbol: string;
  readonly version: number;
  readonly approverId: string;
  readonly proposerId: string;
}

function parseWritten(raw: unknown): VenueWritten | null {
  if (!isRecord(raw) || typeof raw.symbol !== 'string') return null;
  const row = isRecord(raw.listing) ? raw.listing : isRecord(raw.limits) ? raw.limits : null;
  if (!row || typeof row.version !== 'number' || typeof row.approverId !== 'string' || typeof row.proposerId !== 'string') return null;
  return { symbol: raw.symbol, version: row.version, approverId: row.approverId, proposerId: row.proposerId };
}

/** The write door, under the approval's own version and operation id (identity minted it at propose). */
export function writeVenueChange(ctx: TradeCtx, req: VenueChangeRequest, approval: ActionApproval): Promise<Outcome<VenueWritten>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'trade',
      req.door,
      'mutation',
      {
        symbol: req.symbol,
        ...req.fields,
        expectedVersion: approval.expectedVersion,
        reason: req.reason,
        approvalId: approval.approvalId,
        operationId: approval.operationId,
      },
      parseWritten,
    ),
  );
}
