import type { Sql } from 'postgres';
import type { TestAgeSubject } from '@intafaced/service-kit';

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

/**
 * An OTC desk quote not yet settled, made `ms` earlier: its creation, expiry and acceptance all move back together, so
 * its quote expiry or settle window has passed as if the time had gone by. A settled quote is history and is not aged.
 */
export function ageOtcQuote(sql: Sql): TestAgeSubject {
  return async (id, ms) => {
    const rows = await sql<{ created_at: Date; expires_at: Date; accepted_at: Date | null }[]>`
      UPDATE otc_desk_quotes
      SET created_at = created_at - make_interval(secs => ${ms / 1000}),
          expires_at = expires_at - make_interval(secs => ${ms / 1000}),
          accepted_at = accepted_at - make_interval(secs => ${ms / 1000})
      WHERE quote_id = ${id} AND lifecycle <> 'settled'
      RETURNING created_at, expires_at, accepted_at
    `;
    const row = rows[0];
    if (!row) return null;
    return { createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), acceptedAt: iso(row.accepted_at) };
  };
}

/** The door's route is service-kit's, one for every service; svc-trade names only what it ages. */
export { TEST_AGE_PATH, registerTestAgeDoor } from '@intafaced/service-kit';
