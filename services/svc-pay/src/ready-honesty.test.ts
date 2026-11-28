/**
 * GET /ready must not sell configured PAY_CRYPTO_CHAIN_ID / RPC as a live chain.
 * chain.description is a log line. This process does not eth_chainId on /ready.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ChainNotConfiguredError, UnconfiguredChain } from './rails/chain-port.js';
import { PAY_CHAIN_NOT_CONFIGURED, PAY_CHAIN_SANDBOX, PAY_CHAIN_UNPROBED, payChainReadyHonesty } from './ready-honesty.js';

describe('pay ready honesty — configured is not a live chain', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  it('live posture is configured + unprobed; no chainId, no rpc, no 31337', () => {
    const chain = payChainReadyHonesty('live');
    expect(chain).toEqual({
      status: 'configured',
      code: PAY_CHAIN_UNPROBED,
      observedChainId: null,
    });
    expect(chain).not.toHaveProperty('chainId');
    expect(JSON.stringify(chain)).not.toMatch(/31337/);
    expect(JSON.stringify(chain)).not.toMatch(/rpc/i);
    expect(JSON.stringify(chain)).not.toMatch(/live EVM/);
  });

  it('sandbox and absent stay named, never live', () => {
    expect(payChainReadyHonesty('sandbox')).toEqual({
      status: 'sandbox',
      code: PAY_CHAIN_SANDBOX,
      observedChainId: null,
    });
    expect(payChainReadyHonesty('absent')).toEqual({
      status: 'absent',
      code: PAY_CHAIN_NOT_CONFIGURED,
      observedChainId: null,
    });
  });

  it('GET /ready as index.ts mounts does not echo 31337 or rpc', async () => {
    const app = Fastify({ logger: false });
    app.get('/ready', async () => ({
      ready: true as const,
      chain: payChainReadyHonesty('live'),
    }));
    await app.ready();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ready: boolean; chain: unknown; chainId?: unknown };
    expect(body.ready).toBe(true);
    expect(body.chainId).toBeUndefined();
    expect(body.chain).toEqual({
      status: 'configured',
      code: PAY_CHAIN_UNPROBED,
      observedChainId: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/31337/);
    expect(JSON.stringify(body)).not.toMatch(/live EVM/);
  });

  it('the absent chain refuses with the code /ready names, pay.chain_not_configured', async () => {
    const chain = new UnconfiguredChain();
    expect(chain.posture).toBe('absent');
    await expect(chain.acceptanceAddress()).rejects.toBeInstanceOf(ChainNotConfiguredError);
    await expect(chain.acceptanceAddress()).rejects.toMatchObject({ code: PAY_CHAIN_NOT_CONFIGURED });
    expect(PAY_CHAIN_NOT_CONFIGURED).toBe('pay.chain_not_configured');
    expect(payChainReadyHonesty('absent')).toMatchObject({ code: PAY_CHAIN_NOT_CONFIGURED });
  });
});
