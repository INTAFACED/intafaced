import {
  BANK_GLOBAL_CANCEL,
  BANK_GLOBAL_CORRIDORS_LIST,
  BANK_GLOBAL_HOLD_GET,
  BANK_GLOBAL_HOLD_UPLOAD_PROOF,
  BANK_GLOBAL_LIST,
  BANK_GLOBAL_PARTNER,
  BANK_GLOBAL_QUOTE,
  BANK_GLOBAL_RECALL,
  BANK_GLOBAL_RECEIPT,
  BANK_GLOBAL_RECIPIENTS_ADD,
  BANK_GLOBAL_RECIPIENTS_LIST,
  BANK_GLOBAL_RECIPIENTS_REMOVE,
  BANK_GLOBAL_RECIPIENTS_VALIDATE,
  BANK_GLOBAL_SEND,
} from '@intafaced/contracts/bank-global-procedures';
import type { ApiClient } from './deps';
import { sendInput, sendStepUpRequest, type SendDraft } from './global-model';

/** The customer's side of `global.*` on svc-bank, each call by its record. Every call is the service's own answer; nothing is filled in. */
export function createGlobalApi(api: ApiClient) {
  return {
    /** Whether a TEST stand-in answers global sends here: its label, or null when it does not. */
    partner: (signal?: AbortSignal) => api.call(BANK_GLOBAL_PARTNER, undefined, { signal }),
    corridors: (signal?: AbortSignal) => api.call(BANK_GLOBAL_CORRIDORS_LIST, undefined, { signal }),
    recipients: (signal?: AbortSignal) => api.call(BANK_GLOBAL_RECIPIENTS_LIST, { limit: 100 }, { signal }),
    validate: (input: { account: string; bic?: string }, signal?: AbortSignal) =>
      api.call(BANK_GLOBAL_RECIPIENTS_VALIDATE, input, { signal }),
    addRecipient: (
      input: { idempotencyKey: string; name: string; account: string; country: string; bic?: string; label?: string },
      signal?: AbortSignal,
    ) => api.call(BANK_GLOBAL_RECIPIENTS_ADD, input, { signal }),
    removeRecipient: (input: { recipientId: string; idempotencyKey: string }, signal?: AbortSignal) =>
      api.call(BANK_GLOBAL_RECIPIENTS_REMOVE, input, { signal }),
    /** Takes a quote and locks its rate until its valid-until; a send names the lock it was confirmed on. */
    quote: (input: { asset: string; amount: string; toCurrency: string }, signal?: AbortSignal) =>
      api.call(BANK_GLOBAL_QUOTE, input, { signal }),
    sends: (signal?: AbortSignal) => api.call(BANK_GLOBAL_LIST, { limit: 20 }, { signal }),
    send: (draft: SendDraft, stepUpApprovalId: string, signal?: AbortSignal) =>
      api.call(BANK_GLOBAL_SEND, sendInput(draft, stepUpApprovalId), { signal }),
    hold: (id: string, signal?: AbortSignal) => api.call(BANK_GLOBAL_HOLD_GET, { id }, { signal }),
    uploadProof: (input: { id: string; name: string; type: string; contentBase64: string }, signal?: AbortSignal) =>
      api.call(BANK_GLOBAL_HOLD_UPLOAD_PROOF, input, { signal }),
    /** Cancel a send while it is on hold; nothing was taken, so nothing moves. */
    cancel: (id: string, signal?: AbortSignal) => api.call(BANK_GLOBAL_CANCEL, { id }, { signal }),
    /** Ask for a send that left to come back (wrong person or wrong details); nothing moves, so no confirmation code. */
    recall: (input: { id: string; reason: string }, signal?: AbortSignal) => api.call(BANK_GLOBAL_RECALL, input, { signal }),
    receipt: (id: string, signal?: AbortSignal) => api.call(BANK_GLOBAL_RECEIPT, { id }, { signal }),
    stepUpRequest: sendStepUpRequest,
  };
}
export type GlobalApi = ReturnType<typeof createGlobalApi>;
