/**
 * Live HTTP doors hitch UNIT_ONLY MMP mill helpers (post / hedge / mqq).
 * Real MMP is Wave E in svc-matching — do not dual-implement. Do not invent
 * quantity, delta, or vega. Mill files are not recut. router.ts is not recut.
 * Never submit to matching. Never withdrawHold.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { refuseLiveOmsMmp, type OmsMmpUnsupportedRefuse } from './oms-mmp-refuse.js';
import { postBothSidesMmpQuote, type OmsMmpPostInput, type OmsMmpPostResult } from './oms-mmp-post.js';
import { hedgeRemainingAfterMmpFill, type OmsMmpHedgeResult } from './oms-mmp-hedge.js';
import { cancelBothSidesOnMqqBreach, type OmsMmpMqqInput, type OmsMmpMqqResult } from './oms-mmp-mqq.js';
import { authorizeOmsWriteRequest, type OmsWriteS2s } from './oms-write-hmac.js';

export type OmsMmpDoorGreeks = {
  readonly kind?: string | null;
  readonly mmp?: boolean;
  readonly massQuote?: boolean;
  readonly delta?: unknown;
  readonly vega?: unknown;
};

export type OmsMmpPostDoorBody = OmsMmpDoorGreeks & {
  readonly parentClientOrderId?: string;
  readonly quoteId?: string;
  readonly symbol?: string;
  readonly bidQuoteId?: string;
  readonly askQuoteId?: string;
  readonly mqq?: unknown;
  readonly bidSize?: unknown;
  readonly askSize?: unknown;
};

export type OmsMmpHedgeDoorBody = OmsMmpDoorGreeks & {
  readonly parentClientOrderId?: string;
  readonly hedgeSize?: unknown;
};

export type OmsMmpMqqDoorBody = OmsMmpDoorGreeks & {
  readonly mqq?: unknown;
  readonly quotes?: unknown;
};

export type OmsMmpDoorDeps = {
  readonly edgeContext: (req: { headers: FastifyRequest['headers']; id: string }) => {
    principal?: { userId?: string; scopes?: readonly string[] } | null;
  };
  readonly internalSecret?: string | null;
  readonly s2s?: OmsWriteS2s;
};

function asGreek(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return typeof raw === 'string' ? raw : String(raw);
}

function refuseInventedGreeks(body: OmsMmpDoorGreeks): OmsMmpUnsupportedRefuse | null {
  return refuseLiveOmsMmp({
    kind: body.kind,
    mmp: body.mmp,
    massQuote: body.massQuote,
    delta: asGreek(body.delta),
    vega: asGreek(body.vega),
  });
}

/** Ledger amounts stay decimal strings. A number or object is not coerced into a size. */
function isLedgerText(raw: unknown): raw is string | null | undefined {
  return raw === null || raw === undefined || typeof raw === 'string';
}

/** Pure door — tests call this. Delta/vega refuses before mill post. Never matching. */
export function handleOmsMmpPostDoor(body: OmsMmpPostDoorBody): OmsMmpPostResult | OmsMmpUnsupportedRefuse {
  const refused = refuseInventedGreeks(body);
  if (refused) return refused;
  if (!isLedgerText(body.mqq)) {
    return {
      ok: false,
      reason: 'mqq_invalid',
      detail: 'MQQ is not a ledger amount — refuse rather than invent a minimum quote quantity',
    };
  }
  if (!isLedgerText(body.bidSize)) {
    return {
      ok: false,
      reason: 'size_invalid',
      detail: 'bidSize is not a ledger amount — refuse rather than invent size',
    };
  }
  if (!isLedgerText(body.askSize)) {
    return {
      ok: false,
      reason: 'size_invalid',
      detail: 'askSize is not a ledger amount — refuse rather than invent size',
    };
  }
  const mill: OmsMmpPostInput = {
    parentClientOrderId: body.parentClientOrderId,
    quoteId: body.quoteId,
    symbol: body.symbol,
    bidQuoteId: body.bidQuoteId,
    askQuoteId: body.askQuoteId,
    mqq: body.mqq,
    bidSize: body.bidSize,
    askSize: body.askSize,
  };
  return postBothSidesMmpQuote(mill);
}

/** Pure door — never compute hedgeSize from fill/delta/vega. E6: do not start hedging. */
export function handleOmsMmpHedgeDoor(body: OmsMmpHedgeDoorBody): OmsMmpHedgeResult | OmsMmpUnsupportedRefuse {
  const refused = refuseInventedGreeks(body);
  if (refused) return refused;
  if (!isLedgerText(body.hedgeSize)) {
    return {
      ok: false,
      reason: 'hedge_size_invalid',
      detail: 'hedge size is not a ledger amount — not invented',
    };
  }
  return hedgeRemainingAfterMmpFill({
    parentClientOrderId: body.parentClientOrderId,
    hedgeSize: body.hedgeSize,
  });
}

/** Pure door — mill cancel-both-sides on MQQ breach. Never matching/flatten. */
export function handleOmsMmpMqqDoor(body: OmsMmpMqqDoorBody): OmsMmpMqqResult | OmsMmpUnsupportedRefuse {
  const refused = refuseInventedGreeks(body);
  if (refused) return refused;
  if (!isLedgerText(body.mqq)) {
    return {
      ok: false,
      reason: 'mqq_invalid',
      detail: 'MQQ is not a ledger amount — refuse rather than invent a minimum quote quantity',
    };
  }
  const quotes: unknown = body.quotes ?? [];
  if (!Array.isArray(quotes)) {
    const parsedMqq = cancelBothSidesOnMqqBreach({ mqq: body.mqq, quotes: [] });
    if (!parsedMqq.ok) return parsedMqq;
    return {
      ok: false,
      reason: 'remaining_blank',
      detail: 'quotes are not a list — refuse rather than invent remaining size',
    };
  }
  return cancelBothSidesOnMqqBreach({
    mqq: body.mqq,
    quotes: quotes as OmsMmpMqqInput['quotes'],
  });
}

export function registerOmsMmpDoor(app: FastifyInstance, deps: OmsMmpDoorDeps): void {
  app.post('/execution/oms/mmp-post', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsMmpPostDoorBody;
    return reply.send(handleOmsMmpPostDoor(body));
  });

  app.post('/execution/oms/mmp-hedge', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsMmpHedgeDoorBody;
    return reply.send(handleOmsMmpHedgeDoor(body));
  });

  app.post('/execution/oms/mmp-mqq', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsMmpMqqDoorBody;
    return reply.send(handleOmsMmpMqqDoor(body));
  });
}
