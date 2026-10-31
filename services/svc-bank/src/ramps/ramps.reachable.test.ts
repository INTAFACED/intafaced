import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger } from '@intafaced/ledger-client';
import { createBankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { stubApprovalConsumer } from '../action-approval-consume.js';
import { createBankRouter } from '../router.js';
import { CRYPTO_LEDGER_PROGRAMME, NO_RAMP_PROGRAMME, RAMP_SETTINGS, rampProgrammeFor } from './rails.js';
import { memorySecurityLock } from '../security-lock.js';

// The owner's destination sanctions list, a TEST entry for this file: without one every save and send refuses
// bank.destination_sanctions_unset. No address these tests use is on it.
const sanctionsBefore = process.env.BANK_DESTINATION_SANCTIONS;
beforeAll(() => {
  process.env.BANK_DESTINATION_SANCTIONS = '*:0x5a7c7100000000000000000000000000000ba5ed';
});
afterAll(() => {
  if (sanctionsBefore === undefined) delete process.env.BANK_DESTINATION_SANCTIONS;
  else process.env.BANK_DESTINATION_SANCTIONS = sanctionsBefore;
});

/**
 * CAN ANYBODY ACTUALLY CALL RAMPS? (D-S-09 / D-S-15 posture)
 *
 * Enters through createBankRouter + signed createEdgeContext — never RampService
 * directly — so wiring regressions fail here.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `bank.*` SQL stays on `bank`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_BANK`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const EDGE_SECRET = 'a-bank-ramps-reachability-edge-secret-long-enough';
const HOLDER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APPROVAL = { approvalId: 'appr-1', operationId: 'op-1' } as const;

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-bank ramps.reachable is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('rampProgrammeFor is total over the closed setting set', () => {
  it('enumerates exactly none and crypto-ledger', () => {
    expect([...RAMP_SETTINGS]).toEqual(['none', 'crypto-ledger']);
    expect(rampProgrammeFor('none').id).toBe('none');
    expect(rampProgrammeFor('crypto-ledger').simulated).toBe(true);
  });
});

describe('ramps.reachable (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-bank ramps reachable (PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-bank' });

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations: MIGRATIONS });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  function principal(overrides: Partial<Principal> = {}): Principal {
    return {
      sub: HOLDER,
      userId: HOLDER,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes: ['bank:read', 'bank:write', 'trade:withdraw'],
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    } as Principal;
  }

  function signed(p: Principal) {
    const raw = encodePrincipal(p);
    return edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-signed',
    });
  }

  describe('composition root default refuses', () => {
    it('programme is none when ramps option is omitted', async () => {
      const ledger = new MemoryLedger();
      const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
      const caller = createBankRouter(bank, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(signed(principal()));
      const programme = await caller.ramps.programme();
      expect(programme).toEqual({
        id: 'none',
        simulated: true,
        displayName: NO_RAMP_PROGRAMME.displayName,
        cryptoRail: null,
        fiatLeg: 'socket.psp-partners',
        fiatVia: 'svc-pay.RailAdapter',
      });
    });
  });

  describe('reachable crypto ledger half', () => {
    let ledger: MemoryLedger;

    beforeEach(async () => {
      process.env.BANK_OFFRAMP_COOLING_HOURS = '0';
      await sql`TRUNCATE bank.ramp_offramps, bank.ramp_onramps, bank.user_withdraw_destinations RESTART IDENTITY CASCADE`;
      ledger = new MemoryLedger();
    });

    it('operator credits on-ramp; user off-ramps; simulated never flips', async () => {
      const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        ramps: { securityLock: memorySecurityLock(), programme: CRYPTO_LEDGER_PROGRAMME },
      });
      const ops = createBankRouter(bank, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(
        signed(principal({ userId: OPERATOR, sub: OPERATOR, scopes: ['admin:treasury'], mfa: true })),
      );
      const user = createBankRouter(bank, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(signed(principal()));

      const programme = await user.ramps.programme();
      expect(programme.simulated).toBe(true);
      expect(programme.fiatLeg).toBe('socket.psp-partners');
      expect(programme.fiatVia).toBe('svc-pay.RailAdapter');
      expect(programme.cryptoRail).toBeTruthy();

      const credited = await ops.ops.creditOnramp({
        userId: HOLDER,
        assetId: 'USDT',
        amount: '40',
        kind: 'crypto',
        railRef: `reach-${randomUUID()}`,
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      });
      expect(credited.simulated).toBe(true);
      expect(credited.status).toBe('settled');

      await expect(
        ops.ops.creditOnramp({
          userId: HOLDER,
          assetId: 'USDT',
          amount: '1',
          kind: 'fiat',
          railRef: `fiat-${randomUUID()}`,
          confirmOperatorId: CONFIRM,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({
        message: 'bank.fiat_ramp_socket',
        cause: { code: 'bank.fiat_ramp_socket' },
      });

      const offrampId = randomUUID();
      const out = await user.ramps.offramp({
        offrampId,
        assetId: 'USDT',
        amount: '15',
        kind: 'crypto',
        destinationRef: '0x000000000000000000000000000000000000dEaD',
        clientRef: `c-${offrampId}`,
      });
      expect(out.simulated).toBe(true);
      expect(out.status).toBe('settled');

      const listed = await user.ramps.offramps({ limit: 50 });
      expect(listed.some((r) => r.id === offrampId && r.simulated === true)).toBe(true);
    });

    it('offramp without programme refuses precondition', async () => {
      const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        ramps: { securityLock: memorySecurityLock(), programme: NO_RAMP_PROGRAMME },
      });
      const user = createBankRouter(bank, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(signed(principal()));
      await expect(
        user.ramps.offramp({
          offrampId: randomUUID(),
          assetId: 'USDT',
          amount: '1',
          kind: 'crypto',
          destinationRef: '0x',
          clientRef: 'nope',
        }),
      ).rejects.toMatchObject({ message: 'bank.no_ramp_rail', cause: { code: 'bank.no_ramp_rail' } });
    });

    /**
     * Residual closeout gap: the gate was real in code but unasserted end-to-end.
     * A holder with only bank:write must not be able to credit an on-ramp — that
     * is operator surface (`admin:treasury`), because a user who can invent a
     * deposit invents money.
     */
    it('refuses ops.creditOnramp for a user session without admin:treasury', async () => {
      const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        ramps: { securityLock: memorySecurityLock(), programme: CRYPTO_LEDGER_PROGRAMME },
      });
      const user = createBankRouter(bank, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(signed(principal()));
      await expect(
        user.ops.creditOnramp({
          userId: HOLDER,
          assetId: 'USDT',
          amount: '1',
          kind: 'crypto',
          railRef: `user-try-${randomUUID()}`,
          ...APPROVAL,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });
});
