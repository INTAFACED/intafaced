import type { Sql } from 'postgres';
import type {
  HumanTokenTier,
  ProtocolNameTagRequest,
  ProtocolOnboardingChecklist,
  ProtocolOnboardingOpenInput,
  ProtocolTierAudit,
  ProtocolTokenTier,
} from '@intafaced/contracts/protocol-address-risk';
import {
  missingItems,
  type NameTagApproveOutcome,
  type OnboardingApproveOutcome,
  type TierApproveOutcome,
  type TierAskOutcome,
  type TierRemoveOutcome,
  type TrustDeskStore,
} from './trust-desk.js';

/**
 * Postgres `TrustDeskStore` over `protocol.token_tier_requests`, `token_tiers`, `token_tier_audit` and `pool_onboarding`
 * (20261113040000). An approval or removal takes the row lock, so two racing approvals change the tier once; the tables'
 * own checks refuse an approver who asked, and an approved checklist with a blank item.
 */
const iso = (value: Date | string) => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null) => (value === null ? null : iso(value));

type TierRow = {
  token: string;
  tier: HumanTokenTier | null;
  prior_tier: HumanTokenTier | null;
  reason: string | null;
  since: Date | string | null;
  requester_id: string | null;
  approver_id: string | null;
  p_id: string | null;
  p_tier: HumanTokenTier | null;
  p_reason: string | null;
  p_requester_id: string | null;
  p_asked_at: Date | string | null;
};
type AuditRow = {
  id: string;
  token: string;
  action: ProtocolTierAudit['action'];
  tier: HumanTokenTier;
  returned_to: HumanTokenTier | null;
  reason: string;
  actor_id: string;
  at: Date | string;
};
type ChecklistRow = {
  id: string;
  pool: string;
  legal_entity: string | null;
  token_contract: string | null;
  checker_address: string | null;
  wrapper_address: string | null;
  routing_registration: string | null;
  status: ProtocolOnboardingChecklist['status'];
  opened_by: string;
  approved_by: string | null;
  approval_reason: string | null;
  opened_at: Date | string;
  approved_at: Date | string | null;
};

const toTier = (r: TierRow): ProtocolTokenTier => ({
  token: r.token,
  tier: r.tier,
  priorTier: r.prior_tier,
  reason: r.reason,
  since: isoOrNull(r.since),
  requesterId: r.requester_id,
  approverId: r.approver_id,
  pending:
    r.p_id === null
      ? null
      : { id: r.p_id, tier: r.p_tier!, reason: r.p_reason!, requesterId: r.p_requester_id!, askedAt: iso(r.p_asked_at!) },
});
const toAudit = (r: AuditRow): ProtocolTierAudit => ({
  id: r.id,
  token: r.token,
  action: r.action,
  tier: r.tier,
  returnedTo: r.returned_to,
  reason: r.reason,
  actorId: r.actor_id,
  at: iso(r.at),
});
const toChecklist = (r: ChecklistRow): ProtocolOnboardingChecklist => {
  const items = {
    legalEntity: r.legal_entity,
    tokenContract: r.token_contract,
    checkerAddress: r.checker_address,
    wrapperAddress: r.wrapper_address,
    routingRegistration: r.routing_registration,
  };
  return {
    id: r.id,
    pool: r.pool,
    ...items,
    missing: missingItems(items),
    status: r.status,
    openedBy: r.opened_by,
    approvedBy: r.approved_by,
    approvalReason: r.approval_reason,
    openedAt: iso(r.opened_at),
    approvedAt: isoOrNull(r.approved_at),
  };
};
type NameTagRow = {
  id: string;
  address: string;
  tag: string;
  reason: string;
  status: ProtocolNameTagRequest['status'];
  requester_id: string;
  first_approver_id: string | null;
  first_approved_at: Date | string | null;
  second_approver_id: string | null;
  published_at: Date | string | null;
  asked_at: Date | string;
  proof_nonce: string | null;
  proof_signer: string | null;
  proof_block: string | null;
  proof_at: Date | string | null;
};
const toNameTag = (r: NameTagRow): ProtocolNameTagRequest => {
  const approvals: ProtocolNameTagRequest['approvals'] = [];
  if (r.first_approver_id) approvals.push({ approverId: r.first_approver_id, at: iso(r.first_approved_at!) });
  if (r.second_approver_id) approvals.push({ approverId: r.second_approver_id, at: iso(r.published_at!) });
  return {
    id: r.id,
    address: r.address,
    tag: r.tag,
    reason: r.reason,
    status: r.status,
    requesterId: r.requester_id,
    proof: r.proof_signer === null ? null : { signer: r.proof_signer, blockNumber: String(r.proof_block), verifiedAt: iso(r.proof_at!) },
    approvals,
    askedAt: iso(r.asked_at),
    publishedAt: isoOrNull(r.published_at),
  };
};
/**
 * A request with its proof: the one it was published on, or while pending the newest proof stored for its address. A tag
 * carries no reputation of its own (UNKNOWN), so it never raises or lowers the address's risk.
 */
const NAME_TAG_SELECT = `
  SELECT n.id, n.address, n.tag, n.reason, n.status, n.requester_id, n.first_approver_id, n.first_approved_at,
         n.second_approver_id, n.published_at, n.asked_at,
         p.nonce AS proof_nonce, p.signer AS proof_signer, p.block_number::text AS proof_block, p.verified_at AS proof_at
  FROM protocol.name_tag_requests n
  LEFT JOIN LATERAL (
    SELECT nonce, signer, block_number, verified_at FROM protocol.listing_ownership_proofs o
    WHERE (n.proof_nonce IS NOT NULL AND o.nonce = n.proof_nonce)
       OR (n.proof_nonce IS NULL AND o.chain_id = n.chain_id AND lower(o.token) = n.address)
    ORDER BY o.verified_at DESC LIMIT 1) p ON true`;

const CHECKLIST_COLUMNS =
  'id, pool, legal_entity, token_contract, checker_address, wrapper_address, routing_registration, status, opened_by, approved_by, approval_reason, opened_at, approved_at';

export class PostgresTrustDeskStore implements TrustDeskStore {
  constructor(private readonly sql: Sql) {}

  private async tierOf(q: Sql, chainId: number, token: string): Promise<ProtocolTokenTier> {
    const rows = await q<TierRow[]>`
      SELECT k.token, t.tier, t.prior_tier, t.reason, t.since, r.requester_id, r.approver_id,
             p.id AS p_id, p.tier AS p_tier, p.reason AS p_reason, p.requester_id AS p_requester_id, p.asked_at AS p_asked_at
      FROM (SELECT ${chainId}::integer AS chain_id, ${token}::text AS token) k
      LEFT JOIN protocol.token_tiers t ON t.chain_id = k.chain_id AND t.token = k.token
      LEFT JOIN protocol.token_tier_requests r ON r.id = t.request_id
      LEFT JOIN protocol.token_tier_requests p ON p.chain_id = k.chain_id AND p.token = k.token AND p.status = 'pending'`;
    return toTier(rows[0]!);
  }

  async tiers(chainId: number, auditLimit: number) {
    const rows = await this.sql<TierRow[]>`
      WITH k AS (
        SELECT token FROM protocol.token_tiers WHERE chain_id = ${chainId}
        UNION SELECT token FROM protocol.token_tier_requests WHERE chain_id = ${chainId} AND status = 'pending')
      SELECT k.token, t.tier, t.prior_tier, t.reason, t.since, r.requester_id, r.approver_id,
             p.id AS p_id, p.tier AS p_tier, p.reason AS p_reason, p.requester_id AS p_requester_id, p.asked_at AS p_asked_at
      FROM k
      LEFT JOIN protocol.token_tiers t ON t.chain_id = ${chainId} AND t.token = k.token
      LEFT JOIN protocol.token_tier_requests r ON r.id = t.request_id
      LEFT JOIN protocol.token_tier_requests p ON p.chain_id = ${chainId} AND p.token = k.token AND p.status = 'pending'
      ORDER BY k.token`;
    const audit = await this.sql<AuditRow[]>`
      SELECT id, token, action, tier, returned_to, reason, actor_id, at FROM protocol.token_tier_audit
      WHERE chain_id = ${chainId} ORDER BY at DESC, id LIMIT ${auditLimit}`;
    return { tiers: rows.map(toTier), audit: audit.map(toAudit) };
  }

  async askTier(input: {
    chainId: number;
    token: string;
    tier: HumanTokenTier;
    reason: string;
    requesterId: string;
  }): Promise<TierAskOutcome> {
    return this.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      const rows = await q<{ id: string }[]>`
        INSERT INTO protocol.token_tier_requests (chain_id, token, tier, reason, requester_id)
        VALUES (${input.chainId}, ${input.token}, ${input.tier}, ${input.reason}, ${input.requesterId})
        ON CONFLICT (chain_id, token) WHERE status = 'pending' DO NOTHING RETURNING id`;
      if (rows.length === 0) return { kind: 'pending' } as const;
      await q`
        INSERT INTO protocol.token_tier_audit (chain_id, token, action, tier, reason, actor_id)
        VALUES (${input.chainId}, ${input.token}, 'asked', ${input.tier}, ${input.reason}, ${input.requesterId})`;
      return { kind: 'asked', tier: await this.tierOf(q, input.chainId, input.token) } as const;
    });
  }

  async approveTier(input: { chainId: number; requestId: string; approverId: string }): Promise<TierApproveOutcome> {
    return this.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      const [request] = await q<{ id: string; token: string; tier: HumanTokenTier; reason: string; requester_id: string }[]>`
        SELECT id, token, tier, reason, requester_id FROM protocol.token_tier_requests
        WHERE id = ${input.requestId} AND chain_id = ${input.chainId} AND status = 'pending' FOR UPDATE`;
      if (!request) return { kind: 'unknown' } as const;
      if (request.requester_id === input.approverId) return { kind: 'same_approver' } as const;
      await q`
        UPDATE protocol.token_tier_requests SET status = 'approved', approver_id = ${input.approverId}, decided_at = now()
        WHERE id = ${request.id}`;
      // The tier in force before this one is what a removal returns to.
      await q`
        INSERT INTO protocol.token_tiers (chain_id, token, tier, prior_tier, reason, request_id, since)
        VALUES (${input.chainId}, ${request.token}, ${request.tier}, NULL, ${request.reason}, ${request.id}, now())
        ON CONFLICT (chain_id, token) DO UPDATE SET prior_tier = protocol.token_tiers.tier, tier = EXCLUDED.tier,
          reason = EXCLUDED.reason, request_id = EXCLUDED.request_id, since = EXCLUDED.since`;
      await q`
        INSERT INTO protocol.token_tier_audit (chain_id, token, action, tier, reason, actor_id)
        VALUES (${input.chainId}, ${request.token}, 'approved', ${request.tier}, ${request.reason}, ${input.approverId})`;
      return { kind: 'approved', tier: await this.tierOf(q, input.chainId, request.token) } as const;
    });
  }

  async removeTier(input: { chainId: number; token: string; reason: string; actorId: string }): Promise<TierRemoveOutcome> {
    return this.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      const [current] = await q<{ tier: HumanTokenTier; prior_tier: HumanTokenTier | null; request_id: string }[]>`
        SELECT tier, prior_tier, request_id FROM protocol.token_tiers
        WHERE chain_id = ${input.chainId} AND token = ${input.token} FOR UPDATE`;
      if (!current) return { kind: 'none_set' } as const;
      if (current.prior_tier === null) {
        await q`DELETE FROM protocol.token_tiers WHERE chain_id = ${input.chainId} AND token = ${input.token}`;
      } else {
        // Back to the earlier human tier, as it was approved; the step before it is the automated tier.
        const [prior] = await q<{ id: string; reason: string; decided_at: Date | string }[]>`
          SELECT id, reason, decided_at FROM protocol.token_tier_requests
          WHERE chain_id = ${input.chainId} AND token = ${input.token} AND status = 'approved' AND tier = ${current.prior_tier}
            AND id <> ${current.request_id}
          ORDER BY decided_at DESC LIMIT 1`;
        await q`
          UPDATE protocol.token_tiers SET tier = ${current.prior_tier}, prior_tier = NULL,
            reason = ${prior?.reason ?? input.reason}, request_id = ${prior?.id ?? current.request_id},
            since = ${prior ? iso(prior.decided_at) : new Date().toISOString()}
          WHERE chain_id = ${input.chainId} AND token = ${input.token}`;
      }
      await q`
        INSERT INTO protocol.token_tier_audit (chain_id, token, action, tier, returned_to, reason, actor_id)
        VALUES (${input.chainId}, ${input.token}, 'removed', ${current.tier}, ${current.prior_tier}, ${input.reason}, ${input.actorId})`;
      return { kind: 'removed', tier: await this.tierOf(q, input.chainId, input.token) } as const;
    });
  }

  async checklists(chainId: number): Promise<ProtocolOnboardingChecklist[]> {
    const rows = await this.sql<ChecklistRow[]>`
      SELECT ${this.sql.unsafe(CHECKLIST_COLUMNS)} FROM protocol.pool_onboarding WHERE chain_id = ${chainId}
      ORDER BY opened_at DESC, id LIMIT 200`;
    return rows.map(toChecklist);
  }

  async openChecklist(input: ProtocolOnboardingOpenInput & { chainId: number; openedBy: string }) {
    const rows = await this.sql<ChecklistRow[]>`
      INSERT INTO protocol.pool_onboarding
        (chain_id, pool, legal_entity, token_contract, checker_address, wrapper_address, routing_registration, opened_by)
      VALUES (${input.chainId}, ${input.pool}, ${input.legalEntity}, ${input.tokenContract}, ${input.checkerAddress},
              ${input.wrapperAddress}, ${input.routingRegistration}, ${input.openedBy})
      ON CONFLICT (chain_id, lower(pool)) DO NOTHING
      RETURNING ${this.sql.unsafe(CHECKLIST_COLUMNS)}`;
    return rows[0] ? ({ kind: 'opened', checklist: toChecklist(rows[0]) } as const) : ({ kind: 'duplicate' } as const);
  }

  async approveChecklist(input: {
    chainId: number;
    checklistId: string;
    approverId: string;
    reason: string;
  }): Promise<OnboardingApproveOutcome> {
    return this.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      const [row] = await q<ChecklistRow[]>`
        SELECT ${q.unsafe(CHECKLIST_COLUMNS)} FROM protocol.pool_onboarding
        WHERE id = ${input.checklistId} AND chain_id = ${input.chainId} AND status = 'open' FOR UPDATE`;
      if (!row) return { kind: 'unknown' } as const;
      const checklist = toChecklist(row);
      if (checklist.missing.length > 0) return { kind: 'incomplete', missing: checklist.missing } as const;
      if (row.opened_by === input.approverId) return { kind: 'same_approver' } as const;
      const [done] = await q<ChecklistRow[]>`
        UPDATE protocol.pool_onboarding SET status = 'approved', approved_by = ${input.approverId},
          approval_reason = ${input.reason}, approved_at = now()
        WHERE id = ${row.id} RETURNING ${q.unsafe(CHECKLIST_COLUMNS)}`;
      return { kind: 'approved', checklist: toChecklist(done!) } as const;
    });
  }

  async nameTags(chainId: number): Promise<ProtocolNameTagRequest[]> {
    const rows = await this.sql<NameTagRow[]>`
      ${this.sql.unsafe(NAME_TAG_SELECT)} WHERE n.chain_id = ${chainId} ORDER BY n.asked_at DESC, n.id LIMIT 200`;
    return rows.map(toNameTag);
  }

  private async nameTagOf(q: Sql, id: string): Promise<ProtocolNameTagRequest> {
    const [row] = await q<NameTagRow[]>`${q.unsafe(NAME_TAG_SELECT)} WHERE n.id = ${id}`;
    return toNameTag(row!);
  }

  async requestNameTag(input: { chainId: number; address: string; tag: string; reason: string; requesterId: string }) {
    const rows = await this.sql<{ id: string }[]>`
      INSERT INTO protocol.name_tag_requests (chain_id, address, tag, reason, requester_id)
      VALUES (${input.chainId}, ${input.address}, ${input.tag}, ${input.reason}, ${input.requesterId})
      ON CONFLICT (chain_id, address) WHERE status = 'pending' DO NOTHING RETURNING id`;
    if (rows.length === 0) return { kind: 'pending' } as const;
    return { kind: 'requested', request: await this.nameTagOf(this.sql, rows[0]!.id) } as const;
  }

  async approveNameTag(input: { chainId: number; requestId: string; approverId: string }): Promise<NameTagApproveOutcome> {
    return this.sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      const [row] = await q<{ id: string; address: string; tag: string; reason: string; first_approver_id: string | null }[]>`
        SELECT id, address, tag, reason, first_approver_id FROM protocol.name_tag_requests
        WHERE id = ${input.requestId} AND chain_id = ${input.chainId} AND status = 'pending' FOR UPDATE`;
      if (!row) return { kind: 'unknown' } as const;
      const [proof] = await q<{ nonce: string }[]>`
        SELECT nonce FROM protocol.listing_ownership_proofs
        WHERE chain_id = ${input.chainId} AND lower(token) = ${row.address} ORDER BY verified_at DESC LIMIT 1`;
      if (!proof) return { kind: 'no_proof' } as const;
      if (row.first_approver_id === input.approverId) return { kind: 'same_approver' } as const;
      if (row.first_approver_id === null) {
        await q`
          UPDATE protocol.name_tag_requests SET first_approver_id = ${input.approverId}, first_approved_at = now()
          WHERE id = ${row.id}`;
        return { kind: 'approved', request: await this.nameTagOf(q, row.id) } as const;
      }
      await q`
        UPDATE protocol.name_tag_requests SET status = 'public', second_approver_id = ${input.approverId},
          proof_nonce = ${proof.nonce}, published_at = now()
        WHERE id = ${row.id}`;
      const [label] = await q<{ id: string; version: number }[]>`
        INSERT INTO protocol.address_labels (chain_id, address, kind, value, source, reputation, reason, evidence_url, set_by)
        VALUES (${input.chainId}, ${row.address}, 'name', ${row.tag}, 'owner_proof', 'UNKNOWN', ${row.reason}, NULL, ${input.approverId})
        ON CONFLICT (chain_id, lower(address), kind) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source,
          reputation = EXCLUDED.reputation, reason = EXCLUDED.reason, evidence_url = EXCLUDED.evidence_url,
          set_by = EXCLUDED.set_by, version = protocol.address_labels.version + 1, updated_at = now()
        RETURNING id, version`;
      await q`
        INSERT INTO protocol.address_label_history (label_id, version, value, reputation, reason, evidence_url, set_by)
        VALUES (${label!.id}, ${label!.version}, ${row.tag}, 'UNKNOWN', ${row.reason}, NULL, ${input.approverId})`;
      return { kind: 'approved', request: await this.nameTagOf(q, row.id) } as const;
    });
  }
}
