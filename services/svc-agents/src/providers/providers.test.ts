import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../errors.js';
import {
  MockModelProvider,
  mockUsage,
  mockUsageBoardCard,
  mockUsageStatusLine,
  parseMockUsageStatusLine,
  mockUsageStatusLineMatches,
  mockUsageStatusLineConsistent,
  mockUsageExportHeader,
  mockUsageExportLine,
  mockUsageExportText,
  mockInputTokensInRange,
  mockUsageDeterministic,
} from './mock.js';
import { UpstreamModelProvider, readUsage } from './upstream.js';
import {
  isUsable,
  supports,
  totalTokens,
  type CompletionRequest,
  tokenUsageBoardCard,
  tokenUsageStatusLine,
  parseTokenUsageStatusLine,
  tokenUsageStatusLineMatches,
  tokenUsageStatusLineConsistent,
  tokenUsageExportHeader,
  tokenUsageExportLine,
  tokenUsageExportText,
  totalTokensInRange,
  isProviderCapability,
  PROVIDER_CAPABILITIES,
  PROVIDER_UNPROBED_REASON,
} from './provider.js';

/**
 * The adapter layer.
 *
 * Two providers implement one interface: the deterministic mock the rest of the
 * suite meters against, and the real HTTP adapter. The HTTP one is tested with
 * `fetch` stubbed, because what needs proving is not that HTTP works — it is
 * that the adapter reads token counts correctly, refuses to guess when it
 * cannot, and never lets a credential or an upstream's error body escape.
 */

const request = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: 'reasoning-lg',
  messages: [{ role: 'user', content: 'hello' }],
  maxOutputTokens: 128,
  ...over,
});

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: unknown, init: unknown) => handler(String(url), init as RequestInit));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const upstream = (over: Partial<ConstructorParameters<typeof UpstreamModelProvider>[0]> = {}) =>
  new UpstreamModelProvider({
    id: 'primary',
    baseUrl: 'https://engine.test',
    apiKey: 'super-secret-key-value',
    models: { 'reasoning-lg': 'internal-model-7' },
    ...over,
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MockModelProvider — determinism is the feature', () => {
  it('returns identical text and identical token counts for identical requests', async () => {
    const provider = new MockModelProvider();
    const a = await provider.complete(request());
    const b = await provider.complete(request());

    expect(a.text).toBe(b.text);
    expect(a.usage).toEqual(b.usage);
    // And the counts are computable independently, which is what lets a
    // metering test assert an exact amount instead of asserting whatever the
    // implementation happened to produce.
    expect(a.usage).toEqual(mockUsage(request()));
  });

  it('varies across requests, so a test cannot pass by accident', async () => {
    const provider = new MockModelProvider();
    const a = await provider.complete(request());
    const b = await provider.complete(request({ messages: [{ role: 'user', content: 'goodbye' }] }));
    expect(a.text).not.toBe(b.text);
  });

  it('never exceeds the requested output ceiling', async () => {
    const provider = new MockModelProvider();
    for (const ceiling of [1, 4, 17, 256]) {
      const result = await provider.complete(request({ maxOutputTokens: ceiling }));
      expect(result.usage.outputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeLessThanOrEqual(ceiling);
    }
  });

  it('streams to the same text, and reports usage only on the final chunk', async () => {
    const provider = new MockModelProvider();
    const expected = await provider.complete(request());

    let text = '';
    let final: { usage?: { inputTokens: number; outputTokens: number }; done: boolean } | undefined;
    for await (const chunk of provider.stream(request())) {
      text += chunk.delta;
      if (chunk.done) final = chunk;
    }

    expect(text).toBe(expected.text);
    expect(final?.done).toBe(true);
    expect(final?.usage).toEqual(expected.usage);
  });

  it('reports itself unhealthy while broken, and healthy again once repaired', async () => {
    const provider = new MockModelProvider();
    expect(isUsable(provider)).toBe(true);

    provider.breakWith(new ProviderError('down', 'mock', true, 503));
    expect(isUsable(provider)).toBe(false);

    provider.repair();
    expect(isUsable(provider)).toBe(true);
  });

  it('treats a transient blip as freshness, not as staleness', async () => {
    // One failure must not take the provider out of rotation: the difference
    // between a blip and an outage is exactly what `health()` is for.
    const provider = new MockModelProvider({ failFirst: 1 });
    await expect(provider.complete(request())).rejects.toBeInstanceOf(ProviderError);
    expect(isUsable(provider)).toBe(true);
    await expect(provider.complete(request())).resolves.toBeTruthy();
  });
});

describe('UpstreamModelProvider — the real adapter', () => {
  it('does not report healthy or usable off a constructed client — no probe has run', () => {
    const provider = upstream();
    const health = provider.health();
    expect(health.healthy).toBe(false);
    expect(health.reason).toBe(PROVIDER_UNPROBED_REASON);
    expect(isUsable(provider)).toBe(false);
  });

  it('becomes healthy only after a real HTTP call succeeds', async () => {
    stubFetch(() => json({ content: [{ text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const provider = upstream();
    expect(provider.health().healthy).toBe(false);
    await provider.complete(request());
    expect(provider.health().healthy).toBe(true);
    expect(isUsable(provider)).toBe(true);
  });

  it('resolves the routing alias to the upstream id, and hands the ALIAS back', async () => {
    const fetchSpy = stubFetch(() => json({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 4 } }));

    const result = await upstream().complete(request());

    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.model).toBe('internal-model-7');
    expect(body.max_tokens).toBe(128);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);

    // Everything downstream — audit rows, usage records, spans — records what
    // the routing table asked for. The concrete id stays inside the adapter.
    expect(result.model).toBe('reasoning-lg');
    expect(result.providerId).toBe('primary');
    expect(result.text).toBe('hi');
    expect(totalTokens(result.usage)).toBe(14);
  });

  it('passes an unmapped alias through, so a deployment may use concrete ids if it prefers', () => {
    expect(upstream().resolveModel('some-other-id')).toBe('some-other-id');
  });

  it('sends the credential in the configured header and puts it nowhere else', async () => {
    const fetchSpy = stubFetch(() => json({ content: [{ text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } }));

    await upstream({ authHeader: 'authorization', authPrefix: 'Bearer ' }).complete(request());

    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer super-secret-key-value');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('merges configured static headers, so a protocol version pin is deployment config', async () => {
    const fetchSpy = stubFetch(() => json({ content: [{ text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    await upstream({ headers: { 'x-protocol-version': '2026-01-01' } }).complete(request());

    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-protocol-version']).toBe('2026-01-01');
  });

  it('keeps the credential out of the error it throws', async () => {
    stubFetch(() => new Response('unauthorised: key super-secret-key-value is invalid', { status: 401 }));

    const error = await upstream()
      .complete(request())
      .catch((err: unknown) => err as ProviderError);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).not.toContain('super-secret-key-value');
    // The upstream's error BODY is not read into ours either: it is the most
    // likely place for a vendor name to arrive, and one careless `err.message`
    // away from a user's screen (Doctrine §0.7).
    expect(error.message).not.toContain('unauthorised');
    expect(error.message).toContain('401');
  });

  it('marks 429 and 5xx retryable, and a 400 not', async () => {
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [400, false],
    ] as const) {
      stubFetch(() => new Response('nope', { status }));
      const error = (await upstream()
        .complete(request())
        .catch((err: unknown) => err)) as ProviderError;
      expect(error.retryable, `status ${status}`).toBe(retryable);
    }
  });

  it('goes unhealthy after three consecutive failures, and recovers on the first success', async () => {
    const provider = upstream();
    stubFetch(() => new Response('nope', { status: 503 }));

    for (let i = 0; i < 2; i++) await provider.complete(request()).catch(() => undefined);
    expect(provider.health().healthy).toBe(true); // a blip is not an outage

    await provider.complete(request()).catch(() => undefined);
    expect(provider.health().healthy).toBe(false);
    expect(isUsable(provider)).toBe(false);

    stubFetch(() => json({ content: [{ text: 'back' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    await provider.complete(request());
    expect(provider.health().healthy).toBe(true);
  });

  it('declares embed only when an embeddings endpoint is configured', () => {
    expect(supports(upstream(), 'embed')).toBe(false);
    expect(supports(upstream({ embeddingsPath: '/v1/embeddings' }), 'embed')).toBe(true);
  });

  it('bills input tokens from message_start and output tokens from message_delta', async () => {
    stubFetch(() =>
      sse([
        { type: 'message_start', usage: { input_tokens: 25 } },
        { type: 'content_block_delta', delta: { text: 'Hello' } },
        { type: 'content_block_delta', delta: { text: ' there' } },
        { type: 'message_delta', usage: { output_tokens: 4 }, delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]),
    );

    const chunks = [];
    for await (const chunk of upstream().stream(request())) chunks.push(chunk);

    expect(chunks.filter((chunk) => !chunk.done).map((chunk) => chunk.delta).join('')).toBe('Hello there');
    expect(chunks.filter((chunk) => chunk.done)).toEqual([
      { delta: '', done: true, usage: { inputTokens: 25, outputTokens: 4 }, stopReason: 'end' },
    ]);
  });

  it('bills input tokens nested under message.usage when message_delta reports only output', async () => {
    stubFetch(() =>
      sse([
        { type: 'message_start', message: { usage: { input_tokens: 25 } } },
        { type: 'content_block_delta', delta: { text: 'Hello there' } },
        { type: 'message_delta', usage: { output_tokens: 4 }, delta: { stop_reason: 'end_turn' } },
      ]),
    );

    const chunks = [];
    for await (const chunk of upstream().stream(request())) chunks.push(chunk);

    expect(chunks.filter((chunk) => !chunk.done).map((chunk) => chunk.delta).join('')).toBe('Hello there');
    expect(chunks.filter((chunk) => chunk.done)).toEqual([
      { delta: '', done: true, usage: { inputTokens: 25, outputTokens: 4 }, stopReason: 'end' },
    ]);
  });

  it('refuses an input-only usage object instead of billing zero output tokens', async () => {
    stubFetch(() =>
      sse([
        { type: 'content_block_delta', delta: { text: 'Hello' } },
        { type: 'message_delta', usage: { input_tokens: 25 }, delta: { stop_reason: 'end_turn' } },
      ]),
    );

    const chunks = [];
    await expect(async () => {
      for await (const chunk of upstream().stream(request())) chunks.push(chunk);
    }).rejects.toBeInstanceOf(ProviderError);
    expect(chunks.map((chunk) => chunk.delta).join('')).toBe('Hello');
    expect(chunks.some((chunk) => chunk.done)).toBe(false);
    expect(chunks.some((chunk) => chunk.usage?.outputTokens === 0)).toBe(false);
  });

  it('sends temperature and stop sequences on a stream, and omits both when the request leaves them unset', async () => {
    const fetchSpy = stubFetch(() =>
      sse([
        { type: 'message_start', usage: { input_tokens: 3 } },
        { type: 'content_block_delta', delta: { text: 'ok' } },
        { type: 'message_delta', usage: { output_tokens: 1 }, delta: { stop_reason: 'end_turn' } },
      ]),
    );

    const chunks = [];
    for await (const chunk of upstream().stream(
      request({ temperature: 0.2, stopSequences: ['END', 'STOP'] }),
    )) {
      chunks.push(chunk);
    }

    const controlled = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(controlled.temperature).toBe(0.2);
    expect(controlled.stop_sequences).toEqual(['END', 'STOP']);
    expect(controlled.stream).toBe(true);
    expect(controlled.model).toBe('internal-model-7');
    expect(chunks.filter((chunk) => chunk.done)).toEqual([
      { delta: '', done: true, usage: { inputTokens: 3, outputTokens: 1 }, stopReason: 'end' },
    ]);

    const bareChunks = [];
    for await (const chunk of upstream().stream(request())) bareChunks.push(chunk);
    const bare = JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body));
    expect(bare.temperature).toBeUndefined();
    expect(bare.stop_sequences).toBeUndefined();
    expect(bare.stream).toBe(true);
    expect(bare.model).toBe('internal-model-7');
    expect(bare.max_tokens).toBe(128);
    expect(bareChunks.filter((chunk) => chunk.done)).toEqual([
      { delta: '', done: true, usage: { inputTokens: 3, outputTokens: 1 }, stopReason: 'end' },
    ]);
  });
});

describe('readUsage — a call we cannot price is a call we must not bill', () => {
  it('reads either naming convention, because that is where upstreams differ', () => {
    expect(readUsage({ input_tokens: 10, output_tokens: 4 }, 'p')).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(readUsage({ prompt_tokens: 10, completion_tokens: 4 }, 'p')).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it('throws rather than defaulting to zero when usage is missing', () => {
    // Defaulting to zero would bill nothing and hide the fault for as long as
    // it lasted — the platform would pay for every call and never know.
    expect(() => readUsage(undefined, 'p')).toThrow(ProviderError);
    expect(() => readUsage({ input_tokens: 5 }, 'p')).toThrow(ProviderError);
  });

  it('rejects negative or fractional counts', () => {
    expect(() => readUsage({ input_tokens: -1, output_tokens: 0 }, 'p')).toThrow(ProviderError);
    expect(() => readUsage({ input_tokens: 1.5, output_tokens: 0 }, 'p')).toThrow(ProviderError);
  });

  it('allows an output-free response only where one is expected', () => {
    // Embeddings generate nothing; completions always report both.
    expect(readUsage({ input_tokens: 7 }, 'p', { partial: true })).toEqual({ inputTokens: 7, outputTokens: 0 });
  });
});

describe('L3 wave64 mock usage honesty', () => {
  it('deterministic boards and consistency', () => {
    const req = request();
    const card = mockUsageBoardCard(req);
    expect(card.totalTokens).toBe(card.inputTokens + card.outputTokens);
    expect(mockUsageStatusLineMatches(req)).toBe(true);
    expect(mockUsageStatusLineConsistent(mockUsageStatusLine(req))).toBe(true);
    expect(parseMockUsageStatusLine('nope')).toBeNull();
    expect(mockUsageExportText(req).startsWith(mockUsageExportHeader())).toBe(true);
    expect(mockUsageExportLine(req)).toContain(',');
    expect(mockUsageDeterministic(req, request())).toBe(true);
    expect(mockInputTokensInRange(req, 0, 10_000)).toBe(true);
    expect(mockInputTokensInRange(req, 10_000, 0)).toBe(false);
  });
});

describe('L3 wave65 token usage honesty', () => {
  it('boards and capability catalog', () => {
    const usage = { inputTokens: 10, outputTokens: 5 };
    expect(tokenUsageBoardCard(usage).total).toBe(15);
    expect(tokenUsageStatusLineMatches(usage)).toBe(true);
    expect(tokenUsageStatusLineConsistent(tokenUsageStatusLine(usage))).toBe(true);
    expect(parseTokenUsageStatusLine('nope')).toBeNull();
    expect(tokenUsageExportText(usage).startsWith(tokenUsageExportHeader())).toBe(true);
    expect(tokenUsageExportLine(usage)).toBe('10,5,15');
    expect(totalTokensInRange(usage, 15, 15)).toBe(true);
    expect(totalTokensInRange(usage, 20, 10)).toBe(false);
    expect(isProviderCapability('complete')).toBe(true);
    expect(isProviderCapability('paint')).toBe(false);
    expect(PROVIDER_CAPABILITIES).toHaveLength(3);
  });
});
