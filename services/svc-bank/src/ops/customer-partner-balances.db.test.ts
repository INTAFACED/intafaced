/**
 * `bank.ops.customerPartnerBalances` (J-derivatives-26 #8) through the real router, on a real Postgres: the founder console
 * reads one customer's partner-held spending balances with `admin:read`, each the same figure the customer's own
 * `spaces.list` shows, with the partner's label as its source and its as-of time; a person no partner holds answers
 * `heldByPartner: false` with no ledger figure read; the audit line is written before anything is read, and a line that
 * cannot be written refuses the read. Nothing is written.
 *
 * Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServiceOptions } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import { TEST_PARTNER_STALE_AFTER_MS, testPartner, type TestPartner } from '../partner/test-partner.js';
import { TEST_PARTNER_LABEL } from '../partner/test-partner-book.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SID = '99999999-9999-4999-8999-999999999999';

function principal(userId: string, scopes: string[] = ['bank:read', 'bank:write']): Principal {
  return {
    sub: userId,
    userId,
    sid: SID,
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

describe('ops.customerPartnerBalances (J-derivatives-26 #8)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let partner: TestPartner;
  /** svc-ledger's posting freeze as the test sets it: true is posting enabled; 'unreadable' is a failed read. */
  let posting: boolean | 'unreadable';
  const freeze = {
    postingEnabled: async () => {
      if (posting === 'unreadable') throw new Error('svc-ledger /health did not answer');
      return posting;
    },
  };

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`TRUNCATE bank.spaces RESTART IDENTITY CASCADE`;
    await sql`TRUNCATE bank.partner_stops, bank.partner_stop_history, bank.partner_refusal_counts`;
    ledger = new MemoryLedger();
    partner = testPartner();
    posting = true;
  });

  function as(userId: string, options: BankServiceOptions = {}, scopes?: string[]) {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      spaceLimit: '5',
      scheduleEditCutoffMinutes: '60',
      spaceUnlockWaitHours: '24',
      testPartner: partner,
      postingFreeze: freeze,
      ...options,
    });
    const raw = encodePrincipal(principal(userId, scopes));
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
    const api = createBankRouter(bank).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
    return { bank, api };
  }

  /** A person held at the TEST partner with TEST 100 in their main balance and a named space "Trip TEST". */
  async function partnerHeld(userId: string) {
    const { bank, api } = as(userId);
    await api.testPartner.set({ custody: 'off' });
    await api.testPartner.fund({ fundId: `fund-${userId}`, assetId: 'USDT', amount: '100' });
    const trip = await api.spaces.create({ assetId: 'USDT', name: 'Trip TEST' });
    const spaces = await api.spaces.list({ limit: 50 });
    const mainSpace = spaces.find((s) => s.kind === 'primary')!;
    return { bank, api, trip, mainSpace };
  }

  const OPERATOR = '88888888-8888-4888-8888-888888888888';
  const desk = (options: BankServiceOptions = {}) => as(OPERATOR, options, ['admin:read']).api;

  it("answers each partner-held space with the customer's own figure, its source and as-of time, read-only and audited first", async () => {
    const { api, trip, mainSpace } = await partnerHeld(ADA);
    await api.transfers.create({ transferId: 'move-ada-desk1', fromSpaceId: mainSpace.id, toSpaceId: trip.id, amount: '20' });
    const own = await api.spaces.list({ limit: 50 });
    const rows = await sql`SELECT count(*)::int AS n FROM bank.spaces`;
    const post = vi.spyOn(ledger, 'post');
    const balances = vi.spyOn(ledger, 'balances');
    const order: string[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation((line: string) => {
      order.push(`audit:${line}`);
    });
    const original = partner.bank.balances.bind(partner.bank);
    vi.spyOn(partner.bank, 'balances').mockImplementation(async (...args) => {
      order.push('partner');
      return original(...args);
    });
    try {
      const out = await desk().ops.customerPartnerBalances({ userId: ADA });
      expect(out.userId).toBe(ADA);
      expect(out.heldByPartner).toBe(true);
      expect(out.spaces).toHaveLength(own.length);
      for (const s of own) {
        // The TEST partner stamps each report with the time it was read, so the desk's as-of is its own read's, never earlier.
        const mine = out.spaces.find((r) => r.spaceId === s.id)!;
        expect(Date.parse(mine.asOf)).toBeGreaterThanOrEqual(Date.parse(s.heldAt!.asOf));
        expect(mine).toEqual({
          spaceId: s.id,
          assetId: s.assetId,
          kind: s.kind,
          name: s.name,
          balance: s.balance,
          source: TEST_PARTNER_LABEL,
          asOf: mine.asOf,
          state: 'known',
          staleAfterMs: TEST_PARTNER_STALE_AFTER_MS,
        });
      }
      expect(out.spaces.find((s) => s.spaceId === trip.id)!.balance).toBe('20');
      // The audit line names operator and customer, and comes before the partner is read.
      expect(JSON.parse(order[0]!.slice('audit:'.length))).toMatchObject({
        event: 'bank.ops.customer_partner_balances_read',
        actorUserId: OPERATOR,
        ownerUserId: ADA,
      });
      expect(order.indexOf('partner')).toBeGreaterThan(0);
      // Read-only: no ledger read or post, no row written.
      expect(post).not.toHaveBeenCalled();
      expect(balances).not.toHaveBeenCalled();
      expect((await sql`SELECT count(*)::int AS n FROM bank.spaces`)[0]!.n).toBe(rows[0]!.n);
    } finally {
      info.mockRestore();
    }
  });

  it('says stale when the partner figure is stale, and refuses by name when it is not known, never 0', async () => {
    const { api } = await partnerHeld(ADA);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await api.testPartner.set({ figures: 'stale' });
      const stale = await desk().ops.customerPartnerBalances({ userId: ADA });
      expect(stale.spaces.length).toBeGreaterThan(0);
      for (const s of stale.spaces) expect(s.state).toBe('stale');
      await api.testPartner.set({ figures: 'unknown' });
      await expect(desk().ops.customerPartnerBalances({ userId: ADA })).rejects.toMatchObject({
        cause: { code: 'bank.partner_balance_not_known' },
      });
    } finally {
      info.mockRestore();
    }
  });

  it('answers heldByPartner false with no spaces for a person no partner holds, reading no ledger figure', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const balances = vi.spyOn(ledger, 'balances');
    try {
      await ledger.post(recipes.deposit({ userId: BOB, assetId: 'USDT', amount: parseAmount('50'), rail: 'test', railRef: 'r-bob' }));
      const out = await desk().ops.customerPartnerBalances({ userId: BOB });
      expect(out).toEqual({ userId: BOB, heldByPartner: false, spaces: [] });
      expect(balances).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it('refuses the read, reading nothing, when the audit line cannot be written', async () => {
    await partnerHeld(ADA);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('stdout closed');
    });
    const read = vi.spyOn(partner.bank, 'balances');
    try {
      await expect(desk().ops.customerPartnerBalances({ userId: ADA })).rejects.toMatchObject({
        cause: { code: 'bank.ops_audit_unavailable' },
      });
      expect(read).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it("refuses a customer's own session and an operator without admin:read", async () => {
    await partnerHeld(ADA);
    await expect(as(ADA).api.ops.customerPartnerBalances({ userId: ADA })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as(OPERATOR, {}, ['bank:read']).api.ops.customerPartnerBalances({ userId: ADA })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
