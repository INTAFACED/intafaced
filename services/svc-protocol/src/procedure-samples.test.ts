import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, router, signPrincipalHeader, TRPCError } from '@intafaced/contracts';
import type { ProcedureRecord, ProcedureSample } from '@intafaced/contracts/procedure';
import { PROTOCOL_AMM_PROCEDURES } from '@intafaced/contracts/protocol-amm-procedures';
import {
  PROTOCOL_AUDIT_PRODUCTS,
  PROTOCOL_AUDIT_STATUS,
  PROTOCOL_BLOCKERS,
  PROTOCOL_BUILD_REVOKE_ALL_SESSIONS,
  PROTOCOL_BUILD_SESSION_GRANT,
  PROTOCOL_BUILD_SESSION_REVOKE,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_CHAIN_STATUS,
  PROTOCOL_DEPLOYMENTS_LIST,
  PROTOCOL_GAS_PRICE,
  PROTOCOL_HEALTH,
  PROTOCOL_LISTING_OWNERSHIP_CHALLENGE,
  PROTOCOL_LISTING_VERIFY_OWNERSHIP,
  PROTOCOL_NETWORKS_LIST,
  PROTOCOL_PREDICT_ADDRESS,
  PROTOCOL_REPRESENTATION_ACCEPT,
  PROTOCOL_REPRESENTATION_STATUS,
  PROTOCOL_SESSIONS_LIST,
} from '@intafaced/contracts/protocol-procedures';
import { PROTOCOL_CHAIN_PROCEDURES } from '@intafaced/contracts/protocol-chain-procedures';
import { PROTOCOL_WALLET_PROCEDURES } from '@intafaced/contracts/protocol-wallet-procedures';
import { createAddressBookRouter, createWalletSessionRouter, unwiredAddressBookStore } from './address-book/router.js';
import {
  createAddressReportsRouter,
  createAddressRiskRouter,
  createComplianceRouter,
  type AddressRiskDeps,
} from './address-risk/router.js';
import { createEmbeddedWalletRouter, unwiredEmbeddedWalletStore } from './embedded-wallet/router.js';
import { createVenueWalletRouter, unwiredVenueConnectionStore } from './venue-wallet/router.js';
import { createProtocolRouter, type ProtocolRouterDeps } from './router.js';
import { createBridgeRouter } from './bridge/router.js';
import { createContractSourceRouter } from './contract-source/router.js';
import { createEscrowRouter } from './escrow/router.js';
import { createLendingRouter } from './lending/position.js';
import { createPortfolioRouter } from './amm/portfolio-router.js';
import { createTokensRouter } from './amm/tokens-router.js';
import { createVenueFundsRouter } from './venue/router.js';
import { createWalletTxRouters } from './wallet-tx/router.js';

/**
 * The mounted side of each svc-protocol record's samples: sent through the production adapter by a caller the record
 * admits, a refused sample is answered 400 (the input is malformed), an accepted one never is. The record's zod schema and
 * its JSON export run the same samples in `@intafaced/contracts` (`procedure-registry.test.ts`).
 */

const SECRET = 'a-protocol-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-protocol' });

/** A signed-in person in a served region holding every scope the records ask for. */
function signedIn(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['protocol:read', 'admin:read', 'admin:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

/** A store nobody wired: every call fails as an internal error (500), never as a malformed input (400). */
const unwired = <T>(): T =>
  new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'then'
          ? undefined
          : async () => {
              throw new Error('samples: store not wired');
            },
    },
  ) as T;

function serve(root: ReturnType<typeof router>, records: readonly ProcedureRecord[], title: string) {
  const app = Fastify();
  beforeAll(async () => {
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: { router: root, createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
    });
  });
  afterAll(() => app.close());
  const cases = records.flatMap((record) =>
    record.samples.map((sample: ProcedureSample, i) => ({
      record,
      sample,
      label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
    })),
  );
  describe(title, () => {
    it.each(cases)('$label', async ({ record, sample }) => {
      if (record.transport !== 'trpc') throw new Error(`${record.name} is not a tRPC record`);
      const input = sample.input;
      const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
      const res =
        record.kind === 'query'
          ? await app.inject({ method: 'GET', url, headers: signedIn() })
          : await app.inject({
              method: 'POST',
              url,
              headers: { ...signedIn(), 'content-type': 'application/json' },
              payload: input === undefined ? '' : JSON.stringify(input),
            });
      if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
      else expect(res.statusCode, res.body).not.toBe(400);
    });
  });
}

// ── The wallet and trust calls (`protocol-wallet-procedures.ts`), every owner setting blank ───────────────────────────
{
  const chainId = () => 31337;
  const addressBook = {
    chainId,
    store: unwiredAddressBookStore,
    session: () => null,
    maxContacts: () => undefined,
    maxGroups: () => undefined,
  };
  const risk: AddressRiskDeps = { chainId, store: unwired(), screeningLoaded: () => false };
  const venue = {
    chainId,
    store: unwiredVenueConnectionStore,
    session: () => null,
    ttlSeconds: () => null,
    sanctions: () => null,
  };
  const root = router({
    walletSession: createWalletSessionRouter(addressBook),
    addressBook: createAddressBookRouter(addressBook),
    addressRisk: createAddressRiskRouter(risk),
    addressReports: createAddressReportsRouter(risk),
    compliance: createComplianceRouter({ chainId, store: unwired(), trustDesk: unwired(), now: () => new Date() }),
    venueWallet: createVenueWalletRouter(venue),
    embeddedWallet: createEmbeddedWalletRouter({ store: unwiredEmbeddedWalletStore, setting: () => ({ kind: 'unset' as const }) }),
  });
  serve(root, PROTOCOL_WALLET_PROCEDURES, "svc-protocol's wallet and trust routes reach each record sample's verdict");
}

// ── The amm calls (`protocol-amm-procedures.ts`): no chain, database or peer, every owner setting blank, so an accepted
// input reaches its handler and refuses there for the blank setting or the absent chain, which is not a 400 ─────────────
{
  const ZERO = '0x0000000000000000000000000000000000000000';
  const deps = {
    chain: { config: { chainId: 31337, factory: ZERO, implementation: ZERO, rpcUrl: 'http://127.0.0.1:1' } },
    registry: {},
    relay: {},
    relayEnabled: () => false,
    ammFactoryAddress: () => ZERO,
    swapSlippageBps: () => null,
  } as unknown as ProtocolRouterDeps;
  serve(createProtocolRouter(deps), PROTOCOL_AMM_PROCEDURES, "svc-protocol's amm routes reach each record sample's verdict");
}

// ── The chain reads (`protocol-chain-procedures.ts`): no chain and every owner setting blank, so an accepted input reaches
// its handler and is refused by name, never as malformed ────────────────────────────────────────────────────────────
{
  const noChain = (): never => {
    throw new Error('samples: no chain');
  };
  const toTrpcError = (err: unknown) =>
    err instanceof TRPCError ? err : new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: String(err) });
  const ZERO = '0x0000000000000000000000000000000000000000' as const;
  const chainReads = router({
    escrow: createEscrowRouter({ chain: noChain, setting: () => ({ chainId: 31337, escrow: null, mainnet: false }), toTrpcError }),
    venue: createVenueFundsRouter({ chain: noChain, venue: () => null, toTrpcError }),
    lending: createLendingRouter({ chain: noChain, market: () => null, toTrpcError }),
    contract: createContractSourceRouter({ chain: noChain, sources: [], toTrpcError }),
    bridge: createBridgeRouter({ loadRoutes: () => [] }),
    tokens: createTokensRouter({ chain: {} as never, factory: () => ZERO, quoteToken: () => null, toTrpcError }),
    portfolio: createPortfolioRouter({ chain: {} as never, factory: () => ZERO, priceSetting: () => null, toTrpcError }),
    ...createWalletTxRouters({
      chain: noChain,
      claimEscrow: () => null,
      replacement: () => ({ bumpBps: null, ceilingWei: null }),
      toTrpcError,
    }),
  });
  serve(chainReads, PROTOCOL_CHAIN_PROCEDURES, "svc-protocol's chain-read routes reach each record sample's verdict");
}

// ── The root calls (`protocol-procedures.ts`): a refused sample is refused for its input (400 with no named code) ─────
describe("svc-protocol's root calls", () => {
  const ROOT_ZERO = '0x0000000000000000000000000000000000000000';
  /** Nothing wired: every dependency a handler reaches refuses, so only the input check can answer 400 without a code. */
  const rootDeps = {
    chain: {
      config: { chainId: 31337, factory: ROOT_ZERO, implementation: ROOT_ZERO, rpcUrl: 'http://127.0.0.1:1' },
      isDeployed: async () => false,
    },
    registry: {},
    relay: {},
    relayEnabled: () => false,
    ammFactoryAddress: () => ROOT_ZERO,
    swapSlippageBps: () => null,
  } as unknown as ProtocolRouterDeps;

  const rootApp = Fastify();

  beforeAll(async () => {
    await rootApp.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: { router: createProtocolRouter(rootDeps), createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
    });
  });
  afterAll(() => rootApp.close());

  /** svc-protocol's root calls (`@intafaced/contracts/protocol-procedures`). */
  const ROOT_RECORDS: readonly ProcedureRecord[] = [
    PROTOCOL_HEALTH,
    PROTOCOL_AUDIT_STATUS,
    PROTOCOL_AUDIT_PRODUCTS,
    PROTOCOL_CHAIN_STATUS,
    PROTOCOL_GAS_PRICE,
    PROTOCOL_BLOCKERS,
    PROTOCOL_NETWORKS_LIST,
    PROTOCOL_DEPLOYMENTS_LIST,
    PROTOCOL_CAPABILITIES,
    PROTOCOL_PREDICT_ADDRESS,
    PROTOCOL_BUILD_SESSION_GRANT,
    PROTOCOL_BUILD_SESSION_REVOKE,
    PROTOCOL_BUILD_REVOKE_ALL_SESSIONS,
    PROTOCOL_LISTING_OWNERSHIP_CHALLENGE,
    PROTOCOL_LISTING_VERIFY_OWNERSHIP,
    PROTOCOL_REPRESENTATION_STATUS,
    PROTOCOL_REPRESENTATION_ACCEPT,
    PROTOCOL_SESSIONS_LIST,
  ];

  async function sendRoot(record: ProcedureRecord, input: unknown) {
    if (record.transport !== 'trpc') throw new Error(`${record.name} is not a tRPC record`);
    const headers = { 'x-intafaced-region': 'DE' };
    const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
    return record.kind === 'query'
      ? rootApp.inject({ method: 'GET', url, headers })
      : rootApp.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: input === undefined ? '' : JSON.stringify(input),
        });
  }

  /** A 400 that names no refusal code: the input did not pass the record's schema. */
  function refusedForInput(res: { statusCode: number; body: string }): boolean {
    if (res.statusCode !== 400) return false;
    const body = JSON.parse(res.body) as { error?: { data?: { cause?: { code?: unknown } } } };
    return body.error?.data?.cause?.code === undefined;
  }

  const rootCases = (records: readonly ProcedureRecord[]) =>
    records.flatMap((record) =>
      record.samples.map((sample: ProcedureSample, i) => ({
        record,
        sample,
        label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
      })),
    );

  describe("svc-protocol's root calls reach each record sample's verdict on the mounted route", () => {
    it('mounts every root record at its path, from a served region', async () => {
      for (const record of ROOT_RECORDS) {
        const res = await sendRoot(record, record.samples.find((s) => s.verdict === 'accept')?.input);
        expect(res.statusCode, `${record.name}: ${res.body}`).not.toBe(404);
        expect(res.statusCode, `${record.name}: ${res.body}`).not.toBe(403);
      }
    });

    it.each(rootCases(ROOT_RECORDS))('$label', async ({ record, sample }) => {
      const res = await sendRoot(record, sample.input);
      expect(refusedForInput(res), `${res.statusCode} ${res.body}`).toBe(sample.verdict === 'refuse');
    });
  });
});
