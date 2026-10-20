import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { BankApproverEligibilityPort, BankApproverEligibilityResult } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, userAvailable, formatAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayGuardRefusal, type UserMoneyWithdrawalContext } from '../../seams/guards.js';
import { CardSandboxAdapter } from '../../rails/card-sandbox.js';
import { RailRegistry } from '../../rails/registry.js';
import { UserMoneyService } from '../../user-money-service.js';
import { AllowlistError } from './errors.js';
import { createAllowlistGuards } from './guard.js';
import { AllowlistService, normalizeAddress, requestHashOf } from './service.js';

/** The withdrawal allowlist against a real Postgres. TEST figures only. */
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
    .withDatabase('intafaced_allowlist_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const SECRET = 'svc-pay-allowlist-secret-at-least-32-chars';
const OWNER = '11111111-1111-4111-8111-111111111111';
const A1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const A2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const OUTSIDER = 'aaaaaaaa-0000-4000-8000-000000000009';
const TEAM = 'bbbbbbbb-0000-4000-8000-000000000001';
const OPERATOR = '99999999-9999-4999-8999-999999999999';
const ADDR = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const ADDR2 = '0x1111111111111111111111111111111111111111';

class FakeTeam implements BankApproverEligibilityPort {
  eligible = new Set([A1, A2]);
  down = false;
  async check(input: { accountId: string; userId: string }): Promise<BankApproverEligibilityResult> {
    if (this.down) return { state: 'unavailable', code: 'bank.approver_eligibility_unavailable' };
    return this.eligible.has(input.userId) ? { state: 'eligible', role: 'checker' } : { state: 'not_a_member' };
  }
}

describe('withdrawal allowlist (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let team: FakeTeam;
  let service: AllowlistService;
  let owner: string;
  let other: string;
  let seq = 0;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(() => {
    // The mode, policy and quorum history is append-only by trigger, so each test uses a user of its own.
    seq += 1;
    owner = `11111111-1111-4111-8111-${String(seq).padStart(12, '0')}`;
    other = `22222222-2222-4222-8222-${String(seq).padStart(12, '0')}`;
    team = new FakeTeam();
    service = new AllowlistService({ sql: db.sql, eligibility: team });
  });

  const ref = (() => {
    let n = 0;
    return () => `ref-${++n}`;
  })();
  const quorum = (n = 2, userId = owner) => service.setQuorum(OPERATOR, { userId, teamAccountId: TEAM, requiredApprovals: n });
  const add = (over: Partial<{ address: string; label: string; assetId: string; clientRef: string }> = {}, userId = owner) =>
    service.proposeAdd(userId, { group: 'external_wallet', assetId: 'USDT', address: ADDR, label: 'Cold', clientRef: ref(), ...over });
  const approveAll = async (changeId: string, hash: string, who: string[]) => {
    let last;
    for (const a of who) last = await service.approve(a, changeId, hash);
    return last!;
  };
  const addListed = async (over: Parameters<typeof add>[0] = {}, userId = owner) => {
    const c = await add(over, userId);
    await approveAll(c.id, c.requestHash, [A1, A2]);
    return c;
  };
  /** Drive the claim guard the way `claimWithdrawal` does: inside one transaction. */
  const claim = (over: Partial<Omit<UserMoneyWithdrawalContext, 'tx'>> = {}, userId = owner): Promise<void> =>
    db.sql.begin(async (tx) => {
      await createAllowlistGuards().beforeUserMoneyWithdrawal!({
        tx: tx as never,
        userId,
        assetId: 'USDT',
        amount: amt('10'),
        rail: 'crypto-native',
        destination: { kind: 'crypto', ref: ADDR },
        clientRef: ref(),
        replay: { kind: 'fresh' },
        ...over,
      });
    }) as Promise<void>;
  const turnOn = async (userId = owner) => service.setMode(userId, { enabled: true, clientRef: ref() });

  it('is off by default: any crypto destination passes', async () => {
    await expect(claim()).resolves.toBeUndefined();
    expect(await service.mode(owner)).toMatchObject({ enabled: false, setAt: null });
    expect(await service.policy(owner)).toMatchObject({ enabled: false, assetId: null });
  });

  it('refuses a change with no quorum set, and refuses turning the mode on with no quorum', async () => {
    await expect(add()).rejects.toMatchObject({ code: 'allowlist.quorum_unset' });
    await expect(turnOn()).rejects.toMatchObject({ code: 'allowlist.quorum_unset' });
    await expect(service.proposePolicy(owner, { enabled: true, assetId: 'USDT', maxAmount: '5', clientRef: ref() })).rejects.toMatchObject({
      code: 'allowlist.quorum_unset',
    });
  });

  it('default deny: with the mode on an unlisted address refuses, and the typed pre-check names it', async () => {
    await quorum();
    await turnOn();
    await expect(claim()).rejects.toBeInstanceOf(PayGuardRefusal);
    await expect(claim()).rejects.toMatchObject({ code: 'pay.guard_destination_not_allowlisted' });
    await expect(
      service.assertDirectAllowed({
        userId: owner,
        assetId: 'USDT',
        amount: amt('1'),
        clientRef: ref(),
        destination: { kind: 'crypto', ref: ADDR },
      }),
    ).rejects.toMatchObject({ code: 'pay.destination_not_allowlisted' });
    // A bank destination is not on this list; a withdrawal with no destination in the ask is not judged here.
    await expect(claim({ destination: { kind: 'bank', ref: 'DE89370400440532013000' } })).resolves.toBeUndefined();
  });

  it('turning the mode on twice is one event; turning it off is a governed change', async () => {
    await quorum();
    await turnOn();
    await turnOn();
    const [n] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.allowlist_mode_events WHERE user_id = ${owner}`;
    expect(n!.n).toBe(1);
    const off = await service.setMode(owner, { enabled: false, clientRef: ref() });
    expect(off.change).toMatchObject({ op: 'mode_off', status: 'waiting' });
    expect(off.mode.enabled).toBe(true);
    await approveAll(off.change!.id, off.change!.requestHash, [A1, A2]);
    expect((await service.mode(owner)).enabled).toBe(false);
    await expect(service.setMode(owner, { enabled: false, clientRef: ref() })).rejects.toMatchObject({
      code: 'allowlist.mode_already_off',
    });
  });

  it('an add waits for the quorum: one approval is still waiting, the second applies it', async () => {
    await quorum(2);
    const change = await add();
    expect(change).toMatchObject({ status: 'waiting', requiredApprovals: 2, approvalCount: 0 });
    const one = await service.approve(A1, change.id, change.requestHash);
    expect(one).toMatchObject({ status: 'waiting', approvalCount: 1, approvedByMe: true });
    expect(await service.listEntries(owner, { limit: 10 })).toHaveLength(0);
    const two = await service.approve(A2, change.id, change.requestHash);
    expect(two).toMatchObject({ status: 'approved', approvalCount: 2 });
    const [entry] = await service.listEntries(owner, { limit: 10 });
    expect(entry).toMatchObject({ address: ADDR, label: 'Cold', state: 'active', group: 'external_wallet', assetId: 'USDT' });
  });

  it('two approvals landing together apply the change once', async () => {
    await quorum(2);
    const c = await add();
    const [a, b] = await Promise.all([service.approve(A1, c.id, c.requestHash), service.approve(A2, c.id, c.requestHash)]);
    expect([a.status, b.status]).toContain('approved');
    expect(await service.listEntries(owner, { limit: 10 })).toHaveLength(1);
    expect((await service.get(owner, c.id)).status).toBe('approved');
  });

  it('the same person approving twice counts once', async () => {
    await quorum(2);
    const c = await add();
    await service.approve(A1, c.id, c.requestHash);
    const again = await service.approve(A1, c.id, c.requestHash);
    expect(again).toMatchObject({ status: 'waiting', approvalCount: 1 });
  });

  it('the requester cannot approve or reject; an outsider and an unreachable team count for nothing', async () => {
    await quorum();
    team.eligible.add(owner);
    const c = await add();
    await expect(service.approve(owner, c.id, c.requestHash)).rejects.toMatchObject({ code: 'allowlist.requester_cannot_approve' });
    await expect(service.reject(owner, c.id, c.requestHash)).rejects.toMatchObject({ code: 'allowlist.requester_cannot_approve' });
    await expect(service.approve(OUTSIDER, c.id, c.requestHash)).rejects.toMatchObject({ code: 'allowlist.approver_not_eligible' });
    team.down = true;
    await expect(service.approve(A1, c.id, c.requestHash)).rejects.toMatchObject({ code: 'allowlist.eligibility_unavailable' });
    const unwired = new AllowlistService({ sql: db.sql });
    await expect(unwired.approve(A1, c.id, c.requestHash)).rejects.toMatchObject({ code: 'allowlist.eligibility_unwired' });
    expect((await service.get(owner, c.id)).approvalCount).toBe(0);
  });

  it('one rejection blocks, and a rejected change cannot be approved later', async () => {
    await quorum(2);
    const c = await add();
    await service.approve(A1, c.id, c.requestHash);
    const rejected = await service.reject(A2, c.id, c.requestHash);
    expect(rejected.status).toBe('rejected');
    await expect(service.approve(A2, c.id, c.requestHash)).rejects.toMatchObject({ code: 'allowlist.not_waiting' });
    expect(await service.listEntries(owner, { limit: 10 })).toHaveLength(0);
  });

  it('the request hash binds the address: a wrong hash is refused, a changed address is a different request', async () => {
    await quorum();
    const a = await add({ address: ADDR, clientRef: 'r-a' });
    await expect(service.approve(A1, a.id, 'f'.repeat(64))).rejects.toMatchObject({ code: 'allowlist.hash_mismatch' });
    const b = await add({ address: ADDR2, label: 'Other', clientRef: 'r-b' });
    expect(b.requestHash).not.toBe(a.requestHash);
    // A hash is bound to this user too.
    expect(requestHashOf(owner, 'add', null, { address: ADDR })).not.toBe(requestHashOf(other, 'add', null, { address: ADDR }));
    // Approving b's hash against a is refused.
    await expect(service.approve(A1, a.id, b.requestHash)).rejects.toMatchObject({ code: 'allowlist.hash_mismatch' });
  });

  it('is idempotent on the client reference; the same reference with other terms conflicts', async () => {
    await quorum();
    const first = await add({ clientRef: 'same' });
    const again = await add({ clientRef: 'same' });
    expect(again.id).toBe(first.id);
    await expect(add({ clientRef: 'same', address: ADDR2 })).rejects.toMatchObject({ code: 'allowlist.conflict' });
  });

  it('refuses a duplicate address or label at submit, and a second claim to one slot fails when applied', async () => {
    await quorum(1);
    await addListed({ clientRef: 'first' });
    await expect(add({ address: ADDR.toLowerCase(), label: 'New' })).rejects.toMatchObject({ code: 'allowlist.address_listed' });
    await expect(add({ address: ADDR2, label: 'cold' })).rejects.toMatchObject({ code: 'allowlist.label_taken' });
    // Two changes proposed together for one label: the second to be approved fails when applied, and says why.
    const x = await add({ address: ADDR2, label: 'Shared', clientRef: 'x' });
    const y = await add({ address: '0x2222222222222222222222222222222222222222', label: 'shared', clientRef: 'y' });
    await service.approve(A1, x.id, x.requestHash);
    const failed = await service.approve(A1, y.id, y.requestHash);
    expect(failed).toMatchObject({ status: 'failed', failureCode: 'allowlist.label_taken' });
  });

  it('rejects an address the list cannot hold', async () => {
    await quorum();
    await expect(add({ address: 'nope' })).rejects.toMatchObject({ code: 'allowlist.address_invalid' });
    expect(normalizeAddress(ADDR)).toBe(ADDR.toLowerCase());
    expect(normalizeAddress(' bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq ')).toBe('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
  });

  it('a listed address passes for its own asset only, case-insensitive for EVM, and stamps the last use', async () => {
    await quorum();
    await addListed();
    await turnOn();
    await expect(claim({ destination: { kind: 'crypto', ref: ADDR.toLowerCase() } })).resolves.toBeUndefined();
    await expect(claim({ destination: { kind: 'crypto', ref: ADDR.toUpperCase().replace('0X', '0x') } })).resolves.toBeUndefined();
    await expect(claim({ assetId: 'ETH' })).rejects.toMatchObject({ code: 'pay.guard_destination_not_allowlisted' });
    const [entry] = await service.listEntries(owner, { limit: 5 });
    expect(entry!.lastUsedAt).not.toBeNull();
  });

  it("another user's list never opens this user's door", async () => {
    await quorum();
    await quorum(2, other);
    await addListed({}, other);
    await turnOn();
    await expect(claim()).rejects.toMatchObject({ code: 'pay.guard_destination_not_allowlisted' });
  });

  it('a held or already admitted withdrawal is never refused (recovery and replay)', async () => {
    await quorum();
    await turnOn();
    await expect(claim({ replay: { kind: 'recovery', reason: 'withdrawal_hold_booked' } })).resolves.toBeUndefined();
    await expect(claim({ replay: { kind: 'replay', reason: 'withdrawal_already_sent' } })).resolves.toBeUndefined();
  });

  it('delete is a governed request; once applied the address refuses again and can be listed again', async () => {
    await quorum();
    const added = await addListed();
    await turnOn();
    const [entry] = await service.listEntries(owner, { limit: 5 });
    const del = await service.proposeDelete(owner, { entryId: entry!.id, clientRef: ref() });
    expect(del).toMatchObject({ op: 'delete', entryId: entry!.id, status: 'waiting' });
    await expect(claim()).resolves.toBeUndefined(); // still listed while the request waits
    await approveAll(del.id, del.requestHash, [A1, A2]);
    await expect(claim()).rejects.toMatchObject({ code: 'pay.guard_destination_not_allowlisted' });
    expect(await service.listEntries(owner, { limit: 5 })).toHaveLength(0);
    expect(await service.listEntries(owner, { limit: 5 }, true)).toHaveLength(1);
    await expect(service.proposeDelete(owner, { entryId: entry!.id, clientRef: ref() })).rejects.toMatchObject({
      code: 'allowlist.entry_not_found',
    });
    await expect(addListed({ clientRef: 'again' })).resolves.toBeDefined();
    expect(added.status).toBe('waiting'); // the view returned at submit is a snapshot
  });

  it("a user cannot delete another user's entry", async () => {
    await quorum();
    await quorum(2, other);
    await addListed({}, other);
    const [theirs] = await service.listEntries(other, { limit: 5 });
    await expect(service.proposeDelete(owner, { entryId: theirs!.id, clientRef: ref() })).rejects.toMatchObject({
      code: 'allowlist.entry_not_found',
    });
  });

  it('the requester can cancel a waiting change, and no other user can', async () => {
    await quorum();
    const c = await add();
    await expect(service.cancel(other, c.id)).rejects.toMatchObject({ code: 'allowlist.not_found' });
    expect((await service.cancel(owner, c.id)).status).toBe('cancelled');
    await expect(service.approve(A1, c.id, c.requestHash)).rejects.toMatchObject({ code: 'allowlist.not_waiting' });
    await expect(service.cancel(owner, c.id)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('suspended means refused until resumed; operators act at once; a removed entry cannot be suspended', async () => {
    await quorum();
    await addListed();
    await turnOn();
    const [entry] = await service.listEntries(owner, { limit: 5 });
    expect(await service.suspend(OPERATOR, entry!.id, 'review')).toMatchObject({ state: 'suspended', suspendedReason: 'review' });
    await expect(claim()).rejects.toMatchObject({ code: 'pay.guard_destination_not_allowlisted' });
    expect(await service.resume(OPERATOR, entry!.id)).toMatchObject({ state: 'active', suspendedReason: null });
    await expect(claim()).resolves.toBeUndefined();
  });

  it('one-time sends are off until a governed change turns them on, then only for that asset and up to the amount', async () => {
    await quorum();
    await turnOn();
    await expect(claim({ amount: amt('1') })).rejects.toMatchObject({ code: 'pay.guard_destination_not_allowlisted' });
    const p = await service.proposePolicy(owner, { enabled: true, assetId: 'USDT', maxAmount: '25', clientRef: ref() });
    await expect(claim({ amount: amt('1') })).rejects.toMatchObject({ code: 'pay.guard_destination_not_allowlisted' }); // still waiting
    await approveAll(p.id, p.requestHash, [A1, A2]);
    expect(await service.policy(owner)).toMatchObject({ enabled: true, assetId: 'USDT', maxAmount: '25' });
    await expect(claim({ amount: amt('25') })).resolves.toBeUndefined();
    await expect(claim({ amount: amt('25.000000000000000001') })).rejects.toMatchObject({ code: 'pay.guard_destination_not_allowlisted' });
    await expect(claim({ amount: amt('1'), assetId: 'ETH' })).rejects.toMatchObject({ code: 'pay.guard_destination_not_allowlisted' });
    // Only this user.
    await quorum(1, other);
    await turnOn(other);
    await expect(claim({ amount: amt('1') }, other)).rejects.toMatchObject({ code: 'pay.guard_destination_not_allowlisted' });
    // An unchanged policy is not a new request.
    await expect(service.proposePolicy(owner, { enabled: true, assetId: 'USDT', maxAmount: '25', clientRef: ref() })).rejects.toMatchObject(
      {
        code: 'allowlist.policy_unchanged',
      },
    );
    const off = await service.proposePolicy(owner, { enabled: false, assetId: 'USDT', maxAmount: '25', clientRef: ref() });
    await approveAll(off.id, off.requestHash, [A1, A2]);
    await expect(claim({ amount: amt('1') })).rejects.toMatchObject({ code: 'pay.guard_destination_not_allowlisted' });
  });

  it('reads are scoped: the requester and an eligible approver see a change, an outsider sees nothing', async () => {
    await quorum();
    const c = await add();
    expect((await service.get(owner, c.id)).id).toBe(c.id);
    expect((await service.get(A1, c.id)).id).toBe(c.id);
    await expect(service.get(OUTSIDER, c.id)).rejects.toMatchObject({ code: 'allowlist.not_found' });
    expect((await service.listForTeam(A1, { teamAccountId: TEAM, limit: 200 })).map((x) => x.id)).toContain(c.id);
    expect(
      (await service.listForTeam(A2, { teamAccountId: TEAM, status: 'approved', limit: 200 })).filter((x) => x.userId === owner),
    ).toHaveLength(0);
    await expect(service.listForTeam(OUTSIDER, { teamAccountId: TEAM, limit: 10 })).rejects.toMatchObject({
      code: 'allowlist.approver_not_eligible',
    });
    await expect(service.listChanges(owner, {})).rejects.toBeInstanceOf(AllowlistError);
    expect(await service.listChanges(other, { limit: 10 })).toHaveLength(0);
  });

  it('history is append-only', async () => {
    await quorum();
    await turnOn();
    await expect(db.sql`UPDATE pay.allowlist_mode_events SET enabled = false WHERE user_id = ${owner}`).rejects.toThrow(/append-only/);
    await expect(db.sql`DELETE FROM pay.allowlist_quorum_events WHERE user_id = ${owner}`).rejects.toThrow(/append-only/);
    await expect(db.sql`DELETE FROM pay.allowlist_events WHERE user_id = ${owner}`).rejects.toThrow(/append-only/);
  });

  it('a refusal strands nothing: through the real withdrawal service a refused withdrawal leaves the balance whole', async () => {
    await quorum();
    await turnOn();
    const ledger = new MemoryLedger();
    const rails = new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 })]);
    const money = new UserMoneyService(db.sql, ledger, rails, {
      operatorCreditRails: ['card-sandbox'],
      claimGuards: createAllowlistGuards(),
    });
    await money.credit({
      userId: owner,
      assetId: 'USDT',
      amount: amt('100'),
      rail: 'card-sandbox',
      railRef: `psp_${seq}`,
      creditedBy: OPERATOR,
    });
    // A bank destination is outside this list, so the withdrawal goes through and the claim guard let it by.
    await money.withdraw({
      userId: owner,
      assetId: 'USDT',
      amount: amt('10'),
      rail: 'card-sandbox',
      destination: { kind: 'bank', ref: 'DE89370400440532013000' },
      clientRef: 'bank-1',
    });
    expect(formatAmount((await ledger.balance(userAvailable(owner, 'USDT'))).amount)).toBe('90');
    await expect(claim()).rejects.toMatchObject({ code: 'pay.guard_destination_not_allowlisted' });
    expect(formatAmount((await ledger.balance(userAvailable(owner, 'USDT'))).amount)).toBe('90');
  });
});
