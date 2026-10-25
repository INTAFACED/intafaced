/**
 * RC-identity-08 (J-identity-05 #7): a recovery claim through the router. The heir lists the accounts identity says they
 * may claim, opens a claim and executes it with the owner's recovery key signatures; identity's verdict decides. A sweep
 * moves the owner's free balances (main account per asset and named spaces) into the heir's main account once, with
 * business keys; a retry posts nothing new, a crash resumes the same keys, later value goes in the next round, and held
 * value refuses the round. API keys, sub-accounts and staff are refused. Totals per asset never change.
 *
 * Postgres (TEST_DATABASE_URL) and a MemoryLedger. TEST data only.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, recoveryClaimMessage, signPrincipalHeader, type RecoveryEstate } from '@intafaced/contracts';
import {
  LedgerError,
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  recipes,
  subAccountAvailable,
  userAvailable,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import { BankError } from '../errors.js';
import { memoryIdentityRecovery } from './identity-recovery.js';
import { recoveryClaimId } from './recovery-claims.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: MIGRATIONS });
const sql = db.sql;

afterAll(async () => {
  await db.drop();
}, 30_000);

const SECRET = 'c'.repeat(32);
const SID = '77777777-7777-4777-8777-777777777777';
const OWNER = '71111111-1111-4111-8111-111111111111';
const HEIR = '72222222-2222-4222-8222-222222222222';
const STRANGER = '73333333-3333-4333-8333-333333333333';
const NOTICE = '74444444-4444-4444-8444-444444444444';
const KEY_A = '75555555-5555-4555-8555-555555555555';
const ESTATE: RecoveryEstate = { userId: OWNER, handle: 'owner_test', noticeId: NOTICE, threshold: 1, liveKeys: 1 };

const jwk = (() => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const out = publicKey.export({ format: 'jwk' });
  return { kty: 'EC' as const, crv: 'P-256' as const, x: out.x!, y: out.y! };
})();
const SIGNATURES = [{ publicKey: jwk, signature: 'A'.repeat(86) }];

let ledger: MemoryLedger;

beforeEach(async () => {
  await sql`TRUNCATE bank.recovery_sweeps, bank.recovery_claims, bank.spaces RESTART IDENTITY CASCADE`;
  ledger = new MemoryLedger();
});

type Scopes = { scopes?: string[]; kid?: string; sub_account?: string };

function mount(options: { ledger?: LedgerClient; estates?: Record<string, RecoveryEstate[]> } = {}) {
  const identity = memoryIdentityRecovery(options.estates ?? { [HEIR]: [ESTATE] });
  identity.answer(() => ({ ok: true, noticeId: NOTICE, threshold: 1, signerKeyIds: [KEY_A] }));
  const book = options.ledger ?? ledger;
  const bank = createBankServices(sql, book, memoryLedgerHistory(ledger), {
    recipients: memoryRecipientState(),
    identityRecovery: identity,
  });
  return { bank, identity, as: (userId: string, extra: Scopes = {}) => caller(bank, userId, extra) };
}

function caller(bank: BankServices, userId: string, extra: Scopes) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: SID,
    scopes: extra.scopes ?? ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...(extra.kid ? { kid: extra.kid } : {}),
    ...(extra.sub_account ? { sub_account: extra.sub_account } : {}),
  } as Principal);
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter(bank, {}).createCaller(
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

const refused = (code: string, trpc: string) => ({ code: trpc, cause: expect.objectContaining({ code }) });

async function fund(userId: string, assetId: string, amount: string, railRef = randomUUID()) {
  await ledger.post(recipes.deposit({ userId, assetId, amount: amt(amount), rail: 'test', railRef }));
}

async function namedPot(bank: BankServices, userId: string, name: string, amount: string) {
  await bank.spaces.ensurePrimary(userId, 'USDT');
  const pot = await bank.spaces.create({ userId, assetId: 'USDT', name });
  await ledger.post(
    recipes.bankTransfer({
      transferId: `test-fund-${pot.id}`,
      occurrence: 0,
      from: userAvailable(userId, 'USDT'),
      to: subAccountAvailable(pot.id, 'USDT'),
      amount: amt(amount),
      kind: 'manual',
      keySpace: 'own',
    }),
  );
  return pot;
}

const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
async function total(assetId: string, accounts: Array<Parameters<MemoryLedger['balance']>[0]>) {
  let sum = 0n;
  for (const ref of accounts) sum += (await ledger.balance(ref)).amount;
  return formatAmount(sum);
}

describe('recovery claims', () => {
  it('lists only the accounts identity names for the caller, with what a sweep moves', async () => {
    const { bank, as } = mount();
    await fund(OWNER, 'USDT', '100');
    await fund(OWNER, 'BTC', '0.5');
    const pot = await namedPot(bank, OWNER, 'TEST Holiday', '30');

    const listed = await as(HEIR).recovery.estates();
    expect(listed.estates).toHaveLength(1);
    expect(listed.estates[0]).toMatchObject({ userId: OWNER, handle: 'owner_test', threshold: 1, liveKeys: 1, claim: null, blockers: [] });
    expect(listed.estates[0]!.sweepable.map((a) => [a.assetId, a.spaceName, a.amount]).sort()).toEqual(
      [
        ['BTC', null, '0.5'],
        ['USDT', null, '70'],
        ['USDT', 'TEST Holiday', '30'],
      ].sort(),
    );
    expect(listed.estates[0]!.sweepable.find((a) => a.spaceId)?.spaceId).toBe(pot.id);
    expect((await as(STRANGER).recovery.estates()).estates).toEqual([]);
  });

  it('refuses an API key, a sub-account and staff, and refuses when identity is unset or down', async () => {
    const { bank, identity, as } = mount();
    await expect(as(HEIR, { kid: 'key-1' }).recovery.estates()).rejects.toMatchObject(refused('bank.recovery_delegated', 'FORBIDDEN'));
    await expect(as(HEIR, { sub_account: randomUUID() }).recovery.claims.open({ ownerUserId: OWNER })).rejects.toMatchObject(
      refused('bank.recovery_delegated', 'FORBIDDEN'),
    );
    for (const scopes of [
      ['bank:read', 'bank:write', 'admin:read'],
      ['bank:read', 'bank:write', 'support:ops'],
      ['bank:read', 'bank:write', 'market:ops'],
      ['bank:read', 'bank:write', 'campaigns:ops'],
    ]) {
      await expect(as(HEIR, { scopes }).recovery.estates()).rejects.toMatchObject(refused('bank.recovery_staff_forbidden', 'FORBIDDEN'));
    }
    identity.failWith(new BankError('Recovery claims could not be checked: identity answered 503', 'bank.recovery_unavailable'));
    await expect(as(HEIR).recovery.estates()).rejects.toMatchObject(refused('bank.recovery_unavailable', 'SERVICE_UNAVAILABLE'));

    const unset = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { recipients: memoryRecipientState() });
    await expect(caller(unset, HEIR, {}).recovery.estates()).rejects.toMatchObject(
      refused('bank.recovery_unavailable', 'SERVICE_UNAVAILABLE'),
    );
    expect(bank.recovery).toBeDefined();
  });

  it('opens one claim per account under the notice and gives the text each key signs; an account not listed refuses', async () => {
    const { as } = mount();
    const opened = await as(HEIR).recovery.claims.open({ ownerUserId: OWNER });
    expect(opened.claimId).toBe(recoveryClaimId(OWNER, NOTICE));
    expect(opened).toMatchObject({ status: 'open', round: 0, ownerUserId: OWNER, handle: 'owner_test', threshold: 1, liveKeys: 1 });
    expect(opened.message).toBe(recoveryClaimMessage({ userId: OWNER, heirUserId: HEIR, claimId: opened.claimId }));
    expect((await as(HEIR).recovery.claims.open({ ownerUserId: OWNER })).claimId).toBe(opened.claimId);
    expect((await as(HEIR).recovery.claims.open({ ownerUserId: OWNER.toUpperCase() })).claimId).toBe(opened.claimId);
    await expect(as(STRANGER).recovery.claims.open({ ownerUserId: OWNER })).rejects.toMatchObject(
      refused('bank.recovery_estate_not_found', 'NOT_FOUND'),
    );
    await expect(as(STRANGER).recovery.claims.execute({ claimId: opened.claimId, signatures: SIGNATURES })).rejects.toMatchObject(
      refused('bank.recovery_claim_not_found', 'NOT_FOUND'),
    );
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.recovery_claims`;
    expect(n).toBe(1);
  });

  it('identity refusing the signatures moves nothing and names identity’s code', async () => {
    const { identity, as } = mount();
    await fund(OWNER, 'USDT', '100');
    const { claimId } = await as(HEIR).recovery.claims.open({ ownerUserId: OWNER });
    identity.answer(() => ({ ok: false, code: 'identity.recovery_signatures_short' }));
    const err = await as(HEIR)
      .recovery.claims.execute({ claimId, signatures: SIGNATURES })
      .catch((e: unknown) => e);
    expect(err).toMatchObject(refused('bank.recovery_claim_refused', 'PRECONDITION_FAILED'));
    expect((err as Error).message).toContain('identity.recovery_signatures_short');
    expect(identity.asked).toEqual([{ userId: OWNER, heirUserId: HEIR, claimId, signatures: SIGNATURES }]);

    identity.answer(() => ({ ok: true, noticeId: randomUUID(), threshold: 1, signerKeyIds: [KEY_A] }));
    await expect(as(HEIR).recovery.claims.execute({ claimId, signatures: SIGNATURES })).rejects.toMatchObject(
      refused('bank.recovery_claim_refused', 'PRECONDITION_FAILED'),
    );
    expect(await bal(userAvailable(OWNER, 'USDT'))).toBe('100');
    expect(await bal(userAvailable(HEIR, 'USDT'))).toBe('0');
    const [{ n }] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.recovery_sweeps`;
    expect(n).toBe(0);
  });

  it('sweeps every free balance into the heir once; a retry posts nothing; later value goes in the next round', async () => {
    const { bank, as } = mount();
    await fund(OWNER, 'USDT', '100');
    await fund(OWNER, 'BTC', '0.5');
    await fund(HEIR, 'USDT', '5');
    const pot = await namedPot(bank, OWNER, 'TEST Holiday', '30');
    const accounts = {
      USDT: [userAvailable(OWNER, 'USDT'), subAccountAvailable(pot.id, 'USDT'), userAvailable(HEIR, 'USDT')],
      BTC: [userAvailable(OWNER, 'BTC'), userAvailable(HEIR, 'BTC')],
    };
    const before = { USDT: await total('USDT', accounts.USDT), BTC: await total('BTC', accounts.BTC) };

    const { claimId } = await as(HEIR).recovery.claims.open({ ownerUserId: OWNER });
    const done = await as(HEIR).recovery.claims.execute({ claimId, signatures: SIGNATURES });
    expect(done.round).toBe(0);
    expect(done.claim).toMatchObject({ status: 'executed', round: 1 });
    expect(done.sweeps.map((s) => [s.ownerType, s.assetId, s.amount, s.status]).sort()).toEqual(
      [
        ['subaccount', 'USDT', '30', 'posted'],
        ['user', 'BTC', '0.5', 'posted'],
        ['user', 'USDT', '70', 'posted'],
      ].sort(),
    );
    expect(await bal(userAvailable(HEIR, 'USDT'))).toBe('105');
    expect(await bal(userAvailable(HEIR, 'BTC'))).toBe('0.5');
    expect(await bal(userAvailable(OWNER, 'USDT'))).toBe('0');
    expect(await bal(subAccountAvailable(pot.id, 'USDT'))).toBe('0');
    expect({ USDT: await total('USDT', accounts.USDT), BTC: await total('BTC', accounts.BTC) }).toEqual(before);
    // The heir sees the swept value in their own main account.
    expect(await bank.spaces.findPrimary(HEIR, 'BTC')).not.toBeNull();

    const keys = await sql<Array<{ idempotency_key: string }>>`SELECT idempotency_key FROM bank.recovery_sweeps ORDER BY 1`;
    for (const { idempotency_key } of keys) {
      expect(idempotency_key).toMatch(new RegExp(`^bank\\.transfer\\.recovery:${claimId}:.+:0$`));
      expect(await ledger.getTxByKey(idempotency_key)).not.toBeNull();
    }

    const again = await as(HEIR).recovery.claims.execute({ claimId, signatures: SIGNATURES });
    expect(again).toMatchObject({ round: null, sweeps: [], claim: { status: 'executed', round: 1 } });
    expect(await bal(userAvailable(HEIR, 'USDT'))).toBe('105');

    await fund(OWNER, 'USDT', '12');
    const later = await as(HEIR).recovery.claims.execute({ claimId, signatures: SIGNATURES });
    expect(later.round).toBe(1);
    expect(later.sweeps.map((s) => [s.assetId, s.amount, s.status])).toEqual([['USDT', '12', 'posted']]);
    expect(later.claim.round).toBe(2);
    expect(await bal(userAvailable(HEIR, 'USDT'))).toBe('117');
    const [{ key }] = await sql<Array<{ key: string }>>`SELECT idempotency_key AS key FROM bank.recovery_sweeps WHERE round = 1`;
    expect(key.endsWith(':1')).toBe(true);
  });

  it('free value moves while held value stays, and a later round moves it once released', async () => {
    const { as } = mount();
    await fund(OWNER, 'USDT', '100');
    await ledger.post(recipes.orderHold({ orderId: 'test-order-1', userId: OWNER, assetId: 'USDT', amount: amt('10') }));
    const { claimId } = await as(HEIR).recovery.claims.open({ ownerUserId: OWNER });
    const listed = await as(HEIR).recovery.estates();
    expect(listed.estates[0]!.held.map((b) => [b.assetId, b.kind, b.amount])).toEqual([['USDT', 'hold', '10']]);
    expect(listed.estates[0]!.blockers).toEqual([]);
    const first = await as(HEIR).recovery.claims.execute({ claimId, signatures: SIGNATURES });
    expect(first.sweeps.map((s) => [s.assetId, s.amount, s.status, s.spaceId])).toEqual([['USDT', '90', 'posted', null]]);
    expect(await bal(userAvailable(OWNER, 'USDT'))).toBe('0');
    expect(await bal(userAvailable(HEIR, 'USDT'))).toBe('90');
    const after = await as(HEIR).recovery.estates();
    expect(after.estates[0]!.held.map((b) => b.amount)).toEqual(['10']);
    // The order is cancelled: its hold returns to the owner's free balance, and the next round moves it.
    await ledger.post(recipes.orderHoldRelease({ orderId: 'test-order-1', userId: OWNER, assetId: 'USDT', amount: amt('10') }));
    const later = await as(HEIR).recovery.claims.execute({ claimId, signatures: SIGNATURES });
    expect(later.sweeps.map((s) => [s.assetId, s.amount, s.status])).toEqual([['USDT', '10', 'posted']]);
    expect(await bal(userAvailable(HEIR, 'USDT'))).toBe('100');
  });

  it('a crash after the plan resumes the same keys and never posts twice', async () => {
    let failNext = 0;
    const flaky: LedgerClient = {
      post: async (request: PostRequest) => {
        if (request.idempotencyKey.startsWith('bank.transfer.recovery:') && failNext > 0) {
          failNext -= 1;
          // The ledger committed, then the answer was lost.
          await ledger.post(request);
          throw new LedgerError(
            'ledger writes are blocked: ledger.writes_blocked_store_unavailable',
            'ledger.writes_blocked_store_unavailable',
          );
        }
        return ledger.post(request);
      },
      balance: (ref) => ledger.balance(ref),
      balances: (type, id) => ledger.balances(type, id),
      getTx: (id) => ledger.getTx(id),
      getTxByKey: (key) => ledger.getTxByKey(key),
    };
    const { as } = mount({ ledger: flaky });
    await fund(OWNER, 'USDT', '100');
    await fund(OWNER, 'BTC', '2');
    const { claimId } = await as(HEIR).recovery.claims.open({ ownerUserId: OWNER });
    failNext = 1;
    await expect(as(HEIR).recovery.claims.execute({ claimId, signatures: SIGNATURES })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    const pending = await sql<Array<{ status: string }>>`SELECT status FROM bank.recovery_sweeps ORDER BY account_key`;
    expect(pending.map((r) => r.status)).toContain('pending');
    const [{ status, round }] = await sql<Array<{ status: string; round: number }>>`SELECT status, round FROM bank.recovery_claims`;
    expect({ status, round }).toEqual({ status: 'open', round: 0 });

    // Value arriving before the resume waits for the next round: the resumed round keeps its planned amounts.
    await fund(OWNER, 'USDT', '1');
    const resumed = await as(HEIR).recovery.claims.execute({ claimId, signatures: SIGNATURES });
    expect(resumed.round).toBe(0);
    expect(resumed.sweeps.map((s) => s.status)).toEqual(['posted', 'posted']);
    expect(await bal(userAvailable(HEIR, 'USDT'))).toBe('100');
    expect(await bal(userAvailable(HEIR, 'BTC'))).toBe('2');
    expect(await bal(userAvailable(OWNER, 'USDT'))).toBe('1');
    const next = await as(HEIR).recovery.claims.execute({ claimId, signatures: SIGNATURES });
    expect(next.sweeps.map((s) => [s.assetId, s.amount])).toEqual([['USDT', '1']]);
    expect(await bal(userAvailable(HEIR, 'USDT'))).toBe('101');
  });

  it('value gone between the plan and the post settles that row refused, and the next round takes what is left', async () => {
    const { bank, as } = mount();
    await fund(OWNER, 'USDT', '100');
    const pot = await namedPot(bank, OWNER, 'TEST Pot', '40');
    const { claimId } = await as(HEIR).recovery.claims.open({ ownerUserId: OWNER });
    // Something moved 25 out of the pot after the plan and before its post: the pot's planned 40 is no longer there.
    const original = bank.recovery.execute.bind(bank.recovery);
    const sweptPot = subAccountAvailable(pot.id, 'USDT');
    const drain = ledger.post.bind(ledger);
    let drained = false;
    ledger.post = async (request: PostRequest) => {
      if (!drained && request.idempotencyKey.startsWith('bank.transfer.recovery:') && request.idempotencyKey.includes(pot.id)) {
        drained = true;
        await drain(
          recipes.bankTransfer({
            transferId: 'test-drain',
            occurrence: 0,
            from: sweptPot,
            to: userAvailable(OWNER, 'USDT'),
            amount: amt('25'),
            kind: 'manual',
            keySpace: 'own',
          }),
        );
      }
      return drain(request);
    };
    const done = await original(HEIR, claimId, SIGNATURES);
    const byOwner = Object.fromEntries(done.sweeps.map((s) => [s.fromOwnerType, s]));
    expect(byOwner.subaccount).toMatchObject({ status: 'refused', refusalCode: 'ledger.insufficient_funds' });
    expect(done.claim).toMatchObject({ status: 'executed', round: 1 });
    // The main account's planned 60 posted; the 25 moved into it and the pot's 15 are swept by the next round.
    const next = await as(HEIR).recovery.claims.execute({ claimId, signatures: SIGNATURES });
    expect(next.sweeps.every((s) => s.status === 'posted')).toBe(true);
    expect(await bal(userAvailable(OWNER, 'USDT'))).toBe('0');
    expect(await bal(sweptPot)).toBe('0');
    expect(await bal(userAvailable(HEIR, 'USDT'))).toBe('100');
  });

  it('a round another call already posted is not planned again: new value goes in the next round', async () => {
    const { as } = mount();
    await fund(OWNER, 'USDT', '100');
    const { claimId } = await as(HEIR).recovery.claims.open({ ownerUserId: OWNER });
    await as(HEIR).recovery.claims.execute({ claimId, signatures: SIGNATURES });
    // The call that posted round 0 has not moved the claim on yet.
    await sql`UPDATE bank.recovery_claims SET round = 0 WHERE id = ${claimId}`;
    await fund(OWNER, 'USDT', '3');
    const next = await as(HEIR).recovery.claims.execute({ claimId, signatures: SIGNATURES });
    expect(next.round).toBe(1);
    expect(next.sweeps.map((s) => [s.amount, s.status])).toEqual([['3', 'posted']]);
    expect(next.claim.round).toBe(2);
    expect(await bal(userAvailable(HEIR, 'USDT'))).toBe('103');
  });

  it('a ledger refusal that proves nothing posted settles the row, and a claim that moved nothing stays open', async () => {
    const refusing: LedgerClient = {
      post: async (request: PostRequest) => {
        if (request.idempotencyKey.startsWith('bank.transfer.recovery:'))
          throw new LedgerError('TEST asset not listed', 'ledger.invalid_entry');
        return ledger.post(request);
      },
      balance: (ref) => ledger.balance(ref),
      balances: (type, id) => ledger.balances(type, id),
      getTx: (id) => ledger.getTx(id),
      getTxByKey: (key) => ledger.getTxByKey(key),
    };
    const { as } = mount({ ledger: refusing });
    await fund(OWNER, 'USDT', '100');
    const { claimId } = await as(HEIR).recovery.claims.open({ ownerUserId: OWNER });
    const done = await as(HEIR).recovery.claims.execute({ claimId, signatures: SIGNATURES });
    expect(done.sweeps.map((s) => [s.status, s.refusalCode])).toEqual([['refused', 'ledger.invalid_entry']]);
    expect(done.claim).toMatchObject({ status: 'open', round: 1, executedAt: null });
    // Nothing is stuck: the next call plans a new round from the ledger.
    const again = await as(HEIR).recovery.claims.execute({ claimId, signatures: SIGNATURES });
    expect(again.round).toBe(1);
    expect(await bal(userAvailable(OWNER, 'USDT'))).toBe('100');
  });
});
