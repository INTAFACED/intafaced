import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEATH_NOTICE_CONFIRM_ACTION_TYPE,
  DEATH_NOTICE_TARGET_SERVICE,
  DEATH_NOTICE_VERSION,
  recoveryClaimMessage,
  type RecoveryPublicJwk,
} from '@intafaced/contracts/identity-recovery';
import type { Context } from '@intafaced/contracts';
import { RECOVERY_CLAIM_VERIFIERS } from './auth/recovery-claim-verify.js';
import {
  confirmDeathNotice,
  deathNoticePayloadHash,
  recordDeathNotice,
  rejectDeathNotice,
  verifyRecoveryClaim,
} from './auth/death-notices.js';
import { contextWith, recordingSql, type SqlCall } from './boot.testkit.js';
import { createDeathNoticesRouter } from './death-notices-router.js';

/**
 * Death notices and the claim check (RC-identity-02, RC-identity-08). Staff decide that an owner died, never who receives
 * or which keys count: the notice doors are compliance doors only, recording one never touches the account, a freeze
 * only follows a spent second-person approval, and the claim check is a service door for svc-bank alone that reads the
 * owner's own keys and plan. A change that lets one person freeze an account, or staff answer a claim, fails here.
 * Each is asked over a recording stand-in for Postgres: what the door answers, and which statements it ran, in order.
 */
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '33333333-3333-4333-8333-333333333333';
const NOTICE = '44444444-4444-4444-8444-444444444445';
const HEIR = '55555555-5555-4555-8555-555555555555';
const CLAIM = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-11-01T12:00:00.000Z');
const LATER = new Date('2026-11-01T13:00:00.000Z');
const EARLIER = new Date('2026-10-01T00:00:00.000Z');

const noticeRow = (status: 'received' | 'rejected' | 'confirmed') => ({
  id: NOTICE,
  subject_user_id: SUBJECT,
  case_ref: 'case-1',
  status,
  reporter_kind: 'executor',
  evidence_document_ids: [],
  recorded_by: OPERATOR,
  received_at: EARLIER,
  decided_at: status === 'received' ? null : NOW,
  decided_by: status === 'received' ? null : OPERATOR,
  approved_by: status === 'confirmed' ? SECOND : null,
});

const approvalRow = (over: Record<string, unknown> = {}) => ({
  approval_id: 'appr-1',
  action_type: DEATH_NOTICE_CONFIRM_ACTION_TYPE,
  target_service: DEATH_NOTICE_TARGET_SERVICE,
  target_id: SUBJECT,
  expected_version: DEATH_NOTICE_VERSION,
  payload_hash: deathNoticePayloadHash(SUBJECT, NOTICE),
  requester_id: OPERATOR,
  approver_id: SECOND,
  policy_version: 'v1',
  operation_id: 'op-1',
  status: 'APPROVED',
  created_at: EARLIER,
  expires_at: LATER,
  approved_at: EARLIER,
  consumed_at: null,
  consumed_by_service: null,
  consumed_by_principal: null,
  consumed_request_id: null,
  kind: 'four_eyes',
  session_id: null,
  approvals_required: null,
  approvals_given: 1,
  policy_hash: null,
  ...over,
});

/** The rows of a live operator session, an active account and one received notice; `approval` for the confirm path. */
function noticeDb(opts: { approval?: Record<string, unknown> | null; consumes?: boolean } = {}) {
  return recordingSql(({ text }: SqlCall) => {
    if (/FROM sessions WHERE id = /.test(text)) return [{ revoked: false, mfa: true, expires_at: LATER }];
    if (/SELECT status FROM users WHERE id = /.test(text)) return [{ status: 'active' }];
    if (/FROM death_notices WHERE subject_user_id = \? AND case_ref = /.test(text)) return [];
    if (/INSERT INTO death_notices/.test(text)) return [noticeRow('received')];
    if (/SELECT subject_user_id FROM death_notices WHERE id = /.test(text)) return [{ subject_user_id: SUBJECT }];
    if (/FROM death_notices WHERE id = \? FOR UPDATE/.test(text)) return [noticeRow('received')];
    if (/UPDATE death_notices SET status = 'rejected'/.test(text)) return [noticeRow('rejected')];
    if (/FROM death_notices WHERE subject_user_id = \? AND status = 'confirmed'/.test(text)) return [];
    if (/FROM action_approvals WHERE approval_id = /.test(text)) return opts.approval ? [opts.approval] : [];
    if (/UPDATE action_approvals/.test(text))
      return opts.consumes === false || !opts.approval ? [] : [{ ...opts.approval, status: 'CONSUMED' }];
    if (/UPDATE users SET status = 'frozen'/.test(text)) return [{ version: '2' }];
    if (/UPDATE death_notices SET status = 'confirmed'/.test(text)) return [noticeRow('confirmed')];
    return undefined;
  });
}

const operator = () => contextWith(['admin:compliance'], { userId: OPERATOR, mfa: true });
const deps = (sql: unknown) => ({ sql: sql as never, now: () => NOW });
const ACCOUNT_WRITE = /UPDATE (users|sessions|api_keys|sub_accounts|navigator_session_projections)\b/;
const recordInput = {
  userId: SUBJECT,
  caseRef: 'case-1',
  reporterKind: 'executor' as const,
  evidenceDocumentIds: [],
  receivedAt: EARLIER.toISOString(),
};

describe('death notice gate (one person never freezes an account; staff never answer a claim)', () => {
  it('serves the four doors to admin:compliance only', async () => {
    const { sql, queries } = noticeDb();
    const api = createDeathNoticesRouter(() => deps(sql));
    expect(Object.keys(api._def.procedures).sort()).toEqual([
      'deathNotice.confirm',
      'deathNotice.forAccount',
      'deathNotice.record',
      'deathNotice.reject',
    ]);
    const calls = (c: ReturnType<typeof api.createCaller>) => [
      () => c.deathNotice.record(recordInput),
      () => c.deathNotice.forAccount({ userId: SUBJECT }),
      () => c.deathNotice.reject({ noticeId: NOTICE }),
      () => c.deathNotice.confirm({ noticeId: NOTICE, approvalId: 'appr-1' }),
    ];
    for (const scopes of [['identity:read', 'identity:write'], ['admin:read', 'admin:write'], ['support:ops']]) {
      for (const call of calls(api.createCaller(await contextWith(scopes, { userId: OPERATOR, mfa: true })))) {
        await expect(call(), scopes.join()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    }
    expect(queries).toEqual([]);
    // The compliance operator reaches the service, which reads the operator's own session first.
    await api.createCaller(await operator()).deathNotice.forAccount({ userId: SUBJECT });
    expect(queries[0]?.text).toMatch(/FROM sessions WHERE id = /);
  });

  it('recording and rejecting never touch the account', async () => {
    const recorded = noticeDb();
    await expect(recordDeathNotice(deps(recorded.sql), await operator(), recordInput)).resolves.toMatchObject({
      noticeId: NOTICE,
      status: 'received',
    });
    expect(recorded.queries.some((q) => /INSERT INTO death_notices/.test(q.text))).toBe(true);
    expect(recorded.queries.filter((q) => ACCOUNT_WRITE.test(q.text))).toEqual([]);

    const rejected = noticeDb();
    await expect(rejectDeathNotice(deps(rejected.sql), await operator(), NOTICE)).resolves.toMatchObject({ status: 'rejected' });
    expect(rejected.queries.filter((q) => ACCOUNT_WRITE.test(q.text))).toEqual([]);
  });

  it('confirming freezes only after a second person’s approval is spent', async () => {
    const confirm = async (db: ReturnType<typeof noticeDb>, ctx?: Context) =>
      confirmDeathNotice(deps(db.sql), ctx ?? (await operator()), { noticeId: NOTICE, approvalId: 'appr-1' }).catch((e: unknown) => e);

    // No approval, one the confirmer approved himself, one asked by someone else, one for the dead owner's own hand,
    // one for another notice, or one that is not spent: refused, and the account is not touched.
    for (const db of [
      noticeDb({ approval: null }),
      noticeDb({ approval: approvalRow({ approver_id: OPERATOR }) }),
      noticeDb({ approval: approvalRow({ requester_id: SECOND, approver_id: OPERATOR }) }),
      noticeDb({ approval: approvalRow({ approver_id: SUBJECT }) }),
      noticeDb({ approval: approvalRow({ payload_hash: deathNoticePayloadHash(SUBJECT, HEIR) }) }),
      noticeDb({ approval: approvalRow({ kind: 'same_person' }) }),
      noticeDb({ approval: approvalRow(), consumes: false }),
    ]) {
      expect(await confirm(db)).toMatchObject({ code: 'identity.death_notice_approval_required' });
      expect(db.queries.filter((q) => ACCOUNT_WRITE.test(q.text))).toEqual([]);
    }

    // A second person's approval, spent first; then the freeze and the revocations, in that order.
    const db = noticeDb({ approval: approvalRow() });
    expect(await confirm(db)).toMatchObject({ status: 'confirmed', approvedBy: SECOND });
    const at = (re: RegExp) => db.queries.findIndex((q) => re.test(q.text));
    const spent = at(/UPDATE action_approvals/);
    expect(spent).toBeGreaterThan(0);
    for (const write of [/UPDATE users SET status = 'frozen'/, /UPDATE sessions SET revoked/, /UPDATE api_keys SET revoked/]) {
      expect(at(write), String(write)).toBeGreaterThan(spent);
    }
  });

  it('the claim check is svc-bank’s alone and reads only the owner’s own keys and plan', async () => {
    expect([...RECOVERY_CLAIM_VERIFIERS]).toEqual(['svc-bank']);
    // The check takes the claim, never a caller: there is no principal or scope to hand it.
    expect(verifyRecoveryClaim.length).toBe(2);

    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as RecoveryPublicJwk;
    const claim = { userId: SUBJECT, heirUserId: HEIR, claimId: CLAIM };
    const signature = sign('sha256', Buffer.from(recoveryClaimMessage(claim), 'utf8'), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const owner = (values: readonly unknown[]) => values.includes(SUBJECT);
    const { sql, queries } = recordingSql(({ text, values }: SqlCall) => {
      if (/FROM users WHERE id = /.test(text) && owner(values)) return [{ status: 'frozen', version: '2' }];
      if (/FROM death_notices/.test(text) && owner(values)) return [{ id: NOTICE, frozen_version: '2', created_at: NOW }];
      if (/FROM recovery_plans/.test(text) && owner(values))
        return [{ heir_user_id: HEIR, threshold: 1, heir_status: 'active', changed_after: false }];
      if (/FROM recovery_keys/.test(text) && owner(values)) return [{ id: 'key-1', revoked_at: null, added_after: false }];
      return undefined;
    });
    const verdict = await verifyRecoveryClaim(sql as never, {
      ...claim,
      signatures: [{ publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, signature }],
    });
    expect(verdict).toEqual({ ok: true, noticeId: NOTICE, threshold: 1, signerKeyIds: ['key-1'] });
    // Every read of keys and plan is the owner's own rows.
    const reads = queries.filter((q) => /FROM (recovery_keys|recovery_plans)/.test(q.text));
    expect(reads.length).toBe(2);
    for (const read of reads) expect(read.text).toMatch(/(?:p\.)?user_id = \?/);
    for (const read of reads) expect(read.values).toContain(SUBJECT);
  });
});
