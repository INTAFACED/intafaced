import type { Sql } from 'postgres';
import { selfFreezeStateSchema, serviceCallSigner, TRPCError, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { MemorySeenStore, idempotent, type EventBus, type SeenStore, type Subscription } from '@intafaced/events';
import { OwnAgentRefusal } from './catalog.js';

/**
 * THE OWNER'S OWN FREEZE, AS SVC-AGENTS KEEPS IT (W-security-accounts-03; J-wallet-13 #1 #2 #4).
 *
 * Two halves. The event `selfFreezeApplied` (svc-identity, at least once after the freeze commits) revokes every
 * permission this service keeps for an agent to act for the person and stops their scheduled agent runs, in one
 * transaction recorded by the freeze's id, so a second delivery changes nothing. And every action an agent takes for the
 * person, and every change that would give an agent more, reads the freeze itself from identity
 * (`GET /internal/self-freeze/:userId`) before it acts, so a late or lost event never lets one through. An unreadable
 * freeze counts as frozen. A revoked permission stays revoked after the lift: the person grants it again. Nothing here
 * moves value or holds a balance; services never read each other's tables, so the freeze is only ever asked of identity.
 */

export const OWNER_FROZEN_SELF = 'agents.identity.owner_frozen_self' as const;
export const OWNER_FREEZE_UNREAD = 'agents.identity.owner_freeze_unread' as const;

export type SelfFreezeReading = { readonly frozen: false } | { readonly frozen: true; readonly since: string | null };

export interface OwnSelfFreezeRead {
  /** The person's own freeze as identity holds it now. Throws when identity can't be asked or answers off-contract. */
  read(userId: string): Promise<SelfFreezeReading>;
}

export class SelfFreezeUnavailable extends Error {}

const FETCH_MS = 3_000;

export function createIdentitySelfFreezeRead(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): OwnSelfFreezeRead {
  const base = baseUrl.replace(/\/+$/, '');
  const sign = serviceCallSigner({ service: 'svc-agents', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async read(userId) {
      const target = `${base}/internal/self-freeze/${encodeURIComponent(userId)}`;
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'GET',
          headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }),
          signal: AbortSignal.timeout(FETCH_MS),
        });
      } catch {
        throw new SelfFreezeUnavailable('identity did not answer the freeze read');
      }
      if (!response.ok) throw new SelfFreezeUnavailable(`identity refused the freeze read (${response.status})`);
      const parsed = selfFreezeStateSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success || parsed.data.userId.toLowerCase() !== userId.toLowerCase()) {
        throw new SelfFreezeUnavailable('identity answered the freeze read outside its contract');
      }
      return parsed.data.frozen ? { frozen: true, since: parsed.data.since } : { frozen: false };
    },
  };
}

/** For tests: a fixed set of frozen people, and identity that can be taken down. */
export class MemorySelfFreezeRead implements OwnSelfFreezeRead {
  readonly frozenSince = new Map<string, string>();
  down = false;
  async read(userId: string): Promise<SelfFreezeReading> {
    if (this.down) throw new SelfFreezeUnavailable('TEST: identity down');
    const since = this.frozenSince.get(userId);
    return since === undefined ? { frozen: false } : { frozen: true, since };
  }
}

/**
 * Refuses while the person's own freeze is on (`agents.identity.owner_frozen_self`, with the freeze's start), and when
 * it cannot be read (`agents.identity.owner_freeze_unread`): no reader wired, identity down, or an answer off-contract.
 */
export async function assertNotSelfFrozen(userId: string, freeze: OwnSelfFreezeRead | null | undefined): Promise<void> {
  if (!freeze) throw new OwnAgentRefusal(OWNER_FREEZE_UNREAD);
  let reading: SelfFreezeReading;
  try {
    reading = await freeze.read(userId);
  } catch (err) {
    if (err instanceof SelfFreezeUnavailable) throw new OwnAgentRefusal(OWNER_FREEZE_UNREAD);
    throw err;
  }
  if (reading.frozen) throw new OwnAgentRefusal(OWNER_FROZEN_SELF, reading.since ? { since: reading.since } : {});
}

/** The same gate for a route outside the own-agent router: FORBIDDEN with the code as its message. */
export async function selfFreezeGate(userId: string, freeze: OwnSelfFreezeRead | null | undefined): Promise<void> {
  try {
    await assertNotSelfFrozen(userId, freeze);
  } catch (err) {
    if (err instanceof OwnAgentRefusal) throw new TRPCError({ code: 'FORBIDDEN', message: err.code, cause: err });
    throw err;
  }
}

/** What one application of a freeze changed, row counts by kind. */
export type SelfFreezeApplied = {
  readonly tokensRevoked: number;
  readonly consentsRevoked: number;
  readonly accountAccessEnded: number;
  readonly onchainBindingsRevoking: number;
  readonly schedulesCancelled: number;
  readonly triggersCancelled: number;
  readonly autoRunsSkipped: number;
  readonly sessionRunsPaused: number;
  readonly testRunsStopped: number;
};

/**
 * Applies one freeze, once: revokes every agent permission kept for the person and stops their scheduled agent runs, in
 * one transaction, recorded under the freeze's id. The same freeze again returns what the first application changed and
 * changes nothing. Only the person's own rows are touched.
 */
async function applySelfFreeze(
  sql: Sql,
  freeze: { readonly userId: string; readonly freezeId: string; readonly since: string },
): Promise<{ applied: SelfFreezeApplied; repeated: boolean }> {
  return sql.begin(async (tx) => {
    // One application per freeze: two deliveries at once wait here and the second finds the record.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'agents.self_freeze:' + freeze.freezeId}))`;
    const [seen] = await tx<Array<{ applied: SelfFreezeApplied }>>`
      SELECT applied FROM agents.self_freezes_applied WHERE freeze_id = ${freeze.freezeId}
    `;
    if (seen) return { applied: seen.applied, repeated: true };
    const user = freeze.userId;
    const count = (rows: readonly unknown[]) => rows.length;

    // The agent's own credential: its token's next call fails (token_revoked).
    const tokensRevoked = count(
      await tx`
      UPDATE agents.own_agent_tokens SET revoked_at = now(), updated_at = now()
       WHERE owner_id = ${user} AND revoked_at IS NULL RETURNING id
    `,
    );
    // The person's consent to each class of tool: every class must be granted again.
    const consentsRevoked = count(
      await tx`
      UPDATE agents.own_agent_consents SET revoked_at = now(), updated_at = now()
       WHERE owner_id = ${user} AND revoked_at IS NULL RETURNING agent_id
    `,
    );
    // Access to the person's venue sub-accounts: ended, as a new grant ends the one before it.
    const accountAccessEnded = count(
      await tx`
      UPDATE agents.own_agent_account_access SET ended_at = now()
       WHERE owner_id = ${user} AND ended_at IS NULL RETURNING id
    `,
    );
    // The Navigator's session-key bindings: marked revoking, as the person's own revoke does; the chain is still the
    // truth for whether the key is live, and the person signs its on-chain revoke in their wallet.
    const onchainBindingsRevoking = count(
      await tx`
      UPDATE agents.navigator_onchain_bindings SET revoke_requested_at = now(), updated_at = now()
       WHERE user_id = ${user} AND revoke_requested_at IS NULL RETURNING id
    `,
    );
    // Schedules and triggers: no further occurrence or event runs the agent. The person makes a new one after the lift.
    const schedulesCancelled = count(
      await tx`
      UPDATE agents.own_agent_schedules SET state = 'cancelled', next_due_at = NULL, updated_at = now()
       WHERE owner_id = ${user} AND state = 'active' RETURNING id
    `,
    );
    const triggersCancelled = count(
      await tx`
      UPDATE agents.own_agent_triggers SET state = 'cancelled', updated_at = now()
       WHERE owner_id = ${user} AND state = 'active' RETURNING id
    `,
    );
    // An occurrence already claimed and not yet run settles as skipped by the freeze, so no worker runs it.
    const autoRunsSkipped = count(
      await tx`
      UPDATE agents.own_agent_auto_runs SET state = 'skipped', code = 'agents.schedule_blocked', reason_code = ${OWNER_FROZEN_SELF},
             updated_at = now()
       WHERE owner_id = ${user} AND state = 'claimed' RETURNING id
    `,
    );
    // A session's background run takes no new step; it stays paused until the person resumes it after the lift.
    const sessionRunsPaused = count(
      await tx`
      UPDATE agents.session_background_runs SET state = 'paused', updated_at = now()
       WHERE user_id = ${user} AND state IN ('queued', 'running') RETURNING id
    `,
    );
    // A background test run of the person's own agent stops with the freeze's code.
    const testRunsStopped = count(
      await tx`
      UPDATE agents.own_agent_background_runs SET state = 'stopped', stop_code = ${OWNER_FROZEN_SELF}, updated_at = now()
       WHERE owner_id = ${user} AND state = 'running' RETURNING id
    `,
    );

    const applied: SelfFreezeApplied = {
      tokensRevoked,
      consentsRevoked,
      accountAccessEnded,
      onchainBindingsRevoking,
      schedulesCancelled,
      triggersCancelled,
      autoRunsSkipped,
      sessionRunsPaused,
      testRunsStopped,
    };
    await tx`
      INSERT INTO agents.self_freezes_applied (freeze_id, user_id, since, applied)
      VALUES (${freeze.freezeId}, ${user}, ${freeze.since}, ${tx.json(applied)})
    `;
    return { applied, repeated: false };
  });
}

/**
 * The consumer of identity's `selfFreezeApplied`. Idempotent twice over: the bus's seen-set by envelope, and the
 * freeze's own record in Postgres by freezeId, so a redelivery after a restart changes nothing either.
 */
export async function subscribeSelfFreezeApplied(bus: EventBus, sql: Sql, store: SeenStore = new MemorySeenStore()): Promise<Subscription> {
  return bus.subscribe(
    'selfFreezeApplied',
    idempotent(
      async (payload) => {
        await applySelfFreeze(sql, { userId: payload.userId, freezeId: payload.freezeId, since: payload.since });
      },
      store,
      'svc-agents-self-freeze',
    ),
    { durable: 'agents-identity-self-freeze-frozen' },
  );
}
