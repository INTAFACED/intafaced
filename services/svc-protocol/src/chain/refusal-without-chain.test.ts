import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { ProtocolChain } from './client.js';
import { ChainUnavailableError } from './availability.js';
import { createProtocolRouter } from '../router.js';
import { AccountRegistry, MemoryAccountStore } from '../accounts/registry.js';
import { SessionRelay } from '../session/relay.js';
import { createEdgeContext } from '@intafaced/contracts';
import { devChainReachable, devRpcUrl, DEV_CHAIN_ID } from '../../scripts/dev-chain.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A LOCAL DEV CHAIN MUST NOT BECOME SOMETHING PRODUCTION QUIETLY NEEDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The `evm` service in docker-compose.yml is dev-only, and the point of this
 * file is that its absence changes nothing about how svc-protocol behaves.
 * Stop the container, unset the env, deploy to an environment that has no
 * chain — every dependent path must still refuse with the typed code it shipped
 * with, and none of them may start answering because "there is usually a chain
 * now".
 *
 * ── Why this exists alongside router.mount.test.ts ─────────────────────────
 *
 * That suite proves the same contract with a hand-built chain stub. It is a
 * good test and it has a blind spot it names itself: a stub throws the error
 * the test author expected. This one uses the REAL `ProtocolChain`, with real
 * viem, pointed at a real TCP port with nothing listening on it — so the error
 * being classified is one the network produced, not one a test wrote down.
 *
 * That distinction is exactly where `classifyChainError` could rot: viem
 * re-wraps errors as it bubbles them through the transport, so the shape a stub
 * asserts can drift from the shape a socket actually produces on a viem
 * upgrade, and nothing would notice.
 *
 * No chain is needed to run this. That is the whole idea.
 */

/** A port nothing is listening on — bound to learn the number, then released. */
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

const DEAD_RPC = `http://127.0.0.1:${await closedPort()}`;

const FACTORY: Address = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const IMPLEMENTATION: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const ENTRYPOINT: Address = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const OWNER: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ZERO: Address = '0x0000000000000000000000000000000000000000';

const anonymous = () =>
  createEdgeContext({ secret: 'a-refusal-suite-edge-secret-long-enough', serviceName: 'svc-protocol' })({
    headers: { 'x-intafaced-region': 'DE' },
    id: 'req-dead',
  });

function routerFor(chain: ProtocolChain, factory: Address, implementation: Address) {
  return createProtocolRouter({
    chain,
    registry: new AccountRegistry(new MemoryAccountStore(), { chainId: DEV_CHAIN_ID, factory, implementation }),
    relay: new SessionRelay(chain),
    relayEnabled: () => true,
    ammFactoryAddress: () => ZERO,
    swapSlippageBps: () => null,
  }).createCaller(anonymous());
}

/** A plausible deployed TokenFactory. Configured, and on a chain nobody can reach. */
const TOKEN_FACTORY: Address = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';

/** Launch parameters that pass every policy check, so only the chain can refuse. */
const VALID_TOKEN_PARAMS = {
  name: 'Sovereign One',
  symbol: 'SOV',
  decimals: 18,
  totalSupply: '1000000',
  recipient: OWNER,
};

const deadChain = new ProtocolChain({
  chainId: DEV_CHAIN_ID,
  rpcUrl: DEAD_RPC,
  entryPoint: ENTRYPOINT,
  // Real, correct addresses — from the dev deployment. The point is that
  // CONFIGURED addresses buy nothing when nobody can reach the chain they are on.
  factory: FACTORY,
  implementation: IMPLEMENTATION,
  tokenFactory: TOKEN_FACTORY,
});

describe('a real ProtocolChain pointed at a closed socket', () => {
  it('classifies the transport failure as chain_unreachable, from a real refused connection', async () => {
    const error = await deadChain.isDeployed(OWNER).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ChainUnavailableError);
    expect((error as ChainUnavailableError).code).toBe('protocol.chain_unreachable');
    expect((error as ChainUnavailableError).message).not.toContain(DEAD_RPC);
    expect((error as ChainUnavailableError).message).not.toContain('SOCKET');
    expect((error as ChainUnavailableError).operatorDetail).toContain(DEAD_RPC);
  });

  it('reports the outage as data on status(), and claims nothing about deployment', async () => {
    await expect(deadChain.status()).resolves.toMatchObject({
      reachable: false,
      observedChainId: null,
      blockNumber: null,
      suiteConfigured: true,
      // Configured is not deployed. Nobody looked, so nothing is claimed.
      suiteDeployed: false,
      refusalCode: 'protocol.chain_unreachable',
    });
  });
});

describe('the router with no chain behind it — unchanged behaviour', () => {
  const caller = () => routerFor(deadChain, FACTORY, IMPLEMENTATION);

  it('refuses predictAddress with 503 and the code intact, never an address', async () => {
    await expect(caller().predictAddress({ owner: OWNER })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('protocol.chain_unreachable'),
    });
  });

  it('refuses sessionStatus rather than answering exists:false', async () => {
    await expect(caller().sessionStatus({ account: FACTORY, sessionKey: OWNER })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('refuses claimAccount, because it cannot read whether the account is deployed', async () => {
    // Unauthenticated here, so the scope guard refuses first — which is itself
    // the right order. The chain read is unreachable either way.
    await expect(caller().claimAccount({ owner: OWNER, address: FACTORY, signature: `0x${'11'.repeat(65)}` })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('reports usable:false on chainStatus so a surface renders the outage', async () => {
    await expect(caller().chainStatus()).resolves.toMatchObject({
      reachable: false,
      suiteDeployed: false,
      usable: false,
      refusalCode: 'protocol.chain_unreachable',
    });
  });

  /**
   * buildDeployment builds bytes and reads nothing, so it still answers with a
   * chain down. That is correct and worth pinning: the calldata is valid
   * whenever the addresses are, and a user can hold it until a chain exists.
   */
  it('still builds deployment calldata, because building reads nothing', async () => {
    await expect(caller().buildDeployment({ owner: OWNER })).resolves.toMatchObject({ to: FACTORY, value: '0' });
  });

  it('still refuses everything when the addresses are the zero defaults', async () => {
    const unconfigured = new ProtocolChain({
      chainId: DEV_CHAIN_ID,
      rpcUrl: DEAD_RPC,
      entryPoint: ENTRYPOINT,
      factory: ZERO,
      implementation: ZERO,
    });
    const caller = routerFor(unconfigured, ZERO, ZERO);

    await expect(caller.predictAddress({ owner: OWNER })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(caller.buildDeployment({ owner: OWNER })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(caller.chainStatus()).resolves.toMatchObject({ suiteConfigured: false, suiteDeployed: false, usable: false });
    await expect(caller.health()).resolves.toMatchObject({ ok: true, factoryConfigured: false });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LAUNCH — a token address is the worst thing on this surface to fabricate
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A smart-account address a user funds is bad. A token address is worse,
 * because a creator BROADCASTS it — into an announcement, a chat, a listing.
 * Everyone who acts on it sends funds to a contract that will never exist, and
 * none of it is recoverable by anybody.
 *
 * The arithmetic cannot refuse on its own: `address.test.ts` pins that
 * `computeTokenAddress` derives a perfectly well-formed address from a zero
 * factory. So the refusal lives in the router, and it is checked here against a
 * REAL `ProtocolChain` on a REAL closed socket rather than a stub that throws
 * what a test author expected.
 */
describe('launch, with no chain behind it', () => {
  const caller = () => routerFor(deadChain, FACTORY, IMPLEMENTATION);

  it('refuses predictTokenAddress with 503 and the code intact, never an address', async () => {
    await expect(caller().launch.predictTokenAddress({ creator: OWNER, params: VALID_TOKEN_PARAMS })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('protocol.chain_unreachable'),
    });
  });

  it('refuses tokenInfo rather than answering with empty metadata', async () => {
    await expect(caller().launch.tokenInfo({ token: TOKEN_FACTORY })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('protocol.chain_unreachable'),
    });
  });

  it('reports launchUsable:false on chainStatus so a surface renders the outage', async () => {
    await expect(caller().chainStatus()).resolves.toMatchObject({
      reachable: false,
      tokenFactoryConfigured: true,
      // Configured is not deployed, and nobody looked.
      tokenFactoryDeployed: false,
      launchUsable: false,
      refusalCode: 'protocol.chain_unreachable',
    });
  });

  it('reports launch.status as unusable without throwing, and never claims an audit', async () => {
    await expect(caller().launch.status()).resolves.toMatchObject({
      configured: true,
      deployed: false,
      usable: false,
      refusalCode: 'protocol.chain_unreachable',
      mintAuthorityRetained: false,
      template: { contractName: 'SovereignToken', audited: false },
    });
  });

  /**
   * Building reads nothing, so it still answers with the chain down — the same
   * bargain `buildDeployment` makes. The calldata is valid whenever the factory
   * address is, and a creator can hold it until a chain exists.
   */
  it('still builds launch calldata, because building reads nothing', async () => {
    const call = await caller().launch.buildTokenDeployment({ creator: OWNER, params: VALID_TOKEN_PARAMS });
    expect(call).toMatchObject({ to: TOKEN_FACTORY, value: '0' });
    expect(call.predictedAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // 1_000_000 at 18 decimals, as a string. Never a number, at any point.
    expect(call.scaledTotalSupply).toBe((10n ** 24n).toString());
    // The summary is the last place the irreversible part can be said.
    expect(call.summary).toContain('no mint function');
  });

  /**
   * Policy refusals need no chain and must not be masked by one being absent: a
   * creator with a bad supply gets a 400 naming the reason, not a 503 that
   * sends them looking at infrastructure.
   */
  it('refuses invalid parameters with 400 and a launch.* code, chain or no chain', async () => {
    await expect(
      caller().launch.buildTokenDeployment({ creator: OWNER, params: { ...VALID_TOKEN_PARAMS, decimals: 19 } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('launch.invalid_decimals') });

    await expect(
      caller().launch.buildTokenDeployment({ creator: OWNER, params: { ...VALID_TOKEN_PARAMS, totalSupply: '1e21' } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('launch.invalid_supply') });

    await expect(
      caller().launch.buildTokenDeployment({
        creator: OWNER,
        params: { ...VALID_TOKEN_PARAMS, totalSupply: '100000000000000000000' },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('launch.supply_out_of_range') });
  });

  /**
   * THE ONE THAT MATTERS MOST. With no factory configured, every launch path
   * must refuse BEFORE the arithmetic runs — because the arithmetic succeeds
   * and hands back a real-looking address for a token nothing will ever deploy.
   */
  it('refuses every launch path outright when no factory is configured', async () => {
    const unconfigured = new ProtocolChain({
      chainId: DEV_CHAIN_ID,
      rpcUrl: DEAD_RPC,
      entryPoint: ENTRYPOINT,
      factory: FACTORY,
      implementation: IMPLEMENTATION,
      // `tokenFactory` omitted entirely — the other spelling of absence, which
      // the client collapses to the zero address so only one is reachable here.
    });
    const caller = routerFor(unconfigured, FACTORY, IMPLEMENTATION);

    for (const call of [
      () => caller.launch.predictTokenAddress({ creator: OWNER, params: VALID_TOKEN_PARAMS }),
      () => caller.launch.buildTokenDeployment({ creator: OWNER, params: VALID_TOKEN_PARAMS }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('launch.factory_not_configured'),
      });
    }

    // And it says so as data, rather than throwing, on the status surfaces.
    await expect(caller.launch.status()).resolves.toMatchObject({ configured: false, deployed: false, usable: false });
    await expect(caller.chainStatus()).resolves.toMatchObject({ tokenFactoryConfigured: false, launchUsable: false });
  });
});

/**
 * The dev chain answering for the wrong chain id must be refused just as hard.
 * A CREATE2 address is only meaningful on the chain its factory sits on, so a
 * mismatched RPC makes every prediction an address the user can fund and never
 * reach. Needs a live node to be a real test, so it skips without one.
 */
describe.skipIf(!(await devChainReachable()))('an RPC answering for a different chain', () => {
  it('refuses with chain_id_mismatch and names both ids', async () => {
    const wrongChain = new ProtocolChain({
      chainId: 1,
      rpcUrl: devRpcUrl(),
      entryPoint: ENTRYPOINT,
      factory: FACTORY,
      implementation: IMPLEMENTATION,
    });
    const status = await wrongChain.status();
    expect(status).toMatchObject({ reachable: false, observedChainId: null, refusalCode: 'protocol.chain_id_mismatch' });
    expect(status.reason).toContain(String(DEV_CHAIN_ID));
    expect(status.reason).toContain('never reach');
  });
});
