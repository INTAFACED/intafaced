import { describe, expect, it, vi } from 'vitest';
import {
  BANK_APPROVER_ELIGIBILITY_CALLERS,
  BANK_APPROVER_ELIGIBILITY_PROCEDURE,
  bankApproverEligibilityInputSchema,
  bankApproverEligibilitySchema,
  createBankApproverEligibilityClient,
  verifyServiceHeaders,
} from './index.js';
import { SERVICE_NAMES } from './service-keys.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const SECRET = 'approver-eligibility-secret-long-enough';
const input = { accountId: ACCOUNT, userId: 'user-approver' };

const reply = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ result: { data } }), { status, headers: { 'content-type': 'application/json' } });

describe('bank approver eligibility contract', () => {
  it('names one procedure and one caller, and the caller is a real service', () => {
    expect(BANK_APPROVER_ELIGIBILITY_PROCEDURE).toBe('business.approverEligibility');
    expect(BANK_APPROVER_ELIGIBILITY_CALLERS).toEqual(['svc-pay']);
    for (const caller of BANK_APPROVER_ELIGIBILITY_CALLERS) expect(SERVICE_NAMES).toContain(caller);
  });

  it('refuses a field it does not name and a non-uuid account', () => {
    expect(bankApproverEligibilityInputSchema.safeParse({ ...input, extra: 1 }).success).toBe(false);
    expect(bankApproverEligibilityInputSchema.safeParse({ ...input, accountId: 'not-a-uuid' }).success).toBe(false);
    expect(bankApproverEligibilityInputSchema.safeParse({ ...input, userId: '' }).success).toBe(false);
    expect(bankApproverEligibilityInputSchema.safeParse(input).success).toBe(true);
  });

  it('parses each answer and refuses an answer with an invented state or an extra field', () => {
    expect(bankApproverEligibilitySchema.parse({ state: 'eligible', role: 'checker' })).toEqual({ state: 'eligible', role: 'checker' });
    expect(bankApproverEligibilitySchema.parse({ state: 'role_cannot_approve', role: 'viewer' })).toEqual({
      state: 'role_cannot_approve',
      role: 'viewer',
    });
    for (const state of ['not_a_member', 'account_closed', 'no_such_account'])
      expect(bankApproverEligibilitySchema.parse({ state })).toEqual({ state });
    expect(bankApproverEligibilitySchema.safeParse({ state: 'maybe' }).success).toBe(false);
    expect(bankApproverEligibilitySchema.safeParse({ state: 'eligible' }).success).toBe(false);
    expect(bankApproverEligibilitySchema.safeParse({ state: 'not_a_member', role: 'admin' }).success).toBe(false);
  });
});

describe('bank approver eligibility client', () => {
  it('signs the body as svc-pay and returns the parsed answer', async () => {
    const fetcher = vi.fn(async () => reply({ state: 'eligible', role: 'checker' }));
    const client = createBankApproverEligibilityClient({ bankUrl: 'http://bank.internal:4010/', secret: SECRET, fetcher });
    await expect(client.check(input)).resolves.toEqual({ state: 'eligible', role: 'checker' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://bank.internal:4010/trpc/business.approverEligibility');
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
    const client = createBankApproverEligibilityClient({ ...options, fetcher: fetcher as unknown as typeof fetch });
    await expect(client.check(input)).resolves.toEqual({ state: 'unavailable', code: 'bank.approver_eligibility_unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('answers unavailable for an invalid input without fetching', async () => {
    const fetcher = vi.fn();
    const client = createBankApproverEligibilityClient({
      bankUrl: 'http://bank.internal',
      secret: SECRET,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(client.check({ accountId: 'x', userId: 'u' })).resolves.toMatchObject({ state: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-2xx reply', async () => reply({ state: 'eligible', role: 'checker' }, 500)],
    ['a reply that does not parse', async () => reply({ state: 'eligible' })],
    ['an envelope with no result', async () => new Response(JSON.stringify({ error: {} }), { status: 200 })],
    ['a thrown fetch', async () => Promise.reject(new Error('down'))],
  ])('answers unavailable for %s, never eligible', async (_name, fetcher) => {
    const client = createBankApproverEligibilityClient({
      bankUrl: 'http://bank.internal',
      secret: SECRET,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(client.check(input)).resolves.toEqual({ state: 'unavailable', code: 'bank.approver_eligibility_unavailable' });
  });

  it('answers unavailable when the bank does not reply in time', async () => {
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    const client = createBankApproverEligibilityClient({
      bankUrl: 'http://bank.internal',
      secret: SECRET,
      timeoutMs: 20,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(client.check(input)).resolves.toMatchObject({ state: 'unavailable' });
  });
});
