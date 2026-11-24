import type { Sql } from 'postgres';
import type { EventBus } from '@intafaced/events';

/**
 * The owner's own freeze on the bus (`selfFreezeApplied`, J-wallet-13 #1). The freeze commits first (sessions and API
 * keys end in its transaction, `applySelfFreeze`); this relay then announces each freeze whose `published_at` is null,
 * at least once, with the business key `identity.self_freeze.frozen:<freezeId>`, so every service that keeps a
 * permission for an agent to act for the person revokes it and stops their scheduled agent orders. A row another run
 * holds is skipped; a publish that fails leaves the row for the next run. Moves no money.
 */
export interface SelfFreezeRelayDeps {
  readonly sql: Sql;
  readonly bus: Pick<EventBus, 'publish'>;
  readonly now: () => Date;
}

export async function relaySelfFreezeEvents(deps: SelfFreezeRelayDeps, limit = 50): Promise<number> {
  const due = await deps.sql<Array<{ id: string }>>`
    SELECT id FROM account_self_freezes WHERE published_at IS NULL ORDER BY since, id LIMIT ${limit}`;
  let published = 0;
  let failure: unknown;
  for (const { id } of due) {
    try {
      published += await relayOne(deps, id);
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure !== undefined) throw failure;
  return published;
}

async function relayOne(deps: SelfFreezeRelayDeps, id: string): Promise<number> {
  return deps.sql.begin(async (tx) => {
    const [row] = await tx<Array<{ user_id: string; since: Date; published_at: Date | null }>>`
      SELECT user_id, since, published_at FROM account_self_freezes WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
    if (!row || row.published_at) return 0;
    await deps.bus.publish(
      'selfFreezeApplied',
      { userId: row.user_id, freezeId: id, since: new Date(row.since).toISOString() },
      { idempotencyKey: `identity.self_freeze.frozen:${id}` },
    );
    await tx`UPDATE account_self_freezes SET published_at = ${deps.now()} WHERE id = ${id}`;
    return 1;
  });
}
