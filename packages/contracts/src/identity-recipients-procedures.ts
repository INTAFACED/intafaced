import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * svc-identity's saved pay recipients, one record per call. Names on the wire are handles; `label` is the owner's
 * private nickname for that handle. The service mounts each from here (`saved-recipients.router.ts`).
 */

export const savedRecipientSchema = z.object({
  handle: z.string(),
  label: z.string(),
  addedAt: z.string().datetime(),
});

/** svc-identity sends `identity.recipient_conflict` as CONFLICT and every other recipient refusal as BAD_REQUEST. */
const refusals = (bad: readonly string[], conflict = false): Refusals =>
  Object.freeze({
    ...Object.fromEntries(bad.map((c) => [c, 'BAD_REQUEST' as const])),
    ...(conflict ? { 'identity.recipient_conflict': 'CONFLICT' as const } : {}),
  });

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;
const handle = z.string().min(1).max(64);
const idempotencyKey = z.string().min(8).max(64);

export const IDENTITY_RECIPIENTS_LIST = defineProcedure({
  ...base,
  name: 'identity.recipients.list',
  kind: 'query',
  path: 'recipients.list',
  access: { caller: 'scope', scope: 'identity:read', module: 'identity' },
  refusals: refusals(['identity.saved_recipient_list_limit_unset']),
  input: z.object({ limit: z.number().int().min(1).max(100).optional() }),
  output: z.array(savedRecipientSchema),
  samples: [
    { verdict: 'accept', input: { limit: 100 } },
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { limit: 0 } },
    { verdict: 'refuse', input: { limit: 101 } },
  ],
});

export const IDENTITY_RECIPIENTS_ADD = defineProcedure({
  ...base,
  name: 'identity.recipients.add',
  kind: 'mutation',
  path: 'recipients.add',
  access: { caller: 'scope', scope: 'identity:write', module: 'identity' },
  refusals: refusals(['identity.recipient_unknown', 'identity.recipient_self', 'identity.recipient_label_invalid'], true),
  input: z.object({ handle, label: z.string().min(1).max(40), idempotencyKey }),
  output: savedRecipientSchema,
  samples: [
    { verdict: 'accept', input: { handle: 'alice', label: 'Alice', idempotencyKey: 'recipient-add-1' } },
    { verdict: 'refuse', input: { handle: 'alice', label: 'Alice', idempotencyKey: 'short' } },
    { verdict: 'refuse', input: { handle: '', label: 'Alice', idempotencyKey: 'recipient-add-1' } },
  ],
});

export const IDENTITY_RECIPIENTS_REMOVE = defineProcedure({
  ...base,
  name: 'identity.recipients.remove',
  kind: 'mutation',
  path: 'recipients.remove',
  access: { caller: 'scope', scope: 'identity:write', module: 'identity' },
  refusals: refusals(['identity.recipient_unknown'], true),
  input: z.object({ handle, idempotencyKey }),
  output: z.object({ removed: z.boolean(), handle: z.string() }),
  samples: [
    { verdict: 'accept', input: { handle: 'alice', idempotencyKey: 'recipient-remove-1' } },
    { verdict: 'refuse', input: { handle: 'alice' } },
  ],
});

export const IDENTITY_RECIPIENTS_PROCEDURES = [IDENTITY_RECIPIENTS_LIST, IDENTITY_RECIPIENTS_ADD, IDENTITY_RECIPIENTS_REMOVE] as const;
