import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AuthError } from '@intafaced/auth';
import { principalFor } from '../spot/testing.js';
import { convertSettleIdsFor } from './ids.js';
import { convertCustomerHoldKey } from './settle.js';
import { attachConvertExportRoute } from './convert-history-rest.js';
import {
  CONVERT_LIST_WINDOW_MAX_MS,
  TRADE_CONVERT_LIST_LIMIT_UNSET,
  TRADE_CONVERT_LIST_WINDOW_TOO_WIDE,
  TRADE_CONVERT_LIST_WINDOW_UNSET,
  assertConvertListWindow,
  convertFillLedgerKey,
  convertHistoryCsv,
  csvCell,
  exportConvertHistory,
  listConvertHistory,
  publishedConvertListLimit,
  readConvertStatus,
  type ConvertHistoryRow,
} from './convert-history.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const ALICE = 'alice-convert';
const BOB = 'bob-convert';
const NOW = new Date('2026-10-18T00:00:00.000Z');
const FROM = '2026-10-17T00:00:00.000Z';
const TO = '2026-10-18T00:00:00.000Z';
const AMOUNT_IN = '1.230000000000000001';
const AMOUNT_OUT = '9.870000000000000003';

describe('convert list window and csv (no database)', () => {
  it('refuses a missing window, a window over 92 days, and a blank limit', () => {
    expect(CONVERT_LIST_WINDOW_MAX_MS).toBe(92 * 24 * 60 * 60 * 1000);
    expect(() => assertConvertListWindow(undefined, TO)).toThrow(expect.objectContaining({ code: TRADE_CONVERT_LIST_WINDOW_UNSET }));
    expect(() => assertConvertListWindow('', TO)).toThrow(expect.objectContaining({ code: TRADE_CONVERT_LIST_WINDOW_UNSET }));
    expect(() => assertConvertListWindow(FROM, undefined)).toThrow(expect.objectContaining({ code: TRADE_CONVERT_LIST_WINDOW_UNSET }));
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    expect(() =>
      assertConvertListWindow(new Date(start).toISOString(), new Date(start + CONVERT_LIST_WINDOW_MAX_MS).toISOString()),
    ).not.toThrow();
    expect(() =>
      assertConvertListWindow(new Date(start).toISOString(), new Date(start + CONVERT_LIST_WINDOW_MAX_MS + 1).toISOString()),
    ).toThrow(expect.objectContaining({ code: TRADE_CONVERT_LIST_WINDOW_TOO_WIDE }));
    expect(() => publishedConvertListLimit(undefined)).toThrow(expect.objectContaining({ code: TRADE_CONVERT_LIST_LIMIT_UNSET }));
    expect(() => publishedConvertListLimit(null)).toThrow(expect.objectContaining({ code: TRADE_CONVERT_LIST_LIMIT_UNSET }));
    expect(publishedConvertListLimit(50)).toBe(50);
  });

  it('keeps amount strings exact and escapes formula cells', () => {
    const row: ConvertHistoryRow = {
      quoteId: 'q-csv',
      inAsset: '=1+1',
      outAsset: '+SUM(A1)',
      inAmount: AMOUNT_IN,
      outAmount: AMOUNT_OUT,
      lifecycle: 'quoted',
      createdAt: NOW.toISOString(),
      expiresAt: '2026-10-19T00:00:00.000Z',
      acceptedAt: null,
      settledAt: null,
    };
    const csv = convertHistoryCsv([row]);
    expect(csv.split('\n')[1]).toContain(`,${AMOUNT_IN},${AMOUNT_OUT},`);
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('+SUM(A1)')).toBe(`"'+SUM(A1)"`);
    expect(csvCell('-1')).toBe(`"'-1"`);
    expect(csvCell('@cmd')).toBe(`"'@cmd"`);
    expect(csv).toContain(`"'=1+1"`);
    expect(csv).toContain(`"'+SUM(A1)"`);
  });
});

describe('convert history and status (postgres)', () => {
  let db: TestDatabase;
  const posts: string[] = [];
  const reads: string[] = [];

  const ledger = {
    async getTxByKey(key: string) {
      reads.push(key);
      if (key === convertCustomerHoldKey(convertSettleIdsFor('q-unknown').takerOrderId)) return { id: 'tx-hold-1' };
      if (key === convertFillLedgerKey(convertSettleIdsFor('q-settled').fillId)) return { id: 'tx-fill-1' };
      return null;
    },
    async post(request: { idempotencyKey: string }) {
      posts.push(request.idempotencyKey);
      throw new Error('convert status must not write');
    },
  };

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset — this suite does not start Docker');
    db = await createTestDatabase({ service: 'trade', url, migrations });
    await seed(db);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  async function seed(database: TestDatabase) {
    const sql = database.sql;
    await insert(sql, {
      quoteId: 'q-quoted',
      userId: ALICE,
      lifecycle: 'open',
      inAsset: '=1+1',
      outAsset: 'USDT',
      createdAt: '2026-10-17T03:00:00.000Z',
      expiresAt: '2026-10-19T00:00:00.000Z',
      clientConvertId: 'client-quoted',
    });
    await insert(sql, {
      quoteId: 'q-accepted',
      userId: ALICE,
      lifecycle: 'bound',
      inAsset: 'USDT',
      outAsset: '+SUM(A1)',
      createdAt: '2026-10-17T02:00:00.000Z',
      expiresAt: '2026-10-19T00:00:00.000Z',
      acceptedAt: '2026-10-17T02:00:01.000Z',
      clientConvertId: 'client-accepted',
    });
    await insert(sql, {
      quoteId: 'q-settled',
      userId: ALICE,
      lifecycle: 'settled',
      inAsset: '@cmd',
      outAsset: 'BTC',
      createdAt: '2026-10-17T01:00:00.000Z',
      expiresAt: '2026-10-19T00:00:00.000Z',
      acceptedAt: '2026-10-17T01:00:01.000Z',
      settledAt: '2026-10-17T01:00:02.000Z',
      clientConvertId: 'client-settled',
    });
    await insert(sql, {
      quoteId: 'q-refused',
      userId: ALICE,
      lifecycle: 'open',
      createdAt: '2026-10-16T12:00:00.000Z',
      expiresAt: '2026-10-19T00:00:00.000Z',
      refusalCode: 'ledger.insufficient_funds',
      clientConvertId: 'client-refused',
    });
    await insert(sql, {
      quoteId: 'q-expired',
      userId: ALICE,
      lifecycle: 'open',
      createdAt: '2026-10-16T11:00:00.000Z',
      expiresAt: '2026-10-16T12:00:00.000Z',
      clientConvertId: 'client-expired',
    });
    await insert(sql, {
      quoteId: 'q-unknown',
      userId: ALICE,
      lifecycle: 'open',
      createdAt: '2026-10-16T10:00:00.000Z',
      expiresAt: '2026-10-19T00:00:00.000Z',
      clientConvertId: 'client-unknown',
    });
    await insert(sql, {
      quoteId: 'q-bob',
      userId: BOB,
      lifecycle: 'settled',
      createdAt: '2026-10-17T03:30:00.000Z',
      expiresAt: '2026-10-19T00:00:00.000Z',
      acceptedAt: '2026-10-17T03:30:01.000Z',
      settledAt: '2026-10-17T03:30:02.000Z',
      clientConvertId: 'client-bob',
    });
  }

  it('lists the caller’s three lifecycles newest first and hides the other account', async () => {
    const page = await listConvertHistory(db.sql, principalFor(ALICE, ['trade:read']), { from: FROM, to: TO, limit: 3 }, NOW);
    expect(page.rows.map((row) => row.quoteId)).toEqual(['q-quoted', 'q-accepted', 'q-settled']);
    expect(page.rows.map((row) => row.lifecycle)).toEqual(['quoted', 'accepted', 'settled']);
    expect(page.rows[0]?.inAmount).toBe(AMOUNT_IN);
    expect(page.rows[0]?.outAmount).toBe(AMOUNT_OUT);
    expect(page.rows[0]?.inAmount).not.toBe(String(Number(AMOUNT_IN)));
    expect(page.rows.some((row) => row.quoteId === 'q-bob')).toBe(false);
    const csv = await exportConvertHistory(db.sql, principalFor(ALICE, ['trade:read']), { from: FROM, to: TO }, NOW);
    expect(csv).toContain(AMOUNT_IN);
    expect(csv).toContain(AMOUNT_OUT);
    expect(csv).toContain(`"'=1+1"`);
    expect(csv).toContain(`"'+SUM(A1)"`);
    expect(csv).toContain(`"'@cmd"`);
    expect(csv).not.toContain('q-bob');
    expect(posts).toEqual([]);
  });

  it('refuses a missing window, a wide window, and a session without trade:read', async () => {
    const reader = principalFor(ALICE, ['trade:read']);
    await expect(listConvertHistory(db.sql, reader, { to: TO, limit: 10 }, NOW)).rejects.toMatchObject({
      code: TRADE_CONVERT_LIST_WINDOW_UNSET,
    });
    await expect(
      listConvertHistory(db.sql, reader, { from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z', limit: 10 }, NOW),
    ).rejects.toMatchObject({ code: TRADE_CONVERT_LIST_WINDOW_TOO_WIDE });
    await expect(listConvertHistory(db.sql, reader, { from: FROM, to: TO }, NOW)).rejects.toMatchObject({
      code: TRADE_CONVERT_LIST_LIMIT_UNSET,
    });
    await expect(readConvertStatus(db.sql, ledger, principalFor(ALICE, ['admin:read']), 'client-quoted', NOW)).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(posts).toEqual([]);
  });

  it('reports each seeded status, unknown when the hold exists, and none for another account', async () => {
    const alice = principalFor(ALICE, ['trade:read']);
    await expect(readConvertStatus(db.sql, ledger, alice, 'client-quoted', NOW)).resolves.toEqual({
      status: 'quoted',
      quoteId: 'q-quoted',
      ledgerTransactionRef: null,
    });
    await expect(readConvertStatus(db.sql, ledger, alice, 'client-accepted', NOW)).resolves.toEqual({
      status: 'accepted',
      quoteId: 'q-accepted',
      ledgerTransactionRef: null,
    });
    await expect(readConvertStatus(db.sql, ledger, alice, 'client-settled', NOW)).resolves.toEqual({
      status: 'settled',
      quoteId: 'q-settled',
      ledgerTransactionRef: 'tx-fill-1',
    });
    await expect(readConvertStatus(db.sql, ledger, alice, 'client-refused', NOW)).resolves.toEqual({
      status: 'refused',
      quoteId: 'q-refused',
      ledgerTransactionRef: null,
    });
    await expect(readConvertStatus(db.sql, ledger, alice, 'client-expired', NOW)).resolves.toEqual({
      status: 'expired',
      quoteId: 'q-expired',
      ledgerTransactionRef: null,
    });
    await expect(readConvertStatus(db.sql, ledger, alice, 'client-unknown', NOW)).resolves.toEqual({
      status: 'unknown',
      quoteId: 'q-unknown',
      ledgerTransactionRef: 'tx-hold-1',
    });
    await expect(readConvertStatus(db.sql, ledger, alice, 'client-bob', NOW)).resolves.toEqual({
      status: 'none',
      quoteId: null,
      ledgerTransactionRef: null,
    });
    await expect(readConvertStatus(db.sql, ledger, alice, 'missing', NOW)).resolves.toEqual({
      status: 'none',
      quoteId: null,
      ledgerTransactionRef: null,
    });
    expect(posts).toEqual([]);
    expect(reads).toContain(convertCustomerHoldKey(convertSettleIdsFor('q-unknown').takerOrderId));
    expect(reads).toContain(convertFillLedgerKey(convertSettleIdsFor('q-settled').fillId));
    expect(reads.every((key) => key.startsWith('order.hold:') || key.startsWith('trade.fill.mm-maker:'))).toBe(true);
  });

  it('serves the same csv on GET /api/v1/convert/export', async () => {
    const app = Fastify();
    attachConvertExportRoute(
      app,
      (principal, query) => exportConvertHistory(db.sql, principal, query, NOW),
      () => principalFor(ALICE, ['trade:read']),
    );
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/convert/export?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain(AMOUNT_IN);
    expect(res.body).toContain(`"'=1+1"`);
    expect(res.body).not.toContain('q-bob');
    await app.close();
    expect(posts).toEqual([]);
  });
});

async function insert(
  sql: TestDatabase['sql'],
  row: {
    quoteId: string;
    userId: string;
    lifecycle: 'open' | 'bound' | 'settled';
    inAsset?: string;
    outAsset?: string;
    createdAt: string;
    expiresAt: string;
    acceptedAt?: string;
    settledAt?: string;
    refusalCode?: string;
    clientConvertId?: string;
  },
) {
  const bound = row.lifecycle !== 'open';
  await sql`
    INSERT INTO convert_quotes (
      quote_id, user_id, lifecycle, symbol, market_id, side,
      base_asset, quote_asset, in_asset, out_asset,
      in_amount, out_amount, requested_qty, filled_qty,
      book_notional, user_notional, avg_price,
      convert_spread_bps, fully_filled,
      source_kind, source_symbol, source_as_of,
      created_at, expires_at, accepted_at, fill_price, fill_notional, settled_at,
      client_convert_id, refusal_code, updated_at
    ) VALUES (
      ${row.quoteId}, ${row.userId}, ${row.lifecycle}, 'BTC/USDT', 'market-1', 'buy',
      'BTC', 'USDT', ${row.inAsset ?? 'USDT'}, ${row.outAsset ?? 'BTC'},
      ${AMOUNT_IN}, ${AMOUNT_OUT}, ${AMOUNT_IN}, ${AMOUNT_IN},
      ${AMOUNT_OUT}, ${AMOUNT_OUT}, '1.5',
      25, true,
      'book', 'BTC/USDT', ${row.createdAt},
      ${row.createdAt}, ${row.expiresAt},
      ${bound ? (row.acceptedAt ?? row.createdAt) : null},
      ${bound ? '1.5' : null},
      ${bound ? AMOUNT_OUT : null},
      ${row.settledAt ?? null},
      ${row.clientConvertId ?? null},
      ${row.refusalCode ?? null},
      now()
    )
  `;
}
