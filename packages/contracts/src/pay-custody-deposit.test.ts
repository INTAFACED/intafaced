import { describe, expect, it, vi } from 'vitest';
import {
  PAY_CUSTODY_DEPOSIT_ADDRESS_PATH,
  PAY_CUSTODY_DEPOSIT_CALLERS,
  PAY_CUSTODY_DEPOSIT_CATALOGUE_PATH,
  createPayCustodyDepositClient,
  payCustodyDepositAddressInputSchema,
  payCustodyDepositAddressReplySchema,
  payCustodyDepositCatalogueSchema,
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
