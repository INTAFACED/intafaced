import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { amount, asset, id } from './schemas';

/**
 * svc-bank's requests between two people (`bank.personalRequest.*`, J-pay-05). The signed-in person who asks is the payee;
 * the person asked is the payer. Asking moves no money. The payer pays with `transfers.toUser` and the request's id, which
 * settles exactly that request once (svc-bank `personal-pay.ts` claim); a decline, a cancel or the end of its period closes it.
 */
export const requestStatusSchema = z.enum(['open', 'paid', 'declined', 'cancelled', 'expired']);
export type RequestStatus = z.infer<typeof requestStatusSchema>;

export const personRequestSchema = z.object({
  requestId: id,
  payeeUserId: z.string(),
  payerUserId: z.string(),
  payeeHandle: z.string().nullable(),
  payerHandle: z.string().nullable(),
  assetId: asset,
  amount,
  note: z.string().nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  status: requestStatusSchema,
  ledgerTxId: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  notice: z.object({ delivered: z.boolean(), blocker: z.string().nullable() }),
});
export type PersonRequest = z.infer<typeof personRequestSchema>;

export interface NewPersonRequest {
  payerUserId: string;
  assetId: string;
  amount: string;
  note?: string;
  /** When the request stops being payable. The person asking chooses it; svc-bank refuses one in the past. */
  expiresAt: string;
  /** One key per reviewed request, so sending the same review twice makes one request. */
  idempotencyKey: string;
}

export function createPersonRequestsApi(api: ApiClient) {
  return {
    create: (input: NewPersonRequest): Promise<ApiResult<PersonRequest>> =>
      api.mutate('bank', 'personalRequest.create', input, personRequestSchema),
    get: (requestId: string, signal?: AbortSignal): Promise<ApiResult<PersonRequest>> =>
      api.query('bank', 'personalRequest.get', { requestId }, personRequestSchema, { signal }),
    list: (direction: 'incoming' | 'outgoing', limit: number, signal?: AbortSignal): Promise<ApiResult<PersonRequest[]>> =>
      api.query('bank', 'personalRequest.list', { direction, limit }, z.array(personRequestSchema), { signal }),
    decline: (requestId: string): Promise<ApiResult<PersonRequest>> =>
      api.mutate('bank', 'personalRequest.decline', { requestId }, personRequestSchema),
    remind: (requestId: string, idempotencyKey: string): Promise<ApiResult<PersonRequest>> =>
      api.mutate('bank', 'personalRequest.remind', { requestId, idempotencyKey }, personRequestSchema),
  };
}
export type PersonRequestsApi = ReturnType<typeof createPersonRequestsApi>;
