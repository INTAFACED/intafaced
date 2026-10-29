import { memoryApprovalLinks } from './ramps/address-approval.js';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, parseAmount as amt, userAvailable, type LedgerClient } from '@intafaced/ledger-client';
import { BankError } from './errors.js';
import { RampService } from './ramps/ramp-service.js';
import { CRYPTO_LEDGER_PROGRAMME } from './ramps/rails.js';
import { memoryWithdrawNetworks } from './ramps/withdraw-networks.js';
import { memoryWalletProofs } from './ramps/wallet-ownership.js';
import { createIdentitySecurityLock, memorySecurityLock, unconfiguredSecurityLock } from './security-lock.js';
import { memoryWithdrawDestinations } from './withdraw-destination.js';
import { memoryFraudList } from './ramps/fraud-list.js';

/**
 * W-withdraw-09, svc-bank's half of the customer security lock (J-wallet-04 #7): while the owner's lock holds, no
 * withdrawal address is added or removed and nothing is sent to one, and a bank that cannot read the lock refuses the
 * same way. Also the per-address readiness the address book shows (J-wallet-04 #5): the lock first, then the cooling-off
 * with its end. If it crashes here, whose funds are stranded? None: the lock is read before any row or ledger post.
 */

const here = dirname(fileURLToPath(import.meta.url));
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '44444444-4444-4444-8444-444444444444';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const EVM = '0x000000000000000000000000000000000000dEaD';
const ADDRESS = '0xabCDeF0123456789AbcdEf0123456789aBCDEF01';
const SECRET = 'a-bank-security-lock-test-secret-long-enough';
const UNLOCKS_AT = '2026-10-25T08:00:00.000Z';
const LOCKED = { locked: true, unlocksAt: UNLOCKS_AT };

const registry = memoryWithdrawNetworks([
  {
    id: 'USDT',
    kind: 'crypto',
    precision: 6,
    networks: [{ networkId: 'erc20', label: 'TEST erc20' }],
    defaultNetworkId: 'erc20',
    allowedActions: ['deposit', 'withdraw'],
    state: 'active',
    revision: 1,
    updatedAt: '2026-10-23T00:00:00.000Z',
  },
]);
const entry = { userId: USER, assetId: 'USDT', network: 'erc20', ref: ADDRESS, label: 'TEST cold wallet' };

function identityAnswering(answer: () => Response | Promise<Response>) {
  const asked: string[] = [];
  const fetchFn = (async (url: string | URL) => {
    asked.push(String(url));
    return answer();
  }) as typeof globalThis.fetch;
  return { asked, fetchFn };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const lockBody = (over: Record<string, unknown> = {}) => ({
  userId: USER,
  locked: true,
  lockedAt: '2026-10-24T06:00:00.000Z',
  setBy: 'self',
  unlockRequestedAt: null,
  unlocksAt: null,
  ...over,
});
const silentLog = () => undefined;

describe('the identity security lock port', () => {
  it('reads the lock identity holds, from the internal route for that user', async () => {
    const { asked, fetchFn } = identityAnswering(() =>
      json(lockBody({ unlockRequestedAt: '2026-10-24T07:00:00.000Z', unlocksAt: UNLOCKS_AT })),
    );
    const port = createIdentitySecurityLock('http://identity.test/', SECRET, fetchFn, silentLog);
    await expect(port.read(USER)).resolves.toEqual({ locked: true, unlocksAt: UNLOCKS_AT });
    expect(asked).toEqual([`http://identity.test/internal/security-lock/${USER}`]);
  });

  it('reads an open lock as open', async () => {
    const { fetchFn } = identityAnswering(() => json(lockBody({ locked: false, lockedAt: null, setBy: null })));
    await expect(createIdentitySecurityLock('http://identity.test', SECRET, fetchFn, silentLog).read(USER)).resolves.toEqual({
      locked: false,
      unlocksAt: null,
    });
  });

  it.each([
    ['a 404', () => json({ code: 'identity.account_not_found' }, 404)],
    ['a 500', () => json({ error: 'boom' }, 500)],
    ['a 401', () => json({ code: 'identity.unauthenticated' }, 401)],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a body outside the schema', () => json({ userId: USER, locked: 'yes' })],
    ['an answer about another user', () => json(lockBody({ userId: OTHER, locked: false }))],
    [
      'no answer at all',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('refuses as unavailable on %s, never as "no lock"', async (_case, answer) => {
    const { fetchFn } = identityAnswering(answer);
    await expect(createIdentitySecurityLock('http://identity.test', SECRET, fetchFn, silentLog).read(USER)).rejects.toMatchObject({
      code: 'bank.security_lock_unavailable',
    });
  });

  it('refuses unset when no identity is configured', async () => {
    await expect(unconfiguredSecurityLock().read(USER)).rejects.toMatchObject({ code: 'bank.security_lock_unset' });
  });
});

describe('the address book while the security lock holds', () => {
  function ramps(lock = memorySecurityLock(), destinations = memoryWithdrawDestinations({ addressBookCap: () => '5' })) {
    const service = new RampService({} as Sql, {} as LedgerClient, {
      fraudList: memoryFraudList(),
      securityLock: lock,
      destinations,
      withdrawNetworks: registry,
      walletProofs: memoryWalletProofs(),
      approvalLinks: memoryApprovalLinks(),
      offrampCoolingHours: '24',
      walletProofWindowMinutes: '30',
      walletProofValidDays: '180',
    });
    return { service, lock, destinations };
  }

  it('refuses adding an address, and the book is unchanged', async () => {
    const { service, destinations } = ramps(memorySecurityLock({ [USER]: LOCKED }));
    await expect(service.saveDestination(entry)).rejects.toMatchObject({ code: 'bank.security_locked' });
    await expect(service.checkDestination({ userId: USER, ref: ADDRESS })).rejects.toMatchObject({ code: 'bank.security_locked' });
    await expect(service.setWithdrawDestination({ userId: USER, kind: 'crypto', ref: EVM })).rejects.toMatchObject({
      code: 'bank.security_locked',
    });
    expect(await destinations.list(USER)).toEqual([]);
  });

  it('answers a replay of a save made before the lock as before, and adds nothing new', async () => {
    const { service, lock, destinations } = ramps();
    const saved = await service.saveDestination(entry);
    lock.set(USER, LOCKED);
    await expect(service.saveDestination({ ...entry, ref: ADDRESS.toLowerCase() })).resolves.toMatchObject({
      destinationId: saved.destinationId,
    });
    await expect(service.saveDestination({ ...entry, tag: 'memo-1', label: 'TEST other' })).rejects.toMatchObject({
      code: 'bank.security_locked',
    });
    expect((await destinations.list(USER)).map((row) => row.destinationId)).toEqual([saved.destinationId]);
  });

  it('still removes an address: removing only takes a way out away', async () => {
    const { service, lock, destinations } = ramps();
    const saved = await service.saveDestination(entry);
    lock.set(USER, LOCKED);
    await expect(
      service.removeDestination({
        userId: USER,
        destinationId: saved.destinationId,
        idempotencyKey: `destination-remove:${saved.destinationId}`,
      }),
    ).resolves.toEqual({ destinationId: saved.destinationId, removed: true });
    expect(await destinations.list(USER)).toEqual([]);
  });

  it('still renames: a label cannot change where money goes', async () => {
    const { service, lock } = ramps();
    const saved = await service.saveDestination(entry);
    lock.set(USER, LOCKED);
    await expect(
      service.renameDestination({ userId: USER, destinationId: saved.destinationId, label: 'TEST renamed' }),
    ).resolves.toMatchObject({
      label: 'TEST renamed',
    });
  });

  it('refuses every change when identity cannot be read, and stores nothing', async () => {
    const { service, lock, destinations } = ramps();
    lock.failWith(new BankError('identity is down', 'bank.security_lock_unavailable'));
    await expect(service.saveDestination(entry)).rejects.toMatchObject({ code: 'bank.security_lock_unavailable' });
    expect(await destinations.list(USER)).toEqual([]);
  });

  it('refuses every change on a deployment that cannot read the lock', async () => {
    const { service, destinations } = ramps(unconfiguredSecurityLock() as ReturnType<typeof memorySecurityLock>);
    await expect(service.saveDestination(entry)).rejects.toMatchObject({ code: 'bank.security_lock_unset' });
    expect(await destinations.list(USER)).toEqual([]);
  });

  it('reads the lock of the caller, not of anyone else', async () => {
    const { service, lock } = ramps(memorySecurityLock({ [OTHER]: LOCKED }));
    await expect(service.saveDestination(entry)).resolves.toMatchObject({ label: 'TEST cold wallet' });
    expect(lock.asked).toEqual([USER]);
  });
});

describe('whether a saved address can be used now', () => {
  const HOUR = 60 * 60 * 1000;

  function at(clock: { now: Date }) {
    const lock = memorySecurityLock();
    const destinations = memoryWithdrawDestinations({ addressBookCap: () => '5', now: () => clock.now });
    const service = (hours: string) =>
      new RampService({} as Sql, {} as LedgerClient, {
        fraudList: memoryFraudList(),
        securityLock: lock,
        destinations,
        withdrawNetworks: registry,
        walletProofs: memoryWalletProofs(),
        approvalLinks: memoryApprovalLinks(),
        offrampCoolingHours: hours,
      });
    return { lock, service, destinations };
  }

  /** Saved, then approved by its emailed link: its cooling-off runs from the approval (W-withdraw-09). */
  async function approved(service: RampService, destinations: ReturnType<typeof memoryWithdrawDestinations>) {
    const saved = await service.saveDestination(entry);
    await destinations.approve({ userId: USER, destinationId: saved.destinationId, by: 'link' });
    return saved;
  }

  it('says approval_pending for a new address until it is approved, with until when an emailed link works', async () => {
    const clock = { now: new Date() };
    const { service, destinations } = at(clock);
    const saved = await service('24').saveDestination(entry);
    expect(saved).toMatchObject({ state: 'pending', coolingOffEndsAt: null, approvalLinkExpiresAt: null });
    await expect(service('24').destinationReadiness({ userId: USER, destinationId: saved.destinationId })).resolves.toEqual({
      destinationId: saved.destinationId,
      state: 'approval_pending',
      coolingOffEndsAt: null,
      lockUnlocksAt: null,
      approvalLinkExpiresAt: null,
    });
    await destinations.approve({ userId: USER, destinationId: saved.destinationId, by: 'link' });
    await expect(service('24').destinationReadiness({ userId: USER, destinationId: saved.destinationId })).resolves.toMatchObject({
      state: 'cooling',
    });
  });

  it('says cooling, with the end of the cooling-off, for an address saved just now', async () => {
    const clock = { now: new Date() };
    const { service, destinations } = at(clock);
    const saved = await approved(service('24'), destinations);
    const answer = await service('24').destinationReadiness({ userId: USER, destinationId: saved.destinationId });
    expect(answer.state).toBe('cooling');
    expect(answer.coolingOffEndsAt).toBe(new Date(clock.now.getTime() + 24 * HOUR).toISOString());
    expect(answer.lockUnlocksAt).toBeNull();
  });

  it('says ready once the cooling-off has ended', async () => {
    const clock = { now: new Date(Date.now() - 25 * HOUR) };
    const { service, destinations } = at(clock);
    const saved = await approved(service('24'), destinations);
    await expect(service('24').destinationReadiness({ userId: USER, destinationId: saved.destinationId })).resolves.toMatchObject({
      state: 'ready',
    });
  });

  it('says cooling_unset while no cooling-off period is published, and invents none', async () => {
    const clock = { now: new Date(Date.now() - 25 * HOUR) };
    const { service, destinations } = at(clock);
    const saved = await approved(service('24'), destinations);
    await expect(service('').destinationReadiness({ userId: USER, destinationId: saved.destinationId })).resolves.toEqual({
      destinationId: saved.destinationId,
      state: 'cooling_unset',
      coolingOffEndsAt: null,
      lockUnlocksAt: null,
      approvalLinkExpiresAt: null,
    });
  });

  it('says cooling with no end when the published period runs past any date, as the send path refuses it', async () => {
    const clock = { now: new Date() };
    const { service, destinations } = at(clock);
    const saved = await approved(service('24'), destinations);
    await expect(service('99999999999999').destinationReadiness({ userId: USER, destinationId: saved.destinationId })).resolves.toEqual({
      destinationId: saved.destinationId,
      state: 'cooling',
      coolingOffEndsAt: null,
      lockUnlocksAt: null,
      approvalLinkExpiresAt: null,
    });
  });

  it('puts the security lock first, with when it ends', async () => {
    const clock = { now: new Date(Date.now() - 25 * HOUR) };
    const { service, lock, destinations } = at(clock);
    const saved = await approved(service('24'), destinations);
    lock.set(USER, LOCKED);
    await expect(service('24').destinationReadiness({ userId: USER, destinationId: saved.destinationId })).resolves.toMatchObject({
      state: 'locked',
      lockUnlocksAt: UNLOCKS_AT,
    });
  });

  it('does not answer for an address that is someone else’s or not in the book', async () => {
    const clock = { now: new Date() };
    const { service, destinations } = at(clock);
    const saved = await approved(service('24'), destinations);
    await expect(service('24').destinationReadiness({ userId: OTHER, destinationId: saved.destinationId })).rejects.toMatchObject({
      code: 'bank.withdraw_destination_missing',
    });
    await expect(service('24').destinationReadiness({ userId: USER, destinationId: randomUUID() })).rejects.toMatchObject({
      code: 'bank.withdraw_destination_missing',
    });
  });
});

describe('a crypto withdrawal while the security lock holds (money)', () => {
  const migrations = readdirSync(join(here, '..', 'drizzle'))
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let lock: ReturnType<typeof memorySecurityLock>;
  let ramps: RampService;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset: the security lock money proof needs Postgres (no skip-green)');
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE bank.ramp_offramps, bank.ramp_onramps, bank.user_withdraw_destinations RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    lock = memorySecurityLock();
    ramps = new RampService(sql, ledger, { securityLock: lock, programme: CRYPTO_LEDGER_PROGRAMME, offrampCoolingHours: '0' });
    await ramps.creditOnramp({
      userId: USER,
      assetId: 'USDT',
      amount: amt('80'),
      kind: 'crypto',
      railRef: `lock-fund-${randomUUID()}`,
      creditedBy: OPERATOR,
    });
    await ramps.setWithdrawDestination({ userId: USER, kind: 'crypto', ref: EVM });
  });

  const send = (id = randomUUID()) =>
    ramps.offramp({ offrampId: id, userId: USER, assetId: 'USDT', amount: amt('10'), kind: 'crypto', clientRef: `lock-send-${id}` });

  async function nothingMoved() {
    expect(ledger.journal().some((tx) => tx.reason === 'withdraw.held' || tx.reason === 'withdraw.settled')).toBe(false);
    const rows = await sql`SELECT count(*)::int AS n FROM bank.ramp_offramps`;
    expect(rows[0]!.n).toBe(0);
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('80');
  }

  it('refuses bank.security_locked before any row or hold, and the balance stays whole', async () => {
    lock.set(USER, LOCKED);
    await expect(send()).rejects.toMatchObject({ code: 'bank.security_locked' });
    await nothingMoved();
  });

  it('refuses when identity cannot say, and nothing moves', async () => {
    lock.failWith(new BankError('identity is down', 'bank.security_lock_unavailable'));
    await expect(send()).rejects.toMatchObject({ code: 'bank.security_lock_unavailable' });
    await nothingMoved();
  });

  it('answers a replay of a send settled before the lock as before, and posts nothing more', async () => {
    const id = randomUUID();
    const first = await send(id);
    expect(first.status).toBe('settled');
    const posted = ledger.journal().length;
    lock.set(USER, LOCKED);
    await expect(send(id)).resolves.toMatchObject({ id: first.id, status: 'settled' });
    expect(ledger.journal()).toHaveLength(posted);
    // A new send under another id is refused.
    await expect(send()).rejects.toMatchObject({ code: 'bank.security_locked' });
    expect(ledger.journal()).toHaveLength(posted);
  });

  it('refuses a replay that names another address while locked, and the withdrawal address stays', async () => {
    const id = randomUUID();
    const first = await send(id);
    lock.set(USER, LOCKED);
    const attacker = '0x0000000000000000000000000000000000000001';
    await expect(
      ramps.offramp({
        offrampId: id,
        userId: USER,
        assetId: 'USDT',
        amount: amt('10'),
        kind: 'crypto',
        destinationRef: attacker,
        clientRef: `lock-send-${id}`,
      }),
    ).rejects.toMatchObject({ code: 'bank.security_locked' });
    const rows = await sql<Array<{ ref: string }>>`
      SELECT ref FROM bank.user_withdraw_destinations WHERE user_id = ${USER} AND kind = 'crypto' AND origin = 'legacy'
    `;
    expect(rows.map((row) => row.ref)).toEqual([EVM]);
    // The same replay with the address it was claimed with still answers as before.
    await expect(
      ramps.offramp({
        offrampId: id,
        userId: USER,
        assetId: 'USDT',
        amount: amt('10'),
        kind: 'crypto',
        destinationRef: first.destinationRef,
        clientRef: `lock-send-${id}`,
      }),
    ).resolves.toMatchObject({ status: 'settled' });
  });

  it('sends once the lock has ended: the same request id then goes through, hold and settle once', async () => {
    const id = randomUUID();
    lock.set(USER, LOCKED);
    await expect(send(id)).rejects.toMatchObject({ code: 'bank.security_locked' });
    lock.set(USER, { locked: false, unlocksAt: null });
    const row = await send(id);
    expect(row.status).toBe('settled');
    expect(ledger.journal().filter((tx) => tx.reason === 'withdraw.held')).toHaveLength(1);
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('70');
  });
});
