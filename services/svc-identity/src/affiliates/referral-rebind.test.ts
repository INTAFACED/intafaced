import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { ActionApprovalService } from '../auth/action-approval-service.js';
import { SqlActionApprovalStore } from '../auth/action-approval-store.js';
import { ReferralRebindService } from './referral-rebind.js';
import { ReferralService } from './referral-service.js';

// CM-referral-01 RF-3 (J-campaigns-05 #5, #6): a reviewed change of referrer, decided by a second person.

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OLD_REF = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEW_REF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OPERATOR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OPERATOR_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('referral rebind SQL (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const referral = new ReferralService(db.sql);
  let clock = new Date();
  const approvals = new ActionApprovalService(new SqlActionApprovalStore(db.sql), { ttlSeconds: 600 }, () => clock);
  const rebind = (windowSeconds: number | 'blank' = 600) =>
    new ReferralRebindService(db.sql, approvals, { attachWindowSeconds: windowSeconds === 'blank' ? undefined : windowSeconds });

  async function seedUser(id: string, handle: string, ageSeconds = 0) {
    await db.sql`
      INSERT INTO users (id, handle, email, password_hash, status, created_at)
      VALUES (${id}, ${handle}, ${handle + '@example.com'}, 'x', 'active', now() - make_interval(secs => ${ageSeconds}))
    `;
  }
  const edge = async () => (await db.sql`SELECT user_id, referrer_id, attributed_at FROM referral_edges WHERE user_id = ${ME}`)[0] ?? null;

  beforeEach(async () => {
    await db.truncateAll();
    clock = new Date();
    await seedUser(ME, 'rebinder', 3600);
    await seedUser(OLD_REF, 'oldref', 7200);
    await seedUser(NEW_REF, 'newref', 7200);
  });

  afterAll(async () => {
    await db.drop();
  });

  it('after the window: asks with a reason, a second person approves, the new parent applies from then on', async () => {
    const svc = rebind();
    // The link attach is refused once the window has closed.
    await expect(referral.attribute({ userId: ME, referrerId: NEW_REF }, { windowSeconds: 600 })).rejects.toMatchObject({
      code: 'referral.attach_window_closed',
    });
    const asked = await svc.request(ME, NEW_REF, 'Signed up before my friend sent the link');
    expect(asked).toMatchObject({ state: 'under_review', fromReferrerId: null, toReferrerId: NEW_REF });
    expect(asked.approvalId).toBeTruthy();
    // Asking again for the same referrer is the same open request.
    expect((await svc.request(ME, NEW_REF, 'again')).id).toBe(asked.id);
    await expect(svc.request(ME, OLD_REF, 'someone else')).rejects.toMatchObject({ code: 'referral.rebind_open' });

    // The requester cannot approve their own request.
    await expect(svc.decide(ME, asked.id, 'approve', 'self')).rejects.toMatchObject({ code: 'action_approval.same_person' });
    expect(await edge()).toBeNull();

    const done = await svc.decide(OPERATOR, asked.id, 'approve', 'Link sent before sign-up, checked');
    expect(done).toMatchObject({ state: 'approved', decidedBy: OPERATOR, toReferrerId: NEW_REF });
    expect(done.appliedAt).toBeInstanceOf(Date);
    expect((await edge())?.referrer_id).toBe(NEW_REF);
    // A repeat after a lost reply is the same decision; the approval was consumed once.
    expect((await svc.decide(OPERATOR_2, asked.id, 'approve', 'retry')).decidedBy).toBe(OPERATOR);
    const [approval] = await db.sql`SELECT status FROM action_approvals WHERE approval_id = ${asked.approvalId}`;
    expect(approval?.status).toBe('CONSUMED');
  });

  it('changes an existing referrer from the approval time and leaves stored accruals alone', async () => {
    await referral.attribute({ userId: ME, referrerId: OLD_REF });
    const before = await edge();
    await db.sql`
      INSERT INTO affiliate_commission_accruals (fee_event_id, beneficiary_id, payer_id, hop, rate, fee_amount, commission_amount, asset)
      VALUES ('TEST-fee-1', ${OLD_REF}, ${ME}, 0, '0.1', '50', '5', 'USDT')
    `;
    const accrualsBefore = await db.sql`SELECT * FROM affiliate_commission_accruals`;
    const svc = rebind();
    const asked = await svc.request(ME, NEW_REF, 'Wrong referrer at sign-up');
    expect(asked.fromReferrerId).toBe(OLD_REF);
    const done = await svc.decide(OPERATOR, asked.id, 'approve', 'Checked with both people');
    expect(done.fromReferrerId).toBe(OLD_REF);
    const after = await edge();
    expect(after?.referrer_id).toBe(NEW_REF);
    expect(after!.attributed_at.getTime()).toBeGreaterThanOrEqual(before!.attributed_at.getTime());
    expect(await db.sql`SELECT * FROM affiliate_commission_accruals`).toEqual(accrualsBefore);
  });

  it('a rejection records who and why and changes nothing; the person may ask again', async () => {
    const svc = rebind();
    const asked = await svc.request(ME, NEW_REF, 'Please attach me');
    await expect(svc.decide(ME, asked.id, 'reject', 'self')).rejects.toMatchObject({ code: 'action_approval.same_person' });
    const done = await svc.decide(OPERATOR, asked.id, 'reject', 'No evidence of the invitation');
    expect(done).toMatchObject({ state: 'rejected', decidedBy: OPERATOR, decisionReason: 'No evidence of the invitation' });
    expect(await edge()).toBeNull();
    await expect(svc.decide(OPERATOR, asked.id, 'approve', 'changed mind')).rejects.toMatchObject({ code: 'referral.rebind_not_open' });
    expect((await svc.request(ME, NEW_REF, 'New evidence attached')).id).not.toBe(asked.id);
  });

  it('the person can withdraw their own open request; nobody else can', async () => {
    const svc = rebind();
    const asked = await svc.request(ME, NEW_REF, 'Please attach me');
    await expect(svc.withdraw(NEW_REF, asked.id)).rejects.toMatchObject({ code: 'referral.rebind_not_found' });
    expect((await svc.withdraw(ME, asked.id)).state).toBe('withdrawn');
    await expect(svc.decide(OPERATOR, asked.id, 'approve', 'too late')).rejects.toMatchObject({ code: 'referral.rebind_not_open' });
  });

  it('a lapsed review expires and refuses the decision', async () => {
    const svc = rebind();
    const asked = await svc.request(ME, NEW_REF, 'Please attach me');
    clock = new Date(clock.getTime() + 601_000);
    await expect(svc.decide(OPERATOR, asked.id, 'approve', 'late')).rejects.toMatchObject({ code: 'action_approval.expired' });
    await db.sql`UPDATE referral_rebind_requests SET approval_expires_at = now() - interval '1 second' WHERE id = ${asked.id}`;
    expect((await svc.latestOf(ME))?.state).toBe('expired');
    expect(await edge()).toBeNull();
  });

  it('refuses when a link attach still applies, for self, a cycle, or the same referrer', async () => {
    await db.sql`UPDATE users SET created_at = now() WHERE id = ${ME}`;
    await expect(rebind().request(ME, NEW_REF, 'inside window')).rejects.toMatchObject({ code: 'referral.rebind_not_needed' });
    // A blank window means no link attach applies, so the reviewed path is open.
    expect((await rebind('blank').request(ME, NEW_REF, 'blank window')).state).toBe('under_review');
    await db.truncateAll();
    await seedUser(ME, 'rebinder', 3600);
    await seedUser(OLD_REF, 'oldref', 7200);
    await seedUser(NEW_REF, 'newref', 7200);
    await expect(rebind().request(ME, ME, 'self')).rejects.toMatchObject({ code: 'referral.self' });
    await referral.attribute({ userId: NEW_REF, referrerId: ME });
    await expect(rebind().request(ME, NEW_REF, 'cycle')).rejects.toMatchObject({ code: 'referral.cycle' });
    await referral.attribute({ userId: ME, referrerId: OLD_REF });
    await expect(rebind().request(ME, OLD_REF, 'same')).rejects.toMatchObject({ code: 'referral.already_set' });
    // Refusals write nothing.
    expect(await db.sql`SELECT id FROM referral_rebind_requests`).toHaveLength(0);
  });

  it('a request saved before its approval was filed is filed on the next ask', async () => {
    const failing = new ReferralRebindService(
      db.sql,
      {
        ...approvals,
        propose: async () => {
          throw new Error('crash after save');
        },
        approve: approvals.approve.bind(approvals),
        reject: approvals.reject.bind(approvals),
        revoke: approvals.revoke.bind(approvals),
        consume: approvals.consume.bind(approvals),
      },
      { attachWindowSeconds: 600 },
    );
    await expect(failing.request(ME, NEW_REF, 'Please attach me')).rejects.toThrow('crash after save');
    expect((await rebind().latestOf(ME))?.state).toBe('submitted');
    const filed = await rebind().request(ME, NEW_REF, 'Please attach me');
    expect(filed.state).toBe('under_review');
    expect(await db.sql`SELECT id FROM referral_rebind_requests`).toHaveLength(1);
  });

  it('an approval consumed before the relationship changed applies on the next decide', async () => {
    const svc = rebind();
    const asked = await svc.request(ME, NEW_REF, 'Please attach me');
    const [row] = await db.sql`SELECT * FROM referral_rebind_requests WHERE id = ${asked.id}`;
    // Simulate the crash: approved and consumed, but the edge write never ran.
    const { rebindPayloadHash } = await import('./referral-rebind.js');
    const hash = rebindPayloadHash({ id: asked.id, user_id: ME, from_referrer_id: null, to_referrer_id: NEW_REF });
    await approvals.approve(OPERATOR, asked.approvalId!, hash);
    await approvals.consume('svc-identity', {
      approvalId: asked.approvalId!,
      operationId: row!.approval_operation_id,
      payloadHash: hash,
      targetService: 'svc-identity',
      targetId: `referral.rebind:${asked.id}`,
      expectedVersion: '1',
      requestId: `referral.rebind:${asked.id}`,
    });
    expect(await edge()).toBeNull();
    // Its review time passing does not lapse it: the consumed approval is still applied, and it stays in the queue.
    await db.sql`UPDATE referral_rebind_requests SET approval_expires_at = now() - interval '1 second' WHERE id = ${asked.id}`;
    expect((await svc.latestOf(ME))?.state).toBe('under_review');
    expect((await svc.queue(10)).map((r) => r.id)).toContain(asked.id);
    const done = await svc.decide(OPERATOR_2, asked.id, 'approve', 'Finishing the approved change');
    expect(done).toMatchObject({ state: 'approved', decidedBy: OPERATOR });
    expect((await edge())?.referrer_id).toBe(NEW_REF);
  });

  it('a change of referrer since the request makes the approval stale; nothing changes', async () => {
    const svc = rebind('blank');
    const asked = await svc.request(ME, NEW_REF, 'Please attach me');
    // The person got a referrer some other way meanwhile (a sign-up completion path, outside the window).
    await referral.attribute({ userId: ME, referrerId: OLD_REF });
    await expect(svc.decide(OPERATOR, asked.id, 'approve', 'checked')).rejects.toMatchObject({ code: 'referral.rebind_stale' });
    expect((await edge())?.referrer_id).toBe(OLD_REF);
    expect((await svc.latestOf(ME))?.state).toBe('expired');
  });

  it('once a reviewer decided, the person cannot withdraw; a retried reject records the first rejection', async () => {
    const svc = rebind();
    const asked = await svc.request(ME, NEW_REF, 'Please attach me');
    // The reviewer's reject reached the approval, then the reply was lost before the request was updated.
    await approvals.reject(OPERATOR, asked.approvalId!);
    await expect(svc.withdraw(ME, asked.id)).rejects.toMatchObject({ code: 'referral.rebind_not_open' });
    const done = await svc.decide(OPERATOR_2, asked.id, 'reject', 'No evidence of the invitation');
    expect(done).toMatchObject({ state: 'rejected', decidedBy: OPERATOR });
  });

  it('an unset review lifetime refuses by name and leaves no request behind', async () => {
    const unset = new ActionApprovalService(new SqlActionApprovalStore(db.sql), { ttlSeconds: undefined });
    const svc = new ReferralRebindService(db.sql, unset, { attachWindowSeconds: 600 });
    await expect(svc.request(ME, NEW_REF, 'Please attach me')).rejects.toMatchObject({ code: 'action_approval.ttl_unset' });
    expect(await db.sql`SELECT id FROM referral_rebind_requests`).toHaveLength(0);
    expect((await rebind().request(ME, OLD_REF, 'Another referrer')).state).toBe('under_review');
  });

  it('neither the referrer it moves to nor the one it moves from may decide the request', async () => {
    await referral.attribute({ userId: ME, referrerId: OLD_REF });
    const svc = rebind();
    const asked = await svc.request(ME, NEW_REF, 'Wrong referrer at sign-up');
    for (const who of [NEW_REF, OLD_REF])
      for (const decision of ['approve', 'reject'] as const)
        await expect(svc.decide(who, asked.id, decision, 'interested')).rejects.toMatchObject({ code: 'referral.rebind_interested' });
    expect((await edge())?.referrer_id).toBe(OLD_REF);
    expect((await svc.latestOf(ME))?.state).toBe('under_review');
    expect((await svc.decide(OPERATOR, asked.id, 'approve', 'Checked with both people')).state).toBe('approved');
  });
}
