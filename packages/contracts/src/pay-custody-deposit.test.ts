import { describe, expect, it, vi } from 'vitest';
import {
  PAY_CUSTODY_DEPOSIT_ADDRESS_PATH,
  PAY_CUSTODY_DEPOSIT_CALLERS,
  PAY_CUSTODY_DEPOSIT_CATALOGUE_PATH,
  PAY_CUSTODY_DEPOSIT_RECORDS_PATH,
  createPayCustodyDepositClient,
  payCustodyDepositAddressInputSchema,
  payCustodyDepositAddressReplySchema,
  payCustodyDepositCatalogueSchema,
  payCustodyDepositRecordSchema,
  payCustodyDepositRecordsInputSchema,
  verifyServiceHeaders,
} from './index.js';
import { SERVICE_NAMES } from './service-keys.js';

const SECRET = 'custody-deposit-secret-long-enough-x';
const entry = {
  assetId: 'USDT',
  networkId: 'ethereum',
  label: 'Ethereum',
  minimumDeposit: '10',
  confirmationsRequired: 12,
  estimatedArrivalMinutes: 5,
  memoRequired: false,
  sharedAddressGroup: 'evm',
};
const issued = { state: 'issued', address: { address: '0xabc', memo: null, qrPayload: null } };
const input = { userId: 'user-1', assetId: 'USDT', networkId: 'ethereum' };
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status });
const make = (fetcher: unknown, over: object = {}) =>
  createPayCustodyDepositClient({ payUrl: 'http://pay.internal:4020/', secret: SECRET, fetcher: fetcher as typeof fetch, ...over });

describe('pay custody deposit contract', () => {
  it('names one caller, a real service', () => {
    expect(PAY_CUSTODY_DEPOSIT_CALLERS).toEqual(['svc-bank']);
    for (const caller of PAY_CUSTODY_DEPOSIT_CALLERS) expect(SERVICE_NAMES).toContain(caller);
  });

  it('refuses a blank minimum, a float count, a sign and an extra field', () => {
    const parse = (over: object) => payCustodyDepositCatalogueSchema.safeParse({ entries: [{ ...entry, ...over }] }).success;
    expect(parse({})).toBe(true);
    expect(parse({ minimumDeposit: '' })).toBe(false);
    expect(parse({ minimumDeposit: '-1' })).toBe(false);
    expect(parse({ minimumDeposit: '1e3' })).toBe(false);
    expect(parse({ confirmationsRequired: 0 })).toBe(false);
    expect(parse({ confirmationsRequired: 1.5 })).toBe(false);
    expect(parse({ extra: 1 })).toBe(false);
  });

  it('carries an unsupported-case list when the owner published one, and refuses an empty, blank or overlong one', () => {
    const parse = (over: object) => payCustodyDepositCatalogueSchema.safeParse({ entries: [{ ...entry, ...over }] }).success;
    expect(parse({ unsupported: ['TEST: a send from a smart contract'] })).toBe(true);
    expect(parse({ unsupported: [] })).toBe(false);
    expect(parse({ unsupported: [''] })).toBe(false);
    expect(parse({ unsupported: ['x'.repeat(281)] })).toBe(false);
    expect(parse({ unsupported: Array.from({ length: 21 }, (_, i) => `TEST ${i}`) })).toBe(false);
  });

  it('accepts a halted list with a note or none, and refuses a blank note', () => {
    const halted = { assetId: 'USDT', networkId: 'TEST-net', label: 'TEST network', haltNote: null };
    const parse = (h: object) => payCustodyDepositCatalogueSchema.safeParse({ entries: [], halted: [h] }).success;
    expect(payCustodyDepositCatalogueSchema.safeParse({ entries: [] }).success).toBe(true);
    expect(parse(halted)).toBe(true);
    expect(parse({ ...halted, haltNote: 'Maintenance' })).toBe(true);
    expect(parse({ ...halted, haltNote: '' })).toBe(false);
    expect(parse({ ...halted, extra: 1 })).toBe(false);
  });

  it('an extra address carries its expiry and the first never does; a reply names both, and an older reply still parses', () => {
    const parse = (over: object) => payCustodyDepositAddressInputSchema.safeParse({ ...input, ...over }).success;
    expect(parse({})).toBe(true);
    expect(parse({ addressIndex: 0 })).toBe(true);
    expect(parse({ addressIndex: 2, expiresAt: '2026-11-01T00:00:00.000Z' })).toBe(true);
    expect(parse({ addressIndex: 2 })).toBe(false);
    expect(parse({ expiresAt: '2026-11-01T00:00:00.000Z' })).toBe(false);
    expect(parse({ addressIndex: 0, expiresAt: '2026-11-01T00:00:00.000Z' })).toBe(false);
    expect(parse({ addressIndex: 10000, expiresAt: '2026-11-01T00:00:00.000Z' })).toBe(false);
    expect(parse({ addressIndex: 1.5, expiresAt: '2026-11-01T00:00:00.000Z' })).toBe(false);
    expect(parse({ addressIndex: 1, expiresAt: 'next week' })).toBe(false);
    const reply = (address: object) => payCustodyDepositAddressReplySchema.safeParse({ state: 'issued', address }).success;
    expect(reply(issued.address)).toBe(true);
    expect(reply({ ...issued.address, addressIndex: 3, expiresAt: '2026-11-01T00:00:00.000Z' })).toBe(true);
    expect(reply({ ...issued.address, addressIndex: 0, expiresAt: null })).toBe(true);
    expect(reply({ ...issued.address, addressIndex: -1, expiresAt: null })).toBe(false);
  });

  it('names a deposit held for release at an expired address', () => {
    const record = {
      id: 'r2',
      assetId: 'USDT',
      networkId: 'TEST-net',
      address: '0xabc',
      txHash: '0xdef',
      outputIndex: 0,
      amount: '5',
      confirmations: 0,
      confirmationsRequired: null,
      status: 'held_for_release',
      reason: 'address_expired',
      minimumDeposit: null,
      detectedAt: '2026-10-21T00:00:00.000Z',
      creditedAt: null,
    };
    expect(payCustodyDepositRecordSchema.safeParse(record).success).toBe(true);
  });

  it('names the reorg reasons so a reversed record parses', () => {
    const record = {
      id: 'r1',
      assetId: 'USDT',
      networkId: 'TEST-net',
      address: '0xabc',
      txHash: '0xdef',
      outputIndex: 0,
      amount: '5',
      confirmations: 3,
      confirmationsRequired: 3,
      status: 'reversed',
      reason: 'chain_reorg',
      minimumDeposit: '1',
      detectedAt: '2026-10-21T00:00:00.000Z',
      creditedAt: '2026-10-21T00:01:00.000Z',
    };
    expect(payCustodyDepositRecordSchema.safeParse(record).success).toBe(true);
    expect(payCustodyDepositRecordSchema.safeParse({ ...record, status: 'needs_review', reason: 'reversal_unfunded' }).success).toBe(true);
    expect(payCustodyDepositRecordSchema.safeParse({ ...record, reason: 'made_up' }).success).toBe(false);
  });

  it('refuses an address with whitespace and a reply with an invented state', () => {
    expect(payCustodyDepositAddressReplySchema.safeParse(issued).success).toBe(true);
    expect(
      payCustodyDepositAddressReplySchema.safeParse({ ...issued, address: { address: '0x a', memo: null, qrPayload: null } }).success,
    ).toBe(false);
    expect(payCustodyDepositAddressReplySchema.safeParse({ state: 'refused', code: 'pay.deposit_pair_unpublished' }).success).toBe(true);
    expect(payCustodyDepositAddressReplySchema.safeParse({ state: 'refused', code: 'made.up' }).success).toBe(false);
    expect(payCustodyDepositAddressInputSchema.safeParse({ ...input, extra: 1 }).success).toBe(false);
  });
});

describe('pay custody deposit client', () => {
  it('signs the catalogue request as svc-bank and parses the answer', async () => {
    const fetcher = vi.fn(async () => json({ entries: [entry] }));
    await expect(make(fetcher).catalogue()).resolves.toEqual({ state: 'ok', catalogue: { entries: [entry] } });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://pay.internal:4020${PAY_CUSTODY_DEPOSIT_CATALOGUE_PATH}`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(
      verifyServiceHeaders(headers, SECRET, { rawBody: { retained: true, bytes: Buffer.from(String(init.body)) }, mode: 'require' })
        .service,
    ).toBe('svc-bank');
  });

  it('returns an issued address and a typed refusal as they are', async () => {
    const fetcher = vi.fn(async () => json(issued));
    await expect(make(fetcher).address(input)).resolves.toEqual(issued);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://pay.internal:4020${PAY_CUSTODY_DEPOSIT_ADDRESS_PATH}`);
    expect(init.body).toBe(JSON.stringify(input));
    const refused = { state: 'refused', code: 'pay.deposit_source_unset' };
    await expect(make(async () => json(refused)).address(input)).resolves.toEqual(refused);
  });

  it.each([
    ['no url', { payUrl: undefined }],
    ['a url with credentials', { payUrl: 'http://u:p@pay.internal' }],
    ['a url with a query', { payUrl: 'http://pay.internal?x=1' }],
    ['a non-http url', { payUrl: 'ftp://pay.internal' }],
    ['no secret', { secret: undefined }],
    ['a short secret', { secret: 'short' }],
  ])('answers unavailable without fetching for %s', async (_name, over) => {
    const fetcher = vi.fn();
    const client = make(fetcher, over);
    await expect(client.catalogue()).resolves.toMatchObject({ state: 'unavailable' });
    await expect(client.address(input)).resolves.toMatchObject({ state: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('answers unavailable for an invalid address input without fetching', async () => {
    const fetcher = vi.fn();
    await expect(make(fetcher).address({ ...input, assetId: 'not an asset' })).resolves.toMatchObject({ state: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-2xx reply', async () => json({ entries: [entry] }, 500)],
    ['a reply that does not parse', async () => json({ entries: [{ ...entry, minimumDeposit: '' }] })],
    ['a thrown fetch', async () => Promise.reject(new Error('down'))],
  ])('answers unavailable for %s, never an empty catalogue', async (_name, fetcher) => {
    await expect(make(fetcher).catalogue()).resolves.toEqual({ state: 'unavailable', code: 'pay.custody_deposit_unavailable' });
    await expect(make(fetcher).address(input)).resolves.toEqual({ state: 'unavailable', code: 'pay.custody_deposit_unavailable' });
  });
});

const record = {
  id: 'dep-1',
  assetId: 'USDT',
  networkId: 'ethereum',
  address: '0xabc',
  txHash: '0xdead',
  outputIndex: 0,
  amount: '25.5',
  confirmations: 3,
  confirmationsRequired: 12,
  status: 'confirming',
  reason: null,
  minimumDeposit: null,
  detectedAt: '2026-10-20T10:00:00.000Z',
  creditedAt: null,
};

describe('pay custody deposit records', () => {
  it('parses a record and refuses a float amount, an invented state, a reason and an extra field', () => {
    const parse = (over: object) => payCustodyDepositRecordSchema.safeParse({ ...record, ...over }).success;
    expect(parse({})).toBe(true);
    expect(parse({ confirmationsRequired: null })).toBe(true);
    expect(parse({ amount: '1e3' })).toBe(false);
    expect(parse({ amount: 25.5 })).toBe(false);
    expect(parse({ status: 'done' })).toBe(false);
    expect(parse({ reason: 'because' })).toBe(false);
    expect(parse({ confirmationsRequired: 0 })).toBe(false);
    expect(parse({ extra: 1 })).toBe(false);
  });

  it('bounds the page and defaults it', () => {
    expect(payCustodyDepositRecordsInputSchema.parse({ userId: 'u' })).toEqual({ userId: 'u', offset: 0, limit: 50 });
    expect(payCustodyDepositRecordsInputSchema.safeParse({ userId: 'u', limit: 201 }).success).toBe(false);
    expect(payCustodyDepositRecordsInputSchema.safeParse({ userId: 'u', statuses: [] }).success).toBe(false);
    expect(payCustodyDepositRecordsInputSchema.safeParse({ userId: 'u', statuses: ['paid'] }).success).toBe(false);
  });

  it('signs the records request as svc-bank and parses the page; a bad page is unavailable', async () => {
    const fetcher = vi.fn(async () => json({ items: [record], total: 1 }));
    await expect(make(fetcher).records({ userId: 'user-1' })).resolves.toEqual({
      state: 'ok',
      records: { items: [record], total: 1 },
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://pay.internal:4020${PAY_CUSTODY_DEPOSIT_RECORDS_PATH}`);
    expect(JSON.parse(String(init.body))).toEqual({ userId: 'user-1', offset: 0, limit: 50 });
    const bad = make(async () => json({ items: [{ ...record, amount: 1 }], total: 1 }));
    await expect(bad.records({ userId: 'user-1' })).resolves.toEqual({ state: 'unavailable', code: 'pay.custody_deposit_unavailable' });
    const none = vi.fn();
    await expect(make(none).records({ userId: '' })).resolves.toMatchObject({ state: 'unavailable' });
    expect(none).not.toHaveBeenCalled();
  });
});
