import { z } from 'zod';
import type { ApiClient } from './deps';
import {
  corridorSchema,
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

/** The customer's side of `global.*` on svc-bank. Every call is the service's own answer; nothing is filled in. */
export function createGlobalApi(api: ApiClient) {
  return {
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
    stepUpRequest: sendStepUpRequest,
  };
}
export type GlobalApi = ReturnType<typeof createGlobalApi>;
