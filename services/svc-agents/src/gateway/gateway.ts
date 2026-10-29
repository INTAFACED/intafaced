import { createHash } from 'node:crypto';
import { AgentError, ProviderError } from '../errors.js';
import {
  isUsable,
  supports,
  PROVIDER_UNPROBED_REASON,
  type CompletionRequest,
  type CompletionResult,
  type EmbedRequest,
  type EmbedResult,
  type ModelProvider,
  type StreamChunk,
} from '../providers/provider.js';
import { recordUsage, withEngineSpan } from '../tracing.js';
import { resolveRoute, type RouteDef, type RoutingTable } from './routing.js';

/**
 * THE MODEL GATEWAY (§8.2 "provider-agnostic completion API").
 *
 * Its entire job is: task in → route resolved → provider found → capability
 * and health checked → provider called. It does not meter, it does not audit,
 * and it does not know what an agent is. `runtime.ts` composes those on top.
 *
 * That separation is deliberate. Metering has to happen around every engine
 * call, so the temptation is to put it here — and then the gateway becomes the
 * one object that knows about sessions, ledger clients, guardrails and
 * providers at once. Keeping it ignorant means the routing and adapter layer
 * can be tested with no database and no ledger, and means a future non-metered
 * caller (an internal batch job, a health probe) can use the gateway without
 * inheriting a billing path.
 *
 * The gateway never names a provider in anything it returns. Callers see the
 * routing task, the logical provider id, and the model alias — all
 * configuration values (Doctrine §0.7).
 */

export interface GatewayCompletion {
  readonly route: RouteDef;
  readonly result: CompletionResult;
}

export interface GatewayEmbedding {
  readonly route: RouteDef;
  readonly result: EmbedResult;
}

/** Everything the caller supplies; `model` and the ceiling come from the route. */
export interface TaskRequest {
  readonly system?: string;
  readonly messages: readonly { role: 'user' | 'assistant'; content: string }[];
  /** Optional tightening of the route's ceiling. It can never loosen it. */
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
  readonly signal?: AbortSignal;
}

export class ModelGateway {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(
    providers: readonly ModelProvider[],
    private table: RoutingTable,
  ) {
    for (const provider of providers) this.providers.set(provider.id, provider);
  }

  /** Hot-swap the table. §8.2 wants routing to be data an operator can change. */
  setRoutingTable(table: RoutingTable): void {
    this.table = table;
  }

  get routingTable(): RoutingTable {
    return this.table;
  }

  /** The adapter registered under this id, or undefined when the route is unwired. Does not throw. */
  registeredProvider(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId);
  }

  routeFor(task: string): RouteDef {
    return resolveRoute(this.table, task);
  }

  /**
   * Resolve the provider for a route and prove it can serve it.
   *
   * Capability and health are checked here, before any request is built, so a
   * misconfigured route fails identically whether or not the provider happens
   * to be reachable — and so a degraded provider costs one map lookup rather
   * than one timeout per queued call.
   */
  providerFor(route: RouteDef, now: Date = new Date()): ModelProvider {
    const provider = this.providers.get(route.providerId);
    if (!provider) {
      throw new AgentError(
        `Route "${route.task}" names provider "${route.providerId}", which is not registered`,
        'agents.route_not_found',
        'agents.error.route_not_found',
        { task: route.task },
      );
    }

    if (!supports(provider, route.capability)) {
      throw new AgentError(
        `Provider "${provider.id}" does not support capability "${route.capability}" required by task "${route.task}"`,
        'agents.capability_unavailable',
        'agents.error.capability_unavailable',
      );
    }

    if (!isUsable(provider, now)) {
      const health = provider.health();
      // Unprobed ≠ outage, and neither is quiet. `/ready` must not stamp live,
      // but the next complete is the probe: a healthy provider whose last answer
      // is merely old (nobody asked for a minute) refreshes on this call.
      // Refusing it would deadlock inference forever after the first idle minute.
      if (!health.healthy && health.reason !== PROVIDER_UNPROBED_REASON) {
        throw new AgentError(
          `Provider "${provider.id}" is not currently usable: ${health.reason ?? 'unhealthy or stale'}`,
          'agents.provider_unavailable',
          'agents.error.engine_unavailable',
        );
      }
    }

    return provider;
  }

  async complete(task: string, request: TaskRequest): Promise<GatewayCompletion> {
    const route = this.routeFor(task);
    const provider = this.providerFor(route);
    const completion = buildRequest(route, request);

    return withEngineSpan(
      'agents.gateway.complete',
      {
        operation: 'complete',
        task,
        providerId: provider.id,
        model: route.model,
        inputDigest: digestOf(completion),
      },
      async (span) => {
        const result = await this.invoke(provider, () => provider.complete(completion));
        recordUsage(span, result.usage);
        span.setAttribute('intafaced.stop_reason', result.stopReason);
        return { route, result };
      },
    );
  }

  async embed(task: string, inputs: readonly string[], signal?: AbortSignal): Promise<GatewayEmbedding> {
    const route = this.routeFor(task);
    const provider = this.providerFor(route);

    if (!provider.embed) {
      throw new AgentError(
        `Provider "${provider.id}" declared the embed capability but does not implement it`,
        'agents.capability_unavailable',
        'agents.error.capability_unavailable',
      );
    }

    const embedRequest: EmbedRequest = { model: route.model, inputs, ...(signal ? { signal } : {}) };

    return withEngineSpan(
      'agents.gateway.embed',
      { operation: 'embed', task, providerId: provider.id, model: route.model },
      async (span) => {
        const embed = provider.embed!;
        const result = await this.invoke(provider, () => embed.call(provider, embedRequest));
        recordUsage(span, result.usage);
        return { route, result };
      },
    );
  }

  /**
   * Streaming.
   *
   * The final chunk carries usage, and the caller must meter from it — which is
   * why `StreamChunk.usage` is on the terminal frame rather than accumulated by
   * the gateway. A stream abandoned by the consumer produced tokens upstream
   * that we will not see, and pretending otherwise by estimating would put a
   * number in the ledger that nothing can reconcile against.
   */
  async *stream(task: string, request: TaskRequest): AsyncIterable<StreamChunk> {
    const route = this.routeFor(task);
    const provider = this.providerFor(route);

    if (!provider.stream) {
      throw new AgentError(
        `Provider "${provider.id}" declared the stream capability but does not implement it`,
        'agents.capability_unavailable',
        'agents.error.capability_unavailable',
      );
    }

    try {
      yield* provider.stream(buildRequest(route, request));
    } catch (err) {
      rethrowAsAgentError(provider, err);
    }
  }

  private async invoke<T>(provider: ModelProvider, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      rethrowAsAgentError(provider, err);
    }
  }
}

/**
 * Re-shaped at the gateway boundary so nothing above this line handles a
 * provider's own error type — and so the user-facing key is decided once,
 * here, rather than by whatever catches it. Complete, embed, and stream share
 * this: a stream must not let ProviderError or an unexpected throw escape.
 */
function rethrowAsAgentError(provider: ModelProvider, err: unknown): never {
  if (err instanceof AgentError) throw err;
  if (err instanceof ProviderError) {
    throw new AgentError(
      `Provider "${provider.id}" failed: ${err.message}`,
      err.retryable ? 'agents.provider_unavailable' : 'agents.provider_failed',
      'agents.error.engine_unavailable',
    );
  }
  throw new AgentError(`Provider "${provider.id}" failed unexpectedly`, 'agents.provider_failed', 'agents.error.engine_unavailable');
}

/**
 * The route's ceiling is a maximum, not a default.
 *
 * A caller may ask for less; asking for more is silently clamped rather than
 * rejected, because a caller that requests a larger budget than its task is
 * configured for is asking for something the operator has already decided
 * against — and failing the call would only tempt someone to raise the route.
 */
function buildRequest(route: RouteDef, request: TaskRequest): CompletionRequest {
  const maxOutputTokens =
    request.maxOutputTokens === undefined ? route.maxOutputTokens : Math.min(request.maxOutputTokens, route.maxOutputTokens);

  return {
    model: route.model,
    ...(request.system ? { system: request.system } : {}),
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    maxOutputTokens,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.stopSequences ? { stopSequences: request.stopSequences } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

/**
 * SHA-256 over the canonical request.
 *
 * Goes on the span and into `agent_actions.input_digest`, so a trace and an
 * audit row can be proven to describe the same call without either of them
 * storing the prompt (§10 PII isolation).
 */
export function digestOf(request: CompletionRequest): string {
  const canonical = JSON.stringify({
    model: request.model,
    system: request.system ?? null,
    messages: request.messages.map((m) => [m.role, m.content]),
    maxOutputTokens: request.maxOutputTokens,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function digestOfText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
