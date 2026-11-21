import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import type { Address, Hex } from 'viem';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { ChainUnavailableError } from './chain/availability.js';
import { poolAbi } from './amm/abi.js';
import { getAmountOut } from './amm/math.js';
import { createProtocolRouter } from './router.js';
import type { ProtocolRouterDeps } from './router.js';

/**
 * THE MOUNT BOUNDARY, for svc-protocol.
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
 * key. What it defends is whose INTAFACED profile a row belongs to (the
 * embedded wallet, the venue wallet connection), and that is a question about
 * identity, not about custody.
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
    relay: {},
    relayEnabled: () => true,
    ammFactoryAddress: () => ZERO as `0x${string}`,
    swapSlippageBps: () => null,
    ...overrides,
  } as unknown as ProtocolRouterDeps;
}

/** The signed-in person's embedded wallet: a scoped read whose store answers only for the principal's own user id. */
function walletDeps(onRead: (userId: string) => void) {
  return stubDeps({
    embeddedWallet: {
      store: {
        find: async (userId: string) => (onRead(userId), null),
        insert: async () => {
          throw new Error('unreachable');
        },
      },
      setting: () => ({ kind: 'unset' }),
    },
  });
}

describe('svc-protocol mount — authorisation', () => {
  it('refuses an anonymous caller on a scoped procedure, and reads nothing', async () => {
    let read = false;
    const deps = walletDeps(() => (read = true));

    await expect(createProtocolRouter(deps).createCaller(anonymous()).embeddedWallet.status()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(read).toBe(false);
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * An unsigned principal is anonymous, so a caller cannot read a row as
   * somebody else — which on this plane is the only thing there is to steal.
   */
  it('refuses a self-asserted principal, however privileged it claims to be', async () => {
    const ctx = forged(principal({ scopes: ['protocol:read', 'admin:treasury'], tier: 'full', mfa: true }));
    expect(ctx.principal).toBeNull();

    await expect(
      createProtocolRouter(walletDeps(() => undefined))
        .createCaller(ctx)
        .embeddedWallet.status(),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('accepts a principal the edge signed, and reads that principal own row', async () => {
    let readFor: string | null = null;
    const deps = walletDeps((userId) => (readFor = userId));

    await expect(createProtocolRouter(deps).createCaller(signed()).embeddedWallet.status()).resolves.toMatchObject({ wallet: null });
    expect(readFor).toBe(USER);
  });
});

describe('svc-protocol mount — strict screening', () => {
  // vitest.config.ts turns screening off for business fixtures; this test arms the production default
  // (unset INTAFACED_SCREENING_FAIL_CLOSED) and a blank list, and proves a signed request refuses.
  it('refuses a signed request with unconfigured screening before reading anything', async () => {
    let read = false;
    const deps = walletDeps(() => (read = true));
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', undefined);
    vi.stubEnv('INTAFACED_REGION_FAIL_CLOSED', undefined);
    vi.stubEnv('INTAFACED_UNSIGNED_SANCTIONS_ROWS', 'off');
    try {
      await expect(createProtocolRouter(deps).createCaller(signed()).embeddedWallet.status()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        cause: { decision: { code: 'denied.screening_unconfigured' } },
      });
      expect(read).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
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
 * value.** A path that cannot reach a chain must refuse. An address prediction
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

  it('refuses the AMM quote that sources its own reserves', async () => {
    await expect(caller().amm.quoteFromPool({ pool: POOL, tokenIn: TOKEN_A, amountIn: '1000' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('protocol.chain_unreachable'),
    });
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
  it('marks a chain-sourced quote as such', async () => {
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
