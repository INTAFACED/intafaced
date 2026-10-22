import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MerchantControlError } from '../../merchant-account-controls.js';
import { createPayNamespaces } from '../../namespaces/index.js';
import { truncatePayForTest } from '../../payment-events-test-reset.js';
import { BankPayoutAbsentAdapter } from '../../rails/bank-payout.js';
import { CardSandboxAdapter } from '../../rails/card-sandbox.js';
import { RailRegistry } from '../../rails/registry.js';
import { PayGuardRefusal, composeGuards } from '../../seams/guards.js';
import { UserMoneyService } from '../../user-money-service.js';
import { createCustodyPolicyGuards, loadCustodyPolicyMode } from './guards.js';
import type { PolicyRule } from './schemas.js';

/**
 * Custody transaction policy (W-custody-ops-07) through the real founderAdmin router and the real withdrawal claim,
 * against a real Postgres. Every figure is a TEST value; the policy has no defaults of its own.
 */
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
    .withDatabase('intafaced_custody_policy_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const SECRET = 'svc-pay-custody-policy-test-secret-at-least-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';
type Err = { code: string; message?: string };
async function refused(p: Promise<unknown>): Promise<Err> {
  try {
    await p;
  } catch (e) {
    return e as Err;
  }
  throw new Error('expected the call to be refused');
}

const allowAll: PolicyRule = { id: 'allow-all', action: 'allow', match: {} };
const denyBad: PolicyRule = { id: 'deny-bad', action: 'block', match: { destinationsIn: ['GB82WEST12345698765432'] } };
const cumulative: PolicyRule = {
  id: 'cum',
  action: 'block',
  match: { assets: ['USDT'], cumulativeOver: { amount: '15', unit: 'native', windowSeconds: 86_400 } },
};
const approve: PolicyRule = {
  id: 'big',
  action: 'approve',
  match: { assets: ['USDT'], amountOver: { amount: '100', unit: 'native' } },
  approval: { members: ['founder-a', 'founder-b'], threshold: 2, initiatorMayApprove: false },
};

describe('custody transaction policy (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let founder = 'founder-a';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  const policy = () => api.founderAdmin.custody.policy;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const founderAuthority = async () => {
      if (founder === '') throw new MerchantControlError('operator.denied');
      return founder;
    };
    const userId = randomUUID();
    const principal: Principal = {
      userId,
      sub: userId,
      sid: randomUUID(),
      scopes: [...SESSION_SCOPES],
      mfa: true,
      tier: 'full',
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    api = createPayNamespaces({ founderAuthority, custody: { sql: db.sql } }).createCaller({
      principal,
      service: null,
      region: 'DE',
      requestId: 'r',
    });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    founder = 'founder-a';
    await db.sql.unsafe(`ALTER TABLE pay.custody_policy_versions DISABLE TRIGGER custody_policy_immutable_trg`);
    await db.sql.unsafe(`DELETE FROM pay.custody_policy_versions`);
    await db.sql.unsafe(`ALTER TABLE pay.custody_policy_versions ENABLE TRIGGER custody_policy_immutable_trg`);
    await truncatePayForTest(db.sql, 'pay', `TRUNCATE pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`);
    // The existing custody approval quorum (W-custody-ops-06): one registered approver other than the initiator. TEST values.
    founder = 'owner';
    await db.sql.unsafe(`TRUNCATE pay.custody_task_quorum_events, pay.custody_approver_events RESTART IDENTITY CASCADE`);
    await api.founderAdmin.custody.approvalSettings.setQuorum({ kind: 'config', requiredApprovals: 1, expirySeconds: 600 });
    await api.founderAdmin.custody.approvers.register({ userId: 'founder-b', label: 'TEST approver', role: 'founder' });
    founder = 'founder-a';
  }, 30_000);

  const config = () => api.founderAdmin.custody.config;
  /** Propose as founder-a, approve as founder-b: the task runs the policy applier. */
  async function proposeAndApprove(payload: Record<string, unknown>) {
    founder = 'founder-a';
    const task = await config().propose({ scope: 'policy', title: 'TEST publish policy', payload, clientRef: `policy-${randomUUID()}` });
    founder = 'founder-b';
    const out = await config()
      .approve({ taskId: task.id, payloadHash: task.payloadHash })
      .then(
        (t: unknown) => t,
        (e: unknown) => e,
      );
    founder = 'founder-a';
    return { task, out };
  }
  async function publish(rules: PolicyRule[]) {
    founder = 'founder-a';
    const draft = await policy().draft({ rules, note: 'TEST policy', expectedDraftVersion: null });
    await proposeAndApprove({ version: draft.version, rulesHash: draft.rulesHash });
    return policy().current();
  }

  it('is required by default (fail closed); off must be explicit; anything else refuses boot', () => {
    expect(loadCustodyPolicyMode({})).toBe('required');
    expect(loadCustodyPolicyMode({ PAY_CUSTODY_POLICY: 'off' })).toBe('off');
    expect(loadCustodyPolicyMode({ PAY_CUSTODY_POLICY: 'required' })).toBe('required');
    expect(() => loadCustodyPolicyMode({ PAY_CUSTODY_POLICY: '' })).toThrow(/off.*required/);
    expect(() => loadCustodyPolicyMode({ PAY_CUSTODY_POLICY: 'on' })).toThrow(/off.*required/);
  });

  it('no policy published: current and simulate refuse unset', async () => {
    expect((await refused(policy().current())).message).toMatch(/custody_policy\.unset/);
    const sim = policy().simulate({
      userId: USER,
      assetId: 'USDT',
      amount: '1',
      network: 'card-sandbox',
      destinationKind: 'bank',
      destinationRef: 'DE01',
      txType: 'transfer',
    });
    expect((await refused(sim)).message).toMatch(/custody_policy\.unset/);
  });

  it('an invalid draft is refused with per-rule problems and nothing is saved; validate reports without saving', async () => {
    const bad = [{ id: 'x', action: 'approve', match: {} }];
    const err = await refused(policy().draft({ rules: bad, note: 'TEST', expectedDraftVersion: null }));
    expect(err.message).toMatch(/custody_policy\.draft_invalid.*x: action approve needs an approval group/);
    expect(await policy().validate({ rules: bad })).toEqual({
      valid: false,
      problems: [{ ruleId: 'x', problem: 'action approve needs an approval group' }],
    });
    expect(await policy().validate({ rules: [allowAll] })).toEqual({ valid: true, problems: [] });
    expect(await policy().list({})).toEqual([]);
  });

  it('draft edits need the expected version; publishing is an approved policy config task, never the initiator alone', async () => {
    const d1 = await policy().draft({ rules: [allowAll], note: 'TEST v1', expectedDraftVersion: null });
    expect(d1).toMatchObject({
      version: 1,
      status: 'draft',
      editedBy: 'founder-a',
      publishedBy: null,
      approvalTaskId: null,
      approvedBy: [],
    });
    expect((await refused(policy().draft({ rules: [allowAll], note: 'TEST', expectedDraftVersion: null }))).message).toMatch(
      /draft_differs/,
    );
    const d1b = await policy().draft({ rules: [denyBad, allowAll], note: 'TEST v1 edited', expectedDraftVersion: 1 });
    expect(d1b).toMatchObject({ version: 1, note: 'TEST v1 edited' });
    expect(d1b.rulesHash).not.toBe(d1.rulesHash);

    // The initiator cannot approve their own task (existing quorum rule).
    founder = 'founder-a';
    const own = await config().propose({
      scope: 'policy',
      title: 'TEST',
      payload: { version: 1, rulesHash: d1b.rulesHash },
      clientRef: `own-${randomUUID()}`,
    });
    expect(await refused(config().approve({ taskId: own.id, payloadHash: own.payloadHash }))).toBeTruthy();
    expect((await policy().list({}))[0].status).toBe('draft');

    // A task naming the old rules hash fails and publishes nothing.
    const stale = await proposeAndApprove({ version: 1, rulesHash: d1.rulesHash });
    expect(stale.out).toBeTruthy();
    expect((await policy().list({}))[0].status).toBe('draft');

    const ok = await proposeAndApprove({ version: 1, rulesHash: d1b.rulesHash });
    const p1 = await policy().current();
    expect(p1).toMatchObject({
      version: 1,
      status: 'published',
      editedBy: 'founder-a',
      publishedBy: 'founder-a',
      approvalTaskId: ok.task.id,
    });

    // Publishing it again through another task refuses: it is no longer the open draft.
    await proposeAndApprove({ version: 1, rulesHash: d1b.rulesHash });
    expect(await policy().current()).toEqual(p1);
  });

  it('a published version is immutable; a change is a new version and the old one is superseded', async () => {
    await publish([allowAll]);
    await expect(db.sql`UPDATE pay.custody_policy_versions SET rules = '[]'::jsonb WHERE version = 1`).rejects.toThrow(/immutable/);
    await expect(db.sql`DELETE FROM pay.custody_policy_versions WHERE version = 1`).rejects.toThrow(/immutable/);
    await publish([denyBad, allowAll]);
    const list = await policy().list({});
    expect(list.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([
      [2, 'published'],
      [1, 'superseded'],
    ]);
  });

  it('simulate decides without writing anything, against the published or a named version', async () => {
    await publish([denyBad, allowAll]);
    await policy().draft({ rules: [denyBad], note: 'TEST v2', expectedDraftVersion: null });
    const body = {
      userId: USER,
      assetId: 'USDT',
      amount: '1',
      network: 'card-sandbox',
      destinationKind: 'bank',
      destinationRef: 'GB82WEST12345698765432',
      txType: 'transfer',
    };
    const before = await db.sql`SELECT * FROM pay.custody_policy_versions ORDER BY version`;
    expect(await policy().simulate(body)).toEqual({
      version: 1,
      outcome: 'block',
      ruleId: 'deny-bad',
      matchedRuleIds: ['deny-bad', 'allow-all'],
      approval: null,
    });
    expect(await policy().simulate({ ...body, destinationRef: 'DE01', version: 2 })).toMatchObject({ version: 2, outcome: 'no_match' });
    expect((await refused(policy().simulate({ ...body, amount: 'abc' }))).message).toMatch(/draft_invalid/);
    expect(await db.sql`SELECT * FROM pay.custody_policy_versions ORDER BY version`).toEqual(before);
    expect(await db.sql`SELECT 1 FROM pay.withdrawals`).toHaveLength(0);
  });

  it('refuses a caller who is not a founder', async () => {
    founder = '';
    expect((await refused(policy().list({}))).code).toBe('FORBIDDEN');
  });

  describe('inside the withdrawal claim', () => {
    const rails = () =>
      new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 }), new BankPayoutAbsentAdapter()]);
    const money = (mode: 'off' | 'required') =>
      new UserMoneyService(db.sql, new MemoryLedger(), rails(), {
        operatorCreditRails: ['card-sandbox'],
        guards: composeGuards(createCustodyPolicyGuards({ sql: db.sql, mode })),
      });
    async function funded(mode: 'off' | 'required') {
      const service = money(mode);
      await service.credit({
        userId: USER,
        assetId: 'USDT',
        amount: amt('500'),
        rail: 'card-sandbox',
        railRef: `seed-${randomUUID()}`,
        creditedBy: '99999999-9999-4999-8999-999999999999',
      });
      return service;
    }
    const request = (amount: string, clientRef: string, ref = 'DE89370400440532013000') => ({
      userId: USER,
      assetId: 'USDT',
      amount: amt(amount),
      rail: 'card-sandbox',
      destination: { kind: 'bank', ref },
      clientRef,
    });
    const refusal = async (p: Promise<unknown>) => {
      const e = await p.then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(PayGuardRefusal);
      return (e as PayGuardRefusal).code;
    };

    it('off: the policy is not read', async () => {
      const service = await funded('off');
      expect((await service.withdraw(request('1', 'off'))).status).toBe('sent');
    });

    it('required with nothing published: refuses unset and leaves no claim (fail closed)', async () => {
      const service = await funded('required');
      expect(await refusal(service.withdraw(request('1', 'unset')))).toBe('pay.guard_custody_policy_unset');
      await policy().draft({ rules: [allowAll], note: 'TEST draft only', expectedDraftVersion: null });
      expect(await refusal(service.withdraw(request('1', 'draft-only')))).toBe('pay.guard_custody_policy_unset');
      expect(await db.sql`SELECT 1 FROM pay.withdrawals`).toHaveLength(0);
    });

    it('block, no match and approve refuse with their own codes; allow passes', async () => {
      await publish([denyBad, approve, { id: 'small', action: 'allow', match: { destinationKinds: ['bank'] } }]);
      const service = await funded('required');
      expect(await refusal(service.withdraw(request('1', 'bad', 'GB82WEST12345698765432')))).toBe('pay.guard_custody_policy_blocked');
      expect(await refusal(service.withdraw(request('101', 'big')))).toBe('pay.guard_custody_policy_approval_unwired');
      expect(await db.sql`SELECT 1 FROM pay.withdrawals`).toHaveLength(0);
      expect((await service.withdraw(request('1', 'ok'))).status).toBe('sent');
      await publish([{ id: 'crypto-only', action: 'allow', match: { destinationKinds: ['crypto'] } }]);
      expect(await refusal(service.withdraw(request('1', 'nomatch')))).toBe('pay.guard_custody_policy_no_match');
    });

    it('cumulative window counts earlier withdrawals; a retry of the same claim is not refused', async () => {
      await publish([cumulative, allowAll]);
      const service = await funded('required');
      expect((await service.withdraw(request('10', 'a'))).status).toBe('sent');
      expect(await refusal(service.withdraw(request('6', 'b')))).toBe('pay.guard_custody_policy_blocked');
      expect((await service.withdraw(request('5', 'c'))).status).toBe('sent');
      expect((await service.withdraw(request('10', 'a'))).status).toBe('sent');
    });

    it('the cumulative window runs on created_at: a withdrawal asked for before the window does not count', async () => {
      await publish([cumulative, allowAll]);
      const service = await funded('required');
      expect((await service.withdraw(request('10', 'old'))).status).toBe('sent');
      await db.sql`UPDATE pay.withdrawals SET created_at = now() - interval '2 days', updated_at = now() WHERE client_ref = 'old'`;
      expect((await service.withdraw(request('10', 'new'))).status).toBe('sent');
    });

    it('the boot default mode refuses a withdrawal while nothing is published', async () => {
      const service = new UserMoneyService(db.sql, new MemoryLedger(), rails(), {
        operatorCreditRails: ['card-sandbox'],
        guards: composeGuards(createCustodyPolicyGuards({ sql: db.sql, mode: loadCustodyPolicyMode({}) })),
      });
      await service.credit({
        userId: USER,
        assetId: 'USDT',
        amount: amt('5'),
        rail: 'card-sandbox',
        railRef: `seed-${randomUUID()}`,
        creditedBy: '99999999-9999-4999-8999-999999999999',
      });
      expect(await refusal(service.withdraw(request('1', 'boot')))).toBe('pay.guard_custody_policy_unset');
    });

    it('two parallel claims that together cross a cumulative rule: exactly one passes', async () => {
      await publish([cumulative, allowAll]);
      const service = await funded('required');
      const results = await Promise.allSettled([service.withdraw(request('10', 'p1')), service.withdraw(request('10', 'p2'))]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await db.sql`SELECT 1 FROM pay.withdrawals`).toHaveLength(1);
    });
  });
});
