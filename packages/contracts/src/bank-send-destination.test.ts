import { describe, expect, it, vi } from 'vitest';
import {
  BANK_SEND_DESTINATION_CALLERS,
  BANK_SEND_DESTINATION_PROCEDURE,
  BANK_SEND_DESTINATION_STATES,
  bankSendDestinationInputSchema,
  bankSendDestinationSchema,
  createBankSendDestinationClient,
  verifyServiceHeaders,
} from './index.js';
import { SERVICE_NAMES } from './service-keys.js';

const SECRET = 'send-destination-secret-long-enough-0001';
const DESTINATION = '11111111-1111-4111-8111-111111111111';
const input = { userId: 'user-sender', assetId: 'USDT', network: 'ethereum', ref: '0x52908400098527886E0F7030069857D2E4169EE7' };
const ready = { state: 'ready', destinationId: DESTINATION, coolingOffEndsAt: '2026-10-28T00:00:00.000Z' };

const reply = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ result: { data } }), { status, headers: { 'content-type': 'application/json' } });

describe('bank send destination contract', () => {
  it('names one procedure and one caller, and the caller is a real service', () => {
    expect(BANK_SEND_DESTINATION_PROCEDURE).toBe('ramps.destinations.sendable');
    expect(BANK_SEND_DESTINATION_CALLERS).toEqual(['svc-pay']);
    for (const caller of BANK_SEND_DESTINATION_CALLERS) expect(SERVICE_NAMES).toContain(caller);
  });

  it('refuses a field it does not name, a malformed network and a blank address', () => {
    expect(bankSendDestinationInputSchema.safeParse(input).success).toBe(true);
    expect(bankSendDestinationInputSchema.safeParse({ ...input, tag: 'memo' }).success).toBe(false);
    expect(bankSendDestinationInputSchema.safeParse({ ...input, network: 'Ethereum Mainnet' }).success).toBe(false);
    expect(bankSendDestinationInputSchema.safeParse({ ...input, ref: '' }).success).toBe(false);
    expect(bankSendDestinationInputSchema.safeParse({ ...input, assetId: 'US DT' }).success).toBe(false);
  });

  it('parses each state and refuses an invented one or an extra field', () => {
    for (const state of BANK_SEND_DESTINATION_STATES) {
      expect(bankSendDestinationSchema.parse({ state, destinationId: null, coolingOffEndsAt: null }).state).toBe(state);
    }
    expect(bankSendDestinationSchema.safeParse({ ...ready, state: 'maybe' }).success).toBe(false);
    expect(bankSendDestinationSchema.safeParse({ ...ready, label: 'x' }).success).toBe(false);
    expect(bankSendDestinationSchema.safeParse({ state: 'ready' }).success).toBe(false);
  });
});

describe('bank send destination client', () => {
  it('signs the body as svc-pay and returns the parsed answer', async () => {
    const fetcher = vi.fn(async () => reply(ready));
    const client = createBankSendDestinationClient({ bankUrl: 'http://bank.internal:4010/', secret: SECRET, fetcher });
    await expect(client.check(input)).resolves.toEqual(ready);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://bank.internal:4010/trpc/ramps.destinations.sendable');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(input));
    const headers = init.headers as Record<string, string>;
    expect(
      verifyServiceHeaders(headers, SECRET, { rawBody: { retained: true, bytes: Buffer.from(String(init.body)) }, mode: 'require' })
        .service,
    ).toBe('svc-pay');
  });

  it.each([
    ['no url', { secret: SECRET }],
    ['a url with credentials', { bankUrl: 'http://u:p@bank.internal', secret: SECRET }],
    ['a url with a query', { bankUrl: 'http://bank.internal?x=1', secret: SECRET }],
    ['a non-http url', { bankUrl: 'ftp://bank.internal', secret: SECRET }],
    ['no secret', { bankUrl: 'http://bank.internal' }],
    ['a short secret', { bankUrl: 'http://bank.internal', secret: 'short' }],
  ])('answers unavailable without fetching for %s', async (_name, options) => {
    const fetcher = vi.fn();
    const client = createBankSendDestinationClient({ ...options, fetcher: fetcher as unknown as typeof fetch });
    await expect(client.check(input)).resolves.toEqual({ state: 'unavailable', code: 'bank.send_destination_unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('answers unavailable for an invalid input without fetching', async () => {
    const fetcher = vi.fn();
    const client = createBankSendDestinationClient({
      bankUrl: 'http://bank.internal',
      secret: SECRET,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(client.check({ ...input, network: '' })).resolves.toMatchObject({ state: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-2xx reply', async () => reply(ready, 500)],
    ['a reply that does not parse', async () => reply({ state: 'ready' })],
    ['an envelope with no result', async () => new Response(JSON.stringify({ error: {} }), { status: 200 })],
    ['a thrown fetch', async () => Promise.reject(new Error('down'))],
  ])('answers unavailable for %s, never ready', async (_name, fetcher) => {
    const client = createBankSendDestinationClient({
      bankUrl: 'http://bank.internal',
      secret: SECRET,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(client.check(input)).resolves.toEqual({ state: 'unavailable', code: 'bank.send_destination_unavailable' });
  });

  it('answers unavailable when the bank does not reply in time', async () => {
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    const client = createBankSendDestinationClient({
      bankUrl: 'http://bank.internal',
      secret: SECRET,
      timeoutMs: 20,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(client.check(input)).resolves.toMatchObject({ state: 'unavailable' });
  });
});
