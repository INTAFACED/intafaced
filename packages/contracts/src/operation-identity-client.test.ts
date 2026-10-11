import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyServiceHeaders, type IdentityOperationDecisionInput, type IdentityOperationDecision } from './index.js';
import { createIdentityOperationDecisionClient } from './operation-identity-client.js';

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const GRANT = '33333333-3333-4333-8333-333333333333';
const SECRET = 'operation-client-owner-secret-long-enough';
const NOW = '2026-10-10T12:00:00.000Z';
const input: IdentityOperationDecisionInput = {
  mode: 'grant',
  intent: {
    operation: { service: 'svc-trade', kind: 'order.place', userId: USER },
    businessId: 'order:client-42',
    payloadHash: `sha256:${'a'.repeat(64)}`,
    authority: { kind: 'credential', subject: { userId: USER, credential: { kind: 'session', sessionId: SESSION } } },
  },
};

function grant(intent: IdentityOperationDecisionInput['intent'] = input.intent): IdentityOperationDecision {
  return {
    status: 'granted',
    intent,
    grantId: GRANT,
    identityVersion: '9007199254740993',
    decidedAt: NOW,
  };
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ result: { data } }), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('identity operation decision client transport', () => {
  it('refuses absent or invalid configuration and foreign-owner operations without fetching', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const options of [
      { owner: 'svc-trade' as const, secret: SECRET },
      { owner: 'svc-trade' as const, identityUrl: 'file:///tmp/identity', secret: SECRET },
      { owner: 'svc-trade' as const, identityUrl: 'https://user:pass@identity.example', secret: SECRET },
      { owner: 'svc-trade' as const, identityUrl: 'https://identity.example?other=1', secret: SECRET },
      { owner: 'svc-trade' as const, identityUrl: 'https://identity.example', secret: 'too-short' },
    ]) {
      const client = createIdentityOperationDecisionClient({ ...options, fetcher });
      await expect(client.decide(input)).resolves.toEqual({ status: 'unavailable', code: 'authority.unavailable' });
    }
    const client = createIdentityOperationDecisionClient({
      owner: 'svc-trade',
      identityUrl: 'https://identity.example',
      secret: SECRET,
      fetcher,
    });
    const payIntent: IdentityOperationDecisionInput = {
      ...input,
      intent: {
        operation: { service: 'svc-pay', kind: 'payment.capture', userId: USER, merchantId: GRANT },
        businessId: 'payment:capture:example',
        payloadHash: input.intent.payloadHash,
        authority: { kind: 'merchant_policy', merchantId: GRANT },
      },
    };
    await expect(client.decide(payIntent)).resolves.toEqual({ status: 'unavailable', code: 'authority.unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('signs the exact normalized JSON body with the dedicated owner key and validates raw tRPC data', async () => {
    const mixedCase: IdentityOperationDecisionInput = {
      ...input,
      intent: {
        ...input.intent,
        operation: { ...input.intent.operation, userId: USER.toUpperCase() },
        authority: {
          kind: 'credential',
          subject: { userId: USER.toUpperCase(), credential: { kind: 'session', sessionId: SESSION.toUpperCase() } },
        },
      },
    };
    const echoed = {
      ...input.intent,
      operation: { ...input.intent.operation, userId: USER },
      authority: { kind: 'credential' as const, subject: { userId: USER, credential: { kind: 'session' as const, sessionId: SESSION } } },
    };
    let result: IdentityOperationDecision = grant(echoed);
    const fetcher = vi.fn<typeof fetch>(async () => response(result));
    const client = createIdentityOperationDecisionClient({
      owner: 'svc-trade',
      identityUrl: 'https://identity.example/',
      secret: SECRET,
      fetcher,
    });
    const decision = await client.decide(mixedCase);
    expect(decision).toMatchObject({ status: 'granted', identityVersion: '9007199254740993' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://identity.example/trpc/operationAdmission.decide');
    expect(init?.method).toBe('POST');
    expect((init as (RequestInit & { cache?: string }) | undefined)?.cache).toBe('no-store');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = String(init?.body);
    expect(JSON.parse(body)).toEqual({
      mode: 'grant',
      intent: {
        ...input.intent,
        operation: { ...input.intent.operation, userId: USER },
        authority: { kind: 'credential', subject: { userId: USER, credential: { kind: 'session', sessionId: SESSION } } },
      },
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('x-intafaced-service')).toBe('svc-trade');
    expect(
      verifyServiceHeaders(Object.fromEntries(headers.entries()), SECRET, {
        mode: 'require',
        rawBody: { retained: true, bytes: Buffer.from(body) },
      }).service,
    ).toBe('svc-trade');
    if (decision.status !== 'granted') throw new Error('Expected a granted decision');
    expect(decision.identityVersion).toBe('9007199254740993');
  });

  it('rejects malformed envelopes, wrapper-shaped data, and a valid decision echoing another intent', async () => {
    const outputs: unknown[] = [
      { result: {} },
      { result: { data: { json: grant() } } },
      grant({ ...input.intent, businessId: 'another-command' }),
    ];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(outputs.shift()), { status: 200 }));
    const client = createIdentityOperationDecisionClient({
      owner: 'svc-trade',
      identityUrl: 'https://identity.example',
      secret: SECRET,
      fetcher,
    });
    for (let i = 0; i < 3; i++) {
      await expect(client.decide(input)).resolves.toEqual({ status: 'unavailable', code: 'authority.unavailable' });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('bounds a never-resolving fetch at three seconds, aborts its signal, and does not retry', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>(() => undefined);
    });
    const client = createIdentityOperationDecisionClient({
      owner: 'svc-trade',
      identityUrl: 'https://identity.example',
      secret: SECRET,
      fetcher,
    });
    const pending = client.decide(input);
    await vi.advanceTimersByTimeAsync(2999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ status: 'unavailable', code: 'authority.unavailable' });
    expect(signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds a stuck response-body reader and keeps a late grant from changing timeout refusal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const stuckBody = new ReadableStream<Uint8Array>({ start() {} });
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      signal = init?.signal as AbortSignal | undefined;
      return Promise.resolve(new Response(stuckBody));
    });
    const client = createIdentityOperationDecisionClient({
      owner: 'svc-trade',
      identityUrl: 'https://identity.example',
      secret: SECRET,
      fetcher,
    });
    const pending = client.decide(input);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;
    expect(result).toEqual({ status: 'unavailable', code: 'authority.unavailable' });
    expect(signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);

    let resolveFetch!: (value: Response) => void;
    let lateSignal: AbortSignal | undefined;
    const delayedFetch = vi.fn<typeof fetch>((_url, init) => {
      lateSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });
    const delayedClient = createIdentityOperationDecisionClient({
      owner: 'svc-trade',
      identityUrl: 'https://identity.example',
      secret: SECRET,
      fetcher: delayedFetch,
    });
    const delayed = delayedClient.decide(input);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(delayed).resolves.toEqual({ status: 'unavailable', code: 'authority.unavailable' });
    resolveFetch(response(grant()));
    await Promise.resolve();
    expect(lateSignal?.aborted).toBe(true);
    expect(delayedFetch).toHaveBeenCalledTimes(1);
  });
});
