import type { Sql } from 'postgres';
import type { TestAgeSubject } from '@intafaced/service-kit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: Date | string): string => new Date(v).toISOString();

/**
 * A shared pot invite no one has answered, made `ms` earlier: its creation and its end move back together, so it has
 * ended as if the time had gone by. An accepted, declined or cancelled invite is decided and is not aged.
 */
export function ageSharedPotInvite(sql: Sql): TestAgeSubject {
  return async (id, ms) => {
    if (!UUID.test(id)) return null;
    const rows = await sql<{ created_at: Date; expires_at: Date }[]>`
      UPDATE bank.shared_pot_invites
      SET created_at = created_at - make_interval(secs => ${ms / 1000}),
          expires_at = expires_at - make_interval(secs => ${ms / 1000})
      WHERE id = ${id}::uuid AND accepted_at IS NULL AND declined_at IS NULL AND cancelled_at IS NULL
      RETURNING created_at, expires_at
    `;
    const row = rows[0];
    return row ? { createdAt: iso(row.created_at), expiresAt: iso(row.expires_at) } : null;
  };
}

/**
 * A business team invite still open, made `ms` earlier: its creation and its end move back together, so it has ended
 * as if the time had gone by. An accepted, revoked or replaced invite is decided and is not aged.
 */
export function ageBusinessInvite(sql: Sql): TestAgeSubject {
  return async (id, ms) => {
    if (!UUID.test(id)) return null;
    const rows = await sql<{ created_at: Date; expires_at: Date }[]>`
      UPDATE bank.business_invites
      SET created_at = created_at - make_interval(secs => ${ms / 1000}),
          expires_at = expires_at - make_interval(secs => ${ms / 1000})
      WHERE id = ${id}::uuid AND status = 'open'
      RETURNING created_at, expires_at
    `;
    const row = rows[0];
    return row ? { createdAt: iso(row.created_at), expiresAt: iso(row.expires_at) } : null;
  };
}

/**
 * A person's weekly pay yourself rule (J-bank-31 #7), its next run moved `ms` earlier, so its day has come as if the
 * time had gone by. Only the next run moves: the profit it counts is still from when it last ran, or was set.
 */
export function agePayYourselfRule(sql: Sql): TestAgeSubject {
  return async (id, ms) => {
    if (!UUID.test(id)) return null;
    const rows = await sql<{ next_run_at: Date }[]>`
      UPDATE bank.pay_yourself_rules
      SET next_run_at = next_run_at - make_interval(secs => ${ms / 1000})
      WHERE id = ${id}::uuid
      RETURNING next_run_at
    `;
    const row = rows[0];
    return row ? { nextRunAt: iso(row.next_run_at) } : null;
  };
}
