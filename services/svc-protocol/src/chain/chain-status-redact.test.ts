import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { createEdgeContext } from '@intafaced/contracts';
import { AccountRegistry, MemoryAccountStore } from '../accounts/registry.js';
import { createProtocolRouter } from '../router.js';
import { SessionRelay } from '../session/relay.js';
import { DEV_CHAIN_ID } from '../../scripts/dev-chain.js';
import { ProtocolChain } from './client.js';

/**
 * Public chainStatus must not echo PROTOCOL_RPC_URL.
 * Provider keys often sit in the path or the query, so the log keeps scheme+host only.
 */

async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        server.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

const PATH_KEY = 'fk_test_path_key_9f3a';
const QUERY_KEY = 'fk_test_query_key_77c1';
const port = await closedPort();
const rpcUrl = `http://rpcuser:${PATH_KEY}@127.0.0.1:${port}/v2/${PATH_KEY}?apikey=${QUERY_KEY}`;

const FACTORY: Address = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const IMPLEMENTATION: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const ENTRYPOINT: Address = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const ZERO: Address = '0x0000000000000000000000000000000000000000';

const anonymous = () =>
  createEdgeContext({ secret: 'a-chain-status-redact-secret-long-enough', serviceName: 'svc-protocol' })({
    headers: { 'x-intafaced-region': 'DE' },
    id: 'req-redact',
  });

describe('public chainStatus redacts the RPC URL', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns customer text and logs scheme+host when the URL carries a key in the path and the query', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
    });

    const chain = new ProtocolChain({
      chainId: DEV_CHAIN_ID,
      rpcUrl,
      entryPoint: ENTRYPOINT,
      factory: FACTORY,
      implementation: IMPLEMENTATION,
    });
    const caller = createProtocolRouter({
      chain,
      registry: new AccountRegistry(new MemoryAccountStore(), { chainId: DEV_CHAIN_ID, factory: FACTORY, implementation: IMPLEMENTATION }),
      relay: new SessionRelay(chain),
      relayEnabled: () => true,
      ammFactoryAddress: () => ZERO,
      swapSlippageBps: () => null,
    }).createCaller(anonymous());

    const status = await caller.chainStatus();
    const body = JSON.stringify(status);

    expect(status.refusalCode).toBe('protocol.chain_unreachable');
    expect(status.reason).toBe('The chain connection is not available right now.');
    expect(body).not.toContain(PATH_KEY);
    expect(body).not.toContain(QUERY_KEY);
    expect(body).not.toContain(rpcUrl);
    expect(body).not.toContain('127.0.0.1');
    expect(body).not.toContain('SOCKET');
    expect(body).not.toContain('/v2/');
    expect(body).not.toContain('apikey');
    expect(body).not.toContain('rpcuser');

    const line = logs.find((entry) => entry.includes('svc-protocol chain refusal'));
    expect(line).toBeDefined();
    expect(line).toContain(`http://127.0.0.1:${port}`);
    expect(line).not.toContain(PATH_KEY);
    expect(line).not.toContain(QUERY_KEY);
    expect(line).not.toContain('/v2/');
    expect(line).not.toContain('apikey');
    expect(line).not.toContain('rpcuser');
    expect(line).not.toContain('SOCKET');
  });
});
