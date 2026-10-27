/**
 * Customer ramp and deposit doors (BANKRAMPS items 9–14).
 *
 * Enters through the mounted router. A blank PSP, fee source, or custody port
 * refuses by name and writes no row. Injected ports return their own decimals;
 * this service does not price, invent a zero fee, or derive an address.
 * No ledger post on any of these doors.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type RegistryAsset } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { stubApprovalConsumer } from '../action-approval-consume.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import type { CustodyDepositPort } from '../deposits/custody-port.js';
import type { OfframpFeeSource, OnrampPaymentPort, OnrampQuoteSource } from './customer-ports.js';
import type { PayFiatRampPort } from './pay-fiat-adapter.js';
import { CRYPTO_LEDGER_PROGRAMME, NO_RAMP_PROGRAMME } from './rails.js';
import { memorySecurityLock } from '../security-lock.js';
import { memoryAssetRegistry } from '../assets/supported-assets.js';

const SECRET = 'bank-customer-ramps-deposits-edge-secret';
const HOLDER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const EVM = '0x000000000000000000000000000000000000dEaD';
const IBAN = 'GB82WEST12345698765432';
const QUOTE_EXPIRY = '2026-12-01T00:00:00.000Z';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

/** One published registry row (W-balances-05). Test rows, not owner values. */
function registryRow(
  id: string,
  networkIds: string[],
  extra: Partial<Pick<RegistryAsset, 'allowedActions' | 'state' | 'precision'>> = {},
): RegistryAsset {
  return {
    id,
    kind: 'crypto',
    precision: extra.precision ?? 6,
    networks: networkIds.map((networkId) => ({ networkId, label: `Test ${networkId}` })),
    defaultNetworkId: networkIds[0] ?? null,
    allowedActions: extra.allowedActions ?? ['deposit', 'withdraw', 'trade', 'transfer'],
    state: extra.state ?? 'active',
    revision: 1,
    updatedAt: '2026-10-24T00:00:00.000Z',
  };
}
/** The registry these custody tests assume: both test coins open for deposits on the test network. */
const OPEN_REGISTRY = memoryAssetRegistry([registryRow('USDC', ['testnet']), registryRow('USDT', ['testnet'])]);

const livePay: PayFiatRampPort = {
  listFiatRails: () => [{ railId: 'pay-fiat-ach', mode: 'live', capabilities: ['onramp', 'offramp'] }],
};

function quoteSource(): OnrampQuoteSource {
  return {
    async quote() {
      return {
        payAmount: '10.37',
        fee: '0.37',
        rate: '7',
        payCurrency: 'EUR',
        expiresAt: new Date(QUOTE_EXPIRY),
      };
    },
  };
}

describe('customer ramps and deposits (source)', () => {
  it('is not skip-green', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('customer ramps and deposits', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

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
    process.env.BANK_OFFRAMP_COOLING_HOURS = '0';
    await sql`
      TRUNCATE bank.customer_onramps, bank.ramp_onramp_quotes, bank.withdraw_destination_removals,
               bank.deposit_addresses, bank.ramp_offramps, bank.ramp_onramps, bank.user_withdraw_destinations
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  function principal(userId: string, scopes: string[]): Principal {
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

  function caller(bank: ReturnType<typeof createBankServices>, userId: string, scopes: string[]) {
    const actor = principal(userId, scopes);
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

  function bankWith(options: Parameters<typeof createBankServices>[3]) {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), options);
  }

  const readWrite = ['bank:read', 'bank:write', 'trade:withdraw'];

  it('onrampQuote refuses a blank PSP and a blank rate source, and returns the source decimals when both exist', async () => {
    const none = bankWith({
      ramps: { securityLock: memorySecurityLock(), programme: NO_RAMP_PROGRAMME, payFiat: livePay, onrampQuotes: quoteSource() },
    });
    await expect(
      caller(none, HOLDER, readWrite).ramps.onrampQuote({ assetId: 'USDT', amount: '10', method: 'card', country: 'DE' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'bank.fiat_ramp_socket' } });

    const empty = bankWith({ ramps: { securityLock: memorySecurityLock(), programme: CRYPTO_LEDGER_PROGRAMME } });
    await expect(
      caller(empty, HOLDER, readWrite).ramps.onrampQuote({ assetId: 'USDT', amount: '10', method: 'card', country: 'DE' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'bank.fiat_ramp_no_pay_adapter' } });

    const noRate = bankWith({ ramps: { securityLock: memorySecurityLock(), programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay } });
    await expect(
      caller(noRate, HOLDER, readWrite).ramps.onrampQuote({ assetId: 'USDT', amount: '10', method: 'bank_transfer', country: 'DE' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'bank.onramp_rate_unset' } });

    const quoted = bankWith({
      ramps: { securityLock: memorySecurityLock(), programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay, onrampQuotes: quoteSource() },
    });
    const quote = await caller(quoted, HOLDER, readWrite).ramps.onrampQuote({
      assetId: 'USDT',
      amount: '10',
      method: 'card',
      country: 'de',
    });
    // 10 × 7 is 70. These figures are the source's, not a spread this service computed.
    expect(quote).toMatchObject({
      assetId: 'USDT',
      amount: '10',
      method: 'card',
      country: 'DE',
      payAmount: '10.37',
      fee: '0.37',
      rate: '7',
      payCurrency: 'EUR',
      expiresAt: QUOTE_EXPIRY,
      simulated: true,
    });
    const quotes = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bank.ramp_onramp_quotes`;
    const credits = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bank.ramp_onramps`;
    expect(quotes[0]!.n).toBe(1);
    expect(credits[0]!.n).toBe(0);
    expect(ledger.journal()).toHaveLength(0);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('onrampCreate is idempotent by onrampId, stores the partner instruction, and credits nothing', async () => {
    let opens = 0;
    const payments: OnrampPaymentPort = {
      async open() {
        opens += 1;
        return { partnerRail: 'test-psp', hostedUrl: 'https://payments.test/hosted/abc' };
      },
    };
    const bank = bankWith({
      ramps: {
        securityLock: memorySecurityLock(),
        programme: CRYPTO_LEDGER_PROGRAMME,
        payFiat: livePay,
        onrampQuotes: quoteSource(),
        onrampPayments: payments,
      },
    });
    const user = caller(bank, HOLDER, readWrite);
    const missingId = randomUUID();
    await expect(user.ramps.onrampCreate({ onrampId: missingId, quoteId: randomUUID(), method: 'card' })).rejects.toMatchObject({
      cause: { code: 'bank.onramp_quote_missing' },
    });

    const quote = await user.ramps.onrampQuote({ assetId: 'USDT', amount: '10', method: 'card', country: 'DE' });
    const blocked = bankWith({
      ramps: { securityLock: memorySecurityLock(), programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay, onrampQuotes: quoteSource() },
    });
    await expect(
      caller(blocked, HOLDER, readWrite).ramps.onrampCreate({ onrampId: randomUUID(), quoteId: quote.quoteId, method: 'card' }),
    ).rejects.toMatchObject({ cause: { code: 'bank.fiat_ramp_socket' } });
    const noneYet = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bank.customer_onramps`;
    expect(noneYet[0]!.n).toBe(0);

    const onrampId = randomUUID();
    const created = await user.ramps.onrampCreate({ onrampId, quoteId: quote.quoteId, method: 'card' });
    expect(created).toMatchObject({
      onrampId,
      quoteId: quote.quoteId,
      assetId: 'USDT',
      amount: '10',
      payAmount: '10.37',
      fee: '0.37',
      rate: '7',
      payCurrency: 'EUR',
      status: 'pending_payment',
      simulated: true,
      partnerRail: 'test-psp',
      hostedUrl: 'https://payments.test/hosted/abc',
      bankInstructions: null,
    });
    const again = await user.ramps.onrampCreate({ onrampId, quoteId: quote.quoteId, method: 'card' });
    expect(again.onrampId).toBe(onrampId);
    expect(opens).toBe(1);

    const second = await user.ramps.onrampQuote({ assetId: 'USDT', amount: '10', method: 'card', country: 'DE' });
    await expect(user.ramps.onrampCreate({ onrampId, quoteId: second.quoteId, method: 'card' })).rejects.toMatchObject({
      cause: { code: 'bank.ramp_conflict' },
    });

    await sql`UPDATE bank.ramp_onramp_quotes SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ${second.quoteId}::uuid`;
    await expect(user.ramps.onrampCreate({ onrampId: randomUUID(), quoteId: second.quoteId, method: 'card' })).rejects.toMatchObject({
      cause: { code: 'bank.onramp_quote_expired' },
    });

    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bank.customer_onramps`;
    const credits = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bank.ramp_onramps`;
    expect(rows[0]!.n).toBe(1);
    expect(credits[0]!.n).toBe(0);
    expect(ledger.journal()).toHaveLength(0);
  });

  it('bank transfer instructions are the partner account, not a hosted URL', async () => {
    const payments: OnrampPaymentPort = {
      async open(input) {
        expect(input.method).toBe('bank_transfer');
        return {
          partnerRail: 'test-bank',
          bank: { reference: 'TEST-REF-9', accountName: 'Test Partner', accountRef: IBAN },
        };
      },
    };
    const bank = bankWith({
      ramps: {
        securityLock: memorySecurityLock(),
        programme: CRYPTO_LEDGER_PROGRAMME,
        payFiat: livePay,
        onrampQuotes: quoteSource(),
        onrampPayments: payments,
      },
    });
    const user = caller(bank, HOLDER, readWrite);
    const quote = await user.ramps.onrampQuote({ assetId: 'USDT', amount: '10', method: 'bank_transfer', country: 'DE' });
    const created = await user.ramps.onrampCreate({
      onrampId: randomUUID(),
      quoteId: quote.quoteId,
      method: 'bank_transfer',
    });
    expect(created.hostedUrl).toBeNull();
    expect(created.bankInstructions).toEqual({ reference: 'TEST-REF-9', accountName: 'Test Partner', accountRef: IBAN });
    expect(ledger.journal()).toHaveLength(0);
  });

  it('offrampQuote refuses fiat and an unpublished crypto fee, and returns a schedule that adds up', async () => {
    const fees: OfframpFeeSource = {
      async quote() {
        return { fee: '0.37', netAmount: '9.63', expiresAt: new Date(QUOTE_EXPIRY) };
      },
    };
    const crypto = bankWith({
      ramps: { securityLock: memorySecurityLock(), programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay, offrampFees: fees },
    });
    const user = caller(crypto, HOLDER, readWrite);
    await expect(user.ramps.offrampQuote({ assetId: 'USDT', amount: '15', kind: 'fiat', destinationRef: IBAN })).rejects.toMatchObject({
      cause: { code: 'bank.fiat_ramp_socket' },
    });

    const noFee = bankWith({ ramps: { securityLock: memorySecurityLock(), programme: CRYPTO_LEDGER_PROGRAMME } });
    await expect(
      caller(noFee, HOLDER, readWrite).ramps.offrampQuote({ assetId: 'USDT', amount: '10', kind: 'crypto', destinationRef: EVM }),
    ).rejects.toMatchObject({ cause: { code: 'bank.offramp_fee_unset' } });

    const quote = await user.ramps.offrampQuote({ assetId: 'USDT', amount: '10', kind: 'crypto', destinationRef: EVM });
    expect(quote).toEqual({
      assetId: 'USDT',
      amount: '10',
      kind: 'crypto',
      destinationRef: EVM,
      fee: '0.37',
      netAmount: '9.63',
      expiresAt: QUOTE_EXPIRY,
      simulated: true,
    });

    const broken: OfframpFeeSource = {
      async quote() {
        return { fee: '1', netAmount: '1', expiresAt: new Date(QUOTE_EXPIRY) };
      },
    };
    const bad = bankWith({ ramps: { securityLock: memorySecurityLock(), programme: CRYPTO_LEDGER_PROGRAMME, offrampFees: broken } });
    await expect(
      caller(bad, HOLDER, readWrite).ramps.offrampQuote({ assetId: 'USDT', amount: '10', kind: 'crypto', destinationRef: EVM }),
    ).rejects.toMatchObject({ cause: { code: 'bank.offramp_fee_inconsistent' } });
    expect(ledger.journal()).toHaveLength(0);
  });

  it('kind fiat offramp still refuses the bank partner before a row, even when cooling is unpublished', async () => {
    delete process.env.BANK_OFFRAMP_COOLING_HOURS;
    const bank = bankWith({ ramps: { securityLock: memorySecurityLock(), programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay } });
    const user = caller(bank, HOLDER, readWrite);
    await expect(
      user.ramps.offramp({
        offrampId: randomUUID(),
        assetId: 'USDT',
        amount: '15',
        kind: 'fiat',
        destinationRef: IBAN,
        clientRef: `fiat-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ cause: { code: 'bank.fiat_ramp_socket' } });
    const counts = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM bank.ramp_offramps
      UNION ALL
      SELECT count(*)::int AS n FROM bank.ramp_onramps
    `;
    expect(counts.every((row) => row.n === 0)).toBe(true);
    expect(ledger.journal()).toHaveLength(0);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('lists saved destinations with label and cooling end, and remove replays by idempotency key', async () => {
    process.env.BANK_OFFRAMP_COOLING_HOURS = '24';
    const bank = bankWith({ ramps: { securityLock: memorySecurityLock(), programme: CRYPTO_LEDGER_PROGRAMME } });
    const user = caller(bank, HOLDER, readWrite);
    const other = caller(bank, OTHER, readWrite);
    await user.ramps.setWithdrawDestination({ kind: 'crypto', ref: EVM, label: 'Holiday wallet' });
    await user.ramps.setWithdrawDestination({ kind: 'bank', ref: IBAN });
    const listed = await user.ramps.destinations.list();
    expect(listed.map((row) => row.kind).sort()).toEqual(['bank', 'crypto']);
    const crypto = listed.find((row) => row.kind === 'crypto');
    expect(crypto).toMatchObject({ label: 'Holiday wallet', ref: EVM, coolingBlocker: null });
    const stored = await sql<Array<{ updated_at: Date }>>`
      SELECT updated_at FROM bank.user_withdraw_destinations
       WHERE destination_id = ${crypto!.destinationId}::uuid
    `;
    expect(new Date(crypto!.coolingOffEndsAt!).getTime() - stored[0]!.updated_at.getTime()).toBe(24 * 60 * 60 * 1000);

    delete process.env.BANK_OFFRAMP_COOLING_HOURS;
    const unpublished = await user.ramps.destinations.list();
    expect(unpublished.find((row) => row.kind === 'crypto')).toMatchObject({
      coolingOffEndsAt: null,
      coolingBlocker: 'bank.offramp_cooling_unset',
    });

    await expect(
      other.ramps.destinations.remove({ destinationId: crypto!.destinationId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ cause: { code: 'bank.withdraw_destination_missing' } });
    expect((await user.ramps.destinations.list()).some((row) => row.destinationId === crypto!.destinationId)).toBe(true);

    const key = randomUUID();
    const removed = await user.ramps.destinations.remove({ destinationId: crypto!.destinationId, idempotencyKey: key });
    expect(removed).toEqual({ destinationId: crypto!.destinationId, removed: true });
    const replay = await user.ramps.destinations.remove({ destinationId: crypto!.destinationId, idempotencyKey: key });
    expect(replay).toEqual(removed);
    await expect(
      user.ramps.destinations.remove({ destinationId: crypto!.destinationId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ cause: { code: 'bank.withdraw_destination_missing' } });
    expect((await user.ramps.destinations.list()).map((row) => row.kind)).toEqual(['bank']);
  });

  it('deposit catalogue, address, and pending come from custody or refuse by name', async () => {
    const unset = bankWith({});
    const reader = caller(unset, HOLDER, readWrite);
    await expect(reader.deposits.assets()).rejects.toMatchObject({ cause: { code: 'bank.deposit_custody_unset' } });
    await expect(reader.deposits.address({ assetId: 'USDT', networkId: 'testnet' })).rejects.toMatchObject({
      cause: { code: 'bank.deposit_custody_unset' },
    });
    await expect(reader.deposits.pending()).rejects.toMatchObject({ cause: { code: 'bank.deposit_custody_unset' } });
    const stored = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bank.deposit_addresses`;
    expect(stored[0]!.n).toBe(0);

    let issued = 0;
    const answers = ['test-deposit-address-not-a-chain', 'second-address-must-not-replace'];
    const custody: CustodyDepositPort = {
      async listAssets() {
        return [
          {
            assetId: 'USDT',
            networks: [
              {
                id: 'testnet',
                label: 'Test network',
                minimumDeposit: '10.50',
                confirmationsRequired: 12,
                estimatedArrivalMinutes: 20,
              },
            ],
          },
        ];
      },
      async address() {
        const address = answers[issued] ?? answers[1]!;
        issued += 1;
        return { address, memo: null, qrPayload: null };
      },
      async pending() {
        return [
          {
            id: 'pending-test-1',
            assetId: 'USDT',
            networkId: 'testnet',
            amount: '1.250',
            confirmations: 2,
            confirmationsRequired: 12,
          },
        ];
      },
    };
    const wired = bankWith({ deposits: { custody }, assetRegistry: OPEN_REGISTRY });
    const user = caller(wired, HOLDER, readWrite);
    expect(await user.deposits.assets()).toEqual({
      assets: [
        {
          assetId: 'USDT',
          networks: [
            {
              id: 'testnet',
              label: 'Test network',
              minimumDeposit: '10.5',
              confirmationsRequired: 12,
              estimatedArrivalMinutes: 20,
            },
          ],
        },
      ],
      halted: [],
    });
    const first = await user.deposits.address({ assetId: 'USDT', networkId: 'testnet' });
    expect(first).toEqual({
      assetId: 'USDT',
      networkId: 'testnet',
      address: 'test-deposit-address-not-a-chain',
      memo: null,
      qrPayload: null,
    });
    const second = await user.deposits.address({ assetId: 'USDT', networkId: 'testnet' });
    expect(second).toEqual(first);
    expect(issued).toBe(1);
    expect(await user.deposits.pending()).toEqual({
      items: [
        {
          id: 'pending-test-1',
          assetId: 'USDT',
          networkId: 'testnet',
          amount: '1.25',
          confirmations: 2,
          confirmationsRequired: 12,
        },
      ],
    });
    await expect(user.deposits.address({ assetId: 'BTC', networkId: 'testnet' })).rejects.toMatchObject({
      cause: { code: 'bank.deposit_asset_unpublished' },
    });
    expect(issued).toBe(1);
    expect(ledger.journal()).toHaveLength(0);

    const quiet: CustodyDepositPort = {
      listAssets: async () => [],
      address: async () => null,
      pending: async () => [],
    };
    const empty = caller(bankWith({ deposits: { custody: quiet }, assetRegistry: OPEN_REGISTRY }), HOLDER, readWrite);
    expect(await empty.deposits.assets()).toEqual({ assets: [], halted: [] });
    expect(await empty.deposits.pending()).toEqual({ items: [] });

    const readOnly = caller(wired, HOLDER, ['bank:read']);
    await expect(readOnly.deposits.address({ assetId: 'USDT', networkId: 'testnet' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(readOnly.ramps.onrampCreate({ onrampId: randomUUID(), quoteId: randomUUID(), method: 'card' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('carries the owner’s unsupported-case list to the customer as written, and refuses a blank or padded case', async () => {
    const base = { id: 'testnet', label: 'Test network', minimumDeposit: '10', confirmationsRequired: 6, estimatedArrivalMinutes: 15 };
    let unsupported: string[] = ['TEST: a send from a smart contract', 'TEST: a send of an NFT'];
    const custody: CustodyDepositPort = {
      listAssets: async () => {
        throw new Error('a port with the whole catalogue is read once, through catalogue()');
      },
      catalogue: async () => ({
        assets: [
          {
            assetId: 'USDT',
            networks: [
              { ...base, unsupported },
              { ...base, id: 'other' },
            ],
          },
        ],
        halted: [],
      }),
      address: async () => ({ address: 'test-address', memo: null, qrPayload: null }),
      pending: async () => [],
    };
    const user = caller(bankWith({ deposits: { custody }, assetRegistry: OPEN_REGISTRY }), HOLDER, readWrite);
    const { assets } = await user.deposits.assets();
    expect(assets[0]!.networks[0]!.unsupported).toEqual(unsupported);
    for (const bad of [[], [''], [' padded'], ['TEST same', 'TEST same'], Array.from({ length: 21 }, (_, i) => `TEST ${i}`)]) {
      unsupported = bad;
      await expect(user.deposits.assets()).rejects.toMatchObject({ cause: { code: 'bank.deposit_catalogue_invalid' } });
    }
  });

  it('a pair the owner switched off is listed with its note and gives no address, not even one issued before', async () => {
    const network = { id: 'testnet', label: 'Test network', minimumDeposit: '10', confirmationsRequired: 6, estimatedArrivalMinutes: 15 };
    let halted = false;
    let issued = 0;
    const custody: CustodyDepositPort = {
      listAssets: async () => {
        throw new Error('a port with the whole catalogue is read once, through catalogue()');
      },
      catalogue: async () =>
        halted
          ? {
              assets: [{ assetId: 'USDC', networks: [network] }],
              halted: [{ assetId: 'USDT', networkId: 'testnet', label: 'Test network', haltNote: 'TEST maintenance until Monday' }],
            }
          : {
              assets: [
                { assetId: 'USDT', networks: [network] },
                { assetId: 'USDC', networks: [network] },
              ],
              halted: [],
            },
      address: async () => {
        issued += 1;
        return { address: `test-address-${issued}`, memo: null, qrPayload: null };
      },
      pending: async () => [],
    };
    const user = caller(bankWith({ deposits: { custody }, assetRegistry: OPEN_REGISTRY }), HOLDER, readWrite);
    const before = await user.deposits.address({ assetId: 'USDT', networkId: 'testnet' });
    expect(before.address).toBe('test-address-1');

    halted = true;
    expect(await user.deposits.assets()).toEqual({
      assets: [{ assetId: 'USDC', networks: [network] }],
      halted: [{ assetId: 'USDT', networkId: 'testnet', label: 'Test network', haltNote: 'TEST maintenance until Monday' }],
    });
    await expect(user.deposits.address({ assetId: 'USDT', networkId: 'testnet' })).rejects.toMatchObject({
      cause: { code: 'bank.deposit_network_halted' },
    });
    expect(issued).toBe(1);
    // Another pair is not touched by the switch.
    expect((await user.deposits.address({ assetId: 'USDC', networkId: 'testnet' })).address).toBe('test-address-2');

    halted = false;
    expect((await user.deposits.address({ assetId: 'USDT', networkId: 'testnet' })).address).toBe('test-address-1');
    expect(issued).toBe(2);
    expect(ledger.journal()).toHaveLength(0);
  });

  it('refuses a catalogue that lists a pair as both open and switched off, or a switched-off pair without a label', async () => {
    const network = { id: 'testnet', label: 'Test network', minimumDeposit: '10', confirmationsRequired: 6, estimatedArrivalMinutes: 15 };
    for (const halted of [
      { assetId: 'USDT', networkId: 'testnet', label: 'Test network', haltNote: null },
      { assetId: 'USDC', networkId: 'testnet', label: ' ', haltNote: null },
      { assetId: 'USDC', networkId: 'testnet', label: 'Test network', haltNote: ' padded ' },
    ]) {
      const custody: CustodyDepositPort = {
        listAssets: async () => [],
        catalogue: async () => ({ assets: [{ assetId: 'USDT', networks: [network] }], halted: [halted] }),
        address: async () => null,
        pending: async () => [],
      };
      const user = caller(bankWith({ deposits: { custody }, assetRegistry: OPEN_REGISTRY }), HOLDER, readWrite);
      await expect(user.deposits.assets()).rejects.toMatchObject({ cause: { code: 'bank.deposit_catalogue_invalid' } });
    }
  });

  it('a bad switched-off row does not stop addresses for the open pairs', async () => {
    const network = { id: 'testnet', label: 'Test network', minimumDeposit: '10', confirmationsRequired: 6, estimatedArrivalMinutes: 15 };
    const custody: CustodyDepositPort = {
      listAssets: async () => [],
      catalogue: async () => ({
        assets: [{ assetId: 'USDT', networks: [network] }],
        halted: [{ assetId: 'USDC', networkId: 'testnet', label: ' bad ', haltNote: null }],
      }),
      address: async () => ({ address: 'test-address-open', memo: null, qrPayload: null }),
      pending: async () => [],
    };
    const user = caller(bankWith({ deposits: { custody }, assetRegistry: OPEN_REGISTRY }), HOLDER, readWrite);
    expect((await user.deposits.address({ assetId: 'USDT', networkId: 'testnet' })).address).toBe('test-address-open');
  });

  it('the deposit catalogue is narrowed to the registry: a retired, halted or deposit-less asset and an unlisted network take no address', async () => {
    const network = (id: string) => ({
      id,
      label: `Test ${id}`,
      minimumDeposit: '10',
      confirmationsRequired: 6,
      estimatedArrivalMinutes: 15,
    });
    let issued = 0;
    const custody: CustodyDepositPort = {
      listAssets: async () => [],
      catalogue: async () => ({
        assets: [
          { assetId: 'USDT', networks: [network('testnet'), network('othernet')] },
          { assetId: 'USDC', networks: [network('testnet')] },
          { assetId: 'DAI', networks: [network('testnet')] },
          { assetId: 'EURC', networks: [network('testnet')] },
          { assetId: 'PYUSD', networks: [network('testnet')] },
        ],
        halted: [
          { assetId: 'USDC', networkId: 'othernet', label: 'Test othernet', haltNote: null },
          { assetId: 'DAI', networkId: 'othernet', label: 'Test othernet', haltNote: null },
        ],
      }),
      address: async () => {
        issued += 1;
        return { address: `test-address-${issued}`, memo: null, qrPayload: null };
      },
      pending: async () => [],
    };
    let rows = [
      registryRow('USDT', ['testnet']),
      registryRow('USDC', ['testnet', 'othernet']),
      registryRow('DAI', ['testnet', 'othernet'], { state: 'retired', allowedActions: [] }),
      registryRow('EURC', ['testnet'], { state: 'halted' }),
      registryRow('PYUSD', ['testnet'], { allowedActions: ['withdraw', 'trade'] }),
    ];
    const user = caller(bankWith({ deposits: { custody }, assetRegistry: { listed: async () => rows } }), HOLDER, readWrite);
    // Open: only what the registry allows. The rest stays listed as switched off by the registry, with the asset's state there.
    const blocked = (assetId: string, networkId: string, assetState: string | null) => ({
      assetId,
      networkId,
      label: `Test ${networkId}`,
      haltNote: null,
      blockedBy: 'registry',
      assetState,
    });
    expect(await user.deposits.assets()).toEqual({
      assets: [
        { assetId: 'USDT', networks: [network('testnet')] },
        { assetId: 'USDC', networks: [network('testnet')] },
      ],
      halted: [
        { assetId: 'USDC', networkId: 'othernet', label: 'Test othernet', haltNote: null },
        { assetId: 'DAI', networkId: 'othernet', label: 'Test othernet', haltNote: null },
        blocked('USDT', 'othernet', 'active'),
        blocked('DAI', 'testnet', 'retired'),
        blocked('EURC', 'testnet', 'halted'),
        blocked('PYUSD', 'testnet', 'active'),
      ],
    });
    for (const [assetId, networkId] of [
      ['USDT', 'othernet'],
      ['DAI', 'testnet'],
      ['EURC', 'testnet'],
      ['PYUSD', 'testnet'],
      ['GONE', 'testnet'],
    ] as const) {
      await expect(user.deposits.address({ assetId, networkId })).rejects.toMatchObject({
        cause: { code: 'bank.deposit_asset_unpublished' },
      });
    }
    expect(issued).toBe(0);

    // An address issued while the asset was open is not handed out again once the registry retires it.
    expect((await user.deposits.address({ assetId: 'USDT', networkId: 'testnet' })).address).toBe('test-address-1');
    rows = rows.map((row) => (row.id === 'USDT' ? { ...row, state: 'retired', allowedActions: [] } : row));
    await expect(user.deposits.address({ assetId: 'USDT', networkId: 'testnet' })).rejects.toMatchObject({
      cause: { code: 'bank.deposit_asset_unpublished' },
    });
    expect((await user.deposits.assets()).assets.map((a) => a.assetId)).toEqual(['USDC']);
    expect((await user.deposits.assets()).halted).toContainEqual(blocked('USDT', 'testnet', 'retired'));
    // An asset the registry does not publish at all is listed as switched off, its state unknown there.
    rows = rows.filter((row) => row.id !== 'USDT');
    expect((await user.deposits.assets()).halted).toContainEqual(blocked('USDT', 'testnet', null));
    expect(issued).toBe(1);
    expect(ledger.journal()).toHaveLength(0);
  });

  it('with no registry, or one that cannot be read, deposits refuse by name and no address is issued', async () => {
    const network = { id: 'testnet', label: 'Test network', minimumDeposit: '10', confirmationsRequired: 6, estimatedArrivalMinutes: 15 };
    let issued = 0;
    const custody: CustodyDepositPort = {
      listAssets: async () => [{ assetId: 'USDT', networks: [network] }],
      address: async () => {
        issued += 1;
        return { address: 'test-address', memo: null, qrPayload: null };
      },
      pending: async () => [],
    };
    const failing = { listed: async () => Promise.reject(new Error('ledger said: internal detail')) };
    for (const assetRegistry of [undefined, null, failing]) {
      const user = caller(bankWith({ deposits: { custody }, assetRegistry }), HOLDER, readWrite);
      await expect(user.deposits.assets()).rejects.toMatchObject({ cause: { code: 'bank.asset_registry_unavailable' } });
      await expect(user.deposits.address({ assetId: 'USDT', networkId: 'testnet' })).rejects.toMatchObject({
        cause: { code: 'bank.asset_registry_unavailable' },
      });
    }
    await expect(caller(bankWith({ deposits: { custody }, assetRegistry: failing }), HOLDER, readWrite).deposits.assets()).rejects.toThrow(
      'The list of supported assets and networks could not be read. Try again shortly',
    );
    // With custody unset too, custody's refusal is the one named: a registry outage never hides it.
    const both = caller(bankWith({ assetRegistry: failing }), HOLDER, readWrite);
    await expect(both.deposits.assets()).rejects.toMatchObject({ cause: { code: 'bank.deposit_custody_unset' } });
    await expect(both.deposits.address({ assetId: 'USDT', networkId: 'testnet' })).rejects.toMatchObject({
      cause: { code: 'bank.deposit_custody_unset' },
    });
    expect(issued).toBe(0);
    const stored = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bank.deposit_addresses`;
    expect(stored[0]!.n).toBe(0);
  });

  it('assets.list hands the customer every published registry row, a retired one included, or refuses by name', async () => {
    const retired = registryRow('DAI', ['testnet'], { state: 'retired', allowedActions: [], precision: 18 });
    const user = caller(bankWith({ assetRegistry: memoryAssetRegistry([registryRow('USDT', ['testnet', 'othernet']), retired]) }), HOLDER, [
      'bank:read',
    ]);
    expect(await user.assets.list()).toEqual({
      assets: [
        {
          assetId: 'USDT',
          kind: 'crypto',
          precision: 6,
          networks: [
            { networkId: 'testnet', label: 'Test testnet' },
            { networkId: 'othernet', label: 'Test othernet' },
          ],
          defaultNetworkId: 'testnet',
          allowedActions: ['deposit', 'withdraw', 'trade', 'transfer'],
          state: 'active',
        },
        {
          assetId: 'DAI',
          kind: 'crypto',
          precision: 18,
          networks: [{ networkId: 'testnet', label: 'Test testnet' }],
          defaultNetworkId: 'testnet',
          allowedActions: [],
          state: 'retired',
        },
      ],
    });
    await expect(caller(bankWith({}), HOLDER, ['bank:read']).assets.list()).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      cause: { code: 'bank.asset_registry_unavailable' },
    });
    await expect(caller(bankWith({ assetRegistry: OPEN_REGISTRY }), HOLDER, []).assets.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
