import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  type StreamChunk,
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

/** Reject the way `fetch` does once the request signal aborts. */
function abortedFetch(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    if (!signal || signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

/** Exact event-stream bytes, so a test can omit the trailing blank line or use CRLF. */
const sseRaw = (body: string) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const dataFrame = (event: unknown) => `data: ${JSON.stringify(event)}`;

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

  it('parks a completion while its hold file exists, marks itself parked, and answers once the file is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mock-hold-'));
    const hold = join(dir, 'engine.hold');
    try {
      const provider = new MockModelProvider({ holdFile: hold });
      const free = await provider.complete(request());
      expect(existsSync(`${hold}.held`)).toBe(false);
      writeFileSync(hold, 'held');
      let answered = false;
      const parked = provider.complete(request()).then((result) => ((answered = true), result));
      await vi.waitFor(() => expect(existsSync(`${hold}.held`)).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(answered).toBe(false);
      rmSync(hold);
      expect(await parked).toEqual(free);
      expect(existsSync(`${hold}.held`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts each completion that reaches the held engine, one line each, so a test can see which runs reached it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mock-hold-'));
    const hold = join(dir, 'engine.hold');
    try {
      const provider = new MockModelProvider({ holdFile: hold });
      await provider.complete(request());
      expect(existsSync(`${hold}.calls`)).toBe(false);
      writeFileSync(hold, 'held');
      const both = Promise.all([provider.complete(request()), provider.complete(request())]);
      await vi.waitFor(() => expect(readFileSync(`${hold}.calls`, 'utf8').trim().split('\n')).toHaveLength(2));
      rmSync(hold);
      await both;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers anyway once a hold outlasts its limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mock-hold-'));
    const hold = join(dir, 'engine.hold');
    try {
      writeFileSync(hold, 'held');
      const result = await new MockModelProvider({ holdFile: hold, holdMaxMs: 50 }).complete(request());
      expect(result.text).toMatch(/^mock:/);
      expect(existsSync(`${hold}.held`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('does not call upstream when the caller has already aborted, and does not record that as a timeout', async () => {
    const fetchSpy = stubFetch(() => json({ content: [{ text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const provider = upstream();

    const error = (await provider.complete(request({ signal: AbortSignal.abort() })).catch((err: unknown) => err)) as ProviderError;

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toBe('Upstream call cancelled');
    expect(error.retryable).toBe(false);
    // Never attempted, so the cancellation cannot be the first consecutive failure.
    expect(provider.health()).toMatchObject({ healthy: false, reason: PROVIDER_UNPROBED_REASON });
  });

  it('does not let already-aborted callers push a live provider over the outage threshold', async () => {
    stubFetch(() => json({ content: [{ text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const provider = upstream();
    await provider.complete(request());
    expect(provider.health().healthy).toBe(true);

    const signal = AbortSignal.abort();
    for (let i = 0; i < 3; i++) {
      const error = (await provider.complete(request({ signal })).catch((err: unknown) => err)) as ProviderError;
      expect(error.message).toBe('Upstream call cancelled');
      expect(error.retryable).toBe(false);
    }

    expect(provider.health().healthy).toBe(true);
    expect(provider.health().reason).toBeUndefined();
  });

  it('treats an in-flight caller abort as a cancellation, not an upstream timeout', async () => {
    stubFetch(() => json({ content: [{ text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const provider = upstream({ timeoutMs: 60_000 });
    await provider.complete(request());

    let caller: AbortController | undefined;
    stubFetch((_url, init) => {
      caller?.abort();
      return abortedFetch(init.signal);
    });

    for (let i = 0; i < 3; i++) {
      caller = new AbortController();
      const error = (await provider.complete(request({ signal: caller.signal })).catch((err: unknown) => err)) as ProviderError;
      expect(caller.signal.aborted).toBe(true);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.message).toBe('Upstream call cancelled');
      expect(error.retryable).toBe(false);
    }

    expect(provider.health().healthy).toBe(true);
    expect(provider.health().reason).toBeUndefined();
  });

  it('records a timer timeout as a retryable upstream failure while the caller signal is still live', async () => {
    const caller = new AbortController();
    stubFetch((_url, init) => abortedFetch(init.signal));
    const provider = upstream({ timeoutMs: 15 });

    const errors: ProviderError[] = [];
    for (let i = 0; i < 3; i++) {
      errors.push((await provider.complete(request({ signal: caller.signal })).catch((err: unknown) => err)) as ProviderError);
    }

    expect(caller.signal.aborted).toBe(false);
    for (const error of errors) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.message).toBe('Upstream call timed out');
      expect(error.retryable).toBe(true);
    }
    expect(provider.health().healthy).toBe(false);
    expect(provider.health().reason).toBe('upstream timed out');
  });

  it('records a 429 and a 5xx as consecutive upstream failures', async () => {
    const limited = upstream();
    stubFetch(() => new Response('nope', { status: 429 }));
    for (let i = 0; i < 2; i++) {
      const error = (await limited.complete(request()).catch((err: unknown) => err)) as ProviderError;
      expect(error.retryable).toBe(true);
      expect(error.status).toBe(429);
      expect(limited.health().healthy).toBe(true);
    }
    await limited.complete(request()).catch(() => undefined);
    expect(limited.health().healthy).toBe(false);
    expect(limited.health().reason).toBe('upstream status 429');

    const broken = upstream();
    stubFetch(() => new Response('nope', { status: 503 }));
    for (let i = 0; i < 2; i++) {
      const error = (await broken.complete(request()).catch((err: unknown) => err)) as ProviderError;
      expect(error.retryable).toBe(true);
      expect(error.status).toBe(503);
      expect(broken.health().healthy).toBe(true);
    }
    await broken.complete(request()).catch(() => undefined);
    expect(broken.health().healthy).toBe(false);
    expect(broken.health().reason).toBe('upstream status 503');
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

    const chunks: StreamChunk[] = [];
    for await (const chunk of upstream().stream(request())) chunks.push(chunk);

    expect(
      chunks
        .filter((chunk) => !chunk.done)
        .map((chunk) => chunk.delta)
        .join(''),
    ).toBe('Hello there');
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
        { type: 'message_stop' },
      ]),
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of upstream().stream(request())) chunks.push(chunk);

    expect(
      chunks
        .filter((chunk) => !chunk.done)
        .map((chunk) => chunk.delta)
        .join(''),
    ).toBe('Hello there');
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

    const chunks: StreamChunk[] = [];
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
        { type: 'message_stop' },
      ]),
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of upstream().stream(request({ temperature: 0.2, stopSequences: ['END', 'STOP'] }))) {
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

    const bareChunks: StreamChunk[] = [];
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

  it('reads a final stop frame that arrives without a trailing blank line', async () => {
    const start = dataFrame({ type: 'message_start', usage: { input_tokens: 25 } });
    const delta = dataFrame({ type: 'content_block_delta', delta: { text: 'Hello' } });
    const usage = dataFrame({
      type: 'message_delta',
      usage: { output_tokens: 4 },
      delta: { stop_reason: 'end_turn' },
    });
    stubFetch(() => sseRaw(`${start}\n\n${delta}\n\n${usage}\n\n${dataFrame({ type: 'message_stop' })}`));

    const chunks: StreamChunk[] = [];
    for await (const chunk of upstream().stream(request())) chunks.push(chunk);

    expect(
      chunks
        .filter((chunk) => !chunk.done)
        .map((chunk) => chunk.delta)
        .join(''),
    ).toBe('Hello');
    expect(chunks.filter((chunk) => chunk.done)).toEqual([
      { delta: '', done: true, usage: { inputTokens: 25, outputTokens: 4 }, stopReason: 'end' },
    ]);
  });

  it('reads a CRLF-delimited stream, including a final stop frame with no trailing blank line', async () => {
    const start = dataFrame({ type: 'message_start', usage: { input_tokens: 11 } });
    const delta = dataFrame({ type: 'content_block_delta', delta: { text: 'CRLF' } });
    const usage = dataFrame({
      type: 'message_delta',
      usage: { output_tokens: 2 },
      delta: { stop_reason: 'end_turn' },
    });
    stubFetch(() => sseRaw(`${start}\r\n\r\n${delta}\r\n\r\n${usage}\r\n\r\n${dataFrame({ type: 'message_stop' })}`));

    const chunks: StreamChunk[] = [];
    for await (const chunk of upstream().stream(request())) chunks.push(chunk);

    expect(
      chunks
        .filter((chunk) => !chunk.done)
        .map((chunk) => chunk.delta)
        .join(''),
    ).toBe('CRLF');
    expect(chunks.filter((chunk) => chunk.done)).toEqual([
      { delta: '', done: true, usage: { inputTokens: 11, outputTokens: 2 }, stopReason: 'end' },
    ]);
  });

  it('reads an LF-delimited event that ends with a blank line', async () => {
    stubFetch(() =>
      sse([
        { type: 'message_start', usage: { input_tokens: 8 } },
        { type: 'content_block_delta', delta: { text: 'LF' } },
        { type: 'message_delta', usage: { output_tokens: 1 }, delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]),
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of upstream().stream(request())) chunks.push(chunk);

    expect(
      chunks
        .filter((chunk) => !chunk.done)
        .map((chunk) => chunk.delta)
        .join(''),
    ).toBe('LF');
    expect(chunks.filter((chunk) => chunk.done)).toEqual([
      { delta: '', done: true, usage: { inputTokens: 8, outputTokens: 1 }, stopReason: 'end' },
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

describe('upstream terminal usage over actual HTTP', () => {
  const start = { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } };
  const text = { type: 'content_block_delta', delta: { text: 'generated' } };
  const final = { type: 'message_delta', usage: { input_tokens: 200, output_tokens: 15 }, delta: { stop_reason: 'end_turn' } };
  const stop = { type: 'message_stop' };
  const error = { type: 'error', error: { type: 'overloaded_error', message: 'fixture provider failure' } };
  const frame = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`;
  const failures: readonly [string, readonly unknown[]][] = [
    ['provisional start then EOF', [start]],
    ['provisional start then text then EOF', [start, text]],
    ['provisional zero then text then EOF', [{ ...start, message: { usage: { input_tokens: 100, output_tokens: 0 } } }, text]],
    ['error before text', [start, error]],
    ['error after text', [start, text, error]],
    ['error after final usage', [start, text, final, error, stop]],
    ['final usage without message_stop', [start, text, final]],
    ['message_stop without final usage', [start, text, stop]],
    ['malformed final frame after valid usage', [start, text, final, 'data: {broken\r\n\r\n', stop]],
    ['invalid later cumulative usage', [start, text, final, { ...final, usage: { output_tokens: -1 } }, stop]],
    ['null later cumulative usage', [start, text, final, { ...final, usage: null }, stop]],
    ['missing later cumulative usage', [start, text, final, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, stop]],
  ];

  async function consume(events: readonly unknown[]) {
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* drain the native request */
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map((event) => (typeof event === 'string' ? event : frame(event))).join(''));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not bind');
      const provider = upstream({ baseUrl: `http://127.0.0.1:${address.port}` });
      const chunks: StreamChunk[] = [];
      let error: unknown;
      try {
        for await (const chunk of provider.stream(request())) chunks.push(chunk);
      } catch (caught) {
        error = caught;
      }
      return { chunks, error };
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }

  it.each(failures)('refuses %s without any successful done frame', async (_name, events) => {
    const result = await consume(events);
    expect(result.error).toBeInstanceOf(ProviderError);
    // Invalid numeric counts retain readUsage's existing terminal refusal;
    // missing/errored transport evidence remains a retryable stream failure.
    expect(result.error).toMatchObject({ retryable: _name !== 'invalid later cumulative usage' });
    expect(result.chunks.some((chunk) => chunk.done || chunk.usage !== undefined)).toBe(false);
  });

  it('reports only the latest final cumulative input/output, after message_stop', async () => {
    const result = await consume([start, text, { ...final, usage: { output_tokens: 7 } }, final, stop, stop]);
    expect(result.error).toBeUndefined();
    expect(result.chunks.filter((chunk) => chunk.done)).toEqual([
      { delta: '', done: true, usage: { inputTokens: 200, outputTokens: 15 }, stopReason: 'end' },
    ]);
  });

  it('preserves explicitly reported final zero without accepting provisional zero', async () => {
    const result = await consume([start, { ...final, usage: { output_tokens: 0 } }, stop]);
    expect(result.error).toBeUndefined();
    expect(result.chunks.filter((chunk) => chunk.done)).toEqual([
      { delta: '', done: true, usage: { inputTokens: 100, outputTokens: 0 }, stopReason: 'end' },
    ]);
  });
});
