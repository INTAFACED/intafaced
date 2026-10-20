import 'server-only';
import type { DeskRequest } from '@/lib/desk/approval-packet';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { founderCall, type CallModule, type FounderCallContext, type FounderCallFailure } from '@/lib/desk/founder-call';
import { codeInText, explainRefusal, isKnownCode } from '@/lib/desk/refusal-copy';
import { normaliseCostAmount } from '@/lib/venue-economics/model';

/**
 * Run an approved Market or Academy request against the owning service, as the signed-in founder.
 *
 * The service spends the identity approval ONCE. A 2xx only counts as done when the record it returns is in the state
 * the request asked for; anything else is "outcome unknown", never a green tick. The founder session must carry the
 * service's operator scope (market:ops, admin:write) and a verified second factor; the service checks both itself and
 * its refusal is shown in words (admin-BACKEND-NEEDS.md, item 27).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

interface VetAnswer {
  readonly changed: boolean;
  readonly vendorId: string;
  readonly status: string;
}

export function readVetAnswer(raw: unknown): VetAnswer | null {
  if (!isRecord(raw) || typeof raw.changed !== 'boolean' || !isRecord(raw.vendor)) return null;
  const { id, status } = raw.vendor;
  return typeof id === 'string' && typeof status === 'string' ? { changed: raw.changed, vendorId: id, status } : null;
}

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

interface TakedownAnswer {
  readonly listingId: string;
  readonly status: string;
}

export function readTakedownAnswer(raw: unknown): TakedownAnswer | null {
  if (!isRecord(raw) || typeof raw.listingId !== 'string' || typeof raw.status !== 'string') return null;
  return { listingId: raw.listingId, status: raw.status };
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

const WRONG_STATE: ExecuteReply = {
  ok: false,
  refusal: explainRefusal('admin.ops_invalid_response', 502, true),
};

const NEEDS: Readonly<Record<string, string>> = {
  market: 'the market operator permission (market:ops) and a verified second factor',
  academy: 'the Academy operator permission (admin:write) and a verified second factor',
  bank: 'the bank treasury permission (admin:treasury) and a verified second factor',
  p2p: 'moderator access (admin:compliance, or being on the moderator list) and the P2P read permission',
  ops: 'the operator write permission (admin:write) and a verified second factor',
};

/** The permission, as the founder reads it in the refusal's headline. */
const PERMISSION_NAME: Readonly<Record<string, string>> = {
  market: 'market operator',
  academy: 'Academy operator',
  bank: 'bank treasury',
  p2p: 'P2P moderator',
  ops: 'operations',
};

/** A failed call as a desk refusal. A typed approval code is a definite "nothing changed"; a dropped connection is unknown. */
export function failureRefusal(service: string, module: CallModule, failure: FounderCallFailure<unknown>): ExecuteReply {
  switch (failure.kind) {
    case 'forbidden': {
      const base = explainRefusal(failure.refusal.code ?? codeInText(failure.refusal.message), failure.refusal.status, false);
      return {
        ok: false,
        refusal: isKnownCode(base.code)
          ? base
          : {
              ...base,
              title: `Your console session does not have ${PERMISSION_NAME[module] ?? 'operator'} permission`,
              body: `${service} did not accept your founder session for this. It needs ${NEEDS[module] ?? 'an operator permission'}, and founder sign-in does not carry it. Nothing was changed.`,
              next: 'See the back-end needs note for the permission to grant.',
            },
      };
    }
    case 'refused': {
      const code = codeInText(failure.refusal.message) ?? failure.refusal.code;
      const view = explainRefusal(code, failure.refusal.status, false);
      return {
        ok: false,
        refusal: isKnownCode(code) || failure.refusal.message === '' ? view : { ...view, body: failure.refusal.message },
      };
    }
    case 'unavailable':
      return { ok: false, refusal: explainRefusal(null, 503, failure.uncertain) };
    case 'not_built':
      return {
        ok: false,
        refusal: {
          title: `${service} does not have this switched on`,
          body: 'The procedure is not mounted on this deployment. Nothing was changed.',
          next: 'Tell engineering.',
          code: null,
          changed: 'no',
        },
      };
    case 'invalid':
      return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
  }
}

export function opsExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request: DeskRequest, ids: { approvalId: string; operationId: string }): Promise<ExecuteReply> => {
    if (request.kind === 'market.vendor.vet') {
      const result = await founderCall(
        ctx,
        'market',
        'vet',
        'POST',
        { vendorId: request.vendorId, decision: request.decision, reason: request.reason, ...ids },
        readVetAnswer,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-market', 'market', result);
      const a = result.data;
      if (a.vendorId !== request.vendorId || a.status !== request.decision) return WRONG_STATE;
      return {
        ok: true,
        detail: `svc-market answered and its returned vendor record is ${a.status}${a.changed ? '' : ' (it already was, so nothing changed)'}.`,
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
      const result = await founderCall(
        ctx,
        'academy',
        'appointAmbassador',
        'POST',
        { userId: request.userId, ...ids },
        readAmbassadorAnswer,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-academy', 'academy', result);
      const a = result.data;
      if (a.userId !== request.userId || a.status !== 'active') return WRONG_STATE;
      return { ok: true, detail: `svc-academy answered and its returned ambassador record is ${a.status}.` };
    }
    if (request.kind === 'academy.residency.decide') {
      const result = await founderCall(
        ctx,
        'academy',
        'decideResidency',
        'POST',
        { id: request.id, decision: request.decision, ...ids },
        readResidencyAnswer,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-academy', 'academy', result);
      const a = result.data;
      if (a.id !== request.id || a.status !== request.decision) return WRONG_STATE;
      return { ok: true, detail: `svc-academy answered and its returned application is ${a.status}.` };
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
    if (request.kind === 'market.listing.takedown') {
      const result = await founderCall(
        ctx,
        'market',
        'ops.takedownListing',
        'POST',
        { listingId: request.listingId, reason: request.reason, ...ids, clientRequestId: ids.operationId },
        readTakedownAnswer,
      );
      if (result.kind !== 'ok') return failureRefusal('svc-market', 'market', result);
      const a = result.data;
      if (a.listingId !== request.listingId || a.status !== 'taken_down') return WRONG_STATE;
      return { ok: true, detail: 'svc-market answered and its returned listing is taken down.' };
    }
    if (request.kind === 'ops.venue_cost.record') {
      const amount = normaliseCostAmount(request.amount);
      const result = await founderCall(
        ctx,
        'ops',
        'recordVenueCost',
        'POST',
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
    return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
  };
}
