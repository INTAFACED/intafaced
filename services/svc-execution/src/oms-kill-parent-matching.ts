/**
 * Kill-parent matching cancel. Cancel is a request until matching sequence.
 * Matching never-saw (404) or ack without sequence is unknown — never killed
 * from silence. Does not invent a canceled order or a sequence. Does not ledger.
 */
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { readMatchingUrl } from './oms-matching-venue-halt.js';
import type { OmsDrainChild } from './oms-drain.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_SERVICE_SECRET_LENGTH = 32;
export const SERVICE_SECRET_ENV = 'INTERNAL_SERVICE_SECRET';
export const MATCHING_SERVICE_NAME = 'svc-execution';

/** This service's own key and the mode it runs in. Absent leaves the matching calls on the shared secret alone. */
export type OmsMatchingS2s = { readonly signer: ServiceSigner; readonly mode: ServiceAuthMode };

/** Signs a call to svc-matching: with the shared secret as ever, or (once S2S is on) with svc-execution's own key. */
export function matchingCallSigner(secret: string, s2s?: OmsMatchingS2s) {
  return serviceCallSigner({
    service: MATCHING_SERVICE_NAME,
    audience: 'svc-matching',
    legacySecret: secret,
    s2s: s2s ? { signer: s2s.signer, mode: s2s.mode } : undefined,
  });
}

/** The secret a matching call needs. A keypair-only service sends no shared secret, so a blank one is not a refusal. */
export function readMatchingCallSecret(
  raw: string | undefined,
  s2s?: OmsMatchingS2s,
): { ok: true; secret: string } | OmsKillParentMatchingRefusal {
  if (s2s?.mode === 'keypair') return { ok: true, secret: raw ?? '' };
  return readInternalServiceSecret(raw);
}

export type OmsKillParentMatchingChild = {
  readonly marketId?: string | null;
  readonly orderId?: string | null;
};

export type OmsKillParentMatchingRefuseReason =
  'matching_unconfigured' | 'matching_service_auth_unconfigured' | 'missing_market' | 'missing_order_id';

export type OmsKillParentMatchingRefusal = {
  readonly ok: false;
  readonly reason: OmsKillParentMatchingRefuseReason;
  readonly detail: string;
};

export type OmsKillParentMatchingOk = {
  readonly ok: true;
  readonly killed: boolean;
  readonly children: readonly OmsDrainChild[];
};

export type OmsKillParentMatchingResult = OmsKillParentMatchingOk | OmsKillParentMatchingRefusal;

function refuse(reason: OmsKillParentMatchingRefuseReason, detail: string): OmsKillParentMatchingRefusal {
  return { ok: false, reason, detail };
}

export function readInternalServiceSecret(raw: string | undefined): { ok: true; secret: string } | OmsKillParentMatchingRefusal {
  const secret = raw ?? '';
  if (secret.length < MIN_SERVICE_SECRET_LENGTH) {
    return refuse(
      'matching_service_auth_unconfigured',
      'INTERNAL_SERVICE_SECRET is blank; svc-execution does not DELETE unsigned matching cancels',
    );
  }
  return { ok: true, secret };
}

function matchingCancelPath(marketId: string, orderId: string): string {
  return `/markets/${encodeURIComponent(marketId)}/orders/${encodeURIComponent(orderId)}`;
}

function childrenKnown(children: readonly OmsDrainChild[]): boolean {
  return children.every((child) => child.outcome === 'stopped' || child.outcome === 'already_stopped');
}

function parseCancelAck(body: unknown): { readonly sequence: number } | null {
  if (!body || typeof body !== 'object') return null;
  const rec = body as Record<string, unknown>;
  if (rec.cancelled !== true) return null;
  const sequence = rec.sequence;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence)) return null;
  return { sequence };
}

async function deleteOne(
  base: string,
  marketId: string,
  orderId: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
  secret: string,
  s2s?: OmsMatchingS2s,
): Promise<OmsDrainChild> {
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
      return { clientOrderId: orderId, venueId: marketId, outcome: 'unknown', reason: 'matching_unknown' };
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      return { clientOrderId: orderId, venueId: marketId, outcome: 'unknown', reason: 'cancel_failed' };
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      return { clientOrderId: orderId, venueId: marketId, outcome: 'unknown', reason: 'matching_unknown' };
    }
    const ack = parseCancelAck(json);
    if (!ack) {
      return { clientOrderId: orderId, venueId: marketId, outcome: 'unknown', reason: 'matching_unknown' };
    }
    return { clientOrderId: orderId, venueId: marketId, outcome: 'stopped', status: 'canceled' };
  } catch {
    return { clientOrderId: orderId, venueId: marketId, outcome: 'unknown', reason: 'cancel_failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DELETE parent children on matching. 404 / no sequence is killed false.
 * Never treats silence as already_stopped.
 */
export async function cancelKillParentMatching(input: {
  children?: readonly OmsKillParentMatchingChild[] | null;
  matchingUrl?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** INTERNAL_SERVICE_SECRET. Blank / short refuses before unsigned DELETE. */
  internalServiceSecret?: string;
  /** svc-execution's own key. Absent leaves the cancel on the shared secret. */
  s2s?: OmsMatchingS2s;
}): Promise<OmsKillParentMatchingResult> {
  const base = readMatchingUrl(input.matchingUrl);
  if (!base) {
    return refuse('matching_unconfigured', 'MATCHING_URL is blank; svc-execution does not invent a matching host or a cancel');
  }
  const raw = input.children;
  if (raw === null || raw === undefined || raw.length === 0) {
    return refuse('missing_order_id', 'kill-parent matching cancel needs children — refusing to invent a canceled book');
  }
  const pending: { marketId: string; orderId: string }[] = [];
  for (const row of raw) {
    const marketId = row.marketId?.trim() ?? '';
    const orderId = row.orderId?.trim() ?? '';
    // encodeURIComponent leaves "." and ".." unchanged; the URL parser then resolves them as dot segments.
    if (!marketId || marketId === '.' || marketId === '..') {
      return refuse('missing_market', 'kill-parent child marketId is blank — refuse rather than invent a book');
    }
    if (!orderId || !UUID.test(orderId)) {
      return refuse('missing_order_id', 'kill-parent child orderId must be a UUID — refusing to invent a cancel');
    }
    pending.push({ marketId, orderId });
  }
  const secret = readMatchingCallSecret(input.internalServiceSecret ?? process.env[SERVICE_SECRET_ENV], input.s2s);
  if (!secret.ok) return secret;
  const fetchFn = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const children: OmsDrainChild[] = [];
  for (const row of pending) {
    children.push(await deleteOne(base, row.marketId, row.orderId, fetchFn, timeoutMs, secret.secret, input.s2s));
  }
  return {
    ok: true,
    killed: childrenKnown(children),
    children,
  };
}
