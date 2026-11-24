// hand-declared-ok: svc-bank's `transfers.held` answer is declared in its router (services/svc-bank/src/router/shared.ts)
import type { ApiClient, ApiResult } from '../../shared/api';
import { BANK_TRANSFERS_HELD } from '@intafaced/contracts/bank-transfers-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

/** The bank's code for a send its owner's review holds: nothing moved, and `transfers.held` reads it (PP-send-request-10). */
export const SEND_IN_REVIEW = 'bank.personal_send_in_review';

export type HeldSend = ProcedureOutput<typeof BANK_TRANSFERS_HELD>;

/** The signed-in sender's own held send. Anyone else, and an unknown id, read `bank.held_send_not_found`. */
export const fetchHeldSend = (api: ApiClient, transferId: string, signal?: AbortSignal): Promise<ApiResult<HeldSend>> =>
  api.call(BANK_TRANSFERS_HELD, { transferId }, { signal });

/** Where a held send's status is read. */
export const heldSendHref = (transferId: string): string => `/pay/history/${encodeURIComponent(transferId)}`;
