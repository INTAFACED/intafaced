import { createHash } from 'node:crypto';
import {
  CUSTOMER_DETAIL_KEYS,
  customerDetailDecisionInputSchema,
  customerDetailsEditInputSchema,
  customerDetailValueSchemas,
  type CustomerDetailKey,
} from '@intafaced/contracts';

/**
 * The details routes' forms (J-ops-console-04 #9), read on the server: what may be sent to identity, and the business key
 * each request carries, so the same edit or decision asked again is answered with what identity stored.
 */

/** A UUID derived from a business key, so the same edit asked again carries the same request id (never a random one). */
export function keyUuid(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^(?:0|[1-9]\d{0,39})$/;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => key in value)
  );
}

export interface EditForm {
  readonly requestId: string;
  readonly userId: string;
  readonly expectedVersion: string;
  readonly reason: string;
  readonly field: CustomerDetailKey;
  readonly value: string | null;
}

/**
 * The edit form, checked before anything is sent: one detail, its new value (null takes it off the record), a reason and
 * the record as the founder read it: its version and the newest entry in its details history. The request id is the
 * business key of that edit on that reading by that founder. Every attempt identity stores (an applied change, an opened
 * or decided review, a refusal) adds a history entry, so the next reading is a new request and a refused or rejected edit
 * never blocks the next one; asked again on the same reading, identity answers with what it stored.
 */
export function readEditForm(raw: unknown, founderId: string): EditForm | null {
  if (!exactKeys(raw, ['userId', 'field', 'value', 'reason', 'basis'])) return null;
  const { userId, field, value, reason, basis } = raw;
  if (typeof userId !== 'string' || !UUID.test(userId)) return null;
  if (typeof field !== 'string' || !(CUSTOMER_DETAIL_KEYS as readonly string[]).includes(field)) return null;
  if (value !== null && typeof value !== 'string') return null;
  if (!exactKeys(basis, ['version', 'after'])) return null;
  const { version, after } = basis;
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  if (after !== null && (typeof after !== 'string' || !UUID.test(after))) return null;
  const key = field as CustomerDetailKey;
  const parsedValue = value === null ? null : customerDetailValueSchemas[key].safeParse(value);
  if (parsedValue !== null && !parsedValue.success) return null;
  const user = userId.toLowerCase();
  const input = customerDetailsEditInputSchema.safeParse({
    requestId: keyUuid(
      `console:details-edit:${founderId.toLowerCase()}:${user}:v${version}:after:${(after as string | null)?.toLowerCase() ?? 'none'}:${key}`,
    ),
    userId: user,
    expectedVersion: version,
    reason,
    changes: { [key]: parsedValue === null ? null : parsedValue.data },
  });
  if (!input.success) return null;
  return {
    requestId: input.data.requestId,
    userId: user,
    expectedVersion: version,
    reason: input.data.reason,
    field: key,
    value: parsedValue === null ? null : parsedValue.data,
  };
}

export interface DecideForm {
  readonly requestId: string;
  readonly userId: string;
  readonly reviewId: string;
  readonly decision: 'pass' | 'reject';
  readonly note: string;
}

/** A decision on one review; its key is the founder, the review and the decision, so a retry replays the stored answer. */
export function readDecideForm(raw: unknown, founderId: string): DecideForm | null {
  if (!exactKeys(raw, ['userId', 'reviewId', 'decision', 'note'])) return null;
  if (typeof raw.userId !== 'string' || !UUID.test(raw.userId) || typeof raw.reviewId !== 'string') return null;
  const reviewId = raw.reviewId.toLowerCase();
  const userId = raw.userId.toLowerCase();
  const input = customerDetailDecisionInputSchema.safeParse({
    requestId: keyUuid(`console:details-decide:${founderId.toLowerCase()}:${reviewId}:${String(raw.decision)}`),
    userId,
    reviewId,
    decision: raw.decision,
    note: raw.note,
  });
  if (!input.success) return null;
  return {
    requestId: input.data.requestId,
    userId,
    reviewId,
    decision: input.data.decision,
    note: input.data.note,
  };
}
