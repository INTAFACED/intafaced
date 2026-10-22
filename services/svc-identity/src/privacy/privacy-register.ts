/**
 * Privacy register (RC-identity-11). Customers read what is published; any section with no published version
 * reads `{ state: 'not_set' }`. No sample policy text is ever generated: an invented retention period would be a
 * made-up legal commitment. Publishing is four-eyes through the existing action approvals: the publish consumes an
 * APPROVED `identity.privacy_publish` approval bound to (section, version, payload) whose approver is not its
 * requester. Versions are append-only, keyed on (section, version).
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import { sqlCasConsume, sqlGetApprovalForUpdate } from '../auth/action-approval-store.js';

export const PRIVACY_SECTIONS = [
  'collection',
  'residency',
  'access',
  'minimisation',
  'retention',
  'export',
  'deletion',
  'breach_response',
] as const;
export type PrivacySection = (typeof PRIVACY_SECTIONS)[number];

export const PRIVACY_PUBLISH_ACTION = 'identity.privacy_publish';
export const PRIVACY_PUBLISH_SERVICE = 'svc-identity';
export const PRIVACY_PUBLISH_POLICY = '1';

export const PRIVACY_RETENTION_UNSET = 'identity.privacy_retention_unset' as const;
export const PRIVACY_BODY_UNSET = 'identity.privacy_body_unset' as const;
export const PRIVACY_APPROVAL_REQUIRED = 'identity.privacy_approval_required' as const;
export const PRIVACY_VERSION_CONFLICT = 'identity.privacy_version_conflict' as const;

export type PrivacyErrorCode =
  typeof PRIVACY_RETENTION_UNSET | typeof PRIVACY_BODY_UNSET | typeof PRIVACY_APPROVAL_REQUIRED | typeof PRIVACY_VERSION_CONFLICT;

export class PrivacyRegisterError extends Error {
  constructor(readonly code: PrivacyErrorCode) {
    super(code);
  }
}

export type PublishedSection = {
  section: PrivacySection;
  state: 'published';
  version: number;
  bodyRef: string;
  retentionPeriod: string | null;
  publishedAt: string;
};
export type RegisterEntry = PublishedSection | { section: PrivacySection; state: 'not_set' };

export type PublishInput = { section: PrivacySection; version: number; bodyRef: string; retentionPeriod?: string | null };
export type PublishResult = PublishedSection & { approvalId: string };

type Row = {
  section: PrivacySection;
  version: number;
  body_ref: string;
  retention_period: string | null;
  approval_id: string;
  published_at: Date;
};

function published(row: Row): PublishedSection {
  return {
    section: row.section,
    state: 'published',
    version: row.version,
    bodyRef: row.body_ref,
    retentionPeriod: row.retention_period,
    publishedAt: row.published_at.toISOString(),
  };
}

/** The approval's payload hash: what the second operator approved, byte for byte. */
export function privacyPublishPayloadHash(input: {
  section: PrivacySection;
  version: number;
  bodyRef: string;
  retentionPeriod: string | null;
}): string {
  return founderChangeHash(
    { section: input.section, version: input.version, bodyRef: input.bodyRef, retentionPeriod: input.retentionPeriod },
    PRIVACY_PUBLISH_POLICY,
  );
}

/** Latest published version of each of the eight sections, or `not_set`. An optional (section, version) reads an old one. */
export async function readRegister(sql: Sql, at?: { section: PrivacySection; version: number }): Promise<RegisterEntry[]> {
  const rows = at
    ? await sql<Row[]>`
        SELECT section, version, body_ref, retention_period, approval_id, published_at
        FROM identity.privacy_register WHERE section = ${at.section} AND version = ${at.version}`
    : await sql<Row[]>`
        SELECT DISTINCT ON (section) section, version, body_ref, retention_period, approval_id, published_at
        FROM identity.privacy_register ORDER BY section, version DESC`;
  const sections = at ? [at.section] : PRIVACY_SECTIONS;
  return sections.map((section) => {
    const row = rows.find((r) => r.section === section);
    return row ? published(row) : { section, state: 'not_set' as const };
  });
}

function normalise(input: PublishInput): { section: PrivacySection; version: number; bodyRef: string; retentionPeriod: string | null } {
  const bodyRef = input.bodyRef.trim();
  if (bodyRef === '') throw new PrivacyRegisterError(PRIVACY_BODY_UNSET);
  const period = input.retentionPeriod?.trim() ?? '';
  if (input.section === 'retention' && period === '') throw new PrivacyRegisterError(PRIVACY_RETENTION_UNSET);
  return { section: input.section, version: input.version, bodyRef, retentionPeriod: period === '' ? null : period };
}

/**
 * Publishes the next version of a section. Blank body or (for `retention`) blank period refuse before any write.
 * The (section, version) is the business key: a repeat with the same payload and approval returns the first result.
 */
export async function publishSection(
  sql: Sql,
  actorId: string,
  input: PublishInput & { approvalId: string; requestId: string },
): Promise<PublishResult> {
  const payload = normalise(input);
  const approvalId = input.approvalId.trim();
  if (approvalId === '') throw new PrivacyRegisterError(PRIVACY_APPROVAL_REQUIRED);
  const payloadHash = privacyPublishPayloadHash(payload);
  return transaction(sql, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('identity.privacy_register'), hashtext(${payload.section}))`;
    const [existing] = await tx<Row[]>`
      SELECT section, version, body_ref, retention_period, approval_id, published_at
      FROM identity.privacy_register WHERE section = ${payload.section} AND version = ${payload.version}`;
    if (existing) {
      if (
        existing.approval_id === approvalId &&
        existing.body_ref === payload.bodyRef &&
        existing.retention_period === payload.retentionPeriod
      ) {
        return { ...published(existing), approvalId };
      }
      throw new PrivacyRegisterError(PRIVACY_VERSION_CONFLICT);
    }
    const [counter] = await tx<{ next: number }[]>`
      SELECT COALESCE(MAX(version), 0) + 1 AS next FROM identity.privacy_register WHERE section = ${payload.section}`;
    if (payload.version !== counter?.next) throw new PrivacyRegisterError(PRIVACY_VERSION_CONFLICT);
    const approval = await sqlGetApprovalForUpdate(tx, approvalId);
    const bound =
      approval !== null &&
      approval.status === 'APPROVED' &&
      approval.actionType === PRIVACY_PUBLISH_ACTION &&
      approval.targetService === PRIVACY_PUBLISH_SERVICE &&
      approval.targetId === payload.section &&
      approval.expectedVersion === String(payload.version) &&
      approval.payloadHash === payloadHash &&
      approval.approverId !== null &&
      approval.approverId !== approval.requesterId &&
      approval.expiresAt.getTime() > Date.now();
    if (!bound || approval === null) throw new PrivacyRegisterError(PRIVACY_APPROVAL_REQUIRED);
    const consumed = await sqlCasConsume(tx, {
      approvalId: approval.approvalId,
      operationId: approval.operationId,
      payloadHash: approval.payloadHash,
      targetService: approval.targetService,
      targetId: approval.targetId,
      expectedVersion: approval.expectedVersion,
      now: new Date(),
      requestId: input.requestId,
      consumedByService: PRIVACY_PUBLISH_SERVICE,
      consumedByPrincipal: actorId,
    });
    if (!consumed) throw new PrivacyRegisterError(PRIVACY_APPROVAL_REQUIRED);
    const [row] = await tx<Row[]>`
      INSERT INTO identity.privacy_register (section, version, body_ref, retention_period, approval_id, published_by)
      VALUES (${payload.section}, ${payload.version}, ${payload.bodyRef}, ${payload.retentionPeriod}, ${approvalId}, ${actorId})
      RETURNING section, version, body_ref, retention_period, approval_id, published_at`;
    if (!row) throw new PrivacyRegisterError(PRIVACY_VERSION_CONFLICT);
    return { ...published(row), approvalId };
  });
}
