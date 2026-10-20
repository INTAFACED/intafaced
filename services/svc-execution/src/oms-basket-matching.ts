/**
 * Hitch basket/rebalance children onto matching POST /markets/:marketId/orders.
 * Generic live slice (twap|vwap|pov) does not cover basket — do not dual-implement
 * a second engine. Qty/price stay decimal strings. Paper never posts and never
 * ledgers. Partial-failure refuse_all: first matching miss stops remaining legs.
 * A later miss, timeout, or unknown names acks already accepted and kills those children.
 * A basket whose children all post is not killed.
 * Kill: unknown matching cancel is killed false — never invent canceled.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { readMatchingUrl } from './oms-matching-venue-halt.js';
import { matchingCallSigner, type OmsMatchingS2s } from './oms-kill-parent-matching.js';
import type { OmsBasketNamedLeg, OmsBasketStartOk } from './oms-basket-start.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_SERVICE_SECRET_LENGTH = 32;
export const SERVICE_SECRET_ENV = 'INTERNAL_SERVICE_SECRET';
export const MATCHING_SERVICE_NAME = 'svc-execution';

export type BasketMatchingOrderType = 'market' | 'limit';
export type BasketMatchingSide = 'buy' | 'sell';
export type BasketMatchingTif = 'GTC' | 'IOC' | 'FOK' | 'PO' | 'GTD' | 'GTT';

export type OmsBasketMatchingRefuseReason =
  | 'matching_unconfigured'
  | 'matching_service_auth_unconfigured'
  | 'matching_unavailable'
  | 'matching_timeout'
  | 'matching_rejected'
  | 'matching_unknown'
  | 'missing_legs'
  | 'missing_market'
  | 'missing_account'
  | 'missing_order_id'
  | 'missing_side'
  | 'missing_type'
  | 'missing_tif'
  | 'missing_price'
  | 'missing_qty'
  | 'qty_invalid'
  | 'missing_lifecycle_proof'
  | 'paper_unsupported'
  | 'flatten_remaining_refused';

export type OmsBasketMatchingRefusal = {
  readonly ok: false;
  readonly reason: OmsBasketMatchingRefuseReason;
  readonly detail: string;
  /** Acks of children matching already accepted, when a later leg refuses. */
  readonly children?: readonly OmsBasketMatchingChildAck[];
  /** Kill of that accepted prefix. The start door reads this and does not kill twice. */
  readonly kill?: OmsBasketMatchingKillResult;
};

export type OmsBasketMatchingChildInput = {
  readonly name?: string | null;
  readonly qty?: string | null;
  readonly marketId?: string | null;
  readonly orderId?: string | null;
  readonly side?: string | null;
  readonly type?: string | null;
  readonly tif?: string | null;
  readonly price?: string | null;
  readonly accountId?: string | null;
  readonly lifecycleProof?: unknown;
};

export type OmsBasketMatchingChildAck = {
  readonly name: string;
  readonly qty: string;
  readonly marketId: string;
  readonly orderId: string;
  readonly matching: { readonly accepted: true; readonly sequence: number | null };
};

export type OmsBasketMatchingOk = OmsBasketStartOk & {
  readonly children: readonly OmsBasketMatchingChildAck[];
};

export type OmsBasketMatchingResult = OmsBasketMatchingOk | OmsBasketMatchingRefusal;

export type OmsBasketMatchingKillChild = {
  readonly marketId?: string | null;
  readonly orderId?: string | null;
};

export type OmsBasketMatchingKillOutcome = {
  readonly marketId: string;
  readonly orderId: string;
  readonly outcome: 'stopped' | 'already_stopped' | 'unknown';
  readonly reason?: string;
};

export type OmsBasketMatchingKillOk = {
  readonly ok: true;
  readonly killed: boolean;
  readonly children: readonly OmsBasketMatchingKillOutcome[];
};

export type OmsBasketMatchingKillResult = OmsBasketMatchingKillOk | OmsBasketMatchingRefusal;

function refuse(reason: OmsBasketMatchingRefuseReason, detail: string): OmsBasketMatchingRefusal {
  return { ok: false, reason, detail };
}

export function readInternalServiceSecret(raw: string | undefined): { ok: true; secret: string } | OmsBasketMatchingRefusal {
  const secret = raw ?? '';
  if (secret.length < MIN_SERVICE_SECRET_LENGTH) {
    return refuse(
      'matching_service_auth_unconfigured',
      'INTERNAL_SERVICE_SECRET is blank; svc-execution does not POST unsigned matching orders',
    );
  }
  return { ok: true, secret };
}

/** A keypair-only service sends no shared secret, so a blank one is not a refusal there. */
function readCallSecret(raw: string | undefined, s2s?: OmsMatchingS2s): { ok: true; secret: string } | OmsBasketMatchingRefusal {
  if (s2s?.mode === 'keypair') return { ok: true, secret: raw ?? '' };
  return readInternalServiceSecret(raw);
}

function isAbort(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = 'name' in err ? String(err.name) : '';
  return name === 'AbortError' || name === 'TimeoutError';
}

function parseLedgerQty(raw: string | null | undefined, label: string): { ok: true; text: string } | OmsBasketMatchingRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_qty', `${label} qty is blank — refuse rather than invent size`);
  }
  const text = raw.trim();
  if (!text) {
    return refuse('missing_qty', `${label} qty is blank — refuse rather than invent size`);
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('qty_invalid', `${label} qty must be a positive ledger amount — not invented`);
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('qty_invalid', `${label} qty is not a ledger amount — refusing to invent size`);
  }
}

function parseLedgerPrice(raw: string | null | undefined, label: string): { ok: true; text: string } | OmsBasketMatchingRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_price', `${label} price is blank — refuse rather than invent a last`);
  }
  const text = raw.trim();
  if (!text) {
    return refuse('missing_price', `${label} price is blank — refuse rather than invent a last`);
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('missing_price', `${label} price must be a positive ledger amount — not invented`);
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('missing_price', `${label} price is not a ledger amount — refusing to invent a last`);
  }
}

function asSide(raw: string | null | undefined): BasketMatchingSide | null {
  return raw === 'buy' || raw === 'sell' ? raw : null;
}

function asType(raw: string | null | undefined): BasketMatchingOrderType | null {
  return raw === 'market' || raw === 'limit' ? raw : null;
}

function asTif(raw: string | null | undefined): BasketMatchingTif | null {
  return raw === 'GTC' || raw === 'IOC' || raw === 'FOK' || raw === 'PO' || raw === 'GTD' || raw === 'GTT' ? raw : null;
}

/** A blank PX-S01 proof is absent. Empty string, false, and 0 are not evidence. */
function isPresentLifecycleProof(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return true;
}

type ResolvedChild = {
  readonly name: string;
  readonly qty: string;
  readonly marketId: string;
  readonly orderId: string;
  readonly accountId: string;
  readonly side: BasketMatchingSide;
  readonly type: BasketMatchingOrderType;
  readonly tif: BasketMatchingTif;
  readonly price: string | null;
  readonly lifecycleProof: unknown;
};

function resolveChild(
  leg: OmsBasketMatchingChildInput,
  started: OmsBasketNamedLeg | undefined,
  parentAccountId: string | undefined,
  parentType: string | undefined,
  parentTif: string | undefined,
  parentLifecycleProof: unknown,
  index: number,
): { ok: true; child: ResolvedChild } | OmsBasketMatchingRefusal {
  const name = (leg.name ?? started?.name)?.trim() ?? '';
  const label = name || `leg ${index}`;
  if (!name) {
    return refuse('missing_legs', `leg ${index} is unnamed — refuse rather than silently weaken the parent`);
  }
  const qty = parseLedgerQty(leg.qty ?? started?.qty, label);
  if (!qty.ok) return qty;
  const marketId = leg.marketId?.trim() ?? '';
  if (!marketId) {
    return refuse('missing_market', `leg ${label} marketId is blank — refuse rather than invent a book`);
  }
  const orderId = leg.orderId?.trim() ?? '';
  if (!orderId || !UUID.test(orderId)) {
    return refuse('missing_order_id', `leg ${label} orderId must be a UUID — refusing to invent a matching identity`);
  }
  const accountId = (leg.accountId ?? parentAccountId)?.trim() ?? '';
  if (!accountId) {
    return refuse('missing_account', `leg ${label} accountId is blank — refuse rather than invent an account`);
  }
  const side = asSide(leg.side ?? null);
  if (!side) {
    return refuse('missing_side', `leg ${label} side is required — refusing to invent buy or sell`);
  }
  const type = asType(leg.type ?? parentType ?? null);
  if (!type) {
    return refuse('missing_type', `leg ${label} type is required — refusing to invent market or limit`);
  }
  const tif = asTif(leg.tif ?? parentTif ?? null);
  if (!tif) {
    return refuse('missing_tif', `leg ${label} tif is required — refusing to invent GTC`);
  }
  let price: string | null = null;
  if (type === 'limit') {
    const parsed = parseLedgerPrice(leg.price, label);
    if (!parsed.ok) return parsed;
    price = parsed.text;
  }
  const lifecycleProof = leg.lifecycleProof ?? parentLifecycleProof;
  if (!isPresentLifecycleProof(lifecycleProof)) {
    return refuse('missing_lifecycle_proof', `leg ${label} lifecycleProof is missing — refusing to invent PX-S01 evidence`);
  }
  return {
    ok: true,
    child: {
      name,
      qty: qty.text,
      marketId,
      orderId,
      accountId,
      side,
      type,
      tif,
      price,
      lifecycleProof,
    },
  };
}

function matchingSubmitPath(marketId: string): string {
  return `/markets/${encodeURIComponent(marketId)}/orders`;
}

function matchingCancelPath(marketId: string, orderId: string): string {
  return `/markets/${encodeURIComponent(marketId)}/orders/${encodeURIComponent(orderId)}`;
}

function toMatchingSubmitBody(child: ResolvedChild): Record<string, unknown> {
  return {
    orderId: child.orderId,
    accountId: child.accountId,
    type: child.type,
    side: child.side,
    qty: child.qty,
    price: child.price,
    tif: child.tif,
    lifecycleProof: child.lifecycleProof,
  };
}

function classifySubmitStatus(status: number, detail: string): OmsBasketMatchingRefusal {
  if (status === 408 || status === 504) {
    return refuse('matching_timeout', `matching submit timed out (${status}); svc-execution does not invent a fill`);
  }
  if (status >= 500) {
    return refuse(
      'matching_unavailable',
      `matching submit failed (${status})${detail ? `: ${detail}` : ''}; svc-execution does not invent a fill`,
    );
  }
  return refuse(
    'matching_rejected',
    `matching rejected submit (${status})${detail ? `: ${detail}` : ''}; svc-execution does not invent a fill`,
  );
}

function parseSubmitAck(body: unknown): { ok: true; sequence: number | null } | OmsBasketMatchingRefusal {
  if (!body || typeof body !== 'object') {
    return refuse('matching_rejected', 'matching submit returned non-JSON; svc-execution does not invent a fill');
  }
  const rec = body as Record<string, unknown>;
  if (rec.accepted === false) {
    return refuse('matching_rejected', 'matching rejected the order; svc-execution does not invent a fill');
  }
  if (rec.accepted !== true) {
    return refuse(
      'matching_rejected',
      'matching submit ack is not named accepted/sequence JSON; svc-execution does not mint fills, last, or account',
    );
  }
  const sequence = rec.sequence;
  if (sequence === null || sequence === undefined) {
    return { ok: true, sequence: null };
  }
  if (typeof sequence !== 'number' || !Number.isInteger(sequence)) {
    return refuse(
      'matching_rejected',
      'matching submit ack is not named accepted/sequence JSON; svc-execution does not mint fills, last, or account',
    );
  }
  return { ok: true, sequence };
}

async function postOne(
  base: string,
  child: ResolvedChild,
  fetchFn: typeof fetch,
  timeoutMs: number,
  secret: string,
  s2s?: OmsMatchingS2s,
): Promise<{ ok: true; ack: OmsBasketMatchingChildAck } | OmsBasketMatchingRefusal> {
  const payload = JSON.stringify(toMatchingSubmitBody(child));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const target = `${base}${matchingSubmitPath(child.marketId)}`;
    const response = await fetchFn(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...matchingCallSigner(secret, s2s)(payload, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
      },
      body: payload,
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      return classifySubmitStatus(response.status, text.slice(0, 500));
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      return refuse('matching_rejected', 'matching submit returned non-JSON; svc-execution does not invent a fill');
    }
    const ack = parseSubmitAck(json);
    if (!ack.ok) return ack;
    return {
      ok: true,
      ack: {
        name: child.name,
        qty: child.qty,
        marketId: child.marketId,
        orderId: child.orderId,
        matching: { accepted: true, sequence: ack.sequence },
      },
    };
  } catch (err) {
    if (isAbort(err) || controller.signal.aborted) {
      return refuse('matching_timeout', 'matching submit timed out; svc-execution does not invent a fill');
    }
    return refuse('matching_unknown', 'matching submit outcome is unknown; svc-execution does not invent a fill');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST each named basket leg to matching. Blank MATCHING_URL refuses.
 * First matching miss stops remaining legs (refuse_all — never flatten).
 * Children already accepted are killed, and their acks stay on the refusal.
 * Does not touch ledger. Paper callers must refuse before this door.
 */
export async function postBasketChildrenToMatching(input: {
  parent: OmsBasketStartOk;
  legs?: readonly OmsBasketMatchingChildInput[] | null;
  accountId?: string | null;
  type?: string | null;
  tif?: string | null;
  lifecycleProof?: unknown;
  matchingUrl?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** INTERNAL_SERVICE_SECRET. Blank / short refuses before unsigned POST. */
  internalServiceSecret?: string;
  /** svc-execution's own key. Absent leaves the calls on the shared secret. */
  s2s?: OmsMatchingS2s;
  /** Fired only after matching accepts a child, before a later leg can refuse. */
  onChildAccepted?: (child: OmsBasketMatchingChildAck) => void;
}): Promise<OmsBasketMatchingResult> {
  const base = readMatchingUrl(input.matchingUrl);
  if (!base) {
    return refuse('matching_unconfigured', 'MATCHING_URL is blank; svc-execution does not invent a matching host or a fill');
  }
  const rawLegs = input.legs;
  if (rawLegs === null || rawLegs === undefined || rawLegs.length === 0) {
    return refuse('missing_legs', 'basket children require named matching legs — refuse rather than invent a book');
  }
  if (rawLegs.length !== input.parent.legs.length) {
    return refuse('flatten_remaining_refused', 'matching child count must equal named parent legs — refusing to invent remaining flatten');
  }

  const resolved: ResolvedChild[] = [];
  for (const [index, leg] of rawLegs.entries()) {
    const child = resolveChild(
      leg,
      input.parent.legs[index],
      input.accountId ?? undefined,
      input.type ?? undefined,
      input.tif ?? undefined,
      input.lifecycleProof,
      index,
    );
    if (!child.ok) return child;
    resolved.push(child.child);
  }

  const secret = readCallSecret(input.internalServiceSecret ?? process.env[SERVICE_SECRET_ENV], input.s2s);
  if (!secret.ok) return secret;

  const fetchFn = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const children: OmsBasketMatchingChildAck[] = [];
  for (const child of resolved) {
    const posted = await postOne(base, child, fetchFn, timeoutMs, secret.secret, input.s2s);
    if (!posted.ok) {
      const reason =
        posted.reason === 'matching_unknown' ||
        posted.reason === 'matching_timeout' ||
        posted.reason === 'matching_unavailable' ||
        posted.reason === 'matching_rejected'
          ? posted.reason
          : 'flatten_remaining_refused';
      const detail = `${posted.detail} — refuse_all, remaining legs not posted`;
      if (children.length === 0) return refuse(reason, detail);
      const kill = await killBasketMatchingChildren({
        children: children.map((ack) => ({ marketId: ack.marketId, orderId: ack.orderId })),
        matchingUrl: base,
        fetch: fetchFn,
        timeoutMs,
        internalServiceSecret: secret.secret,
        s2s: input.s2s,
      });
      return { ...refuse(reason, detail), children, kill };
    }
    children.push(posted.ack);
    input.onChildAccepted?.(posted.ack);
  }

  return {
    ...input.parent,
    children,
  };
}

function childrenKnown(children: readonly OmsBasketMatchingKillOutcome[]): boolean {
  return children.every((child) => child.outcome === 'stopped' || child.outcome === 'already_stopped');
}

async function deleteOne(
  base: string,
  marketId: string,
  orderId: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
  secret: string,
  s2s?: OmsMatchingS2s,
): Promise<OmsBasketMatchingKillOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const target = `${base}${matchingCancelPath(marketId, orderId)}`;
    const response = await fetchFn(target, {
      method: 'DELETE',
      headers: {
        ...matchingCallSigner(secret, s2s)('', { method: 'DELETE', url: new URL(target), contentType: '' }),
      },
      signal: controller.signal,
    });
    if (response.status === 404) {
      return { marketId, orderId, outcome: 'already_stopped' };
    }
    if (!response.ok) {
      if (response.status === 408 || response.status === 504 || response.status >= 500) {
        return { marketId, orderId, outcome: 'unknown', reason: 'cancel_failed' };
      }
      return { marketId, orderId, outcome: 'unknown', reason: 'cancel_failed' };
    }
    return { marketId, orderId, outcome: 'stopped' };
  } catch {
    return { marketId, orderId, outcome: 'unknown', reason: 'cancel_failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DELETE basket children on matching. Unknown cancel is killed false.
 * Does not invent a canceled order. Does not ledger.
 */
export async function killBasketMatchingChildren(input: {
  children?: readonly OmsBasketMatchingKillChild[] | null;
  matchingUrl?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** INTERNAL_SERVICE_SECRET. Blank / short refuses before unsigned DELETE. */
  internalServiceSecret?: string;
  /** svc-execution's own key. Absent leaves the cancel on the shared secret. */
  s2s?: OmsMatchingS2s;
}): Promise<OmsBasketMatchingKillResult> {
  const base = readMatchingUrl(input.matchingUrl);
  if (!base) {
    return refuse('matching_unconfigured', 'MATCHING_URL is blank; svc-execution does not invent a matching host or a cancel');
  }
  const raw = input.children;
  if (raw === null || raw === undefined || raw.length === 0) {
    return refuse('missing_legs', 'kill-basket needs matching children — refusing to invent a canceled book');
  }
  const pending: { marketId: string; orderId: string }[] = [];
  for (const row of raw) {
    const marketId = row.marketId?.trim() ?? '';
    const orderId = row.orderId?.trim() ?? '';
    if (!marketId) {
      return refuse('missing_market', 'kill-basket child marketId is blank — refuse rather than invent a book');
    }
    if (!orderId || !UUID.test(orderId)) {
      return refuse('missing_order_id', 'kill-basket child orderId must be a UUID — refusing to invent a cancel');
    }
    pending.push({ marketId, orderId });
  }
  const secret = readCallSecret(input.internalServiceSecret ?? process.env[SERVICE_SECRET_ENV], input.s2s);
  if (!secret.ok) {
    return refuse(
      'matching_service_auth_unconfigured',
      'INTERNAL_SERVICE_SECRET is blank; svc-execution does not DELETE unsigned matching cancels',
    );
  }
  const fetchFn = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const children: OmsBasketMatchingKillOutcome[] = [];
  for (const row of pending) {
    children.push(await deleteOne(base, row.marketId, row.orderId, fetchFn, timeoutMs, secret.secret, input.s2s));
  }
  return {
    ok: true,
    killed: childrenKnown(children),
    children,
  };
}
