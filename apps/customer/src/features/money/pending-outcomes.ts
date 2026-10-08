import { z } from 'zod';

// These are unresolved request references, never balances or credentials. No
// client-side read of a changed amount can certify whether the original write ran.
const pendingSchema = z.object({
  reference: z.string().uuid(),
  title: z.string(),
  procedure: z.string(),
  recordRefs: z.record(z.string()),
});
export type PendingOutcome = z.infer<typeof pendingSchema>;
const memory = new Map<string, PendingOutcome[]>();
const prefix = 'intafaced.customer.bank-unconfirmed.v1:';
export function pendingOutcomes(userId: string | null): PendingOutcome[] {
  if (!userId) return [];
  if (memory.has(userId)) return memory.get(userId)!;
  try {
    const saved = sessionStorage.getItem(prefix + userId);
    const parsed = z.array(pendingSchema).safeParse(saved ? JSON.parse(saved) : []);
    if (parsed.success) {
      memory.set(userId, parsed.data);
      return parsed.data;
    }
  } catch {
    /* This visit still retains references when device storage is unavailable. */
  }
  return [];
}
export function rememberPendingOutcome(userId: string, outcome: PendingOutcome) {
  const rows = pendingOutcomes(userId);
  const next = rows.some((row) => row.reference === outcome.reference) ? rows : [...rows, outcome];
  memory.set(userId, next);
  try {
    sessionStorage.setItem(prefix + userId, JSON.stringify(next));
  } catch {
    /* In-memory protection remains active. */
  }
}
