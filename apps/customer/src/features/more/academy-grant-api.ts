import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { createMinimalOriginalJournal, type JournalPorts } from '../../shared/minimal-original-journal';

export type AcademyPending = { id: string; title: string; reference?: string; kind?: string };
export type GrantRecord = { userId: string; certId: string; grantedAt: string; idempotencyKey: string };
export type AcademyKnown = Readonly<{ raw: string; result: ApiResult<unknown>; grant: Readonly<GrantRecord> | null }>;
export type AcademySnapshot =
  | { status: 'empty'; known: AcademyKnown | null }
  | { status: 'unreadable'; problem: string; known: AcademyKnown | null }
  | { status: 'grant' | 'other'; raw: string; marker: AcademyPending; certId: string | null; known: AcademyKnown | null };
export type GrantOperation = { certId: string; dispatched: () => boolean };
export const academyPendingKey = (owner: string) => `intafaced:more:pending:${owner}:academy`;
const pendingSchema = z
  .object({ id: z.string().min(1), title: z.string(), reference: z.string().optional(), kind: z.string().optional() })
  .strict();
const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));
export const grantRecord = z.object({
  userId: z.string().guid(),
  certId: z.string().min(1).max(64),
  grantedAt: timestamp,
  idempotencyKey: z.string().min(1),
});
export function grantCertificate(marker: AcademyPending, owner: string): string | null {
  if (marker.kind !== undefined && marker.kind !== 'grant') return null;
  const prefix = `cert:${owner}:`;
  if (!marker.reference?.startsWith(prefix)) return null;
  const certId = marker.reference.slice(prefix.length);
  return certId.length > 0 && certId.length <= 64 && !/[\r\n]/.test(certId) ? certId : null;
}
export function recordsFor(owner: string, limit: number) {
  return z
    .array(grantRecord)
    .max(limit)
    .refine(
      (rows) =>
        rows.every((row) => row.userId === owner && row.idempotencyKey === `cert:${owner}:${row.certId}`) &&
        new Set(rows.map((row) => row.certId)).size === rows.length &&
        new Set(rows.map((row) => row.idempotencyKey)).size === rows.length,
    );
}
function refuse(code: string): Extract<ApiResult<never>, { ok: false }> {
  return { ok: false, reason: 'aborted', code: `academy.original_${code}`, message: 'The original Academy request remains unresolved.' };
}
/** The original journal delegates to the existing Academy lock, including older
 * common.useAction callers. No global lock patch, alternate lease or second key.
 */
export function academyJournalPorts(owner: string): JournalPorts {
  const key = academyPendingKey(owner);
  return {
    durable: () => globalThis.localStorage,
    locks: () => {
      const locks = globalThis.navigator?.locks;
      if (!locks) return undefined;
      return {
        request: ((name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => {
          if (name !== `intafaced.original:${key}`) throw new Error('Unexpected Academy journal lock');
          return locks.request(`more-action:${key}`, options, callback);
        }) as LockManager['request'],
      };
    },
  };
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
/** Public original metadata is durable; staged bodies and canonical proofs stay
 * in RAM. Grant GET recovery proves a business record, never XP/Identity delivery.
 */
export function createAcademyGrantApi(api: ApiClient, owner: string, ports = academyJournalPorts(owner)) {
  const journal = createMinimalOriginalJournal(academyPendingKey(owner), (raw) => pendingSchema.parse(JSON.parse(raw)), ports);
  let retained: { known: AcademyKnown; current: () => boolean } | null = null;
  const current = (guard: () => boolean) => api.canWrite() && guard();
  function inspect(guard: () => boolean): AcademySnapshot {
    if (!current(guard)) return { status: 'unreadable', problem: 'inactive', known: null };
    const saved = journal.read();
    const known = retained?.current() && (saved.status !== 'present' || saved.raw === retained.known.raw) ? retained.known : null;
    if (saved.status === 'empty') return { status: 'empty', known };
    if (saved.status === 'unreadable') return { status: 'unreadable', problem: saved.reason, known };
    const certId = grantCertificate(saved.value, owner);
    return { status: certId ? 'grant' : 'other', raw: saved.raw, marker: saved.value, certId, known };
  }
  async function readRecords(limit: number, guard: () => boolean, signal?: AbortSignal): Promise<ApiResult<GrantRecord[]>> {
    if (!current(guard)) return refuse('changed');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return refuse('limit');
    const result = await api.query('academy', 'myCerts', { limit }, recordsFor(owner, limit), { signal });
    return current(guard) ? result : refuse('changed');
  }
  async function execute(
    marker: AcademyPending,
    run: (canDispatch: () => boolean) => Promise<ApiResult<unknown>>,
    reviewCurrent: () => boolean,
    ownerCurrent: () => boolean,
    grant?: GrantOperation,
  ): Promise<ApiResult<unknown>> {
    if (!current(reviewCurrent)) return refuse('changed');
    const coordinated = await journal.coordinate(async (lease) => {
      if (!current(reviewCurrent) || inspect(ownerCurrent).known) return refuse('changed');
      const saved = lease.read();
      if (saved.status !== 'empty') return refuse(saved.status === 'unreadable' ? saved.reason : 'pending');
      const raw = JSON.stringify(marker);
      const admitted = lease.writeExact(null, raw);
      if (!admitted.ok) return refuse(admitted.reason);
      const originalCurrent = () => {
        if (!current(reviewCurrent)) return false;
        const present = lease.read();
        return present.status === 'present' && present.raw === raw;
      };
      let result: ApiResult<unknown>;
      try {
        result = await run(originalCurrent);
      } catch {
        result = { ok: false, reason: 'uncertain', code: 'academy.original_connection', message: 'The original outcome is unknown.' };
      }
      if (!current(ownerCurrent)) return refuse('changed');
      const present = lease.read();
      if (present.status !== 'present' || present.raw !== raw) return refuse('changed');
      if ((!current(reviewCurrent) && result.ok) || (grant?.dispatched() && !current(reviewCurrent))) return refuse('changed');
      const record = result.ok ? grantRecord.safeParse((result.data as { grant?: unknown } | null)?.grant) : null;
      const grantProof =
        grant &&
        record?.success &&
        record.data.userId === owner &&
        record.data.certId === grant.certId &&
        record.data.idempotencyKey === marker.reference
          ? record.data
          : null;
      const terminal = grant ? Boolean(grantProof) || !grant.dispatched() : result.ok || result.reason !== 'uncertain';
      if (!terminal) return result;
      const proof: AcademyKnown = immutable({ raw, result, grant: grantProof });
      retained = { known: proof, current: () => current(ownerCurrent) };
      const cleared = lease.finishExact(raw);
      if (cleared.ok && retained?.known === proof) retained = null;
      return result;
    });
    return coordinated.ok ? coordinated.value : refuse(coordinated.reason);
  }
  async function checkOriginal(raw: string, guard: () => boolean, ownerCurrent: () => boolean): Promise<ApiResult<GrantRecord | null>> {
    if (!current(guard)) return refuse('changed');
    const coordinated = await journal.coordinate(async (lease) => {
      const saved = lease.read();
      if (!current(guard) || saved.status !== 'present' || saved.raw !== raw) return refuse('changed');
      const certId = grantCertificate(saved.value, owner);
      if (!certId) return refuse('not_grant');
      const originalCurrent = () => {
        if (!current(guard)) return false;
        const present = lease.read();
        return present.status === 'present' && present.raw === raw;
      };
      const records = await readRecords(200, originalCurrent);
      if (!records.ok) return records;
      const matches = records.data.filter((row) => row.certId === certId && row.idempotencyKey === saved.value.reference);
      if (matches.length !== 1) return { ok: true as const, data: null };
      if (!originalCurrent() || !current(ownerCurrent)) return refuse('changed');
      const record = immutable({ ...matches[0]! });
      const proof: AcademyKnown = immutable({ raw, result: { ok: true as const, data: { grant: record } }, grant: record });
      retained = { known: proof, current: () => current(ownerCurrent) };
      const cleared = lease.finishExact(raw);
      if (cleared.ok && retained?.known === proof) retained = null;
      return { ok: true as const, data: record };
    });
    return coordinated.ok ? coordinated.value : refuse(coordinated.reason);
  }
  async function cleanupKnown(proof: AcademyKnown, guard: () => boolean) {
    if (retained?.known !== proof || !retained.current() || !current(guard)) return false;
    const coordinated = await journal.coordinate(async (lease) => {
      if (retained?.known !== proof || !retained.current() || !current(guard)) return false;
      const saved = lease.read();
      return saved.status === 'empty' || lease.finishExact(proof.raw).ok;
    });
    if (!coordinated.ok || !coordinated.value) return false;
    if (retained?.known === proof) retained = null;
    return true;
  }
  return { inspect, readRecords, execute, checkOriginal, cleanupKnown };
}
export type AcademyGrantApi = ReturnType<typeof createAcademyGrantApi>;
