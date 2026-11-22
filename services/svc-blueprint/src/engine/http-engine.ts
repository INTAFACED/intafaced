import { blueprintProfileSchema } from '@intafaced/contracts/blueprint';
import { z } from 'zod';
import {
  EngineProtocolError,
  EngineUnavailableError,
  type BlueprintRequest,
  type EngineCapability,
  type EngineHealth,
  type EngineProfileResult,
  type NeuralEngineClient,
} from './neural-engine.js';

/**
 * HttpNeuralEngineClient — the real adapter.
 *
 * The engine is an external deployment reached at `BLUEPRINT_ENGINE_URL`. This
 * class is the entire surface of that dependency: one POST, one schema check,
 * one error taxonomy. Everything else in the service talks to
 * `NeuralEngineClient` and cannot tell this apart from the mock.
 *
 * Three things it deliberately does NOT do:
 *
 *  · **It does not log the request body.** The body carries the session's
 *    answers and, when supplied, birth data. §10 puts that in the same class as
 *    a KYC document. The only things that reach a log line here are a status
 *    code and a duration.
 *
 *  · **It does not retry on its own.** A slow engine is the main risk to the
 *    <3-minute onboarding target (§7.2); silently turning one 20-second timeout
 *    into three is how a budget is missed. Retry policy belongs to the caller,
 *    which knows whether the user is still on the page.
 *
 *  · **It does not fall back to a default profile.** A fabricated profile is
 *    indistinguishable downstream from a real one and would place a real person
 *    in a crew on the strength of a timeout. Failure is loud.
 */

const engineResponseSchema = z.object({
  engineVersion: z.string().min(1),
  profile: blueprintProfileSchema,
});

export interface HttpNeuralEngineOptions {
  /** `BLUEPRINT_ENGINE_URL`. */
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  /** Sent as `authorization: Bearer …` when present. Never logged. */
  readonly apiKey?: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `Date.now`. Never used for placement. */
  readonly now?: () => number;
}

export class HttpNeuralEngineClient implements NeuralEngineClient {
  readonly id = 'neural-engine';
  readonly capabilities: readonly EngineCapability[] = ['profile'];

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  /**
   * Health is observed, not polled: every call updates it. A service that has
   * never called the engine reports unhealthy rather than optimistic, so
   * `isUsable()` cannot green-light an engine nobody has spoken to.
   */
  private lastHealth: EngineHealth;

  constructor(private readonly options: HttpNeuralEngineOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.lastHealth = {
      healthy: false,
      latencyMs: 0,
      lastUpdate: new Date(0),
      reason: 'no call made yet',
    };
  }

  health(): EngineHealth {
    return this.lastHealth;
  }

  async profile(request: BlueprintRequest): Promise<EngineProfileResult> {
    const startedAt = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/profile`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-request-id': request.requestId,
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          locale: request.locale,
          responses: request.responses,
          ...(request.birthData ? { birthData: request.birthData } : {}),
        }),
      });
    } catch (err) {
      this.markUnhealthy(startedAt, controller.signal.aborted ? 'timeout' : 'transport error');
      throw new EngineUnavailableError(
        controller.signal.aborted ? `Neural Engine timed out after ${this.timeoutMs}ms` : 'Neural Engine is unreachable',
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = this.now() - startedAt;

    if (!response.ok) {
      this.markUnhealthy(startedAt, `http ${response.status}`);
      // The body may echo the session back. It is not read and not logged.
      throw new EngineUnavailableError(`Neural Engine returned ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      this.lastHealth = { healthy: true, latencyMs, lastUpdate: new Date(this.now()) };
      throw new EngineProtocolError('Neural Engine returned a body that is not JSON', [String(err)]);
    }

    const parsed = engineResponseSchema.safeParse(body);
    if (!parsed.success) {
      // The engine is up — it answered — so health stays true. What failed is
      // the contract, and that is a different alarm with a different owner.
      this.lastHealth = { healthy: true, latencyMs, lastUpdate: new Date(this.now()) };
      throw new EngineProtocolError(
        'Neural Engine returned a profile this service cannot store',
        // Paths only, never values: an issue message can quote the offending
        // input, and the offending input is the user's session.
        parsed.error.issues.map((i) => i.path.join('.') || '(root)'),
      );
    }

    this.lastHealth = { healthy: true, latencyMs, lastUpdate: new Date(this.now()) };

    return { engineVersion: parsed.data.engineVersion, profile: parsed.data.profile, latencyMs };
  }

  private markUnhealthy(startedAt: number, reason: string): void {
    this.lastHealth = { healthy: false, latencyMs: this.now() - startedAt, lastUpdate: new Date(this.now()), reason };
  }
}
