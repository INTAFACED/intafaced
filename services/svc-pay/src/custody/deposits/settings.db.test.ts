import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { ActionApprovalConsumeInput } from '@intafaced/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ActionApprovalConsumeError,
  ACTION_APPROVAL_PAYLOAD_MISMATCH,
  stubApprovalConsumer,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from '../../action-approval-consume.js';
import { createPayNamespaces } from '../../namespaces/index.js';

/**
 * The deposit settings against a real Postgres: every forward migration, including 0119, the real router and service, the real reader. Same arrangement
 * as the other svc-pay db suites: `TEST_DATABASE_URL`, or a Testcontainer when
 * it is unset.
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
    .withDatabase('intafaced_deposit_settings_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const FOUNDER = 'founder-a';
const SECOND = 'founder-b';

type Err = { code: string; message?: string };
async function refused(p: Promise<unknown>): Promise<Err> {
  try {
    await p;
  } catch (e) {
    return e as Err;
  }
  throw new Error('expected the call to be refused');
}

describe('deposit settings (dual-controlled)', () => {
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
  const ds = () => api.founderAdmin.depositSettings;
  const approval = { approvalId: 'appr-1', operationId: 'op-1' };

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const ns = createPayNamespaces({ founderAuthority: async () => FOUNDER, depositSettings: { sql: db.sql, approvals } });
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
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  beforeEach(async () => {
    approver = SECOND;
    consumed = [];
    await db.sql.unsafe(`ALTER TABLE pay.custody_deposit_setting_events DISABLE TRIGGER USER`);
    await db.sql.unsafe(`TRUNCATE pay.custody_deposit_setting_events, pay.custody_deposit_settings RESTART IDENTITY CASCADE`);
    await db.sql.unsafe(`ALTER TABLE pay.custody_deposit_setting_events ENABLE TRIGGER USER`);
  });

  const input = (o: Record<string, unknown> = {}) => ({
    assetId: 'USDT',
    networkId: 'TEST-net',
    label: 'TEST network',
    minimumDeposit: '10',
    estimatedArrivalMinutes: 5,
    enabled: false,
    haltNote: null,
    expectedVersion: null,
    reason: 'TEST setup of the deposit pair',
    ...o,
  });

  it('creates a pair switched off with an audit row and no second founder', async () => {
    const saved = await ds().save(input());
    expect(saved).toMatchObject({ enabled: false, minimumDeposit: '10', version: 1 });
    expect(consumed).toHaveLength(0);
    const events = await ds().history({});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'create', dualControl: false, before: null });
  });

  it('normalises leading zeros so the stored minimum satisfies the table check', async () => {
    expect((await ds().save(input({ minimumDeposit: '007.50' }))).minimumDeposit).toBe('7.5');
    expect((await ds().save(input({ assetId: 'ETH', minimumDeposit: '00.5' }))).minimumDeposit).toBe('0.5');
  });

  it('refuses to create a pair that is already on', async () => {
    const e = await refused(ds().save(input({ enabled: true })));
    expect(e.message).toContain('create_must_be_inert');
    expect(await ds().list()).toHaveLength(0);
  });

  it('refuses a blank, zero or non-decimal minimum', async () => {
    for (const minimumDeposit of ['', '0', '0.000', 'abc', '-1']) {
      await refused(ds().save(input({ minimumDeposit })));
    }
    expect(await ds().list()).toHaveLength(0);
  });

  it('switching on needs a second founder, and a single founder is refused', async () => {
    await ds().save(input());
    const preview = await ds().preview(input({ enabled: true, expectedVersion: 1 }));
    expect(preview.needsDualControl).toBe(true);
    approver = null;
    await refused(ds().save({ ...input({ enabled: true, expectedVersion: 1 }), ...approval }));
    approver = FOUNDER;
    await refused(ds().save({ ...input({ enabled: true, expectedVersion: 1 }), ...approval }));
    expect((await ds().list())[0].enabled).toBe(false);
    approver = SECOND;
    const on = await ds().save({ ...input({ enabled: true, expectedVersion: 1 }), ...approval });
    expect(on).toMatchObject({ enabled: true, version: 2 });
    const events = await ds().history({});
    expect(events[0]).toMatchObject({ action: 'update', dualControl: true, approverId: SECOND });
  });

  it('lowering the minimum of a live pair needs dual control; raising it does not', async () => {
    await ds().save(input());
    await ds().save({ ...input({ enabled: true, expectedVersion: 1 }), ...approval });
    const raise = await ds().save(input({ enabled: true, expectedVersion: 2, minimumDeposit: '20' }));
    expect(raise.minimumDeposit).toBe('20');
    approver = null;
    await refused(ds().save({ ...input({ enabled: true, expectedVersion: 3, minimumDeposit: '5' }), ...approval }));
    approver = SECOND;
    const lowered = await ds().save({ ...input({ enabled: true, expectedVersion: 3, minimumDeposit: '5' }), ...approval });
    expect(lowered.minimumDeposit).toBe('5');
  });

  it('keeps the halt note only while the pair is off', async () => {
    await ds().save(input({ haltNote: 'Maintenance on the network' }));
    expect((await ds().list())[0].haltNote).toBe('Maintenance on the network');
    const on = await ds().save({ ...input({ enabled: true, expectedVersion: 1, haltNote: 'ignored' }), ...approval });
    expect(on.haltNote).toBeNull();
  });

  it('publishes an unsupported-case list, keeps it when an edit leaves it out, and needs a second founder to take a case off a live pair', async () => {
    const cases = ['TEST: a send from a smart contract', 'TEST: a send of an NFT'];
    const created = await ds().save(input({ unsupportedCases: cases }));
    expect(created.unsupportedCases).toEqual(cases);
    expect(consumed).toHaveLength(0);
    // An edit that does not name the list keeps it.
    const kept = await ds().save(input({ expectedVersion: 1, minimumDeposit: '12' }));
    expect(kept.unsupportedCases).toEqual(cases);
    await ds().save({ ...input({ enabled: true, expectedVersion: 2, minimumDeposit: '12' }), ...approval });
    // Adding a case to a live pair is one founder's change.
    consumed = [];
    const more = await ds().save(
      input({ enabled: true, expectedVersion: 3, minimumDeposit: '12', unsupportedCases: [...cases, 'TEST: a third'] }),
    );
    expect(more.unsupportedCases).toHaveLength(3);
    expect(consumed).toHaveLength(0);
    // Taking one off stops warning customers, so it needs a second founder.
    const fewer = input({ enabled: true, expectedVersion: 4, minimumDeposit: '12', unsupportedCases: [cases[0]] });
    expect((await ds().preview(fewer)).reasons).toEqual(['unsupported_case_removed']);
    approver = null;
    await refused(ds().save({ ...fewer, ...approval }));
    expect((await ds().list())[0].unsupportedCases).toHaveLength(3);
    approver = SECOND;
    const removed = await ds().save({ ...fewer, ...approval });
    expect(removed.unsupportedCases).toEqual([cases[0]]);
    const events = await ds().history({});
    expect(events[0]).toMatchObject({ dualControl: true, approverId: SECOND });
    expect(events[0].after).toMatchObject({ unsupportedCases: [cases[0]] });
  });

  it('refuses a blank, repeated or too long unsupported-case list', async () => {
    await refused(ds().save(input({ unsupportedCases: [' '] })));
    await refused(ds().save(input({ unsupportedCases: ['TEST same', 'TEST same'] })));
    await refused(ds().save(input({ unsupportedCases: Array.from({ length: 21 }, (_, i) => `TEST case ${i}`) })));
    expect(await ds().list()).toHaveLength(0);
  });

  it('refuses a stale version', async () => {
    await ds().save(input());
    await ds().save(input({ expectedVersion: 1, minimumDeposit: '12' }));
    const e = await refused(ds().save(input({ expectedVersion: 1, minimumDeposit: '15' })));
    expect(e.message).toContain('version_conflict');
    expect((await ds().list())[0].minimumDeposit).toBe('12');
  });

  it('refuses creating a pair twice and editing a missing one', async () => {
    await ds().save(input());
    expect((await refused(ds().save(input()))).message).toContain('already_exists');
    expect((await refused(ds().save(input({ assetId: 'ETH', expectedVersion: 1 })))).message).toContain('not_found');
  });

  it('keeps the audit trail append-only', async () => {
    await ds().save(input());
    await expect(db.sql.unsafe(`DELETE FROM pay.custody_deposit_setting_events`)).rejects.toThrow();
    await expect(db.sql.unsafe(`UPDATE pay.custody_deposit_setting_events SET reason = 'x'`)).rejects.toThrow();
  });
});
