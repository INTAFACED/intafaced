import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { BankApproverEligibilityPort, BankApproverEligibilityResult } from '@intafaced/contracts';
import { MemoryLedger, formatAmount, parseAmount as amt, userAvailable, withdrawalHoldAccount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayError } from '../../payment-service.js';
import { CardSandboxAdapter } from '../../rails/card-sandbox.js';
import { RailRegistry } from '../../rails/registry.js';
import { UserMoneyService } from '../../user-money-service.js';
import { WithdrawalApprovalError } from './errors.js';
import { createWithdrawalApprovalGuards } from './guard.js';
import { WithdrawalApprovalService, approvalMoneyOf, type WithdrawalApprovalMoney } from './service.js';
import type { SetPolicyInput } from './schemas.js';

/** Multi-approval for withdrawals against a real Postgres and the reference ledger. TEST figures only. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_withdrawal_approvals_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const SECRET = 'svc-pay-withdrawal-approvals-secret-at-least-32';
const USER = '11111111-1111-4111-8111-111111111111';
const A1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const A2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const A3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const OUTSIDER = 'aaaaaaaa-0000-4000-8000-000000000009';
const TEAM = 'bbbbbbbb-0000-4000-8000-000000000001';
const OPERATOR = '99999999-9999-4999-8999-999999999999';
const DESTINATION = { kind: 'bank', ref: 'DE89370400440532013000' };

/** Who the bank would call eligible. Anyone not listed is not on the team. */
class FakeTeam implements BankApproverEligibilityPort {
  eligible = new Set([A1, A2, A3]);
  down = false;
  calls = 0;
  async check(input: { accountId: string; userId: string }): Promise<BankApproverEligibilityResult> {
    this.calls += 1;
    if (this.down) return { state: 'unavailable', code: 'bank.approver_eligibility_unavailable' };
    return this.eligible.has(input.userId) ? { state: 'eligible', role: 'checker' } : { state: 'not_a_member' };
  }
}

describe('multi-approval withdrawals (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let ledger: MemoryLedger;
  let money: UserMoneyService;
  let team: FakeTeam;
  let clock: Date;
  let executeFault: (() => Error | null) | null;
  let service: WithdrawalApprovalService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`
      TRUNCATE pay.withdrawal_approval_events, pay.withdrawal_approval_decisions, pay.withdrawal_approval_requests,
               pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`;
    // The policy history is append-only by trigger, so each test uses its own asset-free user key instead of truncating.
    ledger = new MemoryLedger();
    const rails = new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 })]);
    money = new UserMoneyService(db.sql, ledger, rails, {
      operatorCreditRails: ['card-sandbox'],
      claimGuards: createWithdrawalApprovalGuards({ now: () => clock }),
    });
    await money.credit({
      userId: USER,
      assetId: 'USDT',
      amount: amt('100'),
      rail: 'card-sandbox',
      railRef: `psp_${Math.random()}`,
      creditedBy: OPERATOR,
    });
    team = new FakeTeam();
    clock = new Date();
    executeFault = null;
    const real = approvalMoneyOf(money);
    const moneyPort: WithdrawalApprovalMoney = {
      ...real,
      execute: async (t) => {
        const fault = executeFault?.();
        if (fault) throw fault;
        return real.execute(t);
      },
    };
    service = new WithdrawalApprovalService({ sql: db.sql, money: moneyPort, eligibility: team, now: () => clock });
  });

  const policy = (over: Partial<SetPolicyInput> = {}): SetPolicyInput => ({
    userId: USER,
    assetId: 'USDT',
    active: true,
    teamAccountId: TEAM,
    requiredApprovals: 2,
    threshold: '50',
    windowSeconds: 3600,
    expirySeconds: 600,
    holdAtSubmit: false,
    ...over,
  });
  const ask = (clientRef = 'w-1', amount = '60') => ({
    assetId: 'USDT',
    amount,
    railId: 'card-sandbox',
    destination: DESTINATION,
    clientRef,
  });
  const availableOf = async () => formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount);
  const holdOf = async (id: string, attempt = 0) =>
    formatAmount((await ledger.balance(withdrawalHoldAccount(USER, 'USDT', `${id}:${attempt}`))).amount);
  const rowOf = async (clientRef: string) => {
    const [r] = await db.sql<Array<{ id: string; status: string; failure_code: string | null }>>`
      SELECT id, status::text AS status, failure_code FROM pay.withdrawals WHERE user_id = ${USER} AND client_ref = ${clientRef}`;
    return r;
  };
  const txExists = async (key: string) => (await ledger.getTxByKey(key)) !== null;
  async function code(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      if (e instanceof WithdrawalApprovalError || e instanceof PayError) return e.code;
      throw e;
    }
    throw new Error('expected a refusal');
  }

  // ── policy ────────────────────────────────────────────────────────────────

  it('with no policy a request refuses policy_unset and the direct door is never gated', async () => {
    await expect(code(service.propose(USER, ask()))).resolves.toBe('withdrawal_approval.policy_unset');
    await expect(
      service.assertDirectAllowed({ userId: USER, assetId: 'USDT', amount: amt('60'), clientRef: 'w-1' }),
    ).resolves.toBeUndefined();
  });

  it('a withdrawal under the threshold goes direct; a request for it refuses not_required', async () => {
    await service.setPolicy('founder', policy());
    await expect(code(service.propose(USER, ask('w-1', '30')))).resolves.toBe('withdrawal_approval.not_required');
    await expect(
      service.assertDirectAllowed({ userId: USER, assetId: 'USDT', amount: amt('30'), clientRef: 'w-1' }),
    ).resolves.toBeUndefined();
  });

  it('the threshold applies to the sum in the window, so a split cannot slip under it', async () => {
    await service.setPolicy('founder', policy());
    await money.withdraw({
      userId: USER,
      assetId: 'USDT',
      amount: amt('30'),
      rail: 'card-sandbox',
      destination: DESTINATION,
      clientRef: 'direct-1',
    });
    // 30 already left in the window; another 30 reaches 60 >= 50: the direct door refuses and a request is allowed.
    await expect(
      code(service.assertDirectAllowed({ userId: USER, assetId: 'USDT', amount: amt('30'), clientRef: 'direct-2' })),
    ).resolves.toBe('withdrawal_approval.required');
    const req = await service.propose(USER, ask('split-2', '30'));
    expect(req.status).toBe('pending');
    // A window that has passed forgets it.
    clock = new Date(clock.getTime() + 3601 * 1000);
    await expect(
      service.assertDirectAllowed({ userId: USER, assetId: 'USDT', amount: amt('30'), clientRef: 'direct-3' }),
    ).resolves.toBeUndefined();
  });

  it('an inactive policy sends withdrawals direct again, and the latest event wins', async () => {
    await service.setPolicy('founder', policy());
    await service.setPolicy('founder', policy({ active: false }));
    await expect(
      service.assertDirectAllowed({ userId: USER, assetId: 'USDT', amount: amt('90'), clientRef: 'w-1' }),
    ).resolves.toBeUndefined();
    expect((await service.policy(USER, 'USDT'))?.active).toBe(false);
  });

  it('the direct door refuses a reference that names a request which has not reached its approvals', async () => {
    await service.setPolicy('founder', policy());
    await service.propose(USER, ask());
    await expect(code(service.assertDirectAllowed({ userId: USER, assetId: 'USDT', amount: amt('60'), clientRef: 'w-1' }))).resolves.toBe(
      'withdrawal_approval.required',
    );
  });

  it('the direct door refuses a reference that names an approved request: only approve or the sweep sends its frozen terms', async () => {
    await service.setPolicy('founder', policy());
    const req = await service.propose(USER, ask());
    await db.sql`UPDATE pay.withdrawal_approval_requests SET status = 'approved' WHERE id = ${req.id}`;
    await expect(code(service.assertDirectAllowed({ userId: USER, assetId: 'USDT', amount: amt('1'), clientRef: 'w-1' }))).resolves.toBe(
      'withdrawal_approval.required',
    );
  });

  it('a failed earlier attempt of a reference is a fresh ask and meets the policy again', async () => {
    await db.sql`
      INSERT INTO pay.withdrawals (user_id, client_ref, asset_id, amount, rail, destination, status, failure_code)
      VALUES (${USER}, 'retry-1', 'USDT', 1, 'card-sandbox', ${db.sql.json(DESTINATION as never)}, 'failed', 'pay.rail_declined')`;
    await service.setPolicy('founder', policy());
    await expect(
      code(service.assertDirectAllowed({ userId: USER, assetId: 'USDT', amount: amt('60'), clientRef: 'retry-1' })),
    ).resolves.toBe('withdrawal_approval.required');
  });

  it('the claim itself refuses other terms on an approved request reference, whatever the pre-check saw', async () => {
    await service.setPolicy('founder', policy());
    const req = await service.propose(USER, ask());
    await db.sql`UPDATE pay.withdrawal_approval_requests SET status = 'approved' WHERE id = ${req.id}`;
    await expect(
      money.withdraw({ userId: USER, assetId: 'USDT', amount: amt('1'), rail: 'card-sandbox', destination: DESTINATION, clientRef: 'w-1' }),
    ).rejects.toMatchObject({ code: 'pay.guard_withdrawal_approval_terms' });
  });

  it('a full send on a pending hold-at-submit request is refused by the claim; only the hold-only claim passes', async () => {
    await service.setPolicy('founder', policy({ holdAtSubmit: true }));
    await service.propose(USER, ask());
    await expect(
      money.withdraw({
        userId: USER,
        assetId: 'USDT',
        amount: amt('60'),
        rail: 'card-sandbox',
        destination: DESTINATION,
        clientRef: 'w-1',
      }),
    ).rejects.toMatchObject({ code: 'pay.guard_withdrawal_approval_required' });
    expect((await rowOf('w-1'))?.status).toBe('pending');
  });

  it('two direct withdrawals that are each under the threshold and together over it cannot both claim', async () => {
    await service.setPolicy('founder', policy());
    const go = (clientRef: string) =>
      money.withdraw({ userId: USER, assetId: 'USDT', amount: amt('30'), rail: 'card-sandbox', destination: DESTINATION, clientRef });
    const results = await Promise.allSettled([go('race-1'), go('race-2')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'pay.guard_withdrawal_approval_required' });
  });

  // ── the approvals ─────────────────────────────────────────────────────────

  it('2-of-3: the same person approving twice counts once; the second distinct approver runs the withdrawal once', async () => {
    await service.setPolicy('founder', policy());
    const req = await service.propose(USER, ask());
    // No hold, no row, no rail until the approvals exist.
    expect(await rowOf('w-1')).toBeUndefined();
    expect(await availableOf()).toBe('100');

    const once = await service.approve(A1, req.id);
    const twice = await service.approve(A1, req.id);
    expect(once.approvalCount).toBe(1);
    expect(twice.approvalCount).toBe(1);
    expect(twice.status).toBe('pending');
    expect(await rowOf('w-1')).toBeUndefined();

    const done = await service.approve(A2, req.id);
    expect(done.status).toBe('executed');
    expect(done.approvalCount).toBe(2);
    expect((await rowOf('w-1'))?.status).toBe('sent');
    expect(await availableOf()).toBe('40');
    // A third approver after the fact changes nothing and sends nothing more.
    expect((await service.approve(A3, req.id)).status).toBe('executed');
    expect(await availableOf()).toBe('40');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('the initiator cannot approve or reject their own request, and an outsider cannot either', async () => {
    await service.setPolicy('founder', policy());
    const req = await service.propose(USER, ask());
    team.eligible.add(USER);
    await expect(code(service.approve(USER, req.id))).resolves.toBe('withdrawal_approval.initiator_cannot_approve');
    await expect(code(service.reject(USER, req.id))).resolves.toBe('withdrawal_approval.initiator_cannot_approve');
    await expect(code(service.approve(OUTSIDER, req.id))).resolves.toBe('withdrawal_approval.approver_not_eligible');
    await expect(code(service.reject(OUTSIDER, req.id))).resolves.toBe('withdrawal_approval.approver_not_eligible');
    const [n] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.withdrawal_approval_decisions`;
    expect(n!.n).toBe(0);
  });

  it('an unreachable or unwired team counts nothing', async () => {
    await service.setPolicy('founder', policy());
    const req = await service.propose(USER, ask());
    team.down = true;
    await expect(code(service.approve(A1, req.id))).resolves.toBe('withdrawal_approval.eligibility_unavailable');
    const unwired = new WithdrawalApprovalService({ sql: db.sql, money: approvalMoneyOf(money), now: () => clock });
    await expect(code(unwired.approve(A1, req.id))).resolves.toBe('withdrawal_approval.eligibility_unwired');
    const [n] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.withdrawal_approval_decisions`;
    expect(n!.n).toBe(0);
    expect((await service.get(USER, req.id)).status).toBe('pending');
  });

  it('the terms are frozen at submit: a retry with the same terms is the same request, changed terms conflict', async () => {
    await service.setPolicy('founder', policy());
    const a = await service.propose(USER, ask());
    const b = await service.propose(USER, ask());
    expect(b.id).toBe(a.id);
    await expect(code(service.propose(USER, ask('w-1', '70')))).resolves.toBe('withdrawal_approval.conflict');
    // Raising the threshold later does not change a request already made.
    await service.setPolicy('founder', policy({ requiredApprovals: 1 }));
    expect((await service.get(USER, a.id)).requiredApprovals).toBe(2);
  });

  // ── hold at submission ────────────────────────────────────────────────────

  it('hold at submit: the amount is held once at submission and the last approval sends it', async () => {
    await service.setPolicy('founder', policy({ holdAtSubmit: true }));
    const req = await service.propose(USER, ask());
    const row = (await rowOf('w-1'))!;
    expect(row.status).toBe('pending');
    expect(await availableOf()).toBe('40');
    expect(await holdOf(row.id)).toBe('60');
    // A retried submit holds nothing more.
    await service.propose(USER, ask());
    expect(await availableOf()).toBe('40');

    await service.approve(A1, req.id);
    const done = await service.approve(A2, req.id);
    expect(done.status).toBe('executed');
    expect((await rowOf('w-1'))?.status).toBe('sent');
    expect(await holdOf(row.id)).toBe('0');
    expect(await availableOf()).toBe('40');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('expiry without a hold ends the request and moves nothing', async () => {
    await service.setPolicy('founder', policy());
    const req = await service.propose(USER, ask());
    clock = new Date(clock.getTime() + 601 * 1000);
    await expect(code(service.approve(A1, req.id))).resolves.toBe('withdrawal_approval.expired');
    expect((await service.settleDue('system')).expired).toBe(1);
    expect((await service.get(USER, req.id)).status).toBe('expired');
    expect(await availableOf()).toBe('100');
    await expect(code(service.approve(A1, req.id))).resolves.toBe('withdrawal_approval.not_pending');
  });

  it('expiry with a hold reverses it once, however often the sweep runs', async () => {
    await service.setPolicy('founder', policy({ holdAtSubmit: true }));
    const req = await service.propose(USER, ask());
    const row = (await rowOf('w-1'))!;
    await service.approve(A1, req.id);
    expect(await availableOf()).toBe('40');
    clock = new Date(clock.getTime() + 601 * 1000);

    const first = await service.settleDue('system');
    expect(first).toMatchObject({ expired: 1, released: 1, failures: [] });
    expect(await availableOf()).toBe('100');
    expect(await holdOf(row.id)).toBe('0');
    expect(await txExists(`withdraw.reverse:${row.id}:0`)).toBe(true);

    const second = await service.settleDue('system');
    expect(second).toMatchObject({ expired: 0, released: 0, resumed: 0 });
    expect(await availableOf()).toBe('100');
    expect((await rowOf('w-1'))?.failure_code).toBe('withdrawal.canceled');
    // The reference is dead: neither door reopens it.
    await expect(code(service.assertDirectAllowed({ userId: USER, assetId: 'USDT', amount: amt('60'), clientRef: 'w-1' }))).resolves.toBe(
      'withdrawal_approval.required',
    );
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a crash after the expiry was written but before the hold was released is finished by the sweep', async () => {
    await service.setPolicy('founder', policy({ holdAtSubmit: true }));
    const req = await service.propose(USER, ask());
    clock = new Date(clock.getTime() + 601 * 1000);
    // The expiry commits; the release never ran.
    await db.sql`UPDATE pay.withdrawal_approval_requests SET status = 'expired' WHERE id = ${req.id}`;
    expect(await availableOf()).toBe('40');
    const swept = await service.settleDue('system');
    expect(swept.released).toBe(1);
    expect(await availableOf()).toBe('100');
  });

  it('a rejection ends the request and gives the hold back once; any eligible refusal is final', async () => {
    await service.setPolicy('founder', policy({ holdAtSubmit: true }));
    const req = await service.propose(USER, ask());
    await service.approve(A1, req.id);
    const out = await service.reject(A2, req.id);
    expect(out.status).toBe('rejected');
    expect(await availableOf()).toBe('100');
    expect((await service.reject(A2, req.id)).status).toBe('rejected');
    expect(await availableOf()).toBe('100');
    await expect(code(service.approve(A3, req.id))).resolves.toBe('withdrawal_approval.not_pending');
  });

  it('the initiator can cancel while it waits; the hold goes back and the reference stays dead', async () => {
    await service.setPolicy('founder', policy({ holdAtSubmit: true }));
    const req = await service.propose(USER, ask());
    expect(await availableOf()).toBe('40');
    expect((await service.cancel(USER, req.id)).status).toBe('canceled');
    expect(await availableOf()).toBe('100');
    expect((await service.cancel(USER, req.id)).status).toBe('canceled');
    await expect(code(service.cancel(A1, req.id))).resolves.toBe('withdrawal_approval.not_found');
    await expect(
      code(
        service.propose(USER, ask()).then(() =>
          money.withdraw({
            userId: USER,
            assetId: 'USDT',
            amount: amt('60'),
            rail: 'card-sandbox',
            destination: DESTINATION,
            clientRef: 'w-1',
          }),
        ),
      ),
    ).resolves.toBe('pay.withdrawal_canceled');
    expect(await availableOf()).toBe('100');
  });

  // ── crash and refusal at dispatch ─────────────────────────────────────────

  it('a crash between the last approval and the dispatch resumes under the same key and sends once', async () => {
    await service.setPolicy('founder', policy({ holdAtSubmit: true }));
    const req = await service.propose(USER, ask());
    await service.approve(A1, req.id);
    executeFault = () => new PayError('ledger outcome unknown', 'pay.ledger_outcome_unknown');
    await expect(code(service.approve(A2, req.id))).resolves.toBe('pay.ledger_outcome_unknown');
    expect((await service.get(USER, req.id)).status).toBe('approved');
    const row = (await rowOf('w-1'))!;
    expect(row.status).toBe('pending');
    expect(await availableOf()).toBe('40');

    // The restart: the sweep runs the same frozen terms.
    executeFault = null;
    const swept = await service.settleDue('system');
    expect(swept).toMatchObject({ resumed: 1, failures: [] });
    expect((await service.get(USER, req.id)).status).toBe('executed');
    expect((await rowOf('w-1'))?.id).toBe(row.id);
    expect((await rowOf('w-1'))?.status).toBe('sent');
    expect(await availableOf()).toBe('40');
    expect(await settleCount(row.id)).toBe(1);
    // A repeat of the sweep, and of the approval, send nothing more.
    expect((await service.settleDue('system')).resumed).toBe(0);
    await service.approve(A3, req.id);
    expect(await availableOf()).toBe('40');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  async function settleCount(id: string): Promise<number> {
    return (await txExists(`withdraw.settle:${id}:0`)) ? 1 : 0;
  }

  it('a crash without a hold also resumes under the same client reference and sends once', async () => {
    await service.setPolicy('founder', policy());
    const req = await service.propose(USER, ask());
    await service.approve(A1, req.id);
    executeFault = () => new PayError('rail outcome unknown', 'pay.rail_outcome_unknown');
    await expect(code(service.approve(A2, req.id))).resolves.toBe('pay.rail_outcome_unknown');
    expect(await availableOf()).toBe('100');
    executeFault = null;
    await service.settleDue('system');
    expect((await rowOf('w-1'))?.status).toBe('sent');
    expect(await availableOf()).toBe('40');
  });

  it('a refusal at dispatch ends the request failed and gives a held amount back once', async () => {
    await service.setPolicy('founder', policy({ holdAtSubmit: true }));
    const req = await service.propose(USER, ask());
    await service.approve(A1, req.id);
    executeFault = () => new PayError('rail refused', 'pay.rail_failed');
    await expect(code(service.approve(A2, req.id))).resolves.toBe('pay.rail_failed');
    const view = await service.get(USER, req.id);
    expect(view.status).toBe('failed');
    expect(view.failureCode).toBe('pay.rail_failed');
    expect(await availableOf()).toBe('100');
    expect((await service.settleDue('system')).resumed).toBe(0);
    expect(await availableOf()).toBe('100');
  });

  it('a withdrawal the customer cancelled while it waited ends the request canceled at the last approval', async () => {
    await service.setPolicy('founder', policy({ holdAtSubmit: true }));
    const req = await service.propose(USER, ask());
    const row = (await rowOf('w-1'))!;
    await money.cancelWithdrawal({ userId: USER, withdrawalId: row.id });
    await service.approve(A1, req.id);
    await expect(code(service.approve(A2, req.id))).resolves.toBe('pay.withdrawal_canceled');
    expect((await service.get(USER, req.id)).status).toBe('canceled');
    expect(await availableOf()).toBe('100');
  });

  it('a hold at submit with too little available refuses at once and leaves no request waiting', async () => {
    await service.setPolicy('founder', policy({ holdAtSubmit: true }));
    await expect(code(service.propose(USER, ask('big', '150')))).resolves.toBe('withdrawal_approval.insufficient_funds');
    const [n] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.withdrawal_approval_requests`;
    expect(n!.n).toBe(0);
    expect(await availableOf()).toBe('100');
  });

  // ── reads ─────────────────────────────────────────────────────────────────

  it('a request reads for its initiator and for an eligible approver, and as not found for anyone else', async () => {
    await service.setPolicy('founder', policy());
    const req = await service.propose(USER, ask());
    expect((await service.get(USER, req.id)).id).toBe(req.id);
    expect((await service.get(A1, req.id)).approvedByMe).toBe(false);
    await expect(code(service.get(OUTSIDER, req.id))).resolves.toBe('withdrawal_approval.not_found');
    await service.approve(A1, req.id);
    expect((await service.get(A1, req.id)).approvedByMe).toBe(true);
    expect((await service.get(A2, req.id)).approvedByMe).toBe(false);
  });

  it('lists need an explicit page size, and a team list needs an eligible viewer and leaves out their own requests', async () => {
    await service.setPolicy('founder', policy());
    await service.propose(USER, ask('w-1'));
    clock = new Date(clock.getTime() + 1000);
    await service.propose(USER, ask('w-2', '70'));
    await expect(code(service.list(USER, {}))).resolves.toBe('withdrawal_approval.list_limit_unset');
    expect((await service.list(USER, { limit: 10 })).map((r) => r.clientRef)).toEqual(['w-2', 'w-1']);
    expect((await service.listForTeam(A1, { teamAccountId: TEAM, limit: 10 })).length).toBe(2);
    await expect(code(service.listForTeam(OUTSIDER, { teamAccountId: TEAM, limit: 10 }))).resolves.toBe(
      'withdrawal_approval.approver_not_eligible',
    );
    expect(await service.listForTeam(A1, { teamAccountId: TEAM, status: 'executed', limit: 10 })).toEqual([]);
  });

  it('every step is on the append-only log', async () => {
    await service.setPolicy('founder', policy());
    const req = await service.propose(USER, ask());
    await service.approve(A1, req.id);
    await service.approve(A2, req.id);
    const kinds = await db.sql<
      Array<{ kind: string }>
    >`SELECT kind FROM pay.withdrawal_approval_events WHERE request_id = ${req.id} ORDER BY seq`;
    expect(kinds.map((k) => k.kind)).toEqual(['proposed', 'approved', 'approved', 'quorum', 'executed']);
    await expect(db.sql`UPDATE pay.withdrawal_approval_events SET kind = 'x' WHERE request_id = ${req.id}`).rejects.toThrow(/append-only/);
    await expect(db.sql`DELETE FROM pay.withdrawal_approval_decisions WHERE request_id = ${req.id}`).rejects.toThrow(/append-only/);
  });
});
