import type { Sql } from 'postgres';

/** Orders founder restrictions and asynchronous session projection writes. */
export const FOUNDER_CONTROL_LOCK = 'identity.founder-controls';

export async function lockFounderControls(tx: Sql): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${FOUNDER_CONTROL_LOCK}, 0))`;
}
