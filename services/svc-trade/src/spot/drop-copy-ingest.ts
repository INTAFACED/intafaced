/**
 * House-fill hitch to svc-fix `POST /internal/drop-copy/fills`.
 *
 * Evidence only — never money. Blank ingest URL is valid (ingest dark).
 * Source must be proveable: rest from a user API key, rfq from convert settle.
 * Session-only places are omitted (cannot distinguish Vue/UI from WS).
 * Never ui, never fix (FIX already publishes acks), never guessed ws/algo/broker.
 */

import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { FIX_DROP_COPY_FILL } from '@intafaced/contracts/fix-procedures';
import { callHttpRecord } from '@intafaced/contracts/procedure-http';
import type { ProcedureInput } from '@intafaced/contracts/procedure';
import { HOUSE_MM_API_KEY_ID } from './auth-attribution.js';

export const DROP_COPY_SOURCE_REST = 'rest' as const;
export const DROP_COPY_SOURCE_RFQ = 'rfq' as const;
export const DROP_COPY_SOURCE_LIQUIDATION = 'liquidation' as const;

export type DropCopyHitchSource = typeof DROP_COPY_SOURCE_REST | typeof DROP_COPY_SOURCE_RFQ | typeof DROP_COPY_SOURCE_LIQUIDATION;

/** One fill as svc-fix's drop-copy record takes it: decimal-string money, a proveable source. */
export type DropCopyFillWire = ProcedureInput<typeof FIX_DROP_COPY_FILL>;

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
  const sign = serviceCallSigner({ service: 'svc-trade', audience: 'svc-fix', legacySecret: internalSecret, s2s });

  return {
    async postFill(fill) {
      // A fill the record refuses (IEEE money, a source it cannot prove) is never posted.
      if (!FIX_DROP_COPY_FILL.input.safeParse(fill).success) return;
      await callHttpRecord(FIX_DROP_COPY_FILL, {
        baseUrl: base,
        input: fill,
        sign,
        fetcher: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_MS) }),
        errorOf: (_path, status) => new Error(`drop-copy ingest refused (${status})`),
      });
    },
  };
}
