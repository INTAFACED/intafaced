import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, toFunctionSelector } from 'viem';
import type { Address, Hex } from 'viem';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { ChainUnavailableError } from './chain/availability.js';
import { poolAbi } from './amm/abi.js';
import { getAmountOut } from './amm/math.js';
import { createProtocolRouter } from './router.js';
import type { ProtocolRouterDeps } from './router.js';

/**
 * THE MOUNT BOUNDARY, for svc-protocol (docs/decisions/mount-boundary.md).
 *
 * The context comes from `createEdgeContext` over real headers, as `index.ts`
 * builds it, rather than from a `Context` literal that would keep passing on a
 * service that trusted an unsigned header.
 *
 * Worth being precise about what is and is not being defended here, because
 * this service is `custodial: false` on the `protocol` plane and most of its
 * surface is permissionless by design (§22). The signature buys nothing on
 * chain — no principal, forged or genuine, can move a user's assets, since the
 * only thing that authorises on this plane is a signature from the user's own
 * key. What it defends is the registry: `myAccounts` and `claimAccount` decide
 * WHOSE INTAFACED profile an address is attached to, and that is a question
 * about identity, not about custody.
 */

const SECRET = 'a-protocol-mount-test-edge-secret-length';
const USER = '11111111-1111-4111-8111-111111111111';
const CHAIN_ID = 31337;

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-protocol' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['protocol:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

/** No credentials of any kind — a caller who simply found the port. */
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function forged(p: Principal = principal()) {
  return edgeContext({
    headers: { 'x-intafaced-principal': encodePrincipal(p), 'x-intafaced-region': 'DE' },
    id: 'req-forged',
  });
}

const ZERO = '0x0000000000000000000000000000000000000000';
const OWNER = '0x1111111111111111111111111111111111111111';
const FACTORY = '0x2222222222222222222222222222222222222222';
const IMPLEMENTATION = '0x3333333333333333333333333333333333333333';

function stubDeps(overrides: Partial<Record<string, unknown>> = {}): ProtocolRouterDeps {
  return {
    chain: {
      config: { chainId: CHAIN_ID, factory: ZERO, implementation: ZERO },
      isDeployed: async () => false,
      genesisHash: async () => `0x${'e'.repeat(64)}` as const,
    },
    registry: { accountsOf: async () => [] },
    relay: {
      buildDeployment: () => ({
        to: FACTORY,
        data: '0xdead',
        value: 0n,
        summary: 'deploy',
      }),
    },
    relayEnabled: () => true,
    ammFactoryAddress: () => ZERO as `0x${string}`,
    swapSlippageBps: () => null,
    ...overrides,
  } as unknown as ProtocolRouterDeps;
}

describe('svc-protocol mount — authorisation', () => {
  it('refuses an anonymous caller on a scoped procedure, and reads nothing', async () => {
    let read = false;
    const deps = stubDeps({
      registry: {
        accountsOf: async () => {
          read = true;
          return [];
        },
      },
    });

    await expect(createProtocolRouter(deps).createCaller(anonymous()).myAccounts()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(read).toBe(false);
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * An unsigned principal is anonymous, so a caller cannot read the registry as
   * somebody else — which on this plane is the only thing there is to steal.
   */
  it('refuses a self-asserted principal, however privileged it claims to be', async () => {
    const ctx = forged(principal({ scopes: ['protocol:read', 'admin:treasury'], tier: 'full', mfa: true }));
    expect(ctx.principal).toBeNull();

    await expect(createProtocolRouter(stubDeps()).createCaller(ctx).myAccounts()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('accepts a principal the edge signed, and reads that principal own accounts', async () => {
    let readFor: string | null = null;
    const deps = stubDeps({
      registry: {
        accountsOf: async (userId: string) => {
          readFor = userId;
          return [];
        },
      },
    });

    await expect(createProtocolRouter(deps).createCaller(signed()).myAccounts({ limit: 1 })).resolves.toEqual([]);
    expect(readFor).toBe(USER);
  });

  it('omitting myAccounts limit refuses PRECONDITION_FAILED — never dumps the registry', async () => {
    let read = false;
    const deps = stubDeps({
      registry: {
        accountsOf: async () => {
          read = true;
          return [{ id: 'x', address: OWNER, owner: OWNER, deployed: false }];
        },
      },
    });

    await expect(createProtocolRouter(deps).createCaller(signed()).myAccounts()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('protocol.my_accounts_list_limit_unset'),
    });
    await expect(createProtocolRouter(deps).createCaller(signed()).myAccounts({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('never invent 50'),
    });
    expect(read).toBe(false);
  });
});

describe('svc-protocol mount — the public surface', () => {
  it('serves auditStatus to an anonymous caller, hashed and not audited', async () => {
    const status = await createProtocolRouter(stubDeps()).createCaller(anonymous()).auditStatus();
    expect(status.kind).toBe('internal');
    expect(status.audited).toBe(false);
    expect(status.signedBy).toBe('shehzad002');
    expect(status.artifactHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(status.packagePath).toBe('docs/audits/protocol-smart-accounts-2026-08-08.md');
  });

  it('serves auditRegistry with suite fingerprints and zero audited packages', async () => {
    const registry = await createProtocolRouter(stubDeps()).createCaller(anonymous()).auditRegistry();
    expect(registry.anyAudited).toBe(false);
    expect(registry.auditedCount).toBe(0);
    expect(registry.packageCount).toBe(1);
    expect(registry.suiteCount).toBeGreaterThan(15);
    expect(registry.packages.every((record) => record.audited === false)).toBe(true);
    expect(registry.suites.every((row) => row.sourceHash.match(/^0x[0-9a-f]{64}$/))).toBeTruthy();
    expect(registry.packages.map((record) => record.id)).toEqual(['protocol-smart-accounts']);
  });

  it('refuses amm.buildCreatePool when the factory is zero', async () => {
    await expect(
      createProtocolRouter(stubDeps()).createCaller(anonymous()).amm.buildCreatePool({
        tokenA: OWNER,
        tokenB: FACTORY,
        feeBps: 30,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('PROTOCOL_AMM_FACTORY_ADDRESS'),
    });
  });

  it('serves health to an anonymous caller without a custodial stamp', async () => {
    const health = await createProtocolRouter(stubDeps()).createCaller(anonymous()).health();
    expect(health).toEqual({
      ok: true,
      service: 'svc-protocol',
      relayEnabled: true,
      factoryConfigured: false,
      chain: { status: 'unprobed', code: 'protocol.chain_unprobed', observedChainId: null },
    });
    expect(health).not.toHaveProperty('custodial');
  });

  it('serves health even when a forged principal was presented', async () => {
    await expect(createProtocolRouter(stubDeps()).createCaller(forged()).health()).resolves.toMatchObject({ ok: true });
  });

  it('reports factoryConfigured when factory and implementation are non-zero', async () => {
    const deps = stubDeps({
      chain: {
        config: { chainId: CHAIN_ID, factory: FACTORY, implementation: IMPLEMENTATION },
        isDeployed: async () => false,
      },
    });
    await expect(createProtocolRouter(deps).createCaller(anonymous()).health()).resolves.toMatchObject({
      factoryConfigured: true,
    });
  });

  it('refuses predictAddress when factory is zero', async () => {
    await expect(createProtocolRouter(stubDeps()).createCaller(anonymous()).predictAddress({ owner: OWNER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('refuses buildDeployment when implementation is zero', async () => {
    const deps = stubDeps({
      chain: {
        config: { chainId: CHAIN_ID, factory: FACTORY, implementation: ZERO },
        isDeployed: async () => false,
      },
    });
    await expect(createProtocolRouter(deps).createCaller(anonymous()).buildDeployment({ owner: OWNER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NO CHAIN — WHAT EVERY CHAIN-DEPENDENT PATH DOES ABOUT IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the real state of this environment: there is no EVM RPC anywhere in
 * the stack (SOCKET §13 `socket.evm-rpc`). An operator-set `PROTOCOL_RPC_URL`
 * with nothing behind it is classified here; blank RPC refuses at env load.
 *
 * Note that `stubDeps` above defines `isDeployed: async () => false`. That stub
 * is why none of this was caught before: it makes a chain read *succeed* with a
 * plausible answer in every existing test, so no test ever observed what a real
 * unreachable RPC produces. The suite below supplies a chain whose reads throw
 * the way the real one does.
 *
 * The contract being asserted: **503 with a code, never 500, and never a
 * value.** A path that cannot reach a chain must refuse. A smart-account claim
 * that "succeeds" against no chain is worse than an outage, because a user will
 * believe it and may fund an address on the strength of it.
 */
const RPC = 'http://localhost:8545';

function unreachable(what: string): ChainUnavailableError {
  return new ChainUnavailableError(
    'protocol.chain_unreachable',
    'The chain connection is not available right now.',
    undefined,
    `${what}: no answer from the EVM RPC at http://127.0.0.1`,
  );
}

/** A chain that behaves as the configured one does today: it cannot be read. */
function deadChain(overrides: Record<string, unknown> = {}) {
  return {
    config: { chainId: CHAIN_ID, factory: FACTORY, implementation: IMPLEMENTATION, rpcUrl: RPC },
    isDeployed: async () => {
      throw unreachable('isDeployed');
    },
    sessionOf: async () => {
      throw unreachable('sessionOf');
    },
    isSessionLive: async () => {
      throw unreachable('isSessionLive');
    },
    ownerOf: async () => {
      throw unreachable('ownerOf');
    },
    poolReserves: async () => {
      throw unreachable('poolReserves');
    },
    poolToken0: async () => {
      throw unreachable('poolToken0');
    },
    poolToken1: async () => {
      throw unreachable('poolToken1');
    },
    poolFeeBps: async () => {
      throw unreachable('poolFeeBps');
    },
    status: async () => ({
      reachable: false,
      configuredChainId: CHAIN_ID,
      observedChainId: null,
      blockNumber: null,
      suiteConfigured: true,
      // Configured, never verified: nobody could read the chain to check.
      suiteDeployed: false,
      // The launch factory is unconfigured in this stub — the zero default.
      // Kept apart from `suiteConfigured` on purpose: two unrelated features
      // must not share one boolean, or the more important one goes dark for the
      // wrong reason.
      tokenFactoryConfigured: false,
      tokenFactoryDeployed: false,
      refusalCode: 'protocol.chain_unreachable',
      reason: 'The chain connection is not available right now.',
      expectedChainId: null,
      actualChainId: null,
    }),
    ...overrides,
  };
}

const SESSION_KEY = '0x4444444444444444444444444444444444444444';
const POOL = '0x5555555555555555555555555555555555555555';
const TOKEN_A = '0x6666666666666666666666666666666666666666';
const TOKEN_B = '0x7777777777777777777777777777777777777777';

describe('no chain — every dependent path refuses with a typed reason', () => {
  const caller = () => createProtocolRouter(stubDeps({ chain: deadChain() })).createCaller(anonymous());

  it('refuses predictAddress rather than returning an address it could not confirm', async () => {
    await expect(caller().predictAddress({ owner: OWNER })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('protocol.chain_unreachable'),
    });
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * Before this change `sessionStatus` had no try/catch at all, so an
   * unreachable RPC escaped as a raw viem error and became a 500 whose message
   * was a stack trace about HTTP. The shape it returns on a *successful* read of
   * an account with no session — `exists: false, live: false` — is what makes
   * getting this wrong dangerous: those two answers are indistinguishable to a
   * client, and one of them is a lie.
   */
  it('refuses sessionStatus instead of reporting "no session"', async () => {
    await expect(caller().sessionStatus({ account: OWNER, sessionKey: SESSION_KEY })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('never answers sessionStatus with exists:false when it could not read the chain', async () => {
    const result = await caller()
      .sessionStatus({ account: OWNER, sessionKey: SESSION_KEY })
      .then(
        (value) => ({ resolved: true, value }),
        () => ({ resolved: false, value: null }),
      );
    expect(result.resolved).toBe(false);
  });

  /**
   * A deployed account that genuinely has no session for a key is the ONLY case
   * allowed to answer `exists: false`. Proving the negative is reachable matters
   * as much as proving the refusal is: a guard that refused everything would
   * pass the test above and be useless.
   */
  it('does answer exists:false for a deployed account whose owner granted nothing', async () => {
    const chain = deadChain({ isDeployed: async () => true, sessionOf: async () => null });
    const router = createProtocolRouter(stubDeps({ chain })).createCaller(anonymous());
    await expect(router.sessionStatus({ account: OWNER, sessionKey: SESSION_KEY })).resolves.toMatchObject({
      exists: false,
      live: false,
      spentWei: null,
    });
  });

  it('refuses sessionStatus for an address that holds no contract code', async () => {
    const chain = deadChain({ isDeployed: async () => false });
    const router = createProtocolRouter(stubDeps({ chain })).createCaller(anonymous());
    await expect(router.sessionStatus({ account: OWNER, sessionKey: SESSION_KEY })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('protocol.contract_not_deployed'),
    });
  });

  it('refuses the AMM quote that sources its own reserves', async () => {
    await expect(caller().amm.quoteFromPool({ pool: POOL, tokenIn: TOKEN_A, amountIn: '1000' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('protocol.chain_unreachable'),
    });
  });

  it('refuses poolReserves rather than reporting zero liquidity', async () => {
    await expect(caller().amm.poolReserves({ pool: POOL })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  /**
   * Zero reserves would be read downstream as `amm.no_liquidity` — i.e. the
   * confident claim "this pool is empty" about a pool nobody has looked at.
   */
  it('does not fall back to zero reserves', async () => {
    await expect(caller().amm.poolReserves({ pool: POOL })).rejects.toSatisfy(
      (err: { message?: string }) => !/"?reserve0"?\s*[:=]\s*"?0"?/.test(err.message ?? ''),
    );
  });

  it('reports the outage as data on chainStatus, so a surface can render it', async () => {
    await expect(caller().chainStatus()).resolves.toMatchObject({
      reachable: false,
      observedChainId: null,
      blockNumber: null,
      refusalCode: 'protocol.chain_unreachable',
      usable: false,
    });
  });

  /**
   * `usable` is the field a product surface should branch on. `suiteConfigured`
   * alone is not enough — addresses set on a chain nobody can reach are still
   * unusable — and `health.ok` is not enough either, since it is true whenever
   * the process is running.
   *
   * `suiteDeployed` is false here on purpose, and that is the honest answer
   * rather than a pessimistic one: it means "verified to hold code", the
   * verification is an `eth_getCode` against a chain that did not answer, and
   * an unverifiable claim is not a true one. Wiring real factory addresses into
   * compose is exactly what makes "configured" and "deployed" come apart.
   */
  it('reports usable:false when the suite is configured but the chain is unreachable', async () => {
    await expect(caller().chainStatus()).resolves.toMatchObject({
      suiteConfigured: true,
      suiteDeployed: false,
      usable: false,
    });
  });

  it('still serves health as ok, because liveness is not chain reachability', async () => {
    await expect(caller().health()).resolves.toMatchObject({ ok: true, factoryConfigured: true });
  });
});

describe('the AMM will not quote a side the pool does not trade', () => {
  it('refuses a tokenIn that is neither pool token, rather than assuming token1', async () => {
    const chain = deadChain({
      poolReserves: async () => ({ reserve0: 1_000_000n, reserve1: 2_000_000n, blockTimestampLast: 1 }),
      poolToken0: async () => TOKEN_A,
      poolToken1: async () => TOKEN_B,
      poolFeeBps: async () => 30,
    });
    const router = createProtocolRouter(stubDeps({ chain })).createCaller(anonymous());

    await expect(
      router.amm.quoteFromPool({ pool: POOL, tokenIn: '0x8888888888888888888888888888888888888888', amountIn: '1000' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('amm.token_not_in_pool') });
  });

  it('orients the reserves by token0 and quotes both directions differently', async () => {
    const chain = deadChain({
      poolReserves: async () => ({ reserve0: 1_000_000n, reserve1: 2_000_000n, blockTimestampLast: 7 }),
      poolToken0: async () => TOKEN_A,
      poolToken1: async () => TOKEN_B,
      poolFeeBps: async () => 30,
    });
    const router = createProtocolRouter(stubDeps({ chain })).createCaller(anonymous());

    const aToB = await router.amm.quoteFromPool({ pool: POOL, tokenIn: TOKEN_A, amountIn: '10000' });
    const bToA = await router.amm.quoteFromPool({ pool: POOL, tokenIn: TOKEN_B, amountIn: '10000' });

    expect(aToB.reserveIn).toBe('1000000');
    expect(aToB.reserveOut).toBe('2000000');
    expect(bToA.reserveIn).toBe('2000000');
    expect(bToA.reserveOut).toBe('1000000');
    // Selling into the deeper side must return less, or the orientation is inverted.
    expect(BigInt(bToA.amountOut)).toBeLessThan(BigInt(aToB.amountOut));
  });

  /** The provenance flag is the point: a caller can tell a real quote from arithmetic. */
  it('marks a chain-sourced quote as such, and a caller-supplied one as not', async () => {
    const chain = deadChain({
      poolReserves: async () => ({ reserve0: 1_000_000n, reserve1: 2_000_000n, blockTimestampLast: 7 }),
      poolToken0: async () => TOKEN_A,
      poolToken1: async () => TOKEN_B,
      poolFeeBps: async () => 30,
    });
    const router = createProtocolRouter(stubDeps({ chain })).createCaller(anonymous());

    await expect(router.amm.quoteFromPool({ pool: POOL, tokenIn: TOKEN_A, amountIn: '10000' })).resolves.toMatchObject({
      reservesFromChain: true,
    });
    await expect(
      router.amm.quoteExactIn({ amountIn: '10000', reserveIn: '1000000', reserveOut: '2000000', feeBps: 30 }),
    ).resolves.toMatchObject({
      reservesFromChain: false,
    });
  });

  it('refuses quoteExactIn and buildCreatePool when feeBps is omitted (no invented 30)', async () => {
    const router = createProtocolRouter(stubDeps()).createCaller(anonymous());
    await expect(
      // @ts-expect-error omitted feeBps must refuse — do not invent 30
      router.amm.quoteExactIn({ amountIn: '10000', reserveIn: '1000000', reserveOut: '2000000' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      // @ts-expect-error omitted feeBps must refuse — do not invent 30
      router.amm.buildCreatePool({ tokenA: OWNER, tokenB: FACTORY }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('swap builder refuses an unbounded minAmountOut before it builds calldata', () => {
  const RESERVE_IN = 1_000_000n;
  const RESERVE_OUT = 2_000_000n;
  const FEE_BPS = 30;
  const AMOUNT_IN = 10_000n;
  const SLIPPAGE_BPS = 100;
  const quote = getAmountOut(AMOUNT_IN, RESERVE_IN, RESERVE_OUT, FEE_BPS);
  const floor = (quote * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;

  function chain(reads: { n: number }) {
    return deadChain({
      poolReserves: async (pool: Address) => {
        if (pool !== POOL) throw new Error(`quoted ${pool}, not the pool`);
        reads.n += 1;
        return { reserve0: RESERVE_IN, reserve1: RESERVE_OUT, blockTimestampLast: 1 };
      },
      poolToken0: async (pool: Address) => {
        if (pool !== POOL) throw new Error(`quoted ${pool}, not the pool`);
        return TOKEN_A;
      },
      poolToken1: async (pool: Address) => {
        if (pool !== POOL) throw new Error(`quoted ${pool}, not the pool`);
        return TOKEN_B;
      },
      poolFeeBps: async (pool: Address) => {
        if (pool !== POOL) throw new Error(`quoted ${pool}, not the pool`);
        return FEE_BPS;
      },
    });
  }

  function caller(slippageBps: number | null, reads: { n: number } = { n: 0 }) {
    return {
      reads,
      api: createProtocolRouter(stubDeps({ chain: chain(reads), swapSlippageBps: () => slippageBps })).createCaller(anonymous()),
    };
  }

  const swap = (minAmountOut: bigint) => ({
    pool: POOL,
    tokenIn: TOKEN_A,
    amountIn: AMOUNT_IN.toString(),
    minAmountOut: minAmountOut.toString(),
    to: OWNER,
  });

  it('blank slippage config refuses and does not read the pool', async () => {
    const { api, reads } = caller(null);
    await expect(api.amm.buildSwapExactIn(swap(floor))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('protocol.swap_slippage_unset'),
    });
    expect(reads.n).toBe(0);
  });

  it('a tolerance above the max is the same refusal, not a default', async () => {
    const { api, reads } = caller(5_001);
    await expect(api.amm.buildSwapExactIn(swap(floor))).rejects.toMatchObject({
      message: expect.stringContaining('protocol.swap_slippage_unset'),
    });
    expect(reads.n).toBe(0);
  });

  it('refuses minAmountOut below the fresh-quote floor, including 0', async () => {
    expect(floor).toBeGreaterThan(1n);
    const below = caller(SLIPPAGE_BPS);
    await expect(below.api.amm.buildSwapExactIn(swap(floor - 1n))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('protocol.swap_min_out_below_bound'),
    });
    const zero = caller(SLIPPAGE_BPS);
    await expect(zero.api.amm.buildSwapExactIn(swap(0n))).rejects.toMatchObject({
      message: expect.stringContaining('protocol.swap_min_out_below_bound'),
    });
  });

  it('accepts minAmountOut exactly at the floor and encodes that value', async () => {
    const { api } = caller(SLIPPAGE_BPS);
    const built = await api.amm.buildSwapExactIn(swap(floor));
    const decoded = decodeFunctionData({ abi: poolAbi, data: built.data as Hex });
    expect(decoded.functionName).toBe('swapExactIn');
    expect(decoded.args[2]).toBe(floor);
    expect(built.to).toBe(POOL);
  });
});

describe('session check refuses an unbounded swap from a fresh quote', () => {
  const RESERVE_IN = 1_000_000n;
  const RESERVE_OUT = 2_000_000n;
  const FEE_BPS = 30;
  const AMOUNT_IN = 10_000n;
  const SLIPPAGE_BPS = 100;
  const quote = getAmountOut(AMOUNT_IN, RESERVE_IN, RESERVE_OUT, FEE_BPS);
  const floor = (quote * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
  const ROUTER = '0x9999999999999999999999999999999999999999' as Address;
  const poolSelector = toFunctionSelector('swapExactIn(address,uint256,uint256,address)');

  function chain(reads: { n: number }) {
    return deadChain({
      poolReserves: async (pool: Address) => {
        if (pool !== POOL) throw new Error(`quoted ${pool}, not the pool`);
        reads.n += 1;
        return { reserve0: RESERVE_IN, reserve1: RESERVE_OUT, blockTimestampLast: 1 };
      },
      poolToken0: async (pool: Address) => {
        if (pool !== POOL) throw new Error(`quoted ${pool}, not the pool`);
        return TOKEN_A;
      },
      poolToken1: async (pool: Address) => {
        if (pool !== POOL) throw new Error(`quoted ${pool}, not the pool`);
        return TOKEN_B;
      },
      poolFeeBps: async (pool: Address) => {
        if (pool !== POOL) throw new Error(`quoted ${pool}, not the pool`);
        return FEE_BPS;
      },
    });
  }

  function sessionCall(minAmountOut: bigint, reads: { n: number }, slippageBps: number | null) {
    const data = encodeFunctionData({
      abi: poolAbi,
      functionName: 'swapExactIn',
      args: [TOKEN_A, AMOUNT_IN, minAmountOut, OWNER],
    });
    const api = createProtocolRouter(stubDeps({ chain: chain(reads), swapSlippageBps: () => slippageBps })).createCaller(anonymous());
    return api.checkSessionCall({
      account: OWNER,
      spec: {
        key: SESSION_KEY,
        validAfter: 0,
        validUntil: Math.floor(Date.now() / 1000) + 3_600,
        spendLimitWei: '0',
        targets: [POOL],
        selectors: [poolSelector],
      },
      target: POOL,
      value: '0',
      data,
      spentWei: '0',
    });
  }

  it('blank slippage config refuses before the quote', async () => {
    const reads = { n: 0 };
    await expect(sessionCall(floor, reads, null)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('protocol.swap_slippage_unset'),
    });
    expect(reads.n).toBe(0);
  });

  it('refuses a minimum under the floor and accepts the floor', async () => {
    const under = await sessionCall(floor - 1n, { n: 0 }, SLIPPAGE_BPS);
    expect(under.allowed).toBe(false);
    expect(under.code).toBe('session.swap_min_out_below_bound');
    const at = await sessionCall(floor, { n: 0 }, SLIPPAGE_BPS);
    expect(at.allowed).toBe(true);
    expect(at.code).toBe('allowed');
    const zero = await sessionCall(0n, { n: 0 }, SLIPPAGE_BPS);
    expect(zero.code).toBe('session.swap_min_out_below_bound');
  });

  it('quotes the pool named in router calldata, not the router target', async () => {
    const reads = { n: 0 };
    const data = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'swapExactIn',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'pool', type: 'address' },
            { name: 'tokenIn', type: 'address' },
            { name: 'amountIn', type: 'uint256' },
            { name: 'minAmountOut', type: 'uint256' },
            { name: 'to', type: 'address' },
          ],
          outputs: [{ name: 'amountOut', type: 'uint256' }],
        },
      ] as const,
      functionName: 'swapExactIn',
      args: [POOL, TOKEN_A, AMOUNT_IN, floor, OWNER],
    });
    const api = createProtocolRouter(stubDeps({ chain: chain(reads), swapSlippageBps: () => SLIPPAGE_BPS })).createCaller(anonymous());
    const decision = await api.checkSessionCall({
      account: OWNER,
      spec: {
        key: SESSION_KEY,
        validAfter: 0,
        validUntil: Math.floor(Date.now() / 1000) + 3_600,
        spendLimitWei: '0',
        targets: [ROUTER, POOL],
        selectors: [toFunctionSelector('swapExactIn(address,address,uint256,uint256,address)')],
      },
      target: ROUTER,
      value: '0',
      data,
      spentWei: '0',
    });
    expect(reads.n).toBe(1);
    expect(decision).toMatchObject({ allowed: true, code: 'allowed' });
  });
});

describe('svc-protocol mount — founding badge claim needs the owner signature', () => {
  it('refuses an unsigned claim from a signed principal and stores nothing', async () => {
    let stored = false;
    const deps = stubDeps({
      registry: {
        accountsOf: async () => [{ id: 'a', userId: USER, chainId: CHAIN_ID, address: OWNER, owner: OWNER, deployed: true }],
      },
      badge: {
        store: {
          isListed: async () => true,
          findClaim: async () => null,
          findClaimByAddress: async () => null,
          putClaim: async (r: unknown) => {
            stored = true;
            return r;
          },
          setTxHash: async () => {
            throw new Error('unreachable');
          },
        },
        minter: { signerFor: () => ({ mint: async () => '0x' as Hex }) },
        window: () => ({ opensAt: new Date(Date.now() - 60_000), closesAt: new Date(Date.now() + 60_000) }),
        mainnet: () => false,
      },
    });
    await expect(createProtocolRouter(deps).createCaller(signed()).badge.claim()).rejects.toThrow(/badge\.not_eligible/);
    expect(stored).toBe(false);
  });
});
