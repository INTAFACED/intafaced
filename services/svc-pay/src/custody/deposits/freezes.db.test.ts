import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { ActionApprovalConsumeInput } from '@intafaced/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NetworkState } from '../../registries/policy.js';
import {
  payActionPayloadHash,
  stubApprovalConsumer,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from '../../action-approval-consume.js';
import { createPayNamespaces } from '../../namespaces/index.js';
import { CustodyDepositBook } from './book.js';
import { DEPOSIT_ADDRESS_UNFREEZE_ACTION, unfreezeApprovalFields } from './freezes.js';

/**
 * Compliance freezes on deposit addresses (W-compliance-notices-03, J-wallet-03 #4) against a real Postgres: every forward
 * migration, the real founder router, the real deposit record and the memory ledger. TEST figures only.
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
    .withDatabase('intafaced_deposit_freezes_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const FOUNDER = 'founder-a';
const SECOND = 'founder-b';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '0x00000000000000000000000000000000000000a1';
/** How a founder may paste it: the freeze matches whatever the case. */
const PASTED = '0x00000000000000000000000000000000000000A1';
const TX = '0xabc0000000000000000000000000000000000000000000000000000000000001';
const KEY = `deposit:crypto-native:ethereum:${TX}:0`;

type Err = { code: string; message?: string };
async function refused(p: Promise<unknown>): Promise<Err> {
  try {
    await p;
  } catch (e) {
    return e as Err;
  }
  throw new Error('expected the call to be refused');
}

const network = (): NetworkState =>
  ({
    networkId: 'ethereum',
    displayName: 'Ethereum',
    assetCodes: ['USDT'],
    confirmationsRequired: 12,
    enabled: true,
    feeEstimateSource: 'fixed',
    feeEstimateAmount: '1',
  }) as NetworkState;

describe('deposit address freezes (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let ledger!: MemoryLedger;
  let failPost = false;
  let actor = FOUNDER;
  let approver: string | null = SECOND;
  let consumed: ActionApprovalConsumeInput[] = [];
  const logs: string[] = [];

  const approvals: ActionApprovalConsumer = {
    async consume(input) {
      consumed.push(input);
      if (approver === null) return unwiredApprovalConsumer().consume(input);
      return stubApprovalConsumer(approver).consume(input);
    },
  };
  const book = () =>
    new CustodyDepositBook({
      sql: db.sql,
      postDeposit: async (input) => {
        if (failPost) throw new Error('ledger timeout');
        const { networkId, txHash, outputIndex, ...rest } = input;
        return ledger.post(recipes.deposit({ ...rest, rail: 'crypto-native', railRef: `${networkId}:${txHash}:${outputIndex}` }));
      },
      reverseDeposit: async ({ networkId, txHash, outputIndex, again: _again, ...rest }) => {
        const railRef = `${networkId}:${txHash}:${outputIndex}`;
        const tx = await ledger.post(
          recipes.depositReverse({ ...rest, rail: 'crypto-native', railRef, depositId: `crypto-native:${railRef}` }),
        );
        return { state: 'reversed', id: tx.id };
      },
      registries: { listRoutableNetworks: async () => [network()] },
      log: (msg) => logs.push(msg),
    });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  const fz = () => api.founderAdmin.depositFreezes;
  const seen = (over: Partial<Parameters<CustodyDepositBook['receive']>[0]> = {}) => ({
    address: ADDRESS,
    txHash: TX,
    outputIndex: 0,
    assetId: 'USDT',
    amount: parseAmount('25'),
    confirmations: 12,
    ...over,
  });
  const balance = async () => (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
  const posts = () => ledger.journal().filter((t) => t.reason === 'deposit.credited');
  const row = async () => (await db.sql`SELECT * FROM pay.custody_deposits`)[0]!;
  const freezeIt = (over: Record<string, unknown> = {}) =>
    fz().freeze({ userId: ALICE, networkId: 'ethereum', address: PASTED, reason: 'compliance review of the source', ...over });
  const unfreezeIt = (freezeId: string, over: Record<string, unknown> = {}) =>
    fz().unfreeze({
      userId: ALICE,
      networkId: 'ethereum',
      address: PASTED,
      freezeId,
      reason: 'source cleared by compliance',
      approvalId: 'appr-1',
      operationId: 'op-1',
      ...over,
    });

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const ns = createPayNamespaces({
      founderAuthority: async () => actor,
      depositFreezes: {
        sql: db.sql,
        approvals,
        book: {
          holdAddress: (networkId, address) => book().holdAddress(networkId, address),
          release: (networkId, address, lift) => book().release(networkId, address, lift),
        },
      },
    });
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
  }, 30_000);
  beforeEach(async () => {
    ledger = new MemoryLedger();
    failPost = false;
    actor = FOUNDER;
    approver = SECOND;
    consumed = [];
    logs.length = 0;
    await db.sql`TRUNCATE pay.custody_deposits, pay.custody_deposit_settings, pay.custody_deposit_addresses, pay.custody_deposit_reorgs, pay.custody_deposit_address_freezes`;
    await db.sql`INSERT INTO pay.custody_deposit_addresses (user_id, asset_id, network_id, address) VALUES (${ALICE}, 'USDT', 'ethereum', ${ADDRESS})`;
    await db.sql`
      INSERT INTO pay.custody_deposit_settings (asset_id, network_id, label, minimum_deposit, estimated_arrival_minutes, set_by)
      VALUES ('USDT', 'ethereum', 'Ethereum', '10', 5, 'test-profile')`;
  }, 30_000);

  it('a freeze holds the confirming deposit: on_hold, never credited at full depth, and posts nothing', async () => {
    await book().receive(seen({ confirmations: 3 }));
    const placed = await freezeIt();
    expect(placed).toMatchObject({ held: 1, creditedUntouched: 0, freeze: { frozenBy: FOUNDER, address: ADDRESS } });
    expect(await row()).toMatchObject({ status: 'on_hold', reason: 'address_frozen', credit_started_at: null });
    expect(await book().receive(seen({ confirmations: 40 }))).toEqual({ state: 'recorded', status: 'on_hold', reason: 'address_frozen' });
    expect(await book().settleOpen()).toBe(0);
    expect((await row()).confirmations).toBe(40);
    expect(posts()).toHaveLength(0);
    expect(await balance()).toBe(0n);
    const listed = await book().records({ userId: ALICE, statuses: ['on_hold'], offset: 0, limit: 10 });
    expect(listed.items).toMatchObject([{ status: 'on_hold', reason: 'address_frozen', amount: '25' }]);
  });

  it('a transfer that first reaches a frozen address is held at once', async () => {
    await freezeIt();
    expect(await book().receive(seen())).toEqual({ state: 'recorded', status: 'on_hold', reason: 'address_frozen' });
    expect(posts()).toHaveLength(0);
  });

  it('a second founder unfreezes: one deposit post under the usual key, the balance moves once', async () => {
    await book().receive(seen({ confirmations: 3 }));
    const { freeze } = await freezeIt();
    await book().receive(seen({ confirmations: 12 }));
    const lifted = await unfreezeIt(freeze.id);
    expect(lifted).toMatchObject({
      released: 1,
      credited: 1,
      freeze: { unfrozenBy: FOUNDER, unfreezeApprover: SECOND, unfreezeReason: 'source cleared by compliance' },
    });
    expect(consumed).toEqual([
      {
        approvalId: 'appr-1',
        operationId: 'op-1',
        targetService: 'svc-pay',
        targetId: DEPOSIT_ADDRESS_UNFREEZE_ACTION,
        expectedVersion: '1',
        payloadHash: payActionPayloadHash(
          DEPOSIT_ADDRESS_UNFREEZE_ACTION,
          unfreezeApprovalFields({
            userId: ALICE,
            networkId: 'ethereum',
            address: ADDRESS,
            freezeId: freeze.id,
            reason: 'source cleared by compliance',
          }),
        ),
      },
    ]);
    expect(posts().map((t) => t.idempotencyKey)).toEqual([KEY]);
    expect(await balance()).toBe(parseAmount('25'));
    expect(await row()).toMatchObject({ status: 'credited', reason: null });
    // Unfreezing again is refused; redeliveries and passes credit nothing more.
    expect((await refused(unfreezeIt(freeze.id))).message).toContain('deposit_freeze.not_frozen');
    await book().receive(seen({ confirmations: 50 }));
    await book().settleOpen();
    expect(posts()).toHaveLength(1);
  });

  it('a released deposit still short of its depth waits, and credits when it gets there', async () => {
    await book().receive(seen({ confirmations: 3 }));
    const { freeze } = await freezeIt();
    expect(await unfreezeIt(freeze.id)).toMatchObject({ released: 1, credited: 0 });
    expect(await row()).toMatchObject({ status: 'confirming', reason: null });
    expect(await book().receive(seen({ confirmations: 12 }))).toMatchObject({ status: 'credited' });
    expect(posts()).toHaveLength(1);
  });

  it('the founder who approved cannot also lift it: refused, the freeze stands, nothing posted', async () => {
    await book().receive(seen({ confirmations: 3 }));
    const { freeze } = await freezeIt();
    approver = FOUNDER;
    expect((await refused(unfreezeIt(freeze.id))).code).toBe('PRECONDITION_FAILED');
    expect(await row()).toMatchObject({ status: 'on_hold' });
    expect((await fz().addresses({ userId: ALICE }))[0]).toMatchObject({ frozen: true, freezeId: freeze.id });
    expect(posts()).toHaveLength(0);
  });

  it('with no approval service the unfreeze refuses and invents no second person', async () => {
    await book().receive(seen({ confirmations: 3 }));
    const { freeze } = await freezeIt();
    approver = null;
    expect((await refused(unfreezeIt(freeze.id))).message).toContain('IDENTITY_URL is unpublished');
    expect(await row()).toMatchObject({ status: 'on_hold' });
    expect(posts()).toHaveLength(0);
  });

  it('an unfreeze naming another freeze is refused before any approval is spent', async () => {
    await book().receive(seen({ confirmations: 3 }));
    await freezeIt();
    expect((await refused(unfreezeIt(randomUUID()))).message).toContain('deposit_freeze.freeze_changed');
    expect(consumed).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });

  it('a credited deposit is left as it is: the reply counts it and points nothing at the ledger', async () => {
    await book().receive(seen());
    expect(await balance()).toBe(parseAmount('25'));
    expect(await freezeIt()).toMatchObject({ held: 0, creditedUntouched: 1 });
    expect(await row()).toMatchObject({ status: 'credited' });
    expect(await balance()).toBe(parseAmount('25'));
    expect(ledger.journal()).toHaveLength(1);
  });

  it('refuses an address that is not this customer, a second open freeze and a blank reason', async () => {
    expect((await refused(freezeIt({ userId: BOB }))).message).toContain('deposit_freeze.address_unknown');
    await freezeIt();
    expect((await refused(freezeIt())).message).toContain('deposit_freeze.already_frozen');
    expect((await refused(freezeIt({ reason: '  ' }))).code).toBe('BAD_REQUEST');
    expect(await db.sql`SELECT 1 FROM pay.custody_deposit_address_freezes`).toHaveLength(1);
  });

  it('an unfreeze ledger timeout keeps the credit started; the next pass credits once under the same key', async () => {
    await book().receive(seen({ confirmations: 3 }));
    const { freeze } = await freezeIt();
    await book().receive(seen());
    failPost = true;
    expect(await unfreezeIt(freeze.id)).toMatchObject({ released: 1, credited: 0 });
    expect(logs).toContain('custody deposit released but not credited yet');
    expect((await row()).credit_started_at).not.toBeNull();
    failPost = false;
    expect(await book().settleOpen()).toBe(1);
    expect(posts().map((t) => t.idempotencyKey)).toEqual([KEY]);
    expect(await balance()).toBe(parseAmount('25'));
  });

  it('a pass running beside the unfreeze cannot take its deposits: the lift reports the release, and one credit is posted', async () => {
    await book().receive(seen({ confirmations: 3 }));
    const { freeze } = await freezeIt();
    await book().receive(seen());
    const [lifted] = await Promise.all([unfreezeIt(freeze.id), book().settleOpen(), book().settleOpen()]);
    expect(lifted).toMatchObject({ released: 1 });
    expect(posts().map((t) => t.idempotencyKey)).toEqual([KEY]);
    expect(await row()).toMatchObject({ status: 'credited' });
  });

  it('a credit that already started is finished, not held, and counted with the credited ones; a reversed one is not counted', async () => {
    await book().receive(seen({ outputIndex: 1, confirmations: 12 }));
    await book().reverse({ address: ADDRESS, txHash: TX, outputIndex: 1 });
    failPost = true;
    await expect(book().receive(seen())).rejects.toThrow('ledger timeout');
    expect(await freezeIt()).toMatchObject({ held: 0, creditedUntouched: 1 });
    failPost = false;
    expect(await book().settleOpen()).toBe(1);
    expect(posts().map((t) => t.idempotencyKey)).toEqual([`deposit:crypto-native:ethereum:${TX}:1`, KEY]);
  });

  it('a freeze lifted outside the unfreeze (a manual repair): the next pass releases its deposits and credits once', async () => {
    await book().receive(seen({ confirmations: 3 }));
    await freezeIt();
    await book().receive(seen());
    await db.sql`
      UPDATE pay.custody_deposit_address_freezes
         SET unfrozen_by = ${FOUNDER}, unfreeze_approver = ${SECOND}, unfreeze_reason = 'lifted before a crash', unfrozen_at = now()`;
    expect(await row()).toMatchObject({ status: 'on_hold' });
    expect(await book().settleOpen()).toBe(1);
    expect(posts().map((t) => t.idempotencyKey)).toEqual([KEY]);
  });

  it('a freeze placed between the judgement and the credit start is honoured: held, never credited', async () => {
    await book().receive(seen({ confirmations: 3 }));
    const b = book();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = b as any;
    const original = internal.frozen.bind(b);
    let first = true;
    internal.frozen = async (r: unknown) => {
      if (!first) return original(r);
      first = false;
      // The judgement saw no freeze; compliance places one before the credit starts.
      await db.sql`
        INSERT INTO pay.custody_deposit_address_freezes (user_id, network_id, address, reason, frozen_by)
        VALUES (${ALICE}, 'ethereum', ${ADDRESS.toLowerCase()}, 'placed during the judgement', ${FOUNDER})`;
      return false;
    };
    expect(await b.receive(seen())).toEqual({ state: 'recorded', status: 'on_hold', reason: 'address_frozen' });
    expect(posts()).toHaveLength(0);
  });

  it('a held deposit the chain takes back is closed reversed and posts nothing; the unfreeze then releases none', async () => {
    await book().receive(seen({ confirmations: 3 }));
    const { freeze } = await freezeIt();
    expect(await book().reverse({ address: ADDRESS, txHash: TX, outputIndex: 0 })).toEqual({
      state: 'recorded',
      status: 'reversed',
      reason: 'chain_reorg',
    });
    expect(await unfreezeIt(freeze.id)).toMatchObject({ released: 0, credited: 0 });
    expect(ledger.journal()).toHaveLength(0);
  });

  it('reads each address with its open freeze and held count, and the full history newest first', async () => {
    await book().receive(seen({ confirmations: 3 }));
    const first = (await freezeIt()).freeze;
    expect(await fz().addresses({ userId: ALICE })).toMatchObject([
      {
        id: `ethereum:${ADDRESS}`,
        userId: ALICE,
        networkId: 'ethereum',
        assetId: 'USDT',
        address: ADDRESS,
        expiresAt: null,
        frozen: true,
        freezeId: first.id,
        freezeReason: 'compliance review of the source',
        frozenBy: FOUNDER,
        held: 1,
      },
    ]);
    await unfreezeIt(first.id);
    const second = (await freezeIt({ reason: 'a second compliance review' })).freeze;
    const history = await fz().history({ userId: ALICE });
    expect(history.map((f: { id: string }) => f.id)).toEqual([second.id, first.id]);
    expect(history[1]).toMatchObject({ unfrozenBy: FOUNDER, unfreezeApprover: SECOND });
    expect(await fz().history({ userId: BOB })).toEqual([]);
  });

  it('the preview gives the hash the second founder approves', async () => {
    const { freeze } = await freezeIt();
    const input = {
      userId: ALICE,
      networkId: 'ethereum',
      address: ADDRESS,
      freezeId: freeze.id,
      reason: ' source cleared by compliance ',
    };
    expect(await fz().previewUnfreeze(input)).toEqual({
      actionType: DEPOSIT_ADDRESS_UNFREEZE_ACTION,
      payloadHash: payActionPayloadHash(DEPOSIT_ADDRESS_UNFREEZE_ACTION, unfreezeApprovalFields(input)),
    });
  });

  it('the table refuses an unfreeze its own lifter approved, a half-recorded unfreeze and a second open freeze', async () => {
    const { freeze } = await freezeIt();
    await expect(
      db.sql`UPDATE pay.custody_deposit_address_freezes SET unfrozen_by = 'x', unfreeze_approver = 'x', unfreeze_reason = 'r', unfrozen_at = now() WHERE id = ${freeze.id}`,
    ).rejects.toThrow();
    await expect(db.sql`UPDATE pay.custody_deposit_address_freezes SET unfrozen_at = now() WHERE id = ${freeze.id}`).rejects.toThrow();
    await expect(
      db.sql`INSERT INTO pay.custody_deposit_address_freezes (user_id, network_id, address, reason, frozen_by)
             VALUES (${ALICE}, 'ethereum', ${ADDRESS.toLowerCase()}, 'again', ${FOUNDER})`,
    ).rejects.toThrow();
  });

  it('only founders reach the routes', async () => {
    const ns = createPayNamespaces({
      founderAuthority: async () => {
        throw new Error('not a founder');
      },
      depositFreezes: { sql: db.sql, approvals, book: book() },
    });
    const caller = ns.createCaller({ principal: null, service: null, region: 'DE', requestId: 'r' });
    await expect(caller.founderAdmin.depositFreezes.history({ userId: ALICE })).rejects.toThrow();
    await expect(
      caller.founderAdmin.depositFreezes.freeze({ userId: ALICE, networkId: 'ethereum', address: ADDRESS, reason: 'compliance' }),
    ).rejects.toThrow();
    expect(await db.sql`SELECT 1 FROM pay.custody_deposit_address_freezes`).toHaveLength(0);
  });
});
