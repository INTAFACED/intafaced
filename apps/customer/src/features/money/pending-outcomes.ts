import { t as copyText } from './copy';
import { z } from 'zod';
import { createMinimalOriginalJournal, type JournalPorts, type JournalProblem } from '../../shared/minimal-original-journal';

// Only original record references live here. Credentials, reviewed amounts,
// balances and the request body are never recovery metadata.
const referenceNames = new Set([
  'transferId',
  'scheduleId',
  'fromSpaceId',
  'toSpaceId',
  'toUserId',
  'loanId',
  'eventId',
  'ruleId',
  'positionId',
  'poolId',
  'cardId',
  'approvalId',
  'accountId',
  'payrollId',
  'id',
]);
const pendingSchema = z
  .object({
    reference: z.string().guid(),
    title: z.string(),
    procedure: z.string(),
    recordRefs: z.record(z.string(), z.string()).refine((refs) => Object.keys(refs).every((key) => referenceNames.has(key))),
  })
  .strict();
export type PendingOutcome = z.infer<typeof pendingSchema>;
export const pendingKey = (userId: string) => 'intafaced.customer.bank-unconfirmed.v1:' + userId;
const unreadable = (): PendingOutcome => ({
  reference: 'unreadable',
  title: copyText('pending-outcomes.bank.recovery.metadata.is.unavailable.or.unreadable'),
  procedure: 'recovery.required',
  recordRefs: {},
});

const browserPorts: JournalPorts = {
  durable: () => localStorage,
  legacy: () => sessionStorage,
  locks: () => navigator.locks,
};
export type PendingReservation = Readonly<{ owner: string; reference: string; raw: string }>;
type RecoveryProblem = JournalProblem | 'unresolved' | 'stale' | 'owner';
class BankRecoveryError extends Error {
  constructor(readonly reason: RecoveryProblem) {
    super('Bank original recovery refused: ' + reason);
  }
}
function requireRecovery(result: { ok: true } | { ok: false; reason: RecoveryProblem }) {
  if (!result.ok) throw new BankRecoveryError(result.reason);
}

/** Bank supplies its metadata codec and definitive-response proof. The shared
 * journal supplies verified storage and cooperative cross-tab serialization. */
export function createBankOriginalRecovery(userId: string, ports: JournalPorts = browserPorts) {
  const journal = createMinimalOriginalJournal(pendingKey(userId), (raw) => z.array(pendingSchema).parse(JSON.parse(raw)), ports);
  return {
    read(): PendingOutcome[] {
      const stored = journal.read();
      if (stored.status === 'empty') return [];
      if (stored.status === 'present') return stored.value;
      // A conflict cannot admit a write. Still show both safely decoded originals.
      const originals = new Map<string, PendingOutcome>();
      for (const original of stored.originals ?? []) for (const row of original.value) originals.set(JSON.stringify(row), row);
      return [unreadable(), ...originals.values()];
    },
    async restore() {
      const stored = journal.read();
      if (stored.status === 'unreadable') throw new BankRecoveryError(stored.reason);
      if (stored.status === 'empty' || stored.origin === 'durable') return;
      const restored = await journal.coordinate(async (lease) => lease.migrateLegacy());
      requireRecovery(restored);
      if (restored.ok) requireRecovery(restored.value);
    },
    async reserve(outcome: PendingOutcome, current: () => boolean): Promise<PendingReservation> {
      const parsed = pendingSchema.parse(outcome);
      const raw = JSON.stringify([parsed]);
      const reserved = await journal.coordinate(async (lease) => {
        if (!current()) return { ok: false as const, reason: 'stale' as const };
        const migrated = lease.migrateLegacy();
        if (!migrated.ok) return migrated;
        const stored = lease.read();
        if (stored.status === 'unreadable') return { ok: false as const, reason: stored.reason };
        if (stored.status === 'present' && stored.value.length) return { ok: false as const, reason: 'unresolved' as const };
        return lease.writeExact(stored.status === 'empty' ? null : stored.raw, raw);
      });
      requireRecovery(reserved);
      if (reserved.ok) requireRecovery(reserved.value);
      return Object.freeze({ owner: userId, reference: parsed.reference, raw });
    },
    async finish(original: PendingReservation, current: () => boolean) {
      if (original.owner !== userId) throw new BankRecoveryError('owner');
      const rows = z.array(pendingSchema).parse(JSON.parse(original.raw));
      if (rows.length !== 1 || rows[0]!.reference !== original.reference) throw new BankRecoveryError('mismatch');
      const finished = await journal.coordinate(async (lease) => {
        if (!current()) return { ok: false as const, reason: 'stale' as const };
        return lease.finishExact(original.raw, '[]');
      });
      requireRecovery(finished);
      if (finished.ok) requireRecovery(finished.value);
    },
  };
}
export function pendingOutcomes(userId: string | null): PendingOutcome[] {
  if (!userId) return [];
  return createBankOriginalRecovery(userId).read();
}
export const restorePendingOutcomes = (userId: string) => createBankOriginalRecovery(userId).restore();
export function originalRecordRefs(input: Record<string, unknown>): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (referenceNames.has(key) && typeof value === 'string') refs[key] = value;
  return refs;
}
export const rememberPendingOutcome = (userId: string, outcome: PendingOutcome, current: () => boolean) =>
  createBankOriginalRecovery(userId).reserve(outcome, current);
// Only a definitive response to this original request may clear its guard.
// Changed balances, bounded history, and unrelated records cannot certify it.
export const clearPendingOutcome = (original: PendingReservation, current: () => boolean) =>
  createBankOriginalRecovery(original.owner).finish(original, current);
