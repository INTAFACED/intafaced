import { describe, expect, it } from 'vitest';
import { AgentError, ProviderError } from '../errors.js';
import type { ModelProvider, StreamChunk } from '../providers/provider.js';
import { ModelGateway } from './gateway.js';
import { DEFAULT_ROUTING_TABLE } from './routing.js';

/**
 * Stream failures cross the same boundary as complete and embed.
 *
 * A ProviderError becomes AgentError (`agents.provider_unavailable` when
 * retryable, otherwise `agents.provider_failed`). An unexpected throw becomes
 * `agents.provider_failed`. An AgentError already thrown passes through.
 * A failed stream does not grow a usage frame.
 */

const request = { messages: [{ role: 'user' as const, content: 'hi' }] };

function providerWhoseStreamThrows(error: unknown): ModelProvider {
  return {
    id: 'primary',
    capabilities: ['complete', 'stream'],
    health: () => ({ healthy: true, latencyMs: 1, lastUpdate: new Date() }),
    complete: () => Promise.reject(new Error('complete must not run')),
    async *stream(): AsyncIterable<StreamChunk> {
      throw error;
    },
  };
}

async function pull(gateway: ModelGateway): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gateway.stream('navigator.plan', request)) chunks.push(chunk);
  return chunks;
}

describe('ModelGateway.stream provider failures', () => {
  it('turns a ProviderError and an unexpected stream error into the AgentError invoke would throw', async () => {
    const retryable = new ModelGateway(
      [providerWhoseStreamThrows(new ProviderError('outage', 'primary', true, 503))],
      DEFAULT_ROUTING_TABLE,
    );
    await expect(pull(retryable)).rejects.toEqual(
      expect.objectContaining({
        name: 'AgentError',
        message: 'Provider "primary" failed: outage',
        code: 'agents.provider_unavailable',
        userMessageKey: 'agents.error.engine_unavailable',
      }),
    );

    const terminal = new ModelGateway(
      [providerWhoseStreamThrows(new ProviderError('rejected', 'primary', false, 400))],
      DEFAULT_ROUTING_TABLE,
    );
    await expect(pull(terminal)).rejects.toEqual(
      expect.objectContaining({
        name: 'AgentError',
        message: 'Provider "primary" failed: rejected',
        code: 'agents.provider_failed',
        userMessageKey: 'agents.error.engine_unavailable',
      }),
    );

    const unexpected = new ModelGateway([providerWhoseStreamThrows(new Error('socket hangup'))], DEFAULT_ROUTING_TABLE);
    await expect(pull(unexpected)).rejects.toEqual(
      expect.objectContaining({
        name: 'AgentError',
        message: 'Provider "primary" failed unexpectedly',
        code: 'agents.provider_failed',
        userMessageKey: 'agents.error.engine_unavailable',
      }),
    );
  });

  it('passes an AgentError from the stream through unchanged', async () => {
    const decided = new AgentError('already decided', 'agents.refused', 'agents.error.engine_unavailable');
    const gateway = new ModelGateway([providerWhoseStreamThrows(decided)], DEFAULT_ROUTING_TABLE);
    await expect(pull(gateway)).rejects.toBe(decided);
  });

  it('does not invent a usage frame when the stream fails after a delta', async () => {
    const provider: ModelProvider = {
      id: 'primary',
      capabilities: ['complete', 'stream'],
      health: () => ({ healthy: true, latencyMs: 1, lastUpdate: new Date() }),
      complete: () => Promise.reject(new Error('complete must not run')),
      async *stream(): AsyncIterable<StreamChunk> {
        yield { delta: 'hi', done: false };
        throw new ProviderError('outage', 'primary', true, 503);
      },
    };
    const seen: StreamChunk[] = [];
    const gateway = new ModelGateway([provider], DEFAULT_ROUTING_TABLE);
    await expect(
      (async () => {
        for await (const chunk of gateway.stream('navigator.plan', request)) seen.push(chunk);
      })(),
    ).rejects.toMatchObject({
      name: 'AgentError',
      code: 'agents.provider_unavailable',
      message: 'Provider "primary" failed: outage',
    });
    expect(seen).toEqual([{ delta: 'hi', done: false }]);
  });
});

describe('ModelGateway provider freshness', () => {
  const route = DEFAULT_ROUTING_TABLE.routes.find((r) => r.task === 'navigator.plan')!;
  const provider = (health: ReturnType<ModelProvider['health']>): ModelProvider => ({
    id: 'primary',
    capabilities: ['complete'],
    health: () => health,
    complete: () => Promise.reject(new Error('not called here')),
  });

  it('routes to a healthy provider whose last answer is old: the call is the probe, so a quiet minute never deadlocks', () => {
    const quiet = provider({ healthy: true, latencyMs: 1, lastUpdate: new Date(Date.now() - 10 * 60_000) });
    expect(new ModelGateway([quiet], DEFAULT_ROUTING_TABLE).providerFor(route).id).toBe('primary');
  });

  it('still refuses a provider that reports itself unhealthy', () => {
    const down = provider({ healthy: false, latencyMs: 1, lastUpdate: new Date(), reason: 'three failures in a row' });
    expect(() => new ModelGateway([down], DEFAULT_ROUTING_TABLE).providerFor(route)).toThrow(
      expect.objectContaining({ code: 'agents.provider_unavailable' }),
    );
  });
});
