import type { Sql } from 'postgres';
import type { TestAgeSubject } from '@intafaced/service-kit';

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

/**
 * A reward still waiting on a time, made `ms` earlier: a hold before it is paid (`held`, or `owed` with a hold), or a lock
 * or bonus before it settles (`locked`). Every one of its own times moves back together (made, changed, last tried,
 * posted, owed, locked, the hold's end and the lock's end), so the order between them stays as it was (a settle posts only
 * a reward last tried before it was locked), the hold or lock has ended as if the time had gone by, and the next pass
 * decides it as it would then. A reward in any other state is decided and is not aged.
 */
export function ageReward(sql: Sql): TestAgeSubject {
  return async (id, ms) => {
    const back = ms / 1000;
    const rows = await sql<{ state: string; hold_until: Date | null; locked_at: Date | null; lock_until: Date | null }[]>`
      UPDATE campaigns.reward_intents
      SET created_at = created_at - make_interval(secs => ${back}),
          updated_at = updated_at - make_interval(secs => ${back}),
          last_attempt_at = last_attempt_at - make_interval(secs => ${back}),
          posted_at = posted_at - make_interval(secs => ${back}),
          owed_at = owed_at - make_interval(secs => ${back}),
          hold_until = hold_until - make_interval(secs => ${back}),
          locked_at = locked_at - make_interval(secs => ${back}),
          lock_until = lock_until - make_interval(secs => ${back})
      WHERE reward_key = ${id} AND state IN ('held', 'owed', 'locked')
      RETURNING state, hold_until, locked_at, lock_until
    `;
    const row = rows[0];
    if (!row) return null;
    return { state: row.state, holdUntil: iso(row.hold_until), lockedAt: iso(row.locked_at), lockUntil: iso(row.lock_until) };
  };
}
