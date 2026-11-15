import { describe, expect, it, vi } from 'vitest';
import {
  BANK_SCAM_TRANSFER_CALLERS,
  BANK_SCAM_TRANSFER_PROCEDURE,
  bankScamTransferInputSchema,
  bankScamTransferSchema,
  createBankScamTransferClient,
  verifyServiceHeaders,
} from './index.js';
import { SERVICE_NAMES } from './service-keys.js';

// "Did this person send this transfer?" (BK-safe-02, J-bank-18 #3): one caller, one boolean, and every way of not getting
// an answer reads `unavailable`, never `sent`.

const SECRET = 'scam-transfer-secret-long-enough-000001';
const input = { userId: '11111111-1111-4111-8111-111111111111', transferId: 'jb18-scam-0001' };
const reply = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ result: { data } }), { status, headers: { 'content-type': 'application/json' } });

describe('bank scam transfer contract', () => {
  it('names one procedure and one caller, and the caller is a real service', () => {
    expect(BANK_SCAM_TRANSFER_PROCEDURE).toBe('safety.transferSent');
    expect(BANK_SCAM_TRANSFER_CALLERS).toEqual(['svc-support']);
    for (const caller of BANK_SCAM_TRANSFER_CALLERS) expect(SERVICE_NAMES).toContain(caller);
  });

  it('takes a user and a transfer id only, and answers one boolean only', () => {
    expect(bankScamTransferInputSchema.safeParse(input).success).toBe(true);
    expect(bankScamTransferInputSchema.safeParse({ ...input, amount: '5' }).success).toBe(false);
    expect(bankScamTransferInputSchema.safeParse({ ...input, transferId: 'short' }).success).toBe(false);
    expect(bankScamTransferInputSchema.safeParse({ ...input, transferId: 'has space in it' }).success).toBe(false);
    expect(bankScamTransferSchema.safeParse({ sent: true }).success).toBe(true);
    expect(bankScamTransferSchema.safeParse({ sent: true, amount: '5' }).success).toBe(false);
    expect(bankScamTransferSchema.safeParse({ sent: 'yes' }).success).toBe(false);
  });
});

describe('bank scam transfer client', () => {
  it('signs the body as svc-support and returns the answer', async () => {
    const fetcher = vi.fn(async () => reply({ sent: true }));
    const client = createBankScamTransferClient({ bankUrl: 'http://bank.internal:4010/', secret: SECRET, fetcher });
    await expect(client.check(input)).resolves.toEqual({ state: 'answered', sent: true });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://bank.internal:4010/trpc/safety.transferSent');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(input));
    const headers = init.headers as Record<string, string>;
    expect(
      verifyServiceHeaders(headers, SECRET, { rawBody: { retained: true, bytes: Buffer.from(String(init.body)) }, mode: 'require' })
        .service,
    ).toBe('svc-support');
    fetcher.mockImplementationOnce(async () => reply({ sent: false }));
    await expect(client.check(input)).resolves.toEqual({ state: 'answered', sent: false });
  });

  it.each([
    ['no url', { secret: SECRET }],
    ['a url with credentials', { bankUrl: 'http://u:p@bank.internal', secret: SECRET }],
    ['a non-http url', { bankUrl: 'ftp://bank.internal', secret: SECRET }],
    ['no secret', { bankUrl: 'http://bank.internal' }],
    ['a short secret', { bankUrl: 'http://bank.internal', secret: 'short' }],
  ])('answers unavailable without fetching for %s', async (_name, options) => {
    const fetcher = vi.fn();
    const client = createBankScamTransferClient({ ...options, fetcher: fetcher as unknown as typeof fetch });
    await expect(client.check(input)).resolves.toEqual({ state: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['a refusal', async () => reply({ sent: true }, 403)],
    ['an answer out of shape', async () => reply({ sent: 'yes' })],
    ['an answer with more than the boolean', async () => reply({ sent: true, amount: '5' })],
    ['a thrown fetch', async () => Promise.reject(new Error('ECONNREFUSED'))],
  ])('answers unavailable, never sent, for %s', async (_name, answer) => {
    const client = createBankScamTransferClient({
      bankUrl: 'http://bank.internal',
      secret: SECRET,
      fetcher: vi.fn(answer) as unknown as typeof fetch,
    });
    await expect(client.check(input)).resolves.toEqual({ state: 'unavailable' });
  });
});
