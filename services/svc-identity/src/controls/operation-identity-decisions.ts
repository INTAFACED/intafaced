import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  identityOperationDecisionInputSchema,
  identityOperationDecisionSchema,
  normalizeIdentityOperationInput,
  canonicalIdentityOperationIntent,
  type CurrentAuthorityInput,
  type IdentityOperationDecision,
  type IdentityOperationDecisionInput,
  type IdentityOperationIntent,
} from '@intafaced/contracts';
import { lockFounderControls } from './founder-control-lock.js';

type Refusal = 'auth.account_frozen' | 'auth.credential_denied' | 'auth.sub_account_denied';
type CredentialCheck = { subject: CurrentAuthorityInput | null; expiresAt: Date | null; refusal: Refusal | null };

/** Immutable identity half of owner admission; owner restriction barriers are mandatory. */
export class OperationIdentityDecisions {
  constructor(private readonly sql: Sql) {}

  private async credential(tx: Sql, intent: IdentityOperationIntent): Promise<CredentialCheck> {
    let subject: CurrentAuthorityInput | null = null;
    if (intent.authority.kind === 'credential' || intent.authority.kind === 'payfac_credential') subject = intent.authority.subject;
    else if (intent.authority.kind === 'delegation') {
      const [row] = await tx<Array<{ decision: unknown }>>`
        SELECT decision FROM operation_identity_decisions WHERE grant_id = ${intent.authority.parentGrantId}
      `;
      const parent = identityOperationDecisionSchema.safeParse(row?.decision);
      if (
        !parent.success ||
        parent.data.status !== 'granted' ||
        parent.data.intent.operation.service !== intent.operation.service ||
        parent.data.intent.operation.userId !== intent.operation.userId ||
        parent.data.intent.operation.kind !== 'strategy.start' ||
        parent.data.intent.authority.kind !== 'credential'
      ) {
        return { subject: null, expiresAt: null, refusal: 'auth.credential_denied' };
      }
      subject = parent.data.intent.authority.subject;
    }
    if (subject === null)
      return { subject, expiresAt: null, refusal: intent.authority.kind === 'merchant_policy' ? null : 'auth.credential_denied' };
    if (subject.userId !== intent.operation.userId) {
      // PayFac evidence is vouched for by svc-pay. Identity still checks the
      // original parent's live identity and credential, alongside the child.
      const [actor] = await tx<Array<{ status: string }>>`
        SELECT status FROM users WHERE id = ${subject.userId} FOR SHARE
      `;
      if (!actor || actor.status !== 'active') return { subject, expiresAt: null, refusal: 'auth.account_frozen' };
    }
    const ref = subject.credential;
    const [row] =
      ref.kind === 'session'
        ? await tx<Array<{ user_id: string; revoked: boolean; expires_at: Date | null }>>`
          SELECT user_id, revoked, expires_at FROM sessions WHERE id = ${ref.sessionId} FOR SHARE
        `
        : await tx<Array<{ user_id: string; revoked: boolean; expires_at: Date | null; account_id: string | null }>>`
          SELECT user_id, revoked, expires_at, account_id FROM api_keys WHERE id = ${ref.apiKeyId} FOR SHARE
        `;
    if (!row || row.user_id !== subject.userId || row.revoked) return { subject, expiresAt: null, refusal: 'auth.credential_denied' };
    if ('account_id' in row && row.account_id !== null && row.account_id !== subject.subAccountId)
      return { subject, expiresAt: row.expires_at, refusal: 'auth.sub_account_denied' };
    if (subject.subAccountId) {
      const [sub] = await tx<Array<{ parent_user_id: string; revoked: boolean }>>`
        SELECT parent_user_id, revoked FROM sub_accounts WHERE id = ${subject.subAccountId} FOR SHARE
      `;
      if (!sub || sub.parent_user_id !== subject.userId || sub.revoked)
        return { subject, expiresAt: row.expires_at, refusal: 'auth.sub_account_denied' };
    }
    return { subject, expiresAt: row.expires_at, refusal: null };
  }

  async decide(raw: IdentityOperationDecisionInput, authenticatedOwner: string): Promise<IdentityOperationDecision> {
    const input = identityOperationDecisionInputSchema.parse(normalizeIdentityOperationInput(raw));
    const intent = input.intent;
    if (authenticatedOwner !== intent.operation.service) throw new Error('identity.operation_owner_denied');
    const fingerprint = createHash('sha256').update(canonicalIdentityOperationIntent(intent)).digest('hex');
    try {
      return await transaction(
        this.sql,
        async (tx) => {
          // Same ordering as whole-identity controls. A successful freeze and a
          // fresh grant cannot commit independently from stale snapshots.
          await lockFounderControls(tx);
          const [existing] = await tx<Array<{ fingerprint: string; decision: unknown }>>`
          SELECT fingerprint, decision FROM operation_identity_decisions
          WHERE service = ${intent.operation.service} AND kind = ${intent.operation.kind} AND business_id = ${intent.businessId}
        `;
          if (existing)
            return existing.fingerprint === fingerprint
              ? identityOperationDecisionSchema.parse(existing.decision)
              : { status: 'conflict', code: 'operation.conflict' };

          let refusal: Refusal | 'admission.cancelled' | null = input.mode === 'resolve_or_cancel' ? 'admission.cancelled' : null;
          let identityVersion = '0';
          let credentialExpiry: Date | null = null;
          if (refusal === null) {
            const [user] = await tx<Array<{ status: string; version: string }>>`
            SELECT status, identity_control_version::text AS version FROM users WHERE id = ${intent.operation.userId} FOR SHARE
          `;
            if (!user || user.status !== 'active') refusal = 'auth.account_frozen';
            else {
              identityVersion = user.version;
              const proof = await this.credential(tx, intent);
              refusal = proof.refusal;
              credentialExpiry = proof.expiresAt;
            }
          }
          const [clock] = await tx<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
          const decidedAt = clock!.at.toISOString();
          if (refusal === null && credentialExpiry !== null && credentialExpiry <= clock!.at) refusal = 'auth.credential_denied';
          const decision: IdentityOperationDecision =
            refusal !== null
              ? { status: 'cancelled', intent, decidedAt, code: refusal }
              : { status: 'granted', intent, decidedAt, grantId: randomUUID(), identityVersion };
          const validated = identityOperationDecisionSchema.parse(decision);
          await tx`
          INSERT INTO operation_identity_decisions (service, kind, business_id, fingerprint, grant_id, decision)
          VALUES (${intent.operation.service}, ${intent.operation.kind}, ${intent.businessId}, ${fingerprint},
            ${validated.status === 'granted' ? validated.grantId : null}, ${tx.json(validated as never)})
        `;
          return validated;
        },
        { isolation: 'read committed' },
      );
    } catch {
      return { status: 'unavailable', code: 'authority.unavailable' };
    }
  }
}
