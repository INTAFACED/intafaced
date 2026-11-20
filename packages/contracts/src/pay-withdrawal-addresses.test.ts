import { describe, expect, it, vi } from 'vitest';
import {
  PAY_WITHDRAWAL_ADDRESSES_CALLERS,
  PAY_WITHDRAWAL_ADDRESSES_PATH,
  createPayWithdrawalAddressesClient,
  payWithdrawalAddressesInputSchema,
  verifyServiceHeaders,
} from './index.js';
import { SERVICE_NAMES } from './service-keys.js';

const SECRET = 'withdrawal-addresses-secret-long-enough';
const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status });
const make = (fetcher: unknown, over: object = {}) =>
  createPayWithdrawalAddressesClient({ payUrl: 'http://pay.internal:4020/', secret: SECRET, fetcher: fetcher as typeof fetch, ...over });

describe('pay withdrawal addresses contract (J-portfolio-03 #2)', () => {
  it('names one caller, a real service', () => {
    expect(PAY_WITHDRAWAL_ADDRESSES_CALLERS).toEqual(['svc-bank']);
    for (const caller of PAY_WITHDRAWAL_ADDRESSES_CALLERS) expect(SERVICE_NAMES).toContain(caller);
  });

  it('takes uuids only, at least one, and no extra field', () => {
    expect(payWithdrawalAddressesInputSchema.safeParse({ userId: 'u', withdrawalIds: [W1] }).success).toBe(true);
    expect(payWithdrawalAddressesInputSchema.safeParse({ userId: 'u', withdrawalIds: [] }).success).toBe(false);
    expect(payWithdrawalAddressesInputSchema.safeParse({ userId: 'u', withdrawalIds: ['nope'] }).success).toBe(false);
    expect(payWithdrawalAddressesInputSchema.safeParse({ userId: 'u', withdrawalIds: [W1], extra: 1 }).success).toBe(false);
  });

  it('asks once, signed as svc-bank, and answers the addresses by withdrawal id', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => json({ addresses: [{ withdrawalId: W1, address: '0xabc' }] }));
    const found = await make(fetcher).addressesFor('user-1', [W1, W2, W1]);
    expect(found).toEqual(new Map([[W1, '0xabc']]));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`http://pay.internal:4020${PAY_WITHDRAWAL_ADDRESSES_PATH}`);
    expect(JSON.parse(String(init.body))).toEqual({ userId: 'user-1', withdrawalIds: [W1, W2] });
    const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>));
    expect(
      verifyServiceHeaders(headers, SECRET, { rawBody: { retained: true, bytes: Buffer.from(String(init.body)) }, mode: 'require' })
        .service,
    ).toBe('svc-bank');
  });

  it('asks nothing for no ids', async () => {
    const fetcher = vi.fn();
    expect(await make(fetcher).addressesFor('user-1', [])).toEqual(new Map());
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('answers null, never an empty map, when svc-pay cannot be asked or answers wrong', async () => {
    expect(await make(vi.fn(), { payUrl: undefined }).addressesFor('u', [W1])).toBeNull();
    expect(await make(vi.fn(), { secret: 'short' }).addressesFor('u', [W1])).toBeNull();
    expect(await make(vi.fn(async () => json({ code: 'x' }, 503))).addressesFor('u', [W1])).toBeNull();
    expect(await make(vi.fn(async () => json({ addresses: 'no' }))).addressesFor('u', [W1])).toBeNull();
    expect(
      await make(
        vi.fn(async () => {
          throw new Error('down');
        }),
      ).addressesFor('u', [W1]),
    ).toBeNull();
    expect(await make(vi.fn()).addressesFor('u', ['not-a-uuid'])).toBeNull();
    // An answer naming a withdrawal that was not asked is not trusted at all.
    expect(await make(vi.fn(async () => json({ addresses: [{ withdrawalId: W2, address: '0xabc' }] }))).addressesFor('u', [W1])).toBeNull();
  });
});
