// hand-declared-ok: svc-bank's `transfers.held` answer is declared in its router (services/svc-bank/src/router/shared.ts)
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';

/** The bank's code for a send its owner's review holds: nothing moved, and `transfers.held` reads it (PP-send-request-10). */
export const SEND_IN_REVIEW = 'bank.personal_send_in_review';

export const heldSendSchema = z.object({
  transferId: z.string(),
  status: z.enum(['in_review', 'released', 'rejected']),
  reasonClass: z.string(),
  amount: z.string(),
  assetId: z.string(),
  note: z.string().nullable(),
  reference: z.string().nullable(),
  requestId: z.string().nullable(),
  toHandle: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type HeldSend = z.infer<typeof heldSendSchema>;

/** The signed-in sender's own held send. Anyone else, and an unknown id, read `bank.held_send_not_found`. */
export const fetchHeldSend = (api: ApiClient, transferId: string, signal?: AbortSignal): Promise<ApiResult<HeldSend>> =>
  api.query('bank', 'transfers.held', { transferId }, heldSendSchema, { signal });

/** The transfer id a held-send refusal names ("Payment <id> is in review…"), or null. */
export function heldTransferId(message: string | undefined): string | null {
  return /Payment (\S{8,64}) is in review/.exec(message ?? '')?.[1] ?? null;
}

/** Where a held send's status is read. */
export const heldSendHref = (transferId: string): string => `/pay/history/${encodeURIComponent(transferId)}`;
