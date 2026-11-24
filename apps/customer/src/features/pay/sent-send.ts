import type { ApiClient, ApiResult } from '../../shared/api';
import { BANK_TRANSFERS_SENT } from '@intafaced/contracts/bank-transfers-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

/** The bank's code for a send id that is not this person's own send (or does not exist). */
export const SENT_NOT_FOUND = 'bank.personal_transfer_not_found';

export type SentSend = ProcedureOutput<typeof BANK_TRANSFERS_SENT>;

/** The signed-in sender's own send to another person: Confirming while the bank does not yet know it was made, then Completed. */
export const fetchSentSend = (api: ApiClient, transferId: string, signal?: AbortSignal): Promise<ApiResult<SentSend>> =>
  api.call(BANK_TRANSFERS_SENT, { transferId }, { signal });
