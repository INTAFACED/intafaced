/**
 * Organisation security policy (I-account-lifecycle-06): member second factor and idle sign-out.
 *
 * - `set`: the org owner (organizations.created_by) only, session only, with step-up `identity.step_up.org_security_policy`
 *   bound to (org, memberSecondFactor, idleSignOutSeconds, request id). The same values again answer `changed:false`
 *   and spend nothing. Each change bumps the version and appends a history row in the same transaction.
 * - The idle time is capped by the owner's maximum (`SESSION_IDLE_SECONDS`, signin-sessions slice 06). While that
 *   maximum is unset, setting any idle value refuses `identity.org_policy_idle_unset`; a policy without idle is fine.
 * - `get`: members and the owner read the policy; no row answers `not_set` (nothing is required).
 * - `enforce`: every org call checks it. A member without the required factor is refused `identity.org_policy_2fa`
 *   with the enrol link, and keeps their personal account. With an idle setting, an org call more than that long
 *   after the session's last org call ends the org context for that session (`identity.org_session_idle`) until the
 *   member signs in again. Changes apply from the next org call.
 */
import { customerStepUpPayloadHash } from '@intafaced/contracts';
import type { ActionApprovalConsumeInput } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { ActionApprovalError } from '../auth/action-approval-service.js';
import { userCopy } from '../user-copy.js';

export const ORG_SECURITY_POLICY_SCOPE = 'identity.step_up.org_security_policy';
export const MEMBER_SECOND_FACTORS = ['any', 'passkey_only', 'totp_or_passkey'] as const;
export type MemberSecondFactor = (typeof MEMBER_SECOND_FACTORS)[number];
/** Where a member enrols a second factor (the customer app's security page). */
export const ORG_POLICY_ENROL_LINK = '/uc/safe';
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type OrgSecurityPolicyCode =
  | 'identity.org_policy_delegated'
  | 'identity.org_policy_owner_only'
  | 'identity.org_policy_idle_unset'
  | 'identity.org_policy_idle_out_of_range'
  | 'identity.org_policy_2fa'
  | 'identity.org_session_idle'
  | 'identity.client_request_id_invalid'
  | 'org.not_found'
  | 'org.membership_denied'
  | 'identity.step_up_required'
  | 'identity.step_up_expired'
  | 'identity.step_up_used'
  | 'identity.step_up_not_yours'
  | 'identity.step_up_target';

export class OrgSecurityPolicyError extends Error {
  constructor(
    readonly code: OrgSecurityPolicyCode,
    readonly enrolLink: string | null = null,
  ) {
    super(userCopy(code));
    this.name = 'OrgSecurityPolicyError';
  }
}

export type OrgSecurityPolicyView =
  | { orgId: string; state: 'not_set' }
  | {
      orgId: string;
      state: 'set';
      memberSecondFactor: MemberSecondFactor;
      idleSignOutSeconds: number | null;
      version: number;
      updatedAt: string;
    };

type PolicyRow = { member_second_factor: MemberSecondFactor; idle_sign_out_seconds: number | null; version: number; updated_at: Date };
type Actor = { userId: string; sessionId: string; apiKey: boolean; subAccount: boolean };

export type OrgSecurityPolicyDeps = {
  sql: Sql;
  approvals: { consume(callerService: string, input: ActionApprovalConsumeInput): Promise<unknown> };
  /** The owner's idle maximum in seconds (`SESSION_IDLE_SECONDS`); undefined = unset. */
  idleMaxSeconds: () => number | undefined;
};

function view(orgId: string, row: PolicyRow | undefined): OrgSecurityPolicyView {
  if (!row) return { orgId, state: 'not_set' };
  return {
    orgId,
    state: 'set',
    memberSecondFactor: row.member_second_factor,
    idleSignOutSeconds: row.idle_sign_out_seconds,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

async function readPolicy(q: Sql, orgId: string, lock = false): Promise<PolicyRow | undefined> {
  const rows = lock
    ? await q<PolicyRow[]>`
        SELECT member_second_factor, idle_sign_out_seconds, version, updated_at FROM org_security_policies WHERE org_id = ${orgId} FOR UPDATE`
    : await q<PolicyRow[]>`
        SELECT member_second_factor, idle_sign_out_seconds, version, updated_at FROM org_security_policies WHERE org_id = ${orgId}`;
  return rows[0];
}

async function isMemberOrOwner(q: Sql, userId: string, orgId: string): Promise<'owner' | 'member' | null> {
  const [org] = await q<Array<{ created_by: string }>>`SELECT created_by FROM organizations WHERE id = ${orgId}`;
  if (!org) throw new OrgSecurityPolicyError('org.not_found');
  if (org.created_by === userId) return 'owner';
  const member = await q`SELECT 1 FROM organization_members WHERE org_id = ${orgId} AND user_id = ${userId} LIMIT 1`;
  return member.length > 0 ? 'member' : null;
}

export class OrgSecurityPolicyService {
  constructor(private readonly deps: OrgSecurityPolicyDeps) {}

  async get(userId: string, orgId: string): Promise<OrgSecurityPolicyView> {
    // A non-member learns nothing about the org, not even that it exists.
    let who: 'owner' | 'member' | null;
    try {
      who = await isMemberOrOwner(this.deps.sql, userId, orgId);
    } catch (err) {
      if (err instanceof OrgSecurityPolicyError && err.code === 'org.not_found') throw new OrgSecurityPolicyError('org.membership_denied');
      throw err;
    }
    if (!who) throw new OrgSecurityPolicyError('org.membership_denied');
    return view(orgId, await readPolicy(this.deps.sql, orgId));
  }

  async set(
    input: Actor & {
      orgId: string;
      memberSecondFactor: MemberSecondFactor;
      idleSignOutSeconds: number | null;
      stepUpApprovalId: string;
      clientRequestId: string;
    },
  ): Promise<OrgSecurityPolicyView & { changed: boolean }> {
    if (input.apiKey || input.subAccount) throw new OrgSecurityPolicyError('identity.org_policy_delegated');
    if (!CLIENT_ID.test(input.clientRequestId)) throw new OrgSecurityPolicyError('identity.client_request_id_invalid');
    const idle = input.idleSignOutSeconds;
    if (idle !== null) {
      const max = this.deps.idleMaxSeconds();
      if (max === undefined) throw new OrgSecurityPolicyError('identity.org_policy_idle_unset');
      if (!Number.isInteger(idle) || idle < 1 || idle > max) throw new OrgSecurityPolicyError('identity.org_policy_idle_out_of_range');
    }
    return transaction(this.deps.sql, async (tx) => {
      const [org] = await tx<Array<{ created_by: string }>>`SELECT created_by FROM organizations WHERE id = ${input.orgId} FOR UPDATE`;
      if (!org) throw new OrgSecurityPolicyError('org.not_found');
      if (org.created_by !== input.userId) throw new OrgSecurityPolicyError('identity.org_policy_owner_only');
      const current = await readPolicy(tx, input.orgId, true);
      if (current && current.member_second_factor === input.memberSecondFactor && current.idle_sign_out_seconds === idle) {
        return { ...view(input.orgId, current), changed: false };
      }
      await this.consume(input);
      const version = (current?.version ?? 0) + 1;
      const [row] = await tx<PolicyRow[]>`
        INSERT INTO org_security_policies (org_id, member_second_factor, idle_sign_out_seconds, version, updated_by, updated_at)
        VALUES (${input.orgId}, ${input.memberSecondFactor}, ${idle}, ${version}, ${input.userId}, clock_timestamp())
        ON CONFLICT (org_id) DO UPDATE SET
          member_second_factor = EXCLUDED.member_second_factor,
          idle_sign_out_seconds = EXCLUDED.idle_sign_out_seconds,
          version = EXCLUDED.version,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at
        RETURNING member_second_factor, idle_sign_out_seconds, version, updated_at`;
      await tx`
        INSERT INTO org_security_policy_history (org_id, version, member_second_factor, idle_sign_out_seconds, changed_by, session_id)
        VALUES (${input.orgId}, ${version}, ${input.memberSecondFactor}, ${idle}, ${input.userId}, ${input.sessionId})`;
      return { ...view(input.orgId, row), changed: true };
    });
  }

  private async consume(
    input: Actor & {
      orgId: string;
      memberSecondFactor: string;
      idleSignOutSeconds: number | null;
      stepUpApprovalId: string;
      clientRequestId: string;
    },
  ) {
    try {
      await this.deps.approvals.consume('svc-identity', {
        approvalId: input.stepUpApprovalId,
        operationId: input.stepUpApprovalId,
        payloadHash: customerStepUpPayloadHash(ORG_SECURITY_POLICY_SCOPE, {
          actor: input.userId,
          orgId: input.orgId,
          memberSecondFactor: input.memberSecondFactor,
          idleSignOutSeconds: input.idleSignOutSeconds === null ? '' : String(input.idleSignOutSeconds),
          clientRequestId: input.clientRequestId,
        }),
        targetService: 'svc-identity',
        targetId: ORG_SECURITY_POLICY_SCOPE,
        expectedVersion: '1',
        principalUserId: input.userId,
        principalSessionId: input.sessionId,
      });
    } catch (err) {
      if (err instanceof ActionApprovalError) {
        const code =
          err.code === 'action_approval.expired'
            ? 'identity.step_up_expired'
            : err.code === 'action_approval.consumed'
              ? 'identity.step_up_used'
              : err.code === 'action_approval.not_requester'
                ? 'identity.step_up_not_yours'
                : err.code === 'action_approval.payload_mismatch' || err.code === 'action_approval.target_mismatch'
                  ? 'identity.step_up_target'
                  : 'identity.step_up_required';
        throw new OrgSecurityPolicyError(code);
      }
      throw err;
    }
  }
}

function passkeyCount(raw: unknown): number {
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * The org-call gate. No policy row: nothing is required and nothing is recorded. Runs on the database clock.
 * `sessionId` is null for an API-key caller: the factor rule still applies, the idle rule (a session rule) does not.
 */
export async function enforceOrgSecurityPolicy(
  sql: Sql,
  input: { userId: string; orgId: string; sessionId: string | null },
): Promise<void> {
  // Read through the org itself: a real org with no policy row yields NULL policy columns, which means
  // nothing is required. Any query error propagates, so the gate fails closed.
  const [policy] = await sql<
    Array<{ member_second_factor?: PolicyRow['member_second_factor'] | null; idle_sign_out_seconds?: number | null }>
  >`
    SELECT p.member_second_factor, p.idle_sign_out_seconds
      FROM organizations o LEFT JOIN org_security_policies p ON p.org_id = o.id
     WHERE o.id = ${input.orgId}`;
  if (!policy?.member_second_factor) return;
  // A non-member gets the org action's own refusal, never a policy answer about an org they are not in.
  const member = await sql`
    SELECT 1 FROM organizations o WHERE o.id = ${input.orgId}
       AND (o.created_by = ${input.userId} OR EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id = o.id AND m.user_id = ${input.userId}))`;
  if (member.length === 0) return;
  if (policy.member_second_factor !== 'any') {
    const [u] = await sql<Array<{ totp_secret: string | null; totp_enrolled_at: Date | null; webauthn_creds: unknown }>>`
      SELECT totp_secret, totp_enrolled_at, webauthn_creds FROM users WHERE id = ${input.userId}`;
    const passkey = !!u && passkeyCount(u.webauthn_creds) > 0;
    const totp = !!u && !!u.totp_secret && !!u.totp_enrolled_at;
    const meets = policy.member_second_factor === 'passkey_only' ? passkey : passkey || totp;
    if (!meets) throw new OrgSecurityPolicyError('identity.org_policy_2fa', ORG_POLICY_ENROL_LINK);
  }
  if (policy.idle_sign_out_seconds === null || policy.idle_sign_out_seconds === undefined || input.sessionId === null) return;
  const idle = policy.idle_sign_out_seconds;
  await transaction(sql, async (tx) => {
    const [row] = await tx<Array<{ idle: boolean; ended: boolean }>>`
      SELECT last_at + make_interval(secs => ${idle}) < now() AS idle, ended_at IS NOT NULL AS ended
        FROM org_session_activity WHERE session_id = ${input.sessionId} AND org_id = ${input.orgId} FOR UPDATE`;
    if (row?.ended) throw new OrgSecurityPolicyError('identity.org_session_idle');
    if (row?.idle) {
      await tx`UPDATE org_session_activity SET ended_at = now() WHERE session_id = ${input.sessionId} AND org_id = ${input.orgId}`;
      return 'ended';
    }
    await tx`
      INSERT INTO org_session_activity (session_id, org_id, last_at) VALUES (${input.sessionId}, ${input.orgId}, now())
      ON CONFLICT (session_id, org_id) DO UPDATE SET last_at = now()`;
    return 'ok';
  }).then((outcome) => {
    // The end is committed before the refusal, so it sticks for this session.
    if (outcome === 'ended') throw new OrgSecurityPolicyError('identity.org_session_idle');
  });
}
