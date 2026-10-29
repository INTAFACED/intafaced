import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type ActionApprovalConsumeInput } from '@intafaced/contracts';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stubApprovalConsumer, unwiredApprovalConsumer, type ActionApprovalConsumer } from '../../action-approval-consume.js';
import { createPayNamespaces } from '../../namespaces/index.js';
import { createPayRouter } from '../../router.js';
import type { PayService } from '../../payment-service.js';
import { CardSandboxAdapter } from '../../rails/card-sandbox.js';
import { RailRegistry } from '../../rails/registry.js';
import type { UserMoneyService } from '../../user-money-service.js';
import { amountOutsideRules, refuseTaglessRequired, refuseWithdrawalTag, withdrawalNetworkRuleDualReasons } from './service.js';
import { parseAmount } from '@intafaced/ledger-client';

/**
 * The owner's withdrawal rules per asset and network (W-withdraw-02, J-wallet-05 #1) against a real Postgres: every forward
 * migration, the founders' door through the real namespace router, and the customer's read through the real pay router.
 * `TEST_DATABASE_URL`, or a Testcontainer when it is unset.
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
    .withDatabase('intafaced_withdrawal_rules_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const FOUNDER = 'founder-a';
const SECOND = 'founder-b';
const SECRET = 'a-pay-network-rules-test-edge-secret-long-enough';
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

describe('withdrawal network rules (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let approver: string | null = SECOND;
  let consumed: ActionApprovalConsumeInput[] = [];
  const approvals: ActionApprovalConsumer = {
    async consume(input) {
      consumed.push(input);
      if (approver === null) return unwiredApprovalConsumer().consume(input);
      return stubApprovalConsumer(approver).consume(input);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  const nr = () => api.founderAdmin.withdrawalNetworkRules;
  const approval = { approvalId: 'appr-1', operationId: 'op-1' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let customer: any;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const ns = createPayNamespaces({ founderAuthority: async () => FOUNDER, withdrawalNetworkRules: { sql: db.sql, approvals } });
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
    api = ns.createCaller({ principal, service: null, region: 'DE', requestId: 'r' });

    const raw = encodePrincipal({
      sub: USER,
      userId: USER,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes: ['trade:read'],
      tier: 'full',
      mfa: false,
      expiresAt: new Date(Date.now() + 3_600_000),
    } as Principal);
    const ctx = createEdgeContext({ secret: SECRET, serviceName: 'svc-pay' })({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-rules',
    });
    const rails = new RailRegistry([
      new CardSandboxAdapter({ secret: 'pay-rules-test-rail-secret-at-least-32-chars', toleranceSeconds: 300 }),
    ]);
    customer = createPayRouter(
      {} as PayService,
      rails,
      {} as UserMoneyService,
      null,
      undefined,
      undefined,
      null,
      undefined,
      db.sql,
    ).createCaller(ctx);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  beforeEach(async () => {
    approver = SECOND;
    consumed = [];
    await db.sql.unsafe(`ALTER TABLE pay.withdrawal_network_rule_events DISABLE TRIGGER USER`);
    await db.sql.unsafe(`TRUNCATE pay.withdrawal_network_rule_events, pay.withdrawal_network_rules RESTART IDENTITY CASCADE`);
    await db.sql.unsafe(`ALTER TABLE pay.withdrawal_network_rule_events ENABLE TRIGGER USER`);
  });

  const input = (o: Record<string, unknown> = {}) => ({
    assetId: 'USDT',
    networkId: 'ethereum',
    minimum: '10',
    maximum: '1000',
    step: '0.01',
    tag: 'none',
    expectedVersion: null,
    reason: 'TEST withdrawal rules',
    ...o,
  });
  const read = () => customer.withdrawal.networkRules({ assetId: 'USDT', networkId: 'ethereum' });

  it('reads nothing until the owner publishes, and refuses in a typed error rather than a zero', async () => {
    const e = await refused(read());
    expect(e.code).toBe('PRECONDITION_FAILED');
    expect(e.message).toContain('withdrawal_network_rules.unset');
    expect(await nr().list()).toEqual([]);
  });

  it('publishing a pair needs a second founder; then the customer reads exactly its rules, and never who set them', async () => {
    expect((await nr().preview(input())).reasons).toEqual(['published']);
    approver = null;
    await refused(nr().save({ ...input(), ...approval }));
    approver = FOUNDER;
    await refused(nr().save({ ...input(), ...approval }));
    expect(await nr().list()).toEqual([]);
    approver = SECOND;
    const saved = await nr().save({ ...input({ minimum: '010.0' }), ...approval });
    expect(saved).toMatchObject({ minimum: '10', maximum: '1000', step: '0.01', tag: 'none', version: 1, setBy: FOUNDER });
    expect(await read()).toEqual({ assetId: 'USDT', networkId: 'ethereum', minimum: '10', maximum: '1000', step: '0.01', tag: 'none' });
    expect((await nr().history({}))[0]).toMatchObject({ action: 'create', dualControl: true, approverId: SECOND, before: null });
  });

  it('tightening is one founder; loosening any rule needs a second', async () => {
    await nr().save({ ...input({ tag: 'required' }), ...approval });
    consumed = [];
    const tighter = await nr().save(input({ minimum: '20', maximum: '500', step: '0.1', tag: 'required', expectedVersion: 1 }));
    expect(tighter).toMatchObject({ minimum: '20', maximum: '500', step: '0.1', version: 2 });
    expect(consumed).toHaveLength(0);
    const loosen = [
      [{ minimum: '15' }, 'minimum_lowered'],
      [{ maximum: '600' }, 'maximum_raised'],
      [{ step: '0.05' }, 'step_loosened'],
      [{ tag: 'none' }, 'tag_dropped'],
    ] as const;
    for (const [change, reason] of loosen) {
      const next = input({ minimum: '20', maximum: '500', step: '0.1', tag: 'required', expectedVersion: 2, ...change });
      expect((await nr().preview(next)).reasons).toEqual([reason]);
      approver = null;
      await refused(nr().save({ ...next, ...approval }));
      approver = SECOND;
    }
    expect((await nr().list())[0]).toMatchObject({ minimum: '20', maximum: '500', step: '0.1', tag: 'required', version: 2 });
  });

  it('refuses a blank, zero or inconsistent rule, and writes nothing', async () => {
    for (const bad of [
      { minimum: '' },
      { step: '0' },
      { maximum: 'abc' },
      { minimum: '5', step: '10' },
      { minimum: '100', maximum: '50' },
      { minimum: '10.2', maximum: '10.4', step: '0.5' },
      { tag: 'optional' },
    ]) {
      await refused(nr().save({ ...input(bad), ...approval }));
    }
    expect(await nr().list()).toEqual([]);
    expect(await nr().history({})).toEqual([]);
  });

  it('refuses a stale version, a second create and an edit of a missing pair', async () => {
    await nr().save({ ...input(), ...approval });
    await nr().save(input({ expectedVersion: 1, minimum: '20' }));
    expect((await refused(nr().save(input({ expectedVersion: 1, minimum: '30' })))).message).toContain('version_conflict');
    expect((await refused(nr().save({ ...input(), ...approval }))).message).toContain('already_exists');
    expect((await refused(nr().save(input({ assetId: 'USDC', expectedVersion: 1 })))).message).toContain('not_found');
    expect((await nr().list())[0].minimum).toBe('20');
  });

  it('refuses a tag by name on every network, and never as a dropped field (J-wallet-05 #1)', async () => {
    const tagOn = (networkId: string | undefined) => refused(refuseWithdrawalTag(db.sql, 'USDT', networkId));
    // No rules published: the rules' own refusal, never a guess that the network takes no tag.
    expect((await tagOn('ethereum')).code).toBe('withdrawal_network_rules.unset');
    await nr().save({ ...input(), ...approval });
    const none = await tagOn('ethereum');
    expect(none.code).toBe('pay.withdrawal_tag_not_taken');
    expect(none.message).toContain('ethereum takes no tag or memo');
    // A send inside the platform names no network and takes no tag.
    expect((await tagOn(undefined)).code).toBe('pay.withdrawal_tag_not_taken');
    await nr().save({ ...input({ networkId: 'stellar', tag: 'required' }), ...approval });
    // A network that takes a tag still refuses one: no withdrawal keeps a tag yet, so it is never sent without it.
    expect((await tagOn('stellar')).code).toBe('pay.withdrawal_tag_unsupported');
    // No database: refused as unwired, never let through.
    expect((await refused(refuseWithdrawalTag(null, 'USDT', 'ethereum'))).code).toBe('withdrawal_network_rules.unwired');
  });

  it('refuses a send with no tag on a network that requires one, and lets one on a network that takes none (J-wallet-05 #1)', async () => {
    expect((await refused(refuseTaglessRequired(db.sql, 'USDT', 'ethereum'))).code).toBe('withdrawal_network_rules.unset');
    await nr().save({ ...input(), ...approval });
    await expect(refuseTaglessRequired(db.sql, 'USDT', 'ethereum')).resolves.toBeUndefined();
    await nr().save({ ...input({ networkId: 'stellar', tag: 'required' }), ...approval });
    const required = await refused(refuseTaglessRequired(db.sql, 'USDT', 'stellar'));
    expect(required.code).toBe('pay.withdrawal_tag_required');
    expect(required.message).toContain('stellar needs a tag or memo');
  });

  it('keeps the audit trail append-only', async () => {
    await nr().save({ ...input(), ...approval });
    await expect(db.sql.unsafe(`DELETE FROM pay.withdrawal_network_rule_events`)).rejects.toThrow();
    await expect(db.sql.unsafe(`UPDATE pay.withdrawal_network_rule_events SET reason = 'x'`)).rejects.toThrow();
  });
});

describe('withdrawal network rules, the pure parts', () => {
  const rules = { minimum: '10', maximum: '1000', step: '0.5', tag: 'none' as const };
  it('places an amount inside or outside the rules, edges included', () => {
    expect(amountOutsideRules(rules, parseAmount('9.5'))).toBe('below_minimum');
    expect(amountOutsideRules(rules, parseAmount('10'))).toBeNull();
    expect(amountOutsideRules(rules, parseAmount('1000'))).toBeNull();
    expect(amountOutsideRules(rules, parseAmount('1000.5'))).toBe('above_maximum');
    expect(amountOutsideRules(rules, parseAmount('10.25'))).toBe('off_step');
  });
  it('a step that is a whole multiple of the old one is not a loosening', () => {
    expect(withdrawalNetworkRuleDualReasons({ ...rules, step: '0.1' }, { ...rules, step: '0.2' })).toEqual([]);
    expect(withdrawalNetworkRuleDualReasons({ ...rules, step: '0.2' }, { ...rules, step: '0.1' })).toEqual(['step_loosened']);
  });
});
