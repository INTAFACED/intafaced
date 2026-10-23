import { z } from 'zod';
import type { ApiClient } from './deps';
import {
  corridorSchema,
  holdSchema,
  receiptSchema,
  removedSchema,
  quoteSchema,
  recipientSchema,
  sendPageSchema,
  sendSchema,
  validationSchema,
  sendInput,
  sendStepUpRequest,
  type SendDraft,
} from './global-model';

/** Whether a TEST stand-in answers global sends here: its label, or null when it does not. */
const partnerSchema = z.object({ standIn: z.string().nullable() });

/** The customer's side of `global.*` on svc-bank. Every call is the service's own answer; nothing is filled in. */
export function createGlobalApi(api: ApiClient) {
  return {
    partner: (signal?: AbortSignal) => api.query('bank', 'global.partner', undefined, partnerSchema, { signal }),
    corridors: (signal?: AbortSignal) => api.query('bank', 'global.corridors.list', undefined, z.array(corridorSchema), { signal }),
    recipients: (signal?: AbortSignal) => api.query('bank', 'global.recipients.list', { limit: 100 }, z.array(recipientSchema), { signal }),
    validate: (input: { account: string; bic?: string }, signal?: AbortSignal) =>
      api.query('bank', 'global.recipients.validate', input, validationSchema, { signal }),
    addRecipient: (
      input: { idempotencyKey: string; name: string; account: string; country: string; bic?: string; label?: string },
      signal?: AbortSignal,
    ) => api.mutate('bank', 'global.recipients.add', input, recipientSchema, { signal }),
    removeRecipient: (input: { recipientId: string; idempotencyKey: string }, signal?: AbortSignal) =>
      api.mutate('bank', 'global.recipients.remove', input, removedSchema, { signal }),
    quote: (input: { asset: string; amount: string; toCurrency: string }, signal?: AbortSignal) =>
      api.query('bank', 'global.quote', input, quoteSchema, { signal }),
    sends: (signal?: AbortSignal) => api.query('bank', 'global.list', { limit: 20 }, sendPageSchema, { signal }),
    send: (draft: SendDraft, stepUpApprovalId: string, signal?: AbortSignal) =>
      api.mutate('bank', 'global.send', sendInput(draft, stepUpApprovalId), sendSchema, { signal }),
    hold: (id: string, signal?: AbortSignal) => api.query('bank', 'global.hold.get', { id }, holdSchema, { signal }),
    uploadProof: (input: { id: string; name: string; type: string; contentBase64: string }, signal?: AbortSignal) =>
      api.mutate('bank', 'global.hold.uploadProof', input, holdSchema, { signal }),
    /** Cancel a send while it is on hold; nothing was taken, so nothing moves. */
    cancel: (id: string, signal?: AbortSignal) => api.mutate('bank', 'global.cancel', { id }, sendSchema, { signal }),
    /** Ask for a send that left to come back (wrong person or wrong details); nothing moves, so no confirmation code. */
    recall: (input: { id: string; reason: string }, signal?: AbortSignal) =>
      api.mutate('bank', 'global.recall', input, sendSchema, { signal }),
    receipt: (id: string, signal?: AbortSignal) => api.query('bank', 'global.receipt', { id }, receiptSchema, { signal }),
    stepUpRequest: sendStepUpRequest,
  };
}
export type GlobalApi = ReturnType<typeof createGlobalApi>;
