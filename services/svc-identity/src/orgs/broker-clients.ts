/**
 * Broker / DMA client links (RC-identity-09, TRD-0038). Built on the DMA hierarchy law gate: while the owner law is
 * unpublished every write refuses `identity.dma.hierarchy_law_unset`.
 *
 * - An organisation admin invites a client with a tag; the client accepts (a broker cannot attach itself) and either side
 *   can revoke. Invite and accept are idempotent on (orgId, clientUserId); status moves by CAS; history stays.
 * - Commission schedules are owner-set rows, append-only versions. A blank row or no rows refuses
 *   `identity.broker_schedule_unset`. They are a schedule, never a charge: no ledger write here.
 * - An allocation records the instruction only (execution stays in svc-trade), idempotent on its instruction hash.
 * - The client reads their own evidence: tag, status, schedule version, allocations and link history. A broker never sees
 *   a client's balances.
 */
import { createHash } from 'node:crypto';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { userCopy } from '../user-copy.js';
import { DMA_HIERARCHY_LAW_RESIDUAL, DmaHierarchyRefuseError, type DmaHierarchyLaw } from './dma-hierarchy.js';
import { assertOrgActor } from './org-service.js';

export type BrokerCode =
  | 'identity.broker_admin_required'
  | 'identity.broker_client_not_found'
  | 'identity.broker_client_revoked'
  | 'identity.broker_client_not_active'
  | 'identity.broker_client_self'
  | 'identity.broker_tag_invalid'
  | 'identity.broker_schedule_unset'
  | 'identity.broker_instruction_invalid';

export class BrokerError extends Error {
  constructor(readonly code: BrokerCode) {
    super(userCopy(code));
    this.name = 'BrokerError';
  }
}

export type ScheduleRow = { readonly product: string; readonly rate: string };
export type BrokerStatus = 'invited' | 'active' | 'revoked';

const DECIMAL = /^(0|[1-9]\d{0,17})(\.\d{1,18})?$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Canonical JSON (sorted keys) so the same instruction always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function brokerInstructionHash(instruction: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(canonical(instruction)).digest('hex')}`;
}

export class BrokerClientService {
  constructor(
    private readonly sql: Sql,
    private readonly law: DmaHierarchyLaw,
  ) {}

  private gate(): void {
    if (!this.law.published) {
      throw new DmaHierarchyRefuseError(
        'Broker links are refuse-closed until owner-set DMA hierarchy law exists',
        'identity.dma.hierarchy_law_unset',
        DMA_HIERARCHY_LAW_RESIDUAL,
      );
    }
  }

  private async admin(actorId: string, orgId: string): Promise<void> {
    const seat = await assertOrgActor(this.sql, actorId, orgId);
    if (seat.role !== 'admin') throw new BrokerError('identity.broker_admin_required');
  }

  async invite(input: {
    actorId: string;
    orgId: string;
    clientUserId: string;
    clientTag: string;
  }): Promise<{ status: BrokerStatus; changed: boolean }> {
    this.gate();
    const tag = input.clientTag.trim();
    if (!tag || tag.length > 64 || CONTROL.test(tag)) throw new BrokerError('identity.broker_tag_invalid');
    await this.admin(input.actorId, input.orgId);
    if (input.clientUserId === input.actorId) throw new BrokerError('identity.broker_client_self');
    const users = await this.sql`SELECT 1 FROM users WHERE id = ${input.clientUserId} LIMIT 1`;
    if (!users[0]) throw new BrokerError('identity.broker_client_not_found');
    return transaction(this.sql, async (tx) => {
      const inserted = await tx`
        INSERT INTO broker_clients (org_id, client_user_id, client_tag, status, invited_by)
        VALUES (${input.orgId}, ${input.clientUserId}, ${tag}, 'invited', ${input.actorId})
        ON CONFLICT (org_id, client_user_id) DO NOTHING
      `;
      if (inserted.count === 0) {
        const [row] = await tx<Array<{ status: BrokerStatus }>>`
          SELECT status FROM broker_clients WHERE org_id = ${input.orgId} AND client_user_id = ${input.clientUserId}
        `;
        if (row!.status === 'revoked') throw new BrokerError('identity.broker_client_revoked');
        return { status: row!.status, changed: false };
      }
      await tx`INSERT INTO broker_client_events (org_id, client_user_id, event, actor_id) VALUES (${input.orgId}, ${input.clientUserId}, 'invited', ${input.actorId})`;
      return { status: 'invited' as const, changed: true };
    });
  }

  /** The client accepts an invitation addressed to them. */
  async accept(input: { clientUserId: string; orgId: string }): Promise<{ status: 'active'; changed: boolean }> {
    this.gate();
    return transaction(this.sql, async (tx) => {
      const moved = await tx`
        UPDATE broker_clients SET status = 'active', updated_at = clock_timestamp()
        WHERE org_id = ${input.orgId} AND client_user_id = ${input.clientUserId} AND status = 'invited'
      `;
      if (moved.count === 0) {
        const status = await this.status(tx, input.orgId, input.clientUserId);
        if (status === 'active') return { status: 'active' as const, changed: false };
        throw new BrokerError(status === 'revoked' ? 'identity.broker_client_revoked' : 'identity.broker_client_not_found');
      }
      await tx`INSERT INTO broker_client_events (org_id, client_user_id, event, actor_id) VALUES (${input.orgId}, ${input.clientUserId}, 'accepted', ${input.clientUserId})`;
      return { status: 'active' as const, changed: true };
    });
  }

  /** The client, or an organisation admin, revokes the link. CAS on status; history stays. */
  async revoke(input: { actorId: string; orgId: string; clientUserId: string }): Promise<{ status: 'revoked'; changed: boolean }> {
    this.gate();
    if (input.actorId !== input.clientUserId) await this.admin(input.actorId, input.orgId);
    return transaction(this.sql, async (tx) => {
      const moved = await tx`
        UPDATE broker_clients SET status = 'revoked', updated_at = clock_timestamp()
        WHERE org_id = ${input.orgId} AND client_user_id = ${input.clientUserId} AND status IN ('invited', 'active')
      `;
      if (moved.count === 0) {
        const status = await this.status(tx, input.orgId, input.clientUserId);
        if (status === 'revoked') return { status: 'revoked' as const, changed: false };
        throw new BrokerError('identity.broker_client_not_found');
      }
      await tx`INSERT INTO broker_client_events (org_id, client_user_id, event, actor_id) VALUES (${input.orgId}, ${input.clientUserId}, 'revoked', ${input.actorId})`;
      return { status: 'revoked' as const, changed: true };
    });
  }

  /** Publish the next schedule version. Owner-set rows; no default, no blank row. */
  async publishSchedule(input: { actorId: string; orgId: string; rows: readonly ScheduleRow[] }): Promise<{ version: number }> {
    this.gate();
    const rows = input.rows.map((r) => ({ product: r.product.trim(), rate: r.rate.trim() }));
    if (rows.length === 0 || rows.some((r) => !r.product || !r.rate)) throw new BrokerError('identity.broker_schedule_unset');
    if (rows.some((r) => !DECIMAL.test(r.rate) || CONTROL.test(r.product) || r.product.length > 64)) {
      throw new BrokerError('identity.broker_schedule_unset');
    }
    await this.admin(input.actorId, input.orgId);
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'identity.broker_schedule:' + input.orgId}))`;
      const [next] = await tx<Array<{ v: number }>>`
        SELECT coalesce(max(version), 0) + 1 AS v FROM broker_commission_schedules WHERE org_id = ${input.orgId}
      `;
      await tx`
        INSERT INTO broker_commission_schedules (org_id, version, rows, published_by)
        VALUES (${input.orgId}, ${next!.v}, ${tx.json(rows as never)}, ${input.actorId})
      `;
      return { version: next!.v };
    });
  }

  /** Record one allocation instruction for an active client. Idempotent on the instruction hash. */
  async allocate(input: {
    actorId: string;
    orgId: string;
    clientUserId: string;
    instruction: Record<string, unknown>;
  }): Promise<{ allocationId: string; instructionHash: string; changed: boolean }> {
    this.gate();
    if (Object.keys(input.instruction).length === 0) throw new BrokerError('identity.broker_instruction_invalid');
    await this.admin(input.actorId, input.orgId);
    const instructionHash = brokerInstructionHash(input.instruction);
    return transaction(this.sql, async (tx) => {
      const [link] = await tx<Array<{ status: BrokerStatus }>>`
        SELECT status FROM broker_clients WHERE org_id = ${input.orgId} AND client_user_id = ${input.clientUserId} FOR SHARE
      `;
      if (!link) throw new BrokerError('identity.broker_client_not_found');
      if (link.status === 'revoked') throw new BrokerError('identity.broker_client_revoked');
      if (link.status !== 'active') throw new BrokerError('identity.broker_client_not_active');
      const inserted = await tx<Array<{ id: string }>>`
        INSERT INTO broker_allocations (org_id, client_user_id, instruction_hash, instruction, allocated_by)
        VALUES (${input.orgId}, ${input.clientUserId}, ${instructionHash}, ${tx.json(input.instruction as never)}, ${input.actorId})
        ON CONFLICT (org_id, client_user_id, instruction_hash) DO NOTHING
        RETURNING id
      `;
      if (inserted[0]) return { allocationId: inserted[0].id, instructionHash, changed: true };
      const [existing] = await tx<Array<{ id: string }>>`
        SELECT id FROM broker_allocations WHERE org_id = ${input.orgId} AND client_user_id = ${input.clientUserId} AND instruction_hash = ${instructionHash}
      `;
      return { allocationId: existing!.id, instructionHash, changed: false };
    });
  }

  /** The caller's own evidence for one broker. Only ever the caller's row: another client's evidence is not reachable. */
  async evidenceMine(input: { clientUserId: string; orgId: string }) {
    const [link] = await this.sql<Array<{ client_tag: string; status: BrokerStatus; invited_at: Date }>>`
      SELECT client_tag, status, invited_at FROM broker_clients WHERE org_id = ${input.orgId} AND client_user_id = ${input.clientUserId}
    `;
    if (!link) throw new BrokerError('identity.broker_client_not_found');
    const [schedule] = await this.sql<Array<{ version: number; rows: ScheduleRow[]; published_at: Date }>>`
      SELECT version, rows, published_at FROM broker_commission_schedules WHERE org_id = ${input.orgId} ORDER BY version DESC LIMIT 1
    `;
    const allocations = await this.sql<
      Array<{ id: string; instruction_hash: string; instruction: Record<string, unknown>; allocated_at: Date }>
    >`
      SELECT id, instruction_hash, instruction, allocated_at FROM broker_allocations
      WHERE org_id = ${input.orgId} AND client_user_id = ${input.clientUserId} ORDER BY allocated_at, id
    `;
    const history = await this.sql<Array<{ event: 'invited' | 'accepted' | 'revoked'; at: Date }>>`
      SELECT event, at FROM broker_client_events WHERE org_id = ${input.orgId} AND client_user_id = ${input.clientUserId} ORDER BY at, id
    `;
    return {
      orgId: input.orgId,
      clientTag: link.client_tag,
      status: link.status,
      schedule: schedule ? { version: schedule.version, rows: schedule.rows, publishedAt: schedule.published_at.toISOString() } : null,
      allocations: allocations.map((a) => ({
        id: a.id,
        instructionHash: a.instruction_hash,
        instruction: a.instruction,
        allocatedAt: a.allocated_at.toISOString(),
      })),
      history: history.map((h) => ({ event: h.event, at: h.at.toISOString() })),
    };
  }

  private async status(q: Sql, orgId: string, clientUserId: string): Promise<BrokerStatus | null> {
    const [row] = await q<Array<{ status: BrokerStatus }>>`
      SELECT status FROM broker_clients WHERE org_id = ${orgId} AND client_user_id = ${clientUserId}
    `;
    return row?.status ?? null;
  }
}
