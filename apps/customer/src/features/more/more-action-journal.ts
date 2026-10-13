import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { createMinimalOriginalJournal, type JournalPorts } from '../../shared/minimal-original-journal';

export type MorePending = { id: string; title: string; reference?: string };
export type MoreKnown = Readonly<{ raw: string; result: ApiResult<unknown>; source: 'run' | 'recovery' }>;
export const morePendingKey = (owner: string, room: string) => `intafaced:more:pending:${owner}:${room}`;
const pending = z.object({ id: z.string().min(1), title: z.string(), reference: z.string().optional() }).strict();

/** Share the existing native lock with older More and Academy writers. */
export function moreJournalPorts(key: string): JournalPorts {
  return {
    durable: () => globalThis.localStorage,
    locks: () => {
      const locks = globalThis.navigator?.locks;
      if (!locks) return undefined;
      return {
        request: ((name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => {
          if (name !== `intafaced.original:${key}`) throw new Error('Unexpected More journal lock');
          return locks.request(`more-action:${key}`, options, callback);
        }) as LockManager['request'],
      };
    },
  };
}
function refusal(problem: string): Extract<ApiResult<never>, { ok: false }> {
  return {
    ok: false,
    reason:
      problem === 'locks-unavailable'
        ? 'not_supported'
        : problem === 'connection'
          ? 'uncertain'
          : problem === 'changed' || problem === 'pending' || problem === 'mismatch'
            ? 'aborted'
            : 'error',
    code: `more.original_${problem}`,
    message: 'The original request remains unresolved.',
  };
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
/** Only public lookup metadata is durable. The caller retains its own proof
 * predicate: this module never infers a business outcome from a reference.
 */
export function createMoreActionJournal(key: string, ports = moreJournalPorts(key)) {
  const journal = createMinimalOriginalJournal(key, (raw) => pending.parse(JSON.parse(raw)), ports);
  let retained: { proof: MoreKnown; current: () => boolean } | null = null;
  function inspect(current: () => boolean) {
    const saved = journal.read();
    if (retained && (!retained.current() || (saved.status === 'present' && saved.raw !== retained.proof.raw))) retained = null;
    return { saved, known: current() ? (retained?.proof ?? null) : null };
  }
  function invalidateKnown() {
    retained = null;
  }
  async function execute(
    marker: MorePending,
    run: (canDispatch: () => boolean) => Promise<ApiResult<unknown>>,
    reviewCurrent: () => boolean,
    ownerCurrent: () => boolean,
  ): Promise<ApiResult<unknown>> {
    if (!reviewCurrent()) return refusal('changed');
    const coordinated = await journal.coordinate(async (lease) => {
      if (!reviewCurrent() || inspect(ownerCurrent).known) return refusal('changed');
      const saved = lease.read();
      if (saved.status !== 'empty') return refusal(saved.status === 'unreadable' ? saved.reason : 'pending');
      const raw = JSON.stringify(marker);
      const admitted = lease.writeExact(null, raw);
      if (!admitted.ok) return refusal(admitted.reason);
      const originalCurrent = () => {
        if (!reviewCurrent()) return false;
        const current = lease.read();
        return current.status === 'present' && current.raw === raw;
      };
      let result: ApiResult<unknown>;
      try {
        result = await run(originalCurrent);
      } catch {
        result = refusal('connection');
      }
      if (!originalCurrent() || !ownerCurrent()) return refusal('changed');
      // Keep each caller's existing terminal/refusal contract. Uncertainty never
      // becomes a universal success or automatic retry.
      if (!result.ok && result.reason === 'uncertain') return result;
      const proof: MoreKnown = immutable({ raw, result, source: 'run' as const });
      retained = { proof, current: ownerCurrent };
      if (lease.finishExact(raw).ok && retained?.proof === proof) retained = null;
      return result;
    });
    return coordinated.ok ? coordinated.value : refusal(coordinated.reason);
  }
  async function recover(
    raw: string,
    readOriginal: (reference: string) => Promise<ApiResult<unknown>>,
    originalCurrent: () => boolean,
    ownerCurrent: () => boolean,
  ): Promise<ApiResult<unknown>> {
    if (!originalCurrent()) return refusal('changed');
    const coordinated = await journal.coordinate(async (lease) => {
      const saved = lease.read();
      if (!originalCurrent() || saved.status !== 'present' || saved.raw !== raw || !saved.value.reference) return refusal('changed');
      const exact = () => {
        if (!originalCurrent()) return false;
        const current = lease.read();
        return current.status === 'present' && current.raw === raw;
      };
      let result: ApiResult<unknown>;
      try {
        result = await readOriginal(saved.value.reference);
      } catch {
        result = { ok: false, reason: 'unreachable', code: 'more.original_lookup', message: 'The original read could not be reached.' };
      }
      if (!exact() || !ownerCurrent()) return refusal('changed');
      if (!result.ok) return result;
      const proof: MoreKnown = immutable({ raw, result, source: 'recovery' as const });
      retained = { proof, current: ownerCurrent };
      if (lease.finishExact(raw).ok && retained?.proof === proof) retained = null;
      return result;
    });
    return coordinated.ok ? coordinated.value : refusal(coordinated.reason);
  }
  async function cleanup(proof: MoreKnown, current: () => boolean) {
    if (retained?.proof !== proof || !retained.current() || !current()) return false;
    const coordinated = await journal.coordinate(async (lease) => {
      if (retained?.proof !== proof || !retained.current() || !current()) return false;
      const saved = lease.read();
      return saved.status === 'empty' || (saved.status === 'present' && saved.raw === proof.raw && lease.finishExact(proof.raw).ok);
    });
    if (!coordinated.ok || !coordinated.value) return false;
    if (retained?.proof === proof) retained = null;
    return true;
  }
  return { inspect, execute, recover, cleanup, invalidateKnown };
}
