/**
 * House-fill hitch to svc-fix `POST /internal/drop-copy/fills`.
 *
 * Evidence only — never money. Blank ingest URL is valid (ingest dark).
 * Source must be proveable: rest from a user API key, rfq from convert settle.
 * Session-only places are omitted (cannot distinguish Vue/UI from WS).
 * Never ui, never fix (FIX already publishes acks), never guessed ws/algo/broker.
 */

import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { HOUSE_MM_API_KEY_ID } from './auth-attribution.js';

export const DROP_COPY_INGEST_PATH = '/internal/drop-copy/fills';

export const DROP_COPY_SOURCE_REST = 'rest' as const;
export const DROP_COPY_SOURCE_RFQ = 'rfq' as const;
export const DROP_COPY_SOURCE_LIQUIDATION = 'liquidation' as const;

const HITCHABLE_SOURCES = new Set<string>([DROP_COPY_SOURCE_REST, DROP_COPY_SOURCE_RFQ, DROP_COPY_SOURCE_LIQUIDATION]);

const FORBIDDEN_SOURCES = new Set(['ui', 'ws', 'fix', 'algo', 'broker']);

/** Same decimal-string law as svc-fix DropCopyFill.parse. */
const DECIMAL = /^\d+(\.\d{1,18})?$/;

export type DropCopyHitchSource = typeof DROP_COPY_SOURCE_REST | typeof DROP_COPY_SOURCE_RFQ | typeof DROP_COPY_SOURCE_LIQUIDATION;

export type DropCopyFillWire = {
  readonly fillId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly marketId: string;
  readonly side: string;
  readonly price: string;
  readonly qty: string;
  readonly quoteAmount: string;
  readonly feeAsset: string;
  readonly feeAmount: string;
  readonly sequence?: number;
  readonly ts: string;
  readonly source: DropCopyHitchSource;
};

export interface DropCopyIngestPort {
  postFill(fill: DropCopyFillWire): Promise<void>;
}

export class NoopDropCopyIngest implements DropCopyIngestPort {
  async postFill(): Promise<void> {
    /* ingest dark / tests without a wire */
  }
}

/**
 * Book fill source from order attribution.
 * API-key place → rest. House MM machine key is not rest. Session-only → omit.
 */
export function dropCopySourceForBookOrder(order: { readonly apiKeyId?: string | null }): DropCopyHitchSource | null {
  const apiKeyId = readNonEmpty(order.apiKeyId);
  if (apiKeyId === null) return null;
  if (apiKeyId === HOUSE_MM_API_KEY_ID) return null;
  return DROP_COPY_SOURCE_REST;
}

function readNonEmpty(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function moneyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return DECIMAL.test(value) ? value : null;
}

/** Raw JSON bytes for HMAC body-bind. Null → do not POST (wrong source or IEEE money). */
export function encodeDropCopyFillJson(fill: DropCopyFillWire): string | null {
  if (FORBIDDEN_SOURCES.has(fill.source) || !HITCHABLE_SOURCES.has(fill.source)) return null;
  const price = moneyString(fill.price);
  const qty = moneyString(fill.qty);
  const quoteAmount = moneyString(fill.quoteAmount);
  const feeAmount = moneyString(fill.feeAmount);
  if (price === null || qty === null || quoteAmount === null || feeAmount === null) return null;
  if (typeof fill.feeAsset !== 'string' || fill.feeAsset.length < 1) return null;
  const body: Record<string, string | number> = {
    fillId: fill.fillId,
    orderId: fill.orderId,
    userId: fill.userId,
    marketId: fill.marketId,
    side: fill.side,
    price,
    qty,
    quoteAmount,
    feeAsset: fill.feeAsset,
    feeAmount,
    ts: fill.ts,
    source: fill.source,
  };
  if (fill.sequence !== undefined) {
    if (!Number.isInteger(fill.sequence)) return null;
    body.sequence = fill.sequence;
  }
  return JSON.stringify(body);
}

/** Awaited after ledger settle; never throws. */
export async function fireDropCopyFill(port: DropCopyIngestPort, fill: DropCopyFillWire): Promise<void> {
  try {
    await port.postFill(fill);
  } catch (err) {
    console.warn(
      `svc-trade: drop-copy ingest failed fillId=${fill.fillId} — fill already settled`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

const FETCH_MS = 2_000;

export function createDropCopyIngestClient(
  ingestUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): DropCopyIngestPort {
  const base = ingestUrl.trim().replace(/\/$/, '');
  if (base.length === 0) return new NoopDropCopyIngest();
  const url = `${base}${DROP_COPY_INGEST_PATH}`;
  const authHeaders = serviceCallSigner({ service: 'svc-trade', audience: 'svc-fix', legacySecret: internalSecret, s2s });

  return {
    async postFill(fill) {
      const body = encodeDropCopyFillJson(fill);
      if (body === null) return;
      const headers = {
        'content-type': 'application/json',
        ...authHeaders(body, { method: 'POST', url: new URL(url), contentType: 'application/json' }),
      };
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(FETCH_MS),
      });
      if (response.ok) return;
      throw new Error(`drop-copy ingest refused (${response.status})`);
    },
  };
}
