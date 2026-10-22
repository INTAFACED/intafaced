/**
 * Legal agreements register (RC-identity-12, TRD-0631). One generic acceptance register; derivatives text stays in svc-trade.
 * Published versions are immutable (a DB trigger refuses UPDATE and DELETE); a change is a new version, published four-eyes
 * through the existing identity action approvals. Acceptance is idempotent on (subject, kind, version) and stores the signer.
 * For an organisation the signer must hold the admin role. The text is a reference to owner-supplied content, never generated.
 */
import { AGREEMENT_KINDS, AGREEMENT_PUBLISH_ACTION, type AgreementKind, type AgreementRequiresOutput } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import type { ActionApprovalService } from '../auth/action-approval-service.js';
import { PrivilegedDualControlError, requirePrivilegedDualControl } from '../auth/privileged-dual-control.js';
import { userCopy } from '../user-copy.js';

export type AgreementCode =
  | 'identity.agreement_text_unset'
  | 'identity.dispute_venue_unset'
  | 'identity.agreement_jurisdiction_unset'
  | 'identity.agreement_not_published'
  | 'identity.agreement_version_not_current'
  | 'identity.agreement_signer_not_admin'
  | 'identity.agreement_delegated'
  | 'identity.agreement_approval_refused';

export class AgreementError extends Error {
  constructor(
    readonly code: AgreementCode,
    readonly detail?: string,
  ) {
    super(userCopy(code));
    this.name = 'AgreementError';
  }
}

export type AgreementRow = {
  kind: AgreementKind;
  currentVersion: number;
  jurisdiction: string;
  textRef: string;
  disputeVenue: string;
  publishedAt: string;
  acceptedVersion: number | null;
  needsAcceptance: boolean;
};

type Subject = { id: string; type: 'user' | 'org' };

export class AgreementService {
  constructor(
    private readonly sql: Sql,
    private readonly approvals: Pick<ActionApprovalService, 'consume'>,
  ) {}

  /** The current version per kind with this subject's accepted state. Kinds with no published version are left out. */
  async listMine(input: { userId: string; orgId?: string }): Promise<AgreementRow[]> {
    const subject = await this.subject(input.userId, input.orgId, false);
    const rows = await this.sql<
      Array<{
        kind: AgreementKind;
        version: number;
        jurisdiction: string;
        text_ref: string;
        dispute_venue: string;
        published_at: Date;
        accepted: number | null;
      }>
    >`
      SELECT DISTINCT ON (v.kind) v.kind, v.version, v.jurisdiction, v.text_ref, v.dispute_venue, v.published_at,
        (SELECT max(a.version) FROM agreement_acceptances a WHERE a.subject_id = ${subject.id} AND a.kind = v.kind) AS accepted
      FROM agreement_versions v
      ORDER BY v.kind, v.version DESC
    `;
    return rows
      .sort((a, b) => AGREEMENT_KINDS.indexOf(a.kind) - AGREEMENT_KINDS.indexOf(b.kind))
      .map((r) => ({
        kind: r.kind,
        currentVersion: r.version,
        jurisdiction: r.jurisdiction,
        textRef: r.text_ref,
        disputeVenue: r.dispute_venue,
        publishedAt: r.published_at.toISOString(),
        acceptedVersion: r.accepted,
        needsAcceptance: r.accepted !== r.version,
      }));
  }

  /** Accept the current version of one kind. Idempotent on (subject, kind, version): a repeat answers changed:false. */
  async accept(input: {
    userId: string;
    delegated: boolean;
    kind: AgreementKind;
    version: number;
    orgId?: string;
  }): Promise<{ accepted: true; changed: boolean }> {
    if (input.delegated) throw new AgreementError('identity.agreement_delegated');
    const subject = await this.subject(input.userId, input.orgId, true);
    const current = await this.current(input.kind);
    if (current === null) throw new AgreementError('identity.agreement_not_published');
    if (current !== input.version) throw new AgreementError('identity.agreement_version_not_current');
    const inserted = await this.sql`
      INSERT INTO agreement_acceptances (subject_id, subject_type, kind, version, signer_user_id)
      VALUES (${subject.id}, ${subject.type}, ${input.kind}, ${input.version}, ${input.userId})
      ON CONFLICT (subject_id, kind, version) DO NOTHING
    `;
    return { accepted: true, changed: inserted.count > 0 };
  }

  /** For other services: is an acceptance of the current version missing for this subject (user or organisation id)? */
  async requires(subjectId: string, kind: AgreementKind): Promise<AgreementRequiresOutput> {
    const current = await this.current(kind);
    const rows = await this.sql<Array<{ v: number | null }>>`
      SELECT max(version) AS v FROM agreement_acceptances WHERE subject_id = ${subjectId} AND kind = ${kind}
    `;
    const acceptedVersion = rows[0]?.v ?? null;
    return { kind, currentVersion: current, acceptedVersion, required: current !== null && acceptedVersion !== current };
  }

  /** Publish the next version of one kind, four-eyes. Blank text or venue refuses; never defaults. */
  async publish(input: {
    actorId: string;
    kind: AgreementKind;
    jurisdiction: string;
    textRef: string;
    disputeVenue: string;
    approvalId?: string | null;
    operationId?: string | null;
  }): Promise<{ kind: AgreementKind; version: number }> {
    const textRef = input.textRef.trim();
    const disputeVenue = input.disputeVenue.trim();
    const jurisdiction = input.jurisdiction.trim();
    if (!textRef) throw new AgreementError('identity.agreement_text_unset');
    if (!disputeVenue) throw new AgreementError('identity.dispute_venue_unset');
    if (!jurisdiction) throw new AgreementError('identity.agreement_jurisdiction_unset');
    let approverId: string;
    try {
      ({ approverId } = await requirePrivilegedDualControl(this.approvals, {
        actorId: input.actorId,
        approvalId: input.approvalId,
        operationId: input.operationId,
        targetId: AGREEMENT_PUBLISH_ACTION,
        fields: agreementPublishFields({ kind: input.kind, jurisdiction, textRef, disputeVenue }),
      }));
    } catch (err) {
      if (err instanceof PrivilegedDualControlError) throw new AgreementError('identity.agreement_approval_refused', err.code);
      throw err;
    }
    return transaction(this.sql, async (tx) => {
      // One publisher per kind at a time, versions only ever grow (the primary key refuses a duplicate either way).
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'identity.agreement_versions:' + input.kind}))`;
      const [next] = await tx<Array<{ v: number }>>`
        SELECT coalesce(max(version), 0) + 1 AS v FROM agreement_versions WHERE kind = ${input.kind}
      `;
      const version = next!.v;
      await tx`
        INSERT INTO agreement_versions (kind, version, jurisdiction, text_ref, dispute_venue, published_by, approved_by)
        VALUES (${input.kind}, ${version}, ${jurisdiction}, ${textRef}, ${disputeVenue}, ${input.actorId}, ${approverId})
      `;
      return { kind: input.kind, version };
    });
  }

  private async current(kind: AgreementKind): Promise<number | null> {
    const rows = await this.sql<Array<{ v: number | null }>>`SELECT max(version) AS v FROM agreement_versions WHERE kind = ${kind}`;
    return rows[0]?.v ?? null;
  }

  /** The user themself, or an organisation they belong to (admin only when signing for it). */
  private async subject(userId: string, orgId: string | undefined, signing: boolean): Promise<Subject> {
    if (!orgId) return { id: userId, type: 'user' };
    const seat = await this.sql<Array<{ role: string }>>`
      SELECT role FROM organization_members WHERE org_id = ${orgId} AND user_id = ${userId} LIMIT 1
    `;
    if (!seat[0] || (signing && seat[0].role !== 'admin')) throw new AgreementError('identity.agreement_signer_not_admin');
    return { id: orgId, type: 'org' };
  }
}

/** The fields the publish approval is bound to; the proposer hashes the same with `identityActionPayloadHash`. */
export function agreementPublishFields(input: { kind: string; jurisdiction: string; textRef: string; disputeVenue: string }) {
  return { kind: input.kind, jurisdiction: input.jurisdiction, textRef: input.textRef, disputeVenue: input.disputeVenue };
}
