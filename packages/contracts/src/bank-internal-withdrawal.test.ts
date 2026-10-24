import { describe, expect, it, vi } from 'vitest';
import {
  BANK_INTERNAL_WITHDRAWAL_CALLERS,
  BANK_INTERNAL_WITHDRAWAL_PROCEDURE,
  bankInternalWithdrawalInputSchema,
  bankInternalWithdrawalSchema,
  createBankInternalWithdrawalClient,
  internalWithdrawalTransferId,
  verifyServiceHeaders,
} from './index.js';
import { SERVICE_NAMES } from './service-keys.js';

const WITHDRAWAL = '11111111-1111-4111-8111-111111111111';
const SECRET = 'internal-withdrawal-secret-long-enough';
const input = {
  transferId: internalWithdrawalTransferId(WITHDRAWAL),
  fromUserId: 'user-sender',
  toUserId: 'user-receiver',
  assetId: 'USDT',
  amount: '25.5',
};
const UNKNOWN = { state: 'unknown', code: 'bank.internal_withdrawal_unknown' };

const reply = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ result: { data } }), { status, headers: { 'content-type': 'application/json' } });

describe('bank internal withdrawal contract', () => {
  it('names one procedure and one caller, and the caller is a real service', () => {
    expect(BANK_INTERNAL_WITHDRAWAL_PROCEDURE).toBe('transfers.settleWithdrawal');
    expect(BANK_INTERNAL_WITHDRAWAL_CALLERS).toEqual(['svc-pay']);
    for (const caller of BANK_INTERNAL_WITHDRAWAL_CALLERS) expect(SERVICE_NAMES).toContain(caller);
  });

  it('keys one send per withdrawal', () => {
    expect(internalWithdrawalTransferId(WITHDRAWAL)).toBe(`withdraw:${WITHDRAWAL}`);
  });

  it('refuses a key that is not a withdrawal key, a self send, a number, zero and an extra field', () => {
    expect(bankInternalWithdrawalInputSchema.safeParse(input).success).toBe(true);
    expect(bankInternalWithdrawalInputSchema.safeParse({ ...input, transferId: 'p2p-1234567890' }).success).toBe(false);
    expect(bankInternalWithdrawalInputSchema.safeParse({ ...input, toUserId: input.fromUserId }).success).toBe(false);
    expect(bankInternalWithdrawalInputSchema.safeParse({ ...input, amount: 25 }).success).toBe(false);
    expect(bankInternalWithdrawalInputSchema.safeParse({ ...input, amount: '0.000' }).success).toBe(false);
    expect(bankInternalWithdrawalInputSchema.safeParse({ ...input, amount: '-1' }).success).toBe(false);
    expect(bankInternalWithdrawalInputSchema.safeParse({ ...input, fee: '0' }).success).toBe(false);
  });

  it('parses posted and refused, and nothing else', () => {
    expect(bankInternalWithdrawalSchema.parse({ state: 'posted', transferId: input.transferId, ledgerTxId: 'tx-1' })).toEqual({
      state: 'posted',
      transferId: input.transferId,
      ledgerTxId: 'tx-1',
    });
    expect(bankInternalWithdrawalSchema.parse({ state: 'refused', code: 'bank.recipient_cannot_receive' })).toEqual({
      state: 'refused',
      code: 'bank.recipient_cannot_receive',
    });
    expect(bankInternalWithdrawalSchema.safeParse({ state: 'posted', transferId: input.transferId }).success).toBe(false);
    expect(bankInternalWithdrawalSchema.safeParse({ state: 'refused' }).success).toBe(false);
    expect(bankInternalWithdrawalSchema.safeParse({ state: 'unknown', code: 'x' }).success).toBe(false);
  });
});

describe('bank internal withdrawal client', () => {
  it('signs the body as svc-pay and returns the parsed answer', async () => {
    const fetcher = vi.fn(async () => reply({ state: 'posted', transferId: input.transferId, ledgerTxId: 'tx-1' }));
    const client = createBankInternalWithdrawalClient({ bankUrl: 'http://bank.internal:4010/', secret: SECRET, fetcher });
    await expect(client.settle(input)).resolves.toEqual({ state: 'posted', transferId: input.transferId, ledgerTxId: 'tx-1' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://bank.internal:4010/trpc/transfers.settleWithdrawal');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(input));
    const headers = init.headers as Record<string, string>;
    expect(
      verifyServiceHeaders(headers, SECRET, { rawBody: { retained: true, bytes: Buffer.from(String(init.body)) }, mode: 'require' })
        .service,
    ).toBe('svc-pay');
  });

  it('passes a refusal through as a refusal', async () => {
    const fetcher = vi.fn(async () => reply({ state: 'refused', code: 'ledger.insufficient_funds' }));
    const client = createBankInternalWithdrawalClient({ bankUrl: 'http://bank.internal', secret: SECRET, fetcher });
    await expect(client.settle(input)).resolves.toEqual({ state: 'refused', code: 'ledger.insufficient_funds' });
  });

  it.each([
    ['no url', { secret: SECRET }],
    ['a url with credentials', { bankUrl: 'http://u:p@bank.internal', secret: SECRET }],
    ['a url with a query', { bankUrl: 'http://bank.internal?x=1', secret: SECRET }],
    ['a non-http url', { bankUrl: 'ftp://bank.internal', secret: SECRET }],
    ['no secret', { bankUrl: 'http://bank.internal' }],
    ['a short secret', { bankUrl: 'http://bank.internal', secret: 'short' }],
  ])('answers unknown without fetching for %s, never refused', async (_name, options) => {
    const fetcher = vi.fn();
    const client = createBankInternalWithdrawalClient({ ...options, fetcher: fetcher as unknown as typeof fetch });
    await expect(client.settle(input)).resolves.toEqual(UNKNOWN);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('throws on an input it will not send, so nothing reads as refused', async () => {
    const fetcher = vi.fn();
    const client = createBankInternalWithdrawalClient({
      bankUrl: 'http://bank.internal',
      secret: SECRET,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(client.settle({ ...input, toUserId: input.fromUserId })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-2xx reply', async () => reply({ state: 'refused', code: 'bank.recipient_cannot_receive' }, 500)],
    ['a reply that does not parse', async () => reply({ state: 'posted' })],
    ['an envelope with no result', async () => new Response(JSON.stringify({ error: {} }), { status: 200 })],
    ['a thrown fetch', async () => Promise.reject(new Error('down'))],
  ])('answers unknown for %s, never refused', async (_name, fetcher) => {
    const client = createBankInternalWithdrawalClient({
      bankUrl: 'http://bank.internal',
      secret: SECRET,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(client.settle(input)).resolves.toEqual(UNKNOWN);
  });

  it('answers unknown when the bank does not reply in time', async () => {
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    const client = createBankInternalWithdrawalClient({
      bankUrl: 'http://bank.internal',
      secret: SECRET,
      timeoutMs: 20,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(client.settle(input)).resolves.toEqual(UNKNOWN);
  });
});
