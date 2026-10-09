/**
 * D26-P1-B4 — bank.ramps fiat on/off via pay adapters COMPLETE (public doors).
 *
 * Done bar: kind fiat refuses bank.fiat_ramp_socket before any row or ledger
 * post. These tables are the crypto ledger half. No second book.
 *
 * Breaks caught:
 *   · live fiat money path exists only as a RampService unit test and never
 *     through createBankRouter + signed edge (composition-root regression);
 *   · a sandbox pay rail launders into bank fiat and invents a PSP;
 *   · fiat books against a bank-local rail id instead of the pay adapter id;
 *   · a second money book appears beside ledger-client deposit/withdraw.
 *
 * Enter through the mounted router. Value moves only via imported ledger-client
 * recipes on MemoryLedger. Does not touch auto-invest / business trees.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `bank.*` SQL stays on `bank`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_BANK`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { stubApprovalConsumer } from '../action-approval-consume.js';
import { createBankRouter } from '../router.js';
import { inRepoPayFiatRampPort, type PayFiatRampPort } from './pay-fiat-adapter.js';
import { CRYPTO_LEDGER_PROGRAMME, NO_RAMP_PROGRAMME } from './rails.js';

const SECRET = 'bank-ramps-fiat-product-boundary-secret-32';
const HOLDER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APPROVAL = { approvalId: 'appr-1', operationId: 'op-1' } as const;

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const livePay: PayFiatRampPort = {
  listFiatRails: () => [{ railId: 'pay-fiat-ach', mode: 'live', capabilities: ['onramp', 'offramp'] }],
};

const sandboxPay: PayFiatRampPort = {
  listFiatRails: () => [{ railId: 'card-sandbox', mode: 'sandbox', capabilities: ['onramp', 'offramp'] }],
};

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
      `H8a: svc-bank ramps-fiat-product is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('ramps-fiat-product (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('D26-P1-B4 bank.ramps fiat public doors — pay adapters, ledger-only', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  function principal(userId: string, scopes: Principal['scopes']): Principal {
    return {
      sub: userId,
      userId,
      sid: randomUUID(),
      scopes,
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
  }

  function signedCaller(bank: ReturnType<typeof createBankServices>, actor: Principal) {
    const raw = encodePrincipal(actor);
    return createBankRouter(bank, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(
      edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  beforeEach(async () => {
    process.env.BANK_OFFRAMP_COOLING_HOURS = '0';
    await sql`TRUNCATE bank.ramp_offramps, bank.ramp_onramps, bank.user_withdraw_destinations RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
  });

  it('names fiatVia on the programme door without inventing a bank PSP', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay },
    });
    const programme = await signedCaller(bank, principal(HOLDER, ['bank:read'])).ramps.programme();
    expect(programme).toMatchObject({
      simulated: true,
      fiatLeg: 'socket.psp-partners',
      fiatVia: 'svc-pay.RailAdapter',
    });
  });

  it('ramps.fiatSettle public door refuses when no pay adapter can settle fiat', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { programme: CRYPTO_LEDGER_PROGRAMME },
    });
    await expect(signedCaller(bank, principal(HOLDER, ['bank:read'])).ramps.fiatSettle()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.fiat_ramp_no_pay_adapter' },
    });
  });

  it('public doors name-refuse no programme / no fiat rail / empty adapter — invent must not open a ramp', async () => {
    const none = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { programme: NO_RAMP_PROGRAMME },
    });
    const noneUser = signedCaller(none, principal(HOLDER, ['bank:read', 'bank:write']));
    const noneOps = signedCaller(none, principal(OPERATOR, ['admin:treasury']));

    await expect(
      noneUser.ramps.offramp({
        offrampId: randomUUID(),
        assetId: 'USDT',
        amount: '1',
        kind: 'crypto',
        destinationRef: '0x000000000000000000000000000000000000dEaD',
        clientRef: `none-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.no_ramp_rail' },
    });
    await expect(
      noneOps.ops.creditOnramp({
        userId: HOLDER,
        assetId: 'USDT',
        amount: '1',
        kind: 'fiat',
        railRef: `none-fiat-${randomUUID()}`,
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.fiat_ramp_socket' },
    });

    const empty = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { programme: CRYPTO_LEDGER_PROGRAMME },
    });
    const emptyOps = signedCaller(empty, principal(OPERATOR, ['admin:treasury']));
    await expect(
      emptyOps.ops.creditOnramp({
        userId: HOLDER,
        assetId: 'USDT',
        amount: '1',
        kind: 'fiat',
        railRef: `empty-${randomUUID()}`,
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.fiat_ramp_socket' },
    });

    const noRail = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: sandboxPay },
    });
    const noRailOps = signedCaller(noRail, principal(OPERATOR, ['admin:treasury']));
    await expect(
      noRailOps.ops.creditOnramp({
        userId: HOLDER,
        assetId: 'USDT',
        amount: '1',
        kind: 'fiat',
        railRef: `norail-${randomUUID()}`,
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.fiat_ramp_socket' },
    });

    const counts = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM bank.ramp_onramps
      UNION ALL
      SELECT count(*)::int AS n FROM bank.ramp_offramps
    `;
    expect(counts.every((row) => row.n === 0)).toBe(true);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('ramps.fiatSettle refuses in-repo sandbox/absent pay adapters', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: inRepoPayFiatRampPort },
    });
    await expect(signedCaller(bank, principal(HOLDER, ['bank:read'])).ramps.fiatSettle()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.no_fiat_rail' },
    });
  });

  it('refuses fiat through ops.creditOnramp when no live pay adapter is injected', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { programme: CRYPTO_LEDGER_PROGRAMME },
    });
    const ops = signedCaller(bank, principal(OPERATOR, ['admin:treasury']));
    await expect(
      ops.ops.creditOnramp({
        userId: HOLDER,
        assetId: 'USDT',
        amount: '10',
        kind: 'fiat',
        railRef: `empty-${randomUUID()}`,
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.fiat_ramp_socket' },
    });
    const count = await sql`SELECT count(*)::int AS n FROM bank.ramp_onramps`;
    expect(count[0]!.n).toBe(0);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('sandbox pay rails still refuse fiat through the public door', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: sandboxPay },
    });
    const ops = signedCaller(bank, principal(OPERATOR, ['admin:treasury']));
    await expect(
      ops.ops.creditOnramp({
        userId: HOLDER,
        assetId: 'USDT',
        amount: '10',
        kind: 'fiat',
        railRef: `sandbox-${randomUUID()}`,
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.fiat_ramp_socket' },
    });
    const count = await sql`SELECT count(*)::int AS n FROM bank.ramp_onramps`;
    expect(count[0]!.n).toBe(0);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses fiat on-ramp through the ops door before a row or a ledger post', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay },
    });
    const ops = signedCaller(bank, principal(OPERATOR, ['admin:treasury']));
    await expect(
      ops.ops.creditOnramp({
        userId: HOLDER,
        assetId: 'USDT',
        amount: '25',
        kind: 'fiat',
        railRef: `ach-in-${randomUUID()}`,
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.fiat_ramp_socket' },
    });

    const count = await sql`SELECT count(*)::int AS n FROM bank.ramp_onramps`;
    expect(count[0]!.n).toBe(0);
    expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(amt('0'));
    expect(ledger.journal()).toHaveLength(0);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses fiat off-ramp through the user door before a row or a ledger post', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay },
    });
    const user = signedCaller(bank, principal(HOLDER, ['bank:read', 'bank:write']));
    const offrampId = randomUUID();
    await expect(
      user.ramps.offramp({
        offrampId,
        assetId: 'USDT',
        amount: '15',
        kind: 'fiat',
        destinationRef: 'GB82WEST12345698765432',
        clientRef: `fiat-out-${offrampId}`,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'bank.fiat_ramp_socket' },
    });

    const counts = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM bank.ramp_offramps
      UNION ALL
      SELECT count(*)::int AS n FROM bank.ramp_onramps
    `;
    expect(counts.every((row) => row.n === 0)).toBe(true);
    expect((await ledger.balance(userAvailable(HOLDER, 'USDT'))).amount).toBe(amt('0'));
    expect(ledger.journal()).toHaveLength(0);
    expect(ledger.reconcile()).toEqual({ ok: true });

    const listed = await user.ramps.offramps({ limit: 50 });
    expect(listed.some((row) => row.kind === 'fiat')).toBe(false);
  });

  it('refuses user sessions inventing fiat on-ramp credits', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      ramps: { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay },
    });
    const user = signedCaller(bank, principal(HOLDER, ['bank:read', 'bank:write']));
    await expect(
      user.ops.creditOnramp({
        userId: HOLDER,
        assetId: 'USDT',
        amount: '1',
        kind: 'fiat',
        railRef: `user-try-${randomUUID()}`,
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});
