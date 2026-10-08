import { z } from 'zod';

// Only original record references live here. Credentials, reviewed amounts,
// balances and the request body are never recovery metadata.
const referenceNames = new Set([
  'transferId', 'scheduleId', 'fromSpaceId', 'toSpaceId', 'toUserId',
  'loanId', 'eventId', 'ruleId', 'positionId', 'poolId', 'cardId',
  'approvalId', 'accountId', 'payrollId', 'id',
]);
const pendingSchema = z.object({
  reference: z.string().uuid(), title: z.string(), procedure: z.string(),
  recordRefs: z.record(z.string()).refine((refs) => Object.keys(refs).every((key) => referenceNames.has(key))),
}).strict();
export type PendingOutcome = z.infer<typeof pendingSchema>;
export const pendingKey = (userId: string) => 'intafaced.customer.bank-unconfirmed.v1:' + userId;
const unreadable: PendingOutcome = {
  reference: 'unreadable', title: 'Bank recovery metadata is unavailable or unreadable',
  procedure: 'Recovery required', recordRefs: {},
};

function stored(userId: string): PendingOutcome[] {
  const key = pendingKey(userId);
  const durable = localStorage.getItem(key);
  if (durable !== null) return z.array(pendingSchema).parse(JSON.parse(durable));
  // Migrate the former tab-only journal only after verifying durable storage.
  const legacy = sessionStorage.getItem(key);
  if (!legacy) return [];
  const rows = z.array(pendingSchema).parse(JSON.parse(legacy));
  const serialized = JSON.stringify(rows);
  localStorage.setItem(key, serialized);
  if (localStorage.getItem(key) !== serialized) throw new Error('Recovery storage did not retain the original references');
  sessionStorage.removeItem(key);
  return rows;
}
export function pendingOutcomes(userId: string | null): PendingOutcome[] {
  if (!userId) return [];
  try { return stored(userId); } catch { return [unreadable]; }
}
export function originalRecordRefs(input: Record<string, unknown>): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (referenceNames.has(key) && typeof value === 'string') refs[key] = value;
  return refs;
}
export function rememberPendingOutcome(userId: string, outcome: PendingOutcome) {
  const rows = stored(userId);
  if (rows.length) throw new Error('An original Bank request is unresolved');
  const serialized = JSON.stringify([pendingSchema.parse(outcome)]);
  const key = pendingKey(userId);
  localStorage.setItem(key, serialized);
  if (localStorage.getItem(key) !== serialized) throw new Error('Recovery storage did not retain the original reference');
}
// Only a definitive response to this original request may clear its guard.
// Changed balances, bounded history, and unrelated records cannot certify it.
export function clearPendingOutcome(userId: string, reference: string) {
  const next = stored(userId).filter((row) => row.reference !== reference);
  const serialized = JSON.stringify(next);
  localStorage.setItem(pendingKey(userId), serialized);
  if (localStorage.getItem(pendingKey(userId)) !== serialized) throw new Error('Recovery storage could not be cleared');
}
