import { ProviderError } from '../errors.js';
import {
  PROVIDER_UNPROBED_REASON,
  type CompletionRequest,
  type CompletionResult,
  type EmbedRequest,
  type EmbedResult,
  type ModelProvider,
  type ProviderCapability,
  type ProviderHealth,
  type StopReason,
  type StreamChunk,
  type TokenUsage,
} from './provider.js';

/**
 * The real adapter: an HTTP model service speaking the messages wire protocol.
 *
 * ── Why nothing in this file names a vendor ─────────────────────────────────
 *
 * §1's AI-layer row names one vendor's API as the first target and then says
 * "providers swappable per Doctrine 5"; Doctrine §0.7 says no third-party
 * system name ships to a user. Those two are only reconcilable one way, and it
 * is the way that was going to be right anyway: **the provider's identity is
 * deployment configuration, not source.**
 *
 * Base URL, request paths, the auth header name, any protocol-version headers,
 * and the map from routing-table model aliases to concrete upstream model ids
 * all arrive through `UpstreamProviderConfig` — which is populated from env in
 * `env.ts` and from vault in production (§9). This file contains the *shape* of
 * the conversation and nothing about who is on the other end.
 *
 * The alternative — hardcoding a hostname and a model id and then adding this
 * service to the brand-scan allowlist — would have traded a real architectural
 * property for a lint exemption. Swapping providers would then be a code change
 * in a service that §8.2 exists to make provider-agnostic.
 *
 * ── Wire protocol ───────────────────────────────────────────────────────────
 *
 * Request:  { model, system?, messages: [{role, content}], max_tokens, … }
 * Response: { content: [{type:'text', text}], stop_reason, usage: {…} }
 *
 * Usage keys are read tolerantly (`input_tokens`/`output_tokens` or
 * `prompt_tokens`/`completion_tokens`) because that is the one field where
 * upstreams genuinely differ and where guessing wrong silently mis-meters every
 * call. If neither pair is present the call FAILS rather than defaulting to
 * zero: a completion we cannot price is a completion we must not bill for, and
 * silently billing zero would hide the fault for as long as it lasted.
 */

export interface UpstreamProviderConfig {
  readonly id: string;
  /** e.g. https://engine.internal — no trailing slash required. */
  readonly baseUrl: string;
  /** Secret. Read from env/vault, never logged, never placed on a span. */
  readonly apiKey: string;
  /** Header the key travels in. Default `x-api-key`. */
  readonly authHeader?: string;
  /** Bearer-style prefix, when the upstream wants one (e.g. 'Bearer '). */
  readonly authPrefix?: string;
  /** Additional static headers — protocol version pins, tenant ids, and so on. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly completionsPath?: string;
  /** Only when set does this provider declare the `embed` capability. */
  readonly embeddingsPath?: string;
  /**
   * Routing-table alias → concrete upstream model id. An alias with no entry is
   * passed through unchanged, so a deployment can put real ids in the routing
   * table if it prefers.
   */
  readonly models?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly supportsStreaming?: boolean;
}

interface UpstreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface UpstreamResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: UpstreamUsage;
}

const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  end_turn: 'end',
  stop: 'end',
  stop_sequence: 'stop_sequence',
  max_tokens: 'max_tokens',
  length: 'max_tokens',
  refusal: 'refusal',
};

export class UpstreamModelProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: readonly ProviderCapability[];

  private readonly baseUrl: string;
  private readonly completionsPath: string;
  private readonly embeddingsPath: string | undefined;
  private readonly models: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;

  /**
   * Observed, not assumed. A constructed client has never spoken to upstream —
   * `health()` must not look live off `consecutiveFailures = 0` and `new Date()`.
   */
  private lastUpdate = new Date(0);
  private lastLatencyMs = 0;
  private lastFailure: string | undefined;
  private consecutiveFailures = 0;
  private everAttempted = false;

  /**
   * Three consecutive failures marks the provider unhealthy.
   *
   * One failure is noise — a dropped connection, a single 429. Three in a row
   * is a pattern, and `isUsable()` should stop routing to it before every
   * queued session pays a timeout to discover the same thing.
   *
   * Zero attempts is not "zero failures": unprobed stays unhealthy until a
   * real HTTP call is observed (same shape as svc-blueprint's HTTP engine).
   */
  private static readonly UNHEALTHY_AFTER = 3;

  constructor(private readonly config: UpstreamProviderConfig) {
    this.id = config.id;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.completionsPath = config.completionsPath ?? '/v1/messages';
    this.embeddingsPath = config.embeddingsPath;
    this.models = config.models ?? {};
    this.timeoutMs = config.timeoutMs ?? 60_000;

    const caps: ProviderCapability[] = ['complete'];
    if (config.supportsStreaming !== false) caps.push('stream');
    if (this.embeddingsPath) caps.push('embed');
    this.capabilities = caps;
  }

  health(): ProviderHealth {
    if (!this.everAttempted) {
      return {
        healthy: false,
        latencyMs: this.lastLatencyMs,
        lastUpdate: this.lastUpdate,
        reason: PROVIDER_UNPROBED_REASON,
      };
    }
    const healthy = this.consecutiveFailures < UpstreamModelProvider.UNHEALTHY_AFTER;
    return {
      healthy,
      latencyMs: this.lastLatencyMs,
      lastUpdate: this.lastUpdate,
      // Operator-facing. Surfaces render `agents.error.engine_unavailable`.
      ...(healthy ? {} : { reason: this.lastFailure ?? 'consecutive upstream failures' }),
    };
  }

  /** Resolve a routing-table alias to the id this upstream actually accepts. */
  resolveModel(alias: string): string {
    return this.models[alias] ?? alias;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = this.resolveModel(request.model);
    const body = {
      model,
      ...(request.system ? { system: request.system } : {}),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: request.maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.stopSequences?.length ? { stop_sequences: [...request.stopSequences] } : {}),
    };

    const parsed = (await this.call(this.completionsPath, body, request.signal)) as UpstreamResponse;

    const text = (parsed.content ?? [])
      .filter((block) => (block.type ?? 'text') === 'text')
      .map((block) => block.text ?? '')
      .join('');

    return {
      providerId: this.id,
      // The ALIAS goes back out, not the concrete id. Everything downstream —
      // audit rows, usage records, span attributes — records what the routing
      // table asked for, which keeps the vendor's id inside this adapter.
      model: request.model,
      text,
      usage: readUsage(parsed.usage, this.id),
      stopReason: STOP_REASONS[parsed.stop_reason ?? ''] ?? 'end',
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const model = this.resolveModel(request.model);
    const body = {
      model,
      ...(request.system ? { system: request.system } : {}),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: request.maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.stopSequences?.length ? { stop_sequences: [...request.stopSequences] } : {}),
      stream: true,
    };

    const response = await this.send(this.completionsPath, body, request.signal, 'text/event-stream');
    if (!response.body) throw new ProviderError('Upstream returned no stream body', this.id, true, response.status);

    // Input and output arrive on different events. message_start carries the
    // input count (on the event, or under message.usage). message_delta carries
    // the output count. Hold each side until both are present. A missing output
    // count is a refusal — do not fill it with 0. Embeddings still pass
    // partial:true; a completion stream does not.
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: StopReason | undefined;

    const absorbUsage = (raw: unknown): void => {
      if (!raw || typeof raw !== 'object') return;
      const usage = raw as UpstreamUsage;
      const input = usage.input_tokens ?? usage.prompt_tokens;
      const output = usage.output_tokens ?? usage.completion_tokens;
      if (input !== undefined) inputTokens = input;
      if (output !== undefined) outputTokens = output;
    };

    for await (const event of readServerSentEvents(response.body)) {
      const type = typeof event.type === 'string' ? event.type : '';

      if (type === 'content_block_delta') {
        const delta = (event.delta ?? {}) as { text?: string };
        if (delta.text) yield { delta: delta.text, done: false };
        continue;
      }

      if (type === 'message_start') {
        absorbUsage(event.usage);
        const message = event.message;
        if (message && typeof message === 'object') absorbUsage((message as { usage?: unknown }).usage);
      }

      if (type === 'message_delta' || type === 'message_stop') {
        absorbUsage(event.usage);
        const reason = (event.delta as { stop_reason?: string } | undefined)?.stop_reason;
        if (reason) stopReason = STOP_REASONS[reason] ?? 'end';
      }
    }

    // A stream that never reported both counts cannot be metered. Same rule as
    // the non-streaming path: fail loudly rather than bill zero.
    if (inputTokens === undefined || outputTokens === undefined) {
      throw new ProviderError('Upstream stream ended without reporting token usage', this.id, true);
    }

    const usage = readUsage({ input_tokens: inputTokens, output_tokens: outputTokens }, this.id);

    yield { delta: '', done: true, usage, ...(stopReason ? { stopReason } : {}) };
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    if (!this.embeddingsPath) {
      throw new ProviderError('This provider is not configured with an embeddings endpoint', this.id, false);
    }

    const model = this.resolveModel(request.model);
    const parsed = (await this.call(this.embeddingsPath, { model, input: [...request.inputs] }, request.signal)) as {
      data?: Array<{ embedding?: number[] }>;
      usage?: UpstreamUsage;
    };

    return {
      providerId: this.id,
      model: request.model,
      vectors: (parsed.data ?? []).map((d) => d.embedding ?? []),
      usage: readUsage(parsed.usage, this.id, { partial: true }),
    };
  }

  private async call(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.send(path, body, signal, 'application/json');
    try {
      return await response.json();
    } catch (err) {
      this.recordFailure('unparseable upstream response');
      throw new ProviderError('Upstream returned a body that is not JSON', this.id, true, response.status);
    }
  }

  private async send(path: string, body: unknown, signal: AbortSignal | undefined, accept: string): Promise<Response> {
    // A caller who has already cancelled must not hit upstream. That cancellation
    // is not an upstream timeout and must not count toward the outage threshold.
    if (signal?.aborted) {
      throw new ProviderError('Upstream call cancelled', this.id, false);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const started = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept,
          // The key is placed on the request and nowhere else: not on a span,
          // not in a log line, not in an error message (§9 secrets via vault).
          [this.config.authHeader ?? 'x-api-key']: `${this.config.authPrefix ?? ''}${this.config.apiKey}`,
          ...(this.config.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      this.lastLatencyMs = Date.now() - started;

      if (!response.ok) {
        // The upstream's error BODY is deliberately not read into our error:
        // it is the most likely place for a vendor name to arrive, and it would
        // then be one careless `err.message` away from a user's screen.
        const retryable = response.status === 429 || response.status >= 500;
        this.recordFailure(`upstream status ${response.status}`);
        throw new ProviderError(`Upstream rejected the request (status ${response.status})`, this.id, retryable, response.status);
      }

      this.everAttempted = true;
      this.consecutiveFailures = 0;
      this.lastFailure = undefined;
      this.lastUpdate = new Date();
      return response;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      // The caller aborted while the call was in flight. That is a cancellation
      // even if the timer also fired, and it does not count as a failure.
      if (signal?.aborted) {
        throw new ProviderError('Upstream call cancelled', this.id, false);
      }
      this.lastLatencyMs = Date.now() - started;
      const aborted = timedOut || controller.signal.aborted;
      this.recordFailure(aborted ? 'upstream timed out' : 'upstream transport error');
      throw new ProviderError(aborted ? 'Upstream call timed out' : 'Upstream call failed in transport', this.id, true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private recordFailure(reason: string): void {
    this.everAttempted = true;
    this.consecutiveFailures++;
    this.lastFailure = reason;
    this.lastUpdate = new Date();
  }
}

/**
 * Read the upstream's token counts.
 *
 * `partial` allows a response that reports input tokens only (embeddings do
 * not generate). Everything else must report both, because a completion whose
 * output tokens we do not know is a completion we cannot price.
 */
export function readUsage(raw: UpstreamUsage | undefined, providerId: string, options: { partial?: boolean } = {}): TokenUsage {
  const input = raw?.input_tokens ?? raw?.prompt_tokens;
  const output = raw?.output_tokens ?? raw?.completion_tokens ?? (options.partial ? 0 : undefined);

  if (!Number.isInteger(input) || !Number.isInteger(output) || (input as number) < 0 || (output as number) < 0) {
    throw new ProviderError('Upstream did not report usable token counts — refusing to meter a call we cannot price', providerId, false);
  }

  return { inputTokens: input as number, outputTokens: output as number };
}

/** Minimal SSE reader: `data:` lines carrying JSON, blank line terminates an event. */
async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncIterable<Record<string, unknown>> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            yield JSON.parse(payload) as Record<string, unknown>;
          } catch {
            // A malformed frame is skipped rather than killing the stream; the
            // terminal usage frame is what the caller actually needs, and it is
            // validated separately.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
