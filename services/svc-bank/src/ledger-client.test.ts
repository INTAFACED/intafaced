import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { createLedgerClient } from './ledger-client.js';

function retained(body: string) {
  return { retained: true as const, bytes: Buffer.from(body, 'utf8') };
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The exact bytes that went out. Not a re-serialised object. */
  raw: string;
  body: unknown;
}

const realFetch = globalThis.fetch;
let sent: Captured[];
let respond: (path: string) => { status: number; body: unknown };

beforeEach(() => {
  sent = [];
  respond = () => ({ status: 200, body: { found: false } });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : '';
    sent.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      raw,
      body: raw ? JSON.parse(raw) : undefined,
    });
    const { status, body } = respond(new URL(url).pathname);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const SECRET = 'test-internal-service-secret-32-chars';
const client = () => createLedgerClient('http://ledger.test', SECRET);

/**
 * The two reads svc-bank's money paths make before they post. Both used to throw
 * "not exposed over the internal ledger API", so every immediate business transfer and every card cashback settle failed on a
 * real deployment while the in-memory ledger in the suites answered them (#4694).
 * They now call svc-ledger's read-only, service-signed `/trpc/txByKey` (#4692)
 * and `/trpc/txById` doors.
 */
describe('getTxByKey — the txByKey door', () => {
  it('asks /trpc/txByKey with the key alone, signed over the exact bytes, as svc-bank', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await client().getTxByKey('bank.transfer:t-1:0');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/txByKey');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.headers['content-type']).toBe('application/json');
    expect(sent[0]!.body).toEqual({ idempotencyKey: 'bank.transfer:t-1:0' });
    expect(verifyServiceHeaders(sent[0]!.headers, SECRET, { rawBody: retained(sent[0]!.raw), mode: 'require' })).toEqual({
      service: 'svc-bank',
      rejected: null,
      scheme: 'v2',
    });
  });

  it('answers null for a key the ledger has not booked', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await expect(client().getTxByKey('bank.transfer:never:0')).resolves.toBeNull();
  });

  it('answers the booked transaction for a key it has', async () => {
    respond = () => ({
      status: 200,
      body: { found: true, txId: 'tx-9', hash: 'h9', postedAt: '2026-10-14T01:02:03.000Z', module: 'bank', reason: 'bank.transfer' },
    });
    const tx = await client().getTxByKey('bank.transfer:t-1:0');
    expect(tx).toMatchObject({
      id: 'tx-9',
      idempotencyKey: 'bank.transfer:t-1:0',
      hash: 'h9',
      module: 'bank',
      reason: 'bank.transfer',
      entries: [],
    });
    expect(tx?.postedAt.toISOString()).toBe('2026-10-14T01:02:03.000Z');
  });

  it('throws on an answer with no found verdict, rather than reading it as "not booked"', async () => {
    respond = () => ({ status: 200, body: { txId: 'tx-1', hash: 'h1', postedAt: '2026-10-14T00:00:00.000Z' } });
    await expect(client().getTxByKey('bank.transfer:t-1:0')).rejects.toThrow(/found/);
    await expect(client().getTx('9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e10')).rejects.toThrow(/found/);
  });

  it('throws when the ledger cannot answer, rather than reading it as "not booked"', async () => {
    respond = () => ({ status: 503, body: 'down' });
    await expect(client().getTxByKey('bank.transfer:t-1:0')).rejects.toThrow(/\/trpc\/txByKey failed \(503\)/);
  });
});

describe('getTx — the txById door', () => {
  const TX_ID = '9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e10';

  it('asks /trpc/txById with the id alone, signed over the exact bytes, as svc-bank', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await client().getTx(TX_ID);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ledger.test/trpc/txById');
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.body).toEqual({ txId: TX_ID });
    expect(verifyServiceHeaders(sent[0]!.headers, SECRET, { rawBody: retained(sent[0]!.raw), mode: 'require' })).toEqual({
      service: 'svc-bank',
      rejected: null,
      scheme: 'v2',
    });
  });

  it('answers null for an id the ledger has not booked', async () => {
    respond = () => ({ status: 200, body: { found: false } });
    await expect(client().getTx(TX_ID)).resolves.toBeNull();
  });

  it('answers the transaction with its entries, amounts as scaled bigints', async () => {
    respond = () => ({
      status: 200,
      body: {
        found: true,
        txId: TX_ID,
        idempotencyKey: 'bank.transfer:t-1:0',
        hash: 'h1',
        postedAt: '2026-10-14T01:02:03.000Z',
        module: 'bank',
        reason: 'bank.transfer',
        entries: [
          { accountId: 'a-1', assetId: 'USDT', direction: 'credit', amount: '10.000000000000000001' },
          { accountId: 'a-2', assetId: 'USDT', direction: 'debit', amount: '10.000000000000000001' },
        ],
      },
    });
    const tx = await client().getTx(TX_ID);
    expect(tx?.id).toBe(TX_ID);
    expect(tx?.idempotencyKey).toBe('bank.transfer:t-1:0');
    expect(tx?.entries.map((e) => [e.accountId, e.assetId, e.direction, e.amount])).toEqual([
      ['a-1', 'USDT', 'credit', amt('10.000000000000000001')],
      ['a-2', 'USDT', 'debit', amt('10.000000000000000001')],
    ]);
    expect(formatAmount(tx!.entries[0]!.amount)).toBe('10.000000000000000001');
  });

  it('throws when the ledger refuses, rather than reading it as "not booked"', async () => {
    respond = () => ({ status: 400, body: { message: 'txId must be a uuid', code: 'BAD_REQUEST' } });
    await expect(client().getTx('nope')).rejects.toThrow();
  });
});
