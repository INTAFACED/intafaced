import { createHash } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { ProviderError } from '../errors.js';
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  EmbedRequest,
  EmbedResult,
  ModelProvider,
  ProviderCapability,
  ProviderHealth,
  StreamChunk,
  TokenUsage,
} from './provider.js';

/**
 * Deterministic in-process provider.
 *
 * This is not a stub that returns "ok". It is the executable specification of
 * what the gateway is allowed to assume about a provider, and the tests for
 * routing, metering and guardrails all run against it:
 *
 *   · Same request in → byte-identical text and token counts out. A metering
 *     test asserting an exact `Amount` is only meaningful if the token counts
 *     it prices are reproducible.
 *   · Token counts are a pure function of the request, so a test can compute
 *     the expected bill independently of the code under test rather than
 *     asserting against whatever the implementation happened to produce.
 *   · Failures are injectable and typed, so "the engine went down mid-session"
 *     is a test case rather than a thought experiment.
 *
 * It ships in `src`, not in a test folder, because `AGENTS_PROVIDER_ID=mock` is
 * the correct default for local development: a developer running the fleet
 * should not need an upstream credential, and should not be able to spend real
 * money by starting the service.
 */

export interface MockProviderOptions {
  readonly id?: string;
  /** Fail every call with this error until cleared. Simulates an outage. */
  readonly failWith?: ProviderError;
  /** Fail only the first N calls, then recover. Simulates a transient blip. */
  readonly failFirst?: number;
  readonly capabilities?: readonly ProviderCapability[];
  readonly latencyMs?: number;
  /**
   * How long each answer takes, in milliseconds. Zero or absent answers at once. A local test stack sets it so that
   * two runs started together are both in flight at the same moment, as they would be against a real engine.
   */
  readonly answerDelayMs?: number;
  /**
   * TEST stand-in control: while this file exists, a completion parks at the engine's door, before it answers, and
   * writes `<holdFile>.held` so a test can see it is parked. Removing the file lets it answer. A test stack sets it so a
   * journey can read the service's own record of a run while the engine has not answered yet.
   */
  readonly holdFile?: string;
  /** How long a parked completion waits before it answers anyway. */
  readonly holdMaxMs?: number;
}

/**
 * Token accounting for the mock.
 *
 * Four characters per token is the conventional rough ratio and it does not
 * matter that it is rough — what matters is that it is FIXED, so a test can
 * predict the count. Every real adapter reports the upstream's own counts.
 */
const CHARS_PER_TOKEN = 4;

export function mockInputTokens(request: CompletionRequest): number {
  const system = request.system ?? '';
  const body = request.messages.map((m: ChatMessage) => `${m.role}:${m.content}`).join('\n');
  return Math.ceil((system.length + body.length) / CHARS_PER_TOKEN);
}

export function mockOutputTokens(request: CompletionRequest): number {
  // Deterministic pseudo-length in [1, maxOutputTokens], derived from the
  // request digest so it varies across requests but never across runs.
  const digest = requestDigest(request);
  const nibble = parseInt(digest.slice(0, 4), 16);
  return 1 + (nibble % Math.max(1, request.maxOutputTokens));
}

export function mockUsage(request: CompletionRequest): TokenUsage {
  return { inputTokens: mockInputTokens(request), outputTokens: mockOutputTokens(request) };
}

/** L3 — mock usage board card (deterministic counts only). */
export function mockUsageBoardCard(request: CompletionRequest): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
} {
  const u = mockUsage(request);
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.inputTokens + u.outputTokens,
  };
}

/** L3 — status line. */
export function mockUsageStatusLine(request: CompletionRequest): string {
  const c = mockUsageBoardCard(request);
  return `in=${c.inputTokens} out=${c.outputTokens} total=${c.totalTokens}`;
}

/** L3 — parse status. Invalid → null. */
export function parseMockUsageStatusLine(line: string): { readonly in: number; readonly out: number; readonly total: number } | null {
  const m = line.trim().match(/^in=(\d+) out=(\d+) total=(\d+)$/);
  if (!m) return null;
  return { in: Number(m[1]), out: Number(m[2]), total: Number(m[3]) };
}

/** L3 — true when status matches usage. */
export function mockUsageStatusLineMatches(request: CompletionRequest): boolean {
  const p = parseMockUsageStatusLine(mockUsageStatusLine(request));
  if (!p) return false;
  const c = mockUsageBoardCard(request);
  return p.in === c.inputTokens && p.out === c.outputTokens && p.total === c.totalTokens;
}

/** L3 — true when total = in + out. */
export function mockUsageStatusLineConsistent(line: string): boolean {
  const p = parseMockUsageStatusLine(line);
  if (!p) return false;
  return p.total === p.in + p.out;
}

/** L3 — export header. */
export function mockUsageExportHeader(): string {
  return 'inputTokens,outputTokens,totalTokens';
}

/** L3 — export line. */
export function mockUsageExportLine(request: CompletionRequest): string {
  const c = mockUsageBoardCard(request);
  return `${c.inputTokens},${c.outputTokens},${c.totalTokens}`;
}

/** L3 — full export. */
export function mockUsageExportText(request: CompletionRequest): string {
  return [mockUsageExportHeader(), mockUsageExportLine(request)].join('\n');
}

/** L3 — true when input tokens are within [min,max]. Invalid → false. */
export function mockInputTokensInRange(request: CompletionRequest, min: number, max: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return false;
  const n = mockInputTokens(request);
  return n >= min && n <= max;
}

/** L3 — true when two requests produce identical usage (determinism). */
export function mockUsageDeterministic(a: CompletionRequest, b: CompletionRequest): boolean {
  const ua = mockUsage(a);
  const ub = mockUsage(b);
  return ua.inputTokens === ub.inputTokens && ua.outputTokens === ub.outputTokens;
}

function requestDigest(request: CompletionRequest): string {
  const canonical = JSON.stringify({
    model: request.model,
    system: request.system ?? null,
    messages: request.messages.map((m) => [m.role, m.content]),
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature ?? null,
    stopSequences: request.stopSequences ?? [],
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export class MockModelProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: readonly ProviderCapability[];

  private calls = 0;
  private failures = 0;
  private lastUpdate = new Date(0);
  private lastLatencyMs: number;
  private failWith: ProviderError | undefined;
  private failFirst: number;
  private readonly answerDelayMs: number;
  private readonly holdFile: string | undefined;
  private readonly holdMaxMs: number;

  constructor(options: MockProviderOptions = {}) {
    this.id = options.id ?? 'mock';
    this.capabilities = options.capabilities ?? ['complete', 'stream', 'embed'];
    this.lastLatencyMs = options.latencyMs ?? 1;
    this.failWith = options.failWith;
    this.failFirst = options.failFirst ?? 0;
    this.answerDelayMs = options.answerDelayMs ?? 0;
    this.holdFile = options.holdFile;
    this.holdMaxMs = options.holdMaxMs ?? 60_000;
  }

  /** Test control: start failing. */
  breakWith(error: ProviderError): void {
    this.failWith = error;
  }

  /** Test control: stop failing. */
  repair(): void {
    this.failWith = undefined;
    this.failFirst = 0;
  }

  /** How many times the gateway actually reached the provider. */
  get callCount(): number {
    return this.calls;
  }

  get failureCount(): number {
    return this.failures;
  }

  health(): ProviderHealth {
    // A provider that has never been called is healthy but stale, exactly like
    // a venue with no ticks yet — `isUsable` treats those the same way.
    if (this.failWith) {
      return { healthy: false, latencyMs: this.lastLatencyMs, lastUpdate: this.lastUpdate, reason: this.failWith.message };
    }
    return { healthy: true, latencyMs: this.lastLatencyMs, lastUpdate: this.calls === 0 ? new Date() : this.lastUpdate };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls++;
    if (this.answerDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.answerDelayMs));
    // Freshness is recorded before the failure branch: a provider that answered
    // with an error still answered. That is what separates a transient blip
    // (`failFirst` — the next call is routed normally) from an outage
    // (`failWith` — `health()` reports unhealthy and the gateway stops routing).
    this.lastUpdate = new Date();
    this.throwIfBroken();
    await this.parkWhileHeld();

    const usage = mockUsage(request);
    const digest = requestDigest(request);

    return {
      providerId: this.id,
      model: request.model,
      // Echoing the digest keeps the output deterministic and makes it obvious
      // in a log that this text came from the mock, not from an engine.
      text: `mock:${request.model}:${digest.slice(0, 16)}`,
      usage,
      stopReason: usage.outputTokens >= request.maxOutputTokens ? 'max_tokens' : 'end',
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const result = await this.complete(request);
    // Chunked at a fixed width so the sequence of deltas is reproducible too.
    for (let i = 0; i < result.text.length; i += 8) {
      yield { delta: result.text.slice(i, i + 8), done: false };
    }
    yield { delta: '', done: true, usage: result.usage, stopReason: result.stopReason };
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    this.calls++;
    this.lastUpdate = new Date();
    this.throwIfBroken();

    const vectors = request.inputs.map((input) => {
      const digest = createHash('sha256').update(`${request.model}:${input}`).digest();
      // 16 dimensions in [-1, 1). Small, deterministic, and enough to assert on.
      return Array.from({ length: 16 }, (_, i) => ((digest[i] ?? 0) - 128) / 128);
    });

    const inputTokens = request.inputs.reduce((acc, s) => acc + Math.ceil(s.length / CHARS_PER_TOKEN), 0);
    return { providerId: this.id, model: request.model, vectors, usage: { inputTokens, outputTokens: 0 } };
  }

  /** Waits while the hold file exists (see `holdFile`), marking itself parked; answers anyway after `holdMaxMs`. */
  private async parkWhileHeld(): Promise<void> {
    const hold = this.holdFile;
    if (!hold || !existsSync(hold)) return;
    const marker = `${hold}.held`;
    writeFileSync(marker, new Date().toISOString());
    try {
      const until = Date.now() + this.holdMaxMs;
      while (existsSync(hold) && Date.now() < until) await sleep(25);
    } finally {
      rmSync(marker, { force: true });
    }
  }

  private throwIfBroken(): void {
    if (this.failWith) {
      this.failures++;
      throw this.failWith;
    }
    if (this.failFirst > 0) {
      this.failFirst--;
      this.failures++;
      throw new ProviderError('Injected transient failure', this.id, true, 503);
    }
  }
}
