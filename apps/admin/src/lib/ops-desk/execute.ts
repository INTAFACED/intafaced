import 'server-only';
import {
  edgeCall,
  explainRefusal,
  failureRefusal,
  founderCall,
  founderRecordCall,
  type DeskRequest,
  type ExecuteFn,
  type ExecuteReply,
  type FounderCallContext,
  founderRecordRead,
} from '@/lib/desk';
import { treasuryTransport } from '@/lib/ledger';
import { marketTargetId, poolTargetId } from '@intafaced/contracts/protocol-ops';
import { MARKET_OPS_TAKEDOWN_LISTING, MARKET_VET } from '@intafaced/contracts/market-procedures';
import { normaliseCostAmount } from '@/lib/venue-economics';
import { isRecord } from '@intafaced/contracts/guards';
import { ACADEMY_ADMIN_GRANT_CERT_EXCEPTION } from '@intafaced/contracts/academy-admin-records';
import { ACADEMY_APPOINT_AMBASSADOR } from '@intafaced/contracts/academy-appoint-ambassador-procedures';
import { ACADEMY_DECIDE_RESIDENCY } from '@intafaced/contracts/academy-decide-residency-procedures';
import { OPS_CAPITAL_SET_THRESHOLD } from '@intafaced/contracts/ops-capital-procedures';
import { OPS_RECORD_VENUE_COST } from '@intafaced/contracts/ops-record-venue-cost-procedures';

/**
 * Run an approved Market or Academy request against the owning service, as the signed-in founder.
 *
 * The service spends the identity approval ONCE. A 2xx only counts as done when the record it returns is in the state
 * the request asked for; anything else is "outcome unknown", never a green tick. The founder session must carry the
 * service's operator scope (market:ops, admin:write) and a verified second factor; the service checks both itself and
 * its refusal is shown in words (admin-BACKEND-NEEDS.md, item 27).
 */

interface AmbassadorAnswer {
  readonly userId: string;
  readonly status: string;
}

export function readAmbassadorAnswer(raw: unknown): AmbassadorAnswer | null {
  if (!isRecord(raw) || typeof raw.userId !== 'string' || typeof raw.status !== 'string') return null;
  return { userId: raw.userId, status: raw.status };
}

interface ResidencyAnswer {
  readonly id: string;
  readonly status: string;
}

export function readResidencyAnswer(raw: unknown): ResidencyAnswer | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.status !== 'string') return null;
  return { id: raw.id, status: raw.status };
}

interface CertRevocationAnswer {
  readonly publicId: string;
  readonly reason: string;
  readonly revokedAt: string;
}

export function readCertRevocationAnswer(raw: unknown): CertRevocationAnswer | null {
  if (!isRecord(raw) || typeof raw.publicId !== 'string' || typeof raw.reason !== 'string' || typeof raw.revokedAt !== 'string')
    return null;
  return { publicId: raw.publicId, reason: raw.reason, revokedAt: raw.revokedAt };
}

interface CertExceptionAnswer {
  readonly publicId: string;
  readonly userId: string;
  readonly certId: string;
  readonly reason: string;
}

export function readCertExceptionAnswer(raw: unknown): CertExceptionAnswer | null {
  if (!isRecord(raw)) return null;
  const { publicId, userId, certId, reason } = raw;
  if (typeof publicId !== 'string' || typeof userId !== 'string' || typeof certId !== 'string' || typeof reason !== 'string') return null;
  return { publicId, userId, certId, reason };
}

interface CardStatusAnswer {
  readonly cardId: string;
  readonly status: string;
  readonly frozenBy: string | null;
}

export function readCardStatusAnswer(raw: unknown): CardStatusAnswer | null {
  if (!isRecord(raw) || typeof raw.cardId !== 'string' || typeof raw.status !== 'string') return null;
  if (!(raw.frozenBy === null || typeof raw.frozenBy === 'string')) return null;
  return { cardId: raw.cardId, status: raw.status, frozenBy: raw.frozenBy };
}

interface CardFundingAnswer {
  readonly kind: string;
  readonly amount: string;
  readonly threshold: string | null;
  readonly partnerRef: string;
}

/** A decimal's canonical text, compared as text and never as a number: "01000.50" and "1000.5" are one amount. */
function canonicalDecimal(d: string): string {
  const [whole = '', frac = ''] = d.split('.');
  const f = frac.replace(/0+$/, '');
  return `${whole.replace(/^0+(?=\d)/, '')}${f ? `.${f}` : ''}`;
}

export function readCardFundingAnswer(raw: unknown): CardFundingAnswer | null {
  if (!isRecord(raw) || typeof raw.kind !== 'string' || typeof raw.amount !== 'string' || typeof raw.partnerRef !== 'string') return null;
  if (!(raw.threshold === null || typeof raw.threshold === 'string')) return null;
  return { kind: raw.kind, amount: raw.amount, threshold: raw.threshold, partnerRef: raw.partnerRef };
}

interface VenueCostAnswer {
  readonly key: string;
  readonly period: string;
  readonly category: string;
  readonly amount: string;
  readonly asset: string;
  readonly version: number;
}

export function readVenueCostAnswer(raw: unknown): VenueCostAnswer | null {
  if (!isRecord(raw)) return null;
  const { key, period, category, amount, asset, version } = raw;
  return typeof key === 'string' &&
    typeof period === 'string' &&
    typeof category === 'string' &&
    typeof amount === 'string' &&
    typeof asset === 'string' &&
    typeof version === 'number'
    ? { key, period, category, amount, asset, version }
    : null;
}

interface CapitalThresholdAnswer {
  readonly assetId: string;
  readonly minimum: string;
  readonly contact: string;
  readonly version: number;
}

export function readCapitalThresholdAnswer(raw: unknown): CapitalThresholdAnswer | null {
  if (!isRecord(raw)) return null;
  const { assetId, minimum, contact, version } = raw;
  return typeof assetId === 'string' && typeof minimum === 'string' && typeof contact === 'string' && typeof version === 'number'
    ? { assetId, minimum, contact, version }
    : null;
}

interface ListingAnswer {
  readonly action: string;
  readonly targetId: string;
  readonly state: string;
  readonly outcome: string;
  readonly note: string | null;
}

export function readListingAnswer(raw: unknown): ListingAnswer | null {
  if (!isRecord(raw)) return null;
  const { action, targetId, state, outcome, note } = raw;
  return typeof action === 'string' &&
    typeof targetId === 'string' &&
    typeof state === 'string' &&
    typeof outcome === 'string' &&
    (note === null || typeof note === 'string')
    ? { action, targetId, state, outcome, note }
    : null;
}

type ListingRequest = Extract<
  DeskRequest,
  { kind: 'protocol.pool.hide' | 'protocol.pool.restore' | 'protocol.market.delist' | 'protocol.market.restore' }
>;

/** The svc-ops procedure, its input (before the approval ids) and the state the answer must show for one listing request. */
function listingCall(request: ListingRequest): {
  procedure: string;
  input: Record<string, unknown>;
  targetId: string;
  state: 'hidden' | 'visible';
} {
  switch (request.kind) {
    case 'protocol.pool.hide':
      return {
        procedure: 'protocolListing.pools.hide',
        input: { chainId: request.chainId, poolAddress: request.poolAddress, reasonCode: request.reasonCode, reason: request.reason },
        targetId: poolTargetId(request.chainId, request.poolAddress),
        state: 'hidden',
      };
    case 'protocol.pool.restore':
      return {
        procedure: 'protocolListing.pools.restore',
        input: { chainId: request.chainId, poolAddress: request.poolAddress },
        targetId: poolTargetId(request.chainId, request.poolAddress),
        state: 'visible',
      };
    case 'protocol.market.delist':
      return {
        procedure: 'protocolListing.markets.delist',
        input: { symbol: request.symbol, reasonCode: request.reasonCode, reason: request.reason },
        targetId: marketTargetId(request.symbol),
        state: 'hidden',
      };
    case 'protocol.market.restore':
      return {
        procedure: 'protocolListing.markets.restore',
        input: { symbol: request.symbol },
        targetId: marketTargetId(request.symbol),
        state: 'visible',
      };
  }
}

const WRONG_STATE: ExecuteReply = {
  ok: false,
  refusal: explainRefusal('admin.ops_invalid_response', 502, true),
};

export function opsExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request: DeskRequest, ids: { approvalId: string; operationId: string }): Promise<ExecuteReply> => {
    if (request.kind === 'market.vendor.vet') {
      const result = await founderRecordCall(ctx, MARKET_VET, {
        vendorId: request.vendorId,
        decision: request.decision,
        reason: request.reason,
        ...ids,
      });
      if (result.kind !== 'ok') return failureRefusal('svc-market', 'market', result);
      const { changed, vendor } = result.data;
      if (vendor.id !== request.vendorId || vendor.status !== request.decision) return WRONG_STATE;
      return {
        ok: true,
        detail: `svc-market answered and its returned vendor record is ${vendor.status}${changed ? '' : ' (it already was, so nothing changed)'}.`,
      };
    }
    if (request.kind === 'academy.ambassador.freeze' || request.kind === 'academy.ambassador.unfreeze') {
      const freeze = request.kind === 'academy.ambassador.freeze';
      const result = await founderCall(
        ctx,
        'academy',
        freeze ? 'freezeAmbassador' : 'unfreezeAmbassador',
        'POST',
        freeze ? { userId: request.userId, reason: request.reason, ...ids } : { userId: request.userId, ...ids },
        readAmbassadorAnswer,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-academy', 'academy', result);
      const a = result.data;
      if (a.userId !== request.userId || a.status !== (freeze ? 'frozen' : 'active')) return WRONG_STATE;
      return { ok: true, detail: `svc-academy answered and its returned ambassador record is ${a.status}.` };
    }
    if (request.kind === 'academy.ambassador.appoint') {
      const result = await founderRecordRead(ctx, ACADEMY_APPOINT_AMBASSADOR, { userId: request.userId, ...ids }, readAmbassadorAnswer);
      if (result.kind !== 'ok') return failureRefusal('svc-academy', 'academy', result);
      const a = result.data;
      if (a.userId !== request.userId || a.status !== 'active') return WRONG_STATE;
      return { ok: true, detail: `svc-academy answered and its returned ambassador record is ${a.status}.` };
    }
    if (request.kind === 'academy.residency.decide') {
      const result = await founderRecordRead(
        ctx,
        ACADEMY_DECIDE_RESIDENCY,
        { id: request.id, decision: request.decision, ...ids },
        readResidencyAnswer,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-academy', 'academy', result);
      const a = result.data;
      if (a.id !== request.id || a.status !== request.decision) return WRONG_STATE;
      return { ok: true, detail: `svc-academy answered and its returned application is ${a.status}.` };
    }
    if (request.kind === 'academy.cert.revoke') {
      const result = await founderCall(
        ctx,
        'academy',
        'admin.revokeCert',
        'POST',
        { publicId: request.publicId, reason: request.reason, ...ids },
        readCertRevocationAnswer,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-academy', 'academy', result);
      const a = result.data;
      if (a.publicId !== request.publicId) return WRONG_STATE;
      return { ok: true, detail: `svc-academy answered: certificate ${a.publicId} is revoked, recorded ${a.revokedAt} ("${a.reason}").` };
    }
    if (request.kind === 'academy.cert.exception') {
      const result = await founderRecordRead(
        ctx,
        ACADEMY_ADMIN_GRANT_CERT_EXCEPTION,
        { userId: request.userId, certId: request.certId, reason: request.reason, ...ids },
        readCertExceptionAnswer,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-academy', 'academy', result);
      const a = result.data;
      if (a.userId !== request.userId || a.certId !== request.certId) return WRONG_STATE;
      return {
        ok: true,
        detail: `svc-academy answered: certificate ${a.certId} is issued to ${a.userId} as an exception, code ${a.publicId} ("${a.reason}").`,
      };
    }
    if (request.kind === 'bank.card.status') {
      const result = await founderCall(
        ctx,
        'bank',
        'ops.setCardStatus',
        'POST',
        // The operation id is the client key, so running the same approved request twice replays the first
        // result at the service instead of acting twice.
        { cardId: request.cardId, status: request.status, reason: request.reason, ...ids, clientRequestId: ids.operationId },
        readCardStatusAnswer,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-bank', 'bank', result);
      const a = result.data;
      if (a.cardId !== request.cardId || a.status !== request.status) return WRONG_STATE;
      return {
        ok: true,
        detail: `svc-bank answered and its returned card is ${a.status}${a.frozenBy === 'operator' ? ', frozen by an operator' : ''}.`,
      };
    }
    if (request.kind === 'bank.card.funding') {
      // svc-bank asks for `admin:treasury`, which a founder session never carries, so the instruction goes on the console's
      // treasury transport (`ADMIN_TREASURY_TOKEN`), as the posting freeze, the reconciliation run and staff holds do. The
      // two founders' approval still binds it. A console without that credential sends nothing and names the setting.
      const transport = treasuryTransport();
      if ('reason' in transport) {
        return { ok: false, refusal: { ...explainRefusal('admin.ledger_unconfigured', 503, false), body: transport.reason } };
      }
      const result = await edgeCall(
        transport,
        'bank',
        'ops.requestCardProgrammeFunding',
        'POST',
        // The same fields the approval hash binds, byte for byte; the operation id is the client key, so a re-run replays.
        {
          kind: request.fundingKind,
          amount: request.amount,
          threshold: request.threshold === '' ? null : request.threshold,
          reason: request.reason,
          ...ids,
          clientRequestId: ids.operationId,
        },
        readCardFundingAnswer,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-bank', 'bank', result);
      const a = result.data;
      // The instruction svc-bank recorded must be the one the founders approved: same kind, amount and threshold, answered.
      const wantThreshold = request.threshold === '' ? null : canonicalDecimal(request.threshold);
      const gotThreshold = a.threshold === null ? null : canonicalDecimal(a.threshold);
      if (a.kind !== request.fundingKind || canonicalDecimal(a.amount) !== canonicalDecimal(request.amount)) return WRONG_STATE;
      if (wantThreshold !== gotThreshold || a.partnerRef === '') return WRONG_STATE;
      return { ok: true, detail: `svc-bank answered: the card partner took the instruction, reference ${a.partnerRef}.` };
    }
    if (request.kind === 'market.listing.takedown') {
      const result = await founderRecordCall(ctx, MARKET_OPS_TAKEDOWN_LISTING, {
        listingId: request.listingId,
        reason: request.reason,
        ...ids,
        clientRequestId: ids.operationId,
      });
      if (result.kind !== 'ok') return failureRefusal('svc-market', 'market', result);
      const a = result.data;
      if (a.listingId !== request.listingId || a.status !== 'taken_down') return WRONG_STATE;
      return { ok: true, detail: 'svc-market answered and its returned listing is taken down.' };
    }
    if (request.kind === 'ops.capital.threshold.set') {
      const result = await founderRecordRead(
        ctx,
        OPS_CAPITAL_SET_THRESHOLD,
        {
          assetId: request.assetId,
          minimum: request.minimum,
          contact: request.contact,
          reason: request.reason,
          // One approval is one threshold version: running the same approved request twice returns the first.
          idempotencyKey: `capital-threshold-approval:${ids.approvalId}`,
          ...ids,
        },
        readCapitalThresholdAnswer,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-ops', 'ops', result);
      const a = result.data;
      if (a.assetId !== request.assetId || a.contact !== request.contact || (request.minimum === '') !== (a.minimum === ''))
        return WRONG_STATE;
      return {
        ok: true,
        detail:
          a.minimum === ''
            ? `svc-ops answered: the ${a.assetId} threshold is cleared (version ${a.version}); it is not monitored.`
            : `svc-ops answered: the ${a.assetId} minimum buffer is ${a.minimum} (version ${a.version}), escalated to ${a.contact}.`,
      };
    }
    if (request.kind === 'ops.venue_cost.record') {
      const amount = normaliseCostAmount(request.amount);
      const result = await founderRecordRead(
        ctx,
        OPS_RECORD_VENUE_COST,
        {
          period: request.period,
          category: request.category,
          amount,
          asset: request.asset,
          sourceNote: request.reason,
          // One approval is one entry: running the same approved request twice returns the first entry.
          idempotencyKey: `venue-cost-approval:${ids.approvalId}`,
          ...ids,
        },
        readVenueCostAnswer,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-ops', 'ops', result);
      const a = result.data;
      if (a.period !== request.period || a.category !== request.category || a.amount !== amount || a.asset !== request.asset)
        return WRONG_STATE;
      return {
        ok: true,
        detail: `svc-ops answered and stored version ${a.version} of ${request.category.replace(/_/g, ' ')} for ${a.period}.`,
      };
    }
    if (
      request.kind === 'protocol.pool.hide' ||
      request.kind === 'protocol.pool.restore' ||
      request.kind === 'protocol.market.delist' ||
      request.kind === 'protocol.market.restore'
    ) {
      const call = listingCall(request);
      const result = await founderCall(ctx, 'ops', call.procedure, 'POST', { ...call.input, ...ids }, readListingAnswer);
      if (result.kind !== 'ok') return failureRefusal('svc-ops', 'ops', result);
      const a = result.data;
      if (a.action !== request.kind || a.targetId !== call.targetId || a.state !== call.state) return WRONG_STATE;
      return {
        ok: true,
        detail: `svc-ops answered and ${a.targetId} is ${a.state}${a.outcome === 'noop' ? ' (it already was, so nothing changed)' : ''}.`,
      };
    }
    return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
  };
}
