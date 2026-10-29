/**
 * W-withdraw-03 (J-wallet-05 #2): the owner's destination fraud list, against real Postgres and through the router.
 * Compliance lists an address with a second person's approval; the address book then refuses it before anything is
 * written, however the address is typed, and a saved entry listed later reads blocked. Uses TEST_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { ActionApprovalConsumeError, bankActionPayloadHash } from '../action-approval-consume.js';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import { memorySecurityLock } from '../security-lock.js';
import { DestinationFraudList, fraudChangeKey, fraudListingFields, SET_FRAUD_LISTING_ACTION } from './fraud-list.js';
import { memoryWithdrawNetworks } from './withdraw-networks.js';
import { CRYPTO_LEDGER_PROGRAMME } from './rails.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'd'.repeat(32);
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OFFICER = '77777777-7777-4777-8777-777777777777';
const APPROVER = '88888888-8888-4888-8888-888888888888';
const SID = '99999999-9999-4999-8999-999999999999';
const LISTED = '0x7e5700000000000000000000000000000000fa1d';
const CLEAN = '0x52908400098527886E0F7030069857D2E4169EE7';
const REASON = 'TEST: reported as a scam wallet';

function caller(bank: BankServices, userId: string, scopes: string[], approvals?: ReturnType<typeof deskApprovals>) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: SID,
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter(bank, approvals ? { approvals } : {}).createCaller(
    edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: `req-${randomUUID()}`,
    }),
  );
}

/** Identity stand-in: an approval is bound to one network, one address, one listed state and one revision. */
function deskApprovals() {
  const issued = new Map<string, string>();
  let consumed = 0;
  return {
    get consumed() {
      return consumed;
    },
    issue(change: { network: string; address: string; listed: boolean; expectedRevision: number; reason: string }) {
      const approvalId = randomUUID();
      issued.set(approvalId, bankActionPayloadHash(SET_FRAUD_LISTING_ACTION, fraudListingFields(change)));
      return { approvalId, operationId: randomUUID() };
    },
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      if (issued.get(input.approvalId) !== input.payloadHash || input.targetId !== SET_FRAUD_LISTING_ACTION) {
        throw new ActionApprovalConsumeError('approval does not match this listing', 'action_approval.consume_failed');
      }
      issued.delete(input.approvalId);
      consumed += 1;
      const now = new Date().toISOString();
      return {
        approvalId: input.approvalId,
        actionType: SET_FRAUD_LISTING_ACTION,
        targetService: 'svc-bank',
        targetId: SET_FRAUD_LISTING_ACTION,
        expectedVersion: '1',
        payloadHash: input.payloadHash,
        requesterId: OFFICER,
        approverId: APPROVER,
        requesterIsFounder: true,
        approverIsFounder: true,
        policyVersion: 'v1',
        createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: 'CONSUMED',
        operationId: input.operationId,
      };
    },
  };
}

describe('destination fraud list (W-withdraw-03)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (url.pathname === '/test') url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    // The history refuses DELETE, so a clean slate is a TRUNCATE (which the row trigger does not see).
    await sql`TRUNCATE bank.destination_fraud_list_history, bank.destination_fraud_list, bank.user_withdraw_destinations CASCADE`;
  });

  function services(): BankServices {
    const asset = {
      id: 'USDT',
      kind: 'crypto' as const,
      precision: 6,
      networks: ['ethereum', 'base'].map((networkId) => ({ networkId, label: `TEST ${networkId}` })),
      defaultNetworkId: 'ethereum',
      allowedActions: ['deposit' as const, 'withdraw' as const],
      state: 'active' as const,
      revision: 1,
      updatedAt: '2026-10-29T00:00:00.000Z',
    };
    return createBankServices(sql, new MemoryLedger(), memoryLedgerHistory(new MemoryLedger()), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      ramps: {
        securityLock: memorySecurityLock(),
        withdrawNetworks: memoryWithdrawNetworks([asset]),
        addressBookCap: '5',
        programme: CRYPTO_LEDGER_PROGRAMME,
        offrampCoolingHours: '0',
      },
    });
  }

  async function list(
    bank: BankServices,
    approvals: ReturnType<typeof deskApprovals>,
    change: { network: string; address: string; listed: boolean; expectedRevision: number },
    reason = REASON,
  ) {
    return caller(bank, OFFICER, ['admin:compliance'], approvals).ops.setDestinationFraudListing({
      ...change,
      reason,
      ...approvals.issue({ ...change, reason }),
    });
  }

  const customer = (bank: BankServices) => caller(bank, CUSTOMER, ['bank:read', 'bank:write', 'trade:withdraw']);
  const entry = (ref: string, network = 'ethereum') => ({
    assetId: 'USDT',
    network,
    ref,
    label: `TEST wallet ${randomUUID().slice(0, 8)}`,
  });

  it('starts empty: nothing is listed and the address book saves any valid address', async () => {
    const bank = services();
    expect(await caller(bank, OFFICER, ['admin:read']).ops.destinationFraudList({ limit: 50 })).toEqual({ entries: [], history: [] });
    expect(await customer(bank).ramps.destinations.check({ ref: LISTED, network: 'ethereum' })).toMatchObject({ fraudListed: false });
    await expect(customer(bank).ramps.destinations.save(entry(LISTED))).resolves.toMatchObject({ state: 'pending' });
  });

  it('a listed address is refused by name before anything is written, however its case is typed, on every network', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const listed = await list(bank, approvals, {
      network: '*',
      address: LISTED.toUpperCase().replace('0X', '0x'),
      listed: true,
      expectedRevision: 0,
    });
    expect(listed).toMatchObject({ network: '*', address: LISTED, listed: true, revision: 1, approvedBy: APPROVER, replayed: false });

    for (const [ref, network] of [
      [LISTED, 'ethereum'],
      [LISTED.toUpperCase().replace('0X', '0x'), 'base'],
    ] as const) {
      expect(await customer(bank).ramps.destinations.check({ ref, network })).toMatchObject({ fraudListed: true });
      await expect(customer(bank).ramps.destinations.save(entry(ref, network))).rejects.toMatchObject({
        cause: expect.objectContaining({ code: 'bank.destination_fraud_listed' }),
      });
    }
    expect(await sql`SELECT 1 FROM bank.user_withdraw_destinations WHERE lower(ref) = ${LISTED}`).toHaveLength(0);
    expect(await customer(bank).ramps.destinations.list()).toEqual([]);
    // An address that is not listed still saves.
    await expect(customer(bank).ramps.destinations.save(entry(CLEAN))).resolves.toMatchObject({ refMasked: '0x5290…9EE7' });
  });

  it('a listing on one network refuses that network only', async () => {
    const bank = services();
    await list(bank, deskApprovals(), { network: 'base', address: LISTED, listed: true, expectedRevision: 0 });
    await expect(customer(bank).ramps.destinations.save(entry(LISTED, 'base'))).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'bank.destination_fraud_listed' }),
    });
    await expect(customer(bank).ramps.destinations.save(entry(LISTED, 'ethereum'))).resolves.toMatchObject({ network: 'ethereum' });
  });

  it('a saved entry listed later reads blocked, and saving it again is refused rather than replayed', async () => {
    const bank = services();
    const saved = await customer(bank).ramps.destinations.save(entry(CLEAN));
    await list(bank, deskApprovals(), { network: '*', address: CLEAN, listed: true, expectedRevision: 0 });
    expect(await customer(bank).ramps.destinations.readiness({ destinationId: saved.destinationId })).toMatchObject({ state: 'blocked' });
    await expect(customer(bank).ramps.destinations.save({ ...entry(CLEAN), label: saved.label! })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'bank.destination_fraud_listed' }),
    });
  });

  it('delisting is its own approved change; the history keeps both, newest first, and refuses edits', async () => {
    const bank = services();
    const approvals = deskApprovals();
    await list(bank, approvals, { network: '*', address: LISTED, listed: true, expectedRevision: 0 });
    await list(
      bank,
      approvals,
      { network: '*', address: LISTED, listed: false, expectedRevision: 1 },
      'TEST: report withdrawn after review',
    );
    expect(approvals.consumed).toBe(2);
    await expect(customer(bank).ramps.destinations.save(entry(LISTED))).resolves.toMatchObject({ state: 'pending' });

    const desk = await caller(bank, OFFICER, ['admin:read']).ops.destinationFraudList({
      limit: 50,
      historyFor: { network: '*', address: LISTED.toUpperCase().replace('0X', '0x') },
      historyLimit: 10,
    });
    expect(desk.entries).toEqual([expect.objectContaining({ address: LISTED, listed: false, revision: 2 })]);
    expect(desk.history.map((h) => [h.revision, h.listed, h.requestedBy, h.approvedBy, h.changeKey])).toEqual([
      [2, false, OFFICER, APPROVER, fraudChangeKey('*', LISTED, 2)],
      [1, true, OFFICER, APPROVER, fraudChangeKey('*', LISTED, 1)],
    ]);
    await expect(sql`UPDATE bank.destination_fraud_list_history SET listed = true`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM bank.destination_fraud_list_history`).rejects.toThrow(/append-only/);
  });

  it('a retried change replays without a second approval; another change on the same revision conflicts', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const change = { network: '*', address: LISTED, listed: true, expectedRevision: 0 };
    await list(bank, approvals, change);
    const again = await caller(bank, OFFICER, ['admin:compliance'], approvals).ops.setDestinationFraudListing({
      ...change,
      reason: REASON,
    });
    expect(again).toMatchObject({ revision: 1, replayed: true });
    expect(approvals.consumed).toBe(1);
    await expect(list(bank, approvals, { ...change, listed: false })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'bank.ops_revision_conflict' }),
    });
    // Once a later change lands, the old retry is stale: it conflicts rather than reporting a state that is no longer true.
    await list(bank, approvals, { ...change, listed: false, expectedRevision: 1 }, 'TEST: report withdrawn after review');
    await expect(
      caller(bank, OFFICER, ['admin:compliance'], approvals).ops.setDestinationFraudListing({ ...change, reason: REASON }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'bank.ops_revision_conflict' }) });
  });

  it('needs compliance and a matching approval; a short reason and a read-only desk change nothing', async () => {
    const bank = services();
    const approvals = deskApprovals();
    const change = { network: '*', address: LISTED, listed: true, expectedRevision: 0 };
    await expect(
      caller(bank, OFFICER, ['admin:read'], approvals).ops.setDestinationFraudListing({
        ...change,
        reason: REASON,
        ...approvals.issue({ ...change, reason: REASON }),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(list(bank, approvals, change, 'too short')).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'bank.ops_reason_too_short' }),
    });
    // An approval for another address, or for this change with another reason, is not this change's approval.
    for (const wrong of [
      approvals.issue({ ...change, address: CLEAN, reason: REASON }),
      approvals.issue({ ...change, reason: 'TEST: some other reason' }),
    ]) {
      await expect(
        caller(bank, OFFICER, ['admin:compliance'], approvals).ops.setDestinationFraudListing({ ...change, reason: REASON, ...wrong }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    }
    expect(await new DestinationFraudList(sql).list(50)).toEqual([]);
    expect(await sql`SELECT 1 FROM bank.destination_fraud_list_history`).toHaveLength(0);
  });

  it('a send to a listed address is refused before anything is claimed or held, and an entry with no network matches any listing', async () => {
    const bank = services();
    await list(bank, deskApprovals(), { network: 'ethereum', address: LISTED, listed: true, expectedRevision: 0 });
    const list2 = new DestinationFraudList(sql);
    expect(await list2.isListed(null, LISTED)).toBe(true);
    expect(await list2.isListed('base', LISTED)).toBe(false);
    await expect(
      bank.ramps.offramp({
        offrampId: randomUUID(),
        userId: CUSTOMER,
        assetId: 'USDT',
        amount: 1n,
        kind: 'crypto',
        destinationRef: LISTED,
        clientRef: 'TEST-fraud-send',
      }),
    ).rejects.toMatchObject({ code: 'bank.destination_fraud_listed' });
    expect(await sql`SELECT 1 FROM bank.ramp_offramps WHERE user_id = ${CUSTOMER}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM bank.user_withdraw_destinations WHERE lower(ref) = ${LISTED}`).toHaveLength(0);
  });

  it('a list that cannot be read refuses the save rather than assuming the address is safe', async () => {
    const broken = new DestinationFraudList({} as TestDatabase['sql']);
    await expect(broken.isListed('ethereum', CLEAN)).rejects.toMatchObject({ code: 'bank.destination_fraud_list_unreadable' });
  });
});
