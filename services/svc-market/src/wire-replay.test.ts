import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal, Scope } from '@intafaced/auth';
import {
  REGION_FAIL_CLOSED_ENV,
  SANCTIONS_REGIONS_ENV,
  SANCTIONS_SOURCE_ENV,
  SCREENING_FAIL_CLOSED_ENV,
  UNSIGNED_SANCTIONS_ROWS_ENV,
} from '@intafaced/config';
import { createEdgeContext, encodePrincipal, procedureCallers, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { createMarketRouter } from './router.js';
import { stubApprovalConsumer, unwiredApprovalConsumer } from './action-approval-consume.js';
import { CommerceService } from './commerce/commerce-service.js';
import { ReviewsService } from './reviews/reviews-service.js';
import { PerpProposalService } from './perp-proposal-service.js';
import { SignalPublisher } from './signals/signal-publisher.js';
import { createStakeSource, type SlotEntitlementSource, type VendorEntitlement } from './stake-source.js';
import { createLedgerClient } from './ledger-client.js';
import { MARKET_OPS_SCOPE, VendorService } from './vendor-service.js';
import { MARKET_LISTING_PIN_ENV } from './live-markets.js';

/**
 * The wire replay for svc-market: every call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden/` holds what svc-market's tRPC router answered (main 2026-11-19, as it is, bugs included) to a
 * matrix of requests: every procedure of the router `index.ts` mounts, each call's own inputs and six generic ones, and
 * several callers, in two set-ups on a freshly migrated database. `blank` is every owner value blank and every outside
 * service unreachable, as `index.ts` builds the router from an empty environment. `set` is every owner value set, with
 * a seeded approved vendor, two listings, a funded buyer, a held purchase window, provider criteria and a track record.
 * Requests go through the production Fastify adapter with the edge context `index.ts` builds. A later move of these
 * calls must answer each one byte for byte the same; a wrong door, a changed refusal code, a widened input or a
 * reshaped envelope shows here as a difference.
 *
 * Each call's own inputs go to every caller. The six generic inputs (absent, null, a wrong type, `{}`, the valid input
 * plus a key, the valid input with every field null) go to the three callers that reach input checking in different
 * ways (nobody, a signed customer, a signed operator), which keeps the recording a size a reviewer can read.
 *
 * Ids and times the database makes are new on every run, so each is recorded by its place: a uuid the replay did not
 * choose becomes `<uuid-N>` in order of first appearance across the run (the same id keeps its number everywhere), an
 * ISO time becomes `<time>`, and a cursor built from them becomes `<cursor>`. tRPC's stack becomes `<stack>`. The
 * screening list is fixed here, so the recording does not change with the machine's environment.
 *
 * `/health` and `/ready` are plain Fastify routes written inline in `index.ts`, which connects to a database and
 * listens when imported; they are not in this recording.
 *
 * The recording is one file for the callers and, per set-up, files cut at call boundaries, so each new file stays under
 * the size one review part reads whole. `WIRE_REPLAY_WRITE=1` rewrites the golden files. Only for a change that is meant to change the wire, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
/** One recorded JSON file in the recording folder. */
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);
const SECRET = 'a-market-wire-replay-edge-secret-long-enough';
/** A port nothing listens on: an outside service that is not there. */
const NOWHERE = 'http://127.0.0.1:1';

const USER = '11111111-1111-4111-8111-111111111111';
const VENDOR_USER = '44444444-4444-4444-8444-444444444444';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PURCHASE = '66666666-6666-4666-8666-666666666666';
const MISSING = '77777777-7777-4777-8777-777777777777';
const PROPOSAL = '88888888-8888-4888-8888-888888888888';
const FIXED_IDS = new Set([USER, VENDOR_USER, OPERATOR, CONFIRM, PURCHASE, MISSING, PROPOSAL]);

/** The screening list and its fail-closed switches, fixed for the run: KP is screened out, every other region is not. */
const SCREENING_ENV: Record<string, string | undefined> = {
  APP_ENV: 'test',
  [SANCTIONS_REGIONS_ENV]: 'KP',
  [SANCTIONS_SOURCE_ENV]: 'wire-replay-fixture',
  [UNSIGNED_SANCTIONS_ROWS_ENV]: undefined,
  [SCREENING_FAIL_CLOSED_ENV]: undefined,
  [REGION_FAIL_CLOSED_ENV]: undefined,
};

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

let db: TestDatabase | undefined;

beforeAll(async () => {
  for (const [name, value] of Object.entries(SCREENING_ENV)) vi.stubEnv(name, value);
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is required (database name must end with _test)');
  db = await createTestDatabase({ service: 'market', url, migrations });
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await db?.drop();
}, 30_000);

/** Every vendor holds six slots on the Operator tier. */
class FixedEntitlement implements SlotEntitlementSource {
  async entitlementOf(): Promise<VendorEntitlement> {
    return { tierName: 'Operator', vendorSlots: 6 };
  }
}

/** What the set-up seeded, for the calls' own inputs. */
interface Seed {
  vendorId: string;
  oneTimeListing: string;
  subscriptionListing: string;
}

type Built = { router: ReturnType<typeof createMarketRouter>; seed: Seed };

/** Every owner value blank and every outside service unreachable, as `index.ts` builds the router from an empty environment. */
async function blank(sql: TestDatabase['sql']): Promise<Built> {
  vi.stubEnv(MARKET_LISTING_PIN_ENV, undefined);
  const vendors = new VendorService(sql, createStakeSource(NOWHERE, 'replay-internal-secret'));
  const commerce = new CommerceService(sql, vendors, createLedgerClient(NOWHERE, 'replay-internal-secret'), {
    commissionBps: null,
    hold: { on: false, refundWindowSeconds: null, releaseSweepSeconds: null, refundPolicy: null },
  });
  const signals = new SignalPublisher({
    sql,
    commerce,
    myVendor: (userId) => vendors.myVendor(userId),
    criteria: null,
    trackRecord: null,
  });
  const router = createMarketRouter(
    vendors,
    commerce,
    new PerpProposalService(sql, vendors),
    unwiredApprovalConsumer(),
    new ReviewsService(sql),
    signals,
  );
  return { router, seed: { vendorId: MISSING, oneTimeListing: MISSING, subscriptionListing: MISSING } };
}

/** Every owner value set, an approved vendor with two listings, a funded buyer and a held-purchase window. */
async function set(sql: TestDatabase['sql']): Promise<Built> {
  vi.stubEnv(MARKET_LISTING_PIN_ENV, 'BTC-USD');
  const vendors = new VendorService(sql, new FixedEntitlement());
  const ledger = new MemoryLedger();
  const commerce = new CommerceService(sql, vendors, ledger, {
    commissionBps: 500,
    hold: { on: true, refundWindowSeconds: 3_600, releaseSweepSeconds: 60, refundPolicy: 'seller_full' },
  });
  const signals = new SignalPublisher({
    sql,
    commerce,
    myVendor: (userId) => vendors.myVendor(userId),
    criteria: { minTier: 'basic', minFills: 1 },
    trackRecord: { recordOf: async () => ({ fills: 5, firstFillAt: '2026-01-01T00:00:00.000Z' }) },
  });
  const vendor = await vendors.applyAsVendor({ userId: VENDOR_USER, displayName: 'Replay Bots', description: 'Bots for the replay' });
  await vendors.vet({ vendorId: vendor.id, decision: 'approved', reason: 'replay seed', actorId: OPERATOR, actorScope: MARKET_OPS_SCOPE });
  const oneTime = await commerce.createListing({
    userId: VENDOR_USER,
    title: 'Replay bot',
    description: 'A one-time bot',
    offerType: 'one_time',
    assetId: 'USDT',
    price: '10',
  });
  const subscription = await commerce.createListing({
    userId: VENDOR_USER,
    title: 'Replay feed',
    description: 'A monthly feed',
    offerType: 'subscription',
    assetId: 'USDT',
    price: '5',
    periodSeconds: 2_592_000,
  });
  await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('1000'), rail: 'test', railRef: 'replay-buyer' }));
  const router = createMarketRouter(
    vendors,
    commerce,
    new PerpProposalService(sql, vendors),
    stubApprovalConsumer(CONFIRM),
    new ReviewsService(sql),
    signals,
  );
  return { router, seed: { vendorId: vendor.id, oneTimeListing: oneTime.id, subscriptionListing: subscription.id } };
}

const SETUPS: ReadonlyArray<[string, (sql: TestDatabase['sql']) => Promise<Built>]> = [
  ['blank', blank],
  ['set', set],
];

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-market' });

async function serve(router: Built['router']) {
  const app = Fastify({ maxParamLength: 5_000, genReqId: () => 'replay-request' });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router, createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
  return app;
}

type Call = { path: string; kind: 'query' | 'mutation'; own: Array<[string, unknown]> };

/** Each call with its own inputs: the valid one first, then the ones that reach its own refusals. In the order they run. */
function calls(seed: Seed): Call[] {
  const listing = seed.oneTimeListing;
  const sub = seed.subscriptionListing;
  return [
    { path: 'commerceProgramme', kind: 'query', own: [['valid', undefined]] },
    {
      path: 'applyAsVendor',
      kind: 'mutation',
      own: [
        ['valid', { displayName: 'Caller shop', description: 'I sell signals' }],
        ['blank-name', { displayName: '', description: 'I sell signals' }],
        ['long-description', { displayName: 'Caller shop', description: 'x'.repeat(2_001) }],
      ],
    },
    { path: 'mine', kind: 'query', own: [['valid', undefined]] },
    {
      path: 'listApplications',
      kind: 'query',
      own: [
        ['valid', { status: 'applied', limit: 10 }],
        ['no-limit', { status: 'approved' }],
        ['big-limit', { limit: 51 }],
        ['bad-status', { status: 'lost', limit: 10 }],
      ],
    },
    {
      path: 'vet',
      kind: 'mutation',
      own: [
        ['valid', { vendorId: seed.vendorId, decision: 'approved', reason: 'still fine', approvalId: 'appr-1', operationId: 'op-1' }],
        ['no-approval', { vendorId: seed.vendorId, decision: 'suspended', reason: 'checking' }],
        ['unknown-vendor', { vendorId: MISSING, decision: 'rejected', reason: 'no', approvalId: 'appr-2', operationId: 'op-2' }],
        ['bad-decision', { vendorId: seed.vendorId, decision: 'applied', reason: 'no' }],
      ],
    },
    {
      path: 'history',
      kind: 'query',
      own: [
        ['valid', { vendorId: seed.vendorId, limit: 10 }],
        ['no-limit', { vendorId: seed.vendorId }],
        ['bad-id', { vendorId: 'nope', limit: 10 }],
      ],
    },
    {
      path: 'claimSlot',
      kind: 'mutation',
      own: [
        ['valid', { ref: 'replay-slot' }],
        ['blank-ref', { ref: '' }],
      ],
    },
    { path: 'slots', kind: 'query', own: [['valid', undefined]] },
    {
      path: 'releaseSlot',
      kind: 'mutation',
      own: [
        ['valid', { ref: 'replay-slot' }],
        ['unheld', { ref: 'never-claimed' }],
      ],
    },
    {
      path: 'proposePerpMarket',
      kind: 'mutation',
      own: [
        ['valid', { clientProposalId: PROPOSAL, symbol: 'IFC-PERP', settle: 'USDC', oracleSource: 'replay-oracle', leverageCap: '5' }],
        ['blank-symbol', { clientProposalId: MISSING, symbol: '', settle: 'USDC', oracleSource: 'replay-oracle', leverageCap: '5' }],
      ],
    },
    {
      path: 'profile',
      kind: 'query',
      own: [
        ['valid', { vendorId: seed.vendorId }],
        ['unknown', { vendorId: MISSING }],
        ['bad-id', { vendorId: 'nope' }],
      ],
    },
    {
      path: 'listed',
      kind: 'query',
      own: [
        ['valid', { limit: 10 }],
        ['no-limit', undefined],
      ],
    },
    {
      path: 'listedPage',
      kind: 'query',
      own: [
        ['valid', { limit: 10 }],
        ['no-limit', {}],
        ['bad-cursor', { limit: 10, cursor: 'nope' }],
      ],
    },
    {
      path: 'createListing',
      kind: 'mutation',
      own: [
        ['valid', { title: 'Caller bot', description: 'A bot', offerType: 'one_time', assetId: 'USDT', price: '3' }],
        ['sub-no-period', { title: 'Caller feed', description: 'A feed', offerType: 'subscription', assetId: 'USDT', price: '3' }],
        ['zero-price', { title: 'Caller bot', description: 'A bot', offerType: 'one_time', assetId: 'USDT', price: '0' }],
        [
          'bad-category',
          { title: 'Caller bot', description: 'A bot', offerType: 'one_time', assetId: 'USDT', price: '3', category: 'nope' },
        ],
      ],
    },
    {
      path: 'createStrategyListing',
      kind: 'mutation',
      own: [
        ['valid', { title: 'Caller strategy', description: 'A strategy', assetId: 'USDT', price: '4', periodSeconds: 2_592_000 }],
        ['no-period', { title: 'Caller strategy', description: 'A strategy', assetId: 'USDT', price: '4' }],
      ],
    },
    {
      path: 'createNonStrategyListing',
      kind: 'mutation',
      own: [
        ['valid', { title: 'Caller course', description: 'A course', assetId: 'USDT', price: '2', category: 'data' }],
        ['no-price', { title: 'Caller course', description: 'A course', assetId: 'USDT', category: 'data' }],
        ['no-category', { title: 'Caller course', description: 'A course', assetId: 'USDT', price: '2' }],
      ],
    },
    {
      path: 'myListings',
      kind: 'query',
      own: [
        ['valid', { limit: 10 }],
        ['no-limit', undefined],
      ],
    },
    { path: 'marketData.policy', kind: 'query', own: [['valid', undefined]] },
    {
      path: 'marketData.book',
      kind: 'query',
      own: [
        ['valid', { marketId: 'BTC-USD', product: 'L2' }],
        ['l3', { marketId: 'BTC-USD', product: 'L3' }],
        ['executable-l3', { marketId: 'BTC-USD', product: 'executable_l3' }],
        ['queue', { marketId: 'BTC-USD', product: 'queue' }],
      ],
    },
    {
      path: 'marketData.quote',
      kind: 'query',
      own: [
        ['valid', { kind: 'indicative', price: '100' }],
        ['as-native', { kind: 'indicative', price: '100', asNativeExecutable: true }],
        ['as-bid-ask', { kind: 'index', price: '100', asBidAsk: true }],
        ['native', { kind: 'native_executable', price: '100' }],
        ['number-price', { kind: 'mark', price: 100 }],
      ],
    },
    { path: 'liveMarkets', kind: 'query', own: [['valid', undefined]] },
    { path: 'listedAssets', kind: 'query', own: [['valid', undefined]] },
    {
      path: 'listing',
      kind: 'query',
      own: [
        ['valid', { listingId: listing }],
        ['unknown', { listingId: MISSING }],
      ],
    },
    {
      path: 'listings',
      kind: 'query',
      own: [
        ['valid', { limit: 10 }],
        ['no-limit', undefined],
      ],
    },
    {
      path: 'listingsPage',
      kind: 'query',
      own: [
        ['valid', { sort: 'newest', limit: 10 }],
        ['no-sort', { limit: 10 }],
        ['search', { q: 'Replay', offerType: 'one_time', assetId: 'USDT', sort: 'priceAsc', limit: 10 }],
        ['bad-cursor', { sort: 'title', limit: 10, cursor: 'nope' }],
      ],
    },
    { path: 'listingCategories', kind: 'query', own: [['valid', undefined]] },
    {
      path: 'listingsByCategory',
      kind: 'query',
      own: [
        ['valid', { category: 'data', limit: 10 }],
        ['no-category', { limit: 10 }],
        ['unknown-category', { category: 'nope', limit: 10 }],
      ],
    },
    { path: 'subscribe', kind: 'mutation', own: [['valid', { listingId: sub }]] },
    { path: 'recurring', kind: 'mutation', own: [['valid', { listingId: sub }]] },
    {
      path: 'purchase',
      kind: 'mutation',
      own: [
        ['valid', { listingId: listing, purchaseId: PURCHASE }],
        ['subscription', { listingId: sub, purchaseId: CONFIRM }],
        ['unknown-listing', { listingId: MISSING, purchaseId: PROPOSAL }],
      ],
    },
    {
      path: 'myPurchases',
      kind: 'query',
      own: [
        ['valid', { limit: 10 }],
        ['no-limit', undefined],
      ],
    },
    {
      path: 'subscriptionAccess',
      kind: 'query',
      own: [
        ['valid', { listingId: sub }],
        ['one-time', { listingId: listing }],
      ],
    },
    {
      path: 'reviews.submit',
      kind: 'mutation',
      own: [
        ['valid', { purchaseId: PURCHASE, score: 5, text: 'Useful', clientRequestId: 'replay-review' }],
        ['bad-score', { purchaseId: PURCHASE, score: 6, clientRequestId: 'replay-review-2' }],
        ['unknown-purchase', { purchaseId: MISSING, score: 4, clientRequestId: 'replay-review-3' }],
      ],
    },
    {
      path: 'reviews.list',
      kind: 'query',
      own: [
        ['valid', { listingId: listing, limit: 10 }],
        ['no-limit', { listingId: listing }],
        ['bad-cursor', { listingId: listing, limit: 10, cursor: 'nope' }],
      ],
    },
    {
      path: 'reviews.summary',
      kind: 'query',
      own: [
        ['valid', { vendorId: seed.vendorId }],
        ['unknown', { vendorId: MISSING }],
      ],
    },
    {
      path: 'requestRefund',
      kind: 'mutation',
      own: [
        ['valid', { purchaseId: PURCHASE }],
        ['unknown', { purchaseId: MISSING }],
      ],
    },
    {
      path: 'refundRequests',
      kind: 'query',
      own: [
        ['valid', { limit: 10 }],
        ['no-limit', undefined],
      ],
    },
    {
      path: 'refund',
      kind: 'mutation',
      own: [
        ['valid', { purchaseId: PURCHASE }],
        ['unknown', { purchaseId: MISSING }],
      ],
    },
    {
      path: 'myEarnings',
      kind: 'query',
      own: [
        ['valid', { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' }],
        ['no-window', undefined],
        ['bad-from', { from: 'yesterday', to: '2027-01-01T00:00:00.000Z' }],
      ],
    },
    {
      path: 'cancelSubscription',
      kind: 'mutation',
      own: [
        ['valid', { listingId: sub }],
        ['unknown', { listingId: MISSING }],
      ],
    },
    {
      path: 'ops.sales',
      kind: 'query',
      own: [
        ['valid', { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z', limit: 10 }],
        ['no-limit', {}],
        ['bad-cursor', { limit: 10, cursor: 'nope' }],
      ],
    },
    {
      path: 'ops.setListingCategory',
      kind: 'mutation',
      own: [
        ['valid', { listingId: listing, category: 'data', reason: 'fits the data shelf', businessKey: 'replay-category' }],
        ['unknown-category', { listingId: listing, category: 'nope', reason: 'fits the data shelf', businessKey: 'replay-category-2' }],
      ],
    },
    {
      path: 'ops.takedownListing',
      kind: 'mutation',
      own: [
        [
          'valid',
          {
            listingId: sub,
            reason: 'replay takedown reason',
            approvalId: 'appr-3',
            operationId: 'op-3',
            clientRequestId: 'replay-takedown',
          },
        ],
        ['no-approval', { listingId: sub, reason: 'replay takedown reason', clientRequestId: 'replay-takedown-2' }],
        [
          'unknown',
          {
            listingId: MISSING,
            reason: 'replay takedown reason',
            approvalId: 'appr-4',
            operationId: 'op-4',
            clientRequestId: 'replay-takedown-3',
          },
        ],
      ],
    },
    {
      path: 'archiveListing',
      kind: 'mutation',
      own: [
        ['valid', { listingId: listing }],
        ['unknown', { listingId: MISSING }],
      ],
    },
    { path: 'signals.criteria', kind: 'query', own: [['valid', undefined]] },
    {
      path: 'signals.publish',
      kind: 'mutation',
      own: [
        [
          'valid',
          {
            publishKey: 'replay-signal',
            title: 'Replay signal',
            description: 'A signal',
            assetId: 'USDT',
            feeModel: 'monthly',
            price: '7',
            periodSeconds: 2_592_000,
          },
        ],
        [
          'no-price',
          {
            publishKey: 'replay-signal-2',
            title: 'Replay signal',
            description: 'A signal',
            assetId: 'USDT',
            feeModel: 'monthly',
            periodSeconds: 2_592_000,
          },
        ],
        [
          'profit-share',
          {
            publishKey: 'replay-signal-3',
            title: 'Replay signal',
            description: 'A signal',
            assetId: 'USDT',
            feeModel: 'profit_share',
            price: '7',
          },
        ],
      ],
    },
    {
      path: 'signals.mine',
      kind: 'query',
      own: [
        ['valid', { limit: 10 }],
        ['no-limit', {}],
      ],
    },
    {
      path: 'signals.list',
      kind: 'query',
      own: [
        ['valid', { limit: 10 }],
        ['big-limit', { limit: 51 }],
      ],
    },
    {
      path: 'signals.earnings',
      kind: 'query',
      own: [
        ['valid', { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' }],
        ['bad-window', { from: '2027-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }],
      ],
    },
    {
      path: 'signals.archive',
      kind: 'mutation',
      own: [
        ['valid', { signalId: MISSING }],
        ['bad-id', { signalId: 'nope' }],
      ],
    },
  ];
}

/** The generic inputs: nothing; null; a wrong type; an empty object; the valid input plus a key; the valid input with every field null. */
function generic(call: Call): Array<[string, unknown]> {
  const valid = call.own[0]![1];
  const isObject = valid !== null && typeof valid === 'object' && !Array.isArray(valid);
  return [
    ['absent', undefined],
    ['null', null],
    ['wrong-type', 7],
    ['empty', {}],
    ['extra-key', isObject ? { ...(valid as object), extra: 1 } : { extra: 1 }],
    ['all-null', isObject ? Object.fromEntries(Object.keys(valid as object).map((k) => [k, null])) : null],
  ];
}

type How = 'signed' | 'forged' | 'none';
interface Caller {
  readonly name: string;
  readonly user: string;
  readonly scopes: Scope[];
  readonly tier: Principal['tier'];
  readonly mfa: boolean;
  readonly region: string;
  readonly how: How;
}

const CUSTOMER: Scope[] = ['market:read', 'market:write'];
/**
 * Nobody; a verified customer in a served region, in an unserved one and in a screened one; an unverified customer; the
 * seeded vendor; an operator with MFA; and an operator's principal with no signature.
 */
const CALLERS: readonly Caller[] = [
  { name: 'anon', user: USER, scopes: [], tier: 'none', mfa: false, region: 'DE', how: 'none' },
  { name: 'signed', user: USER, scopes: CUSTOMER, tier: 'basic', mfa: false, region: 'DE', how: 'signed' },
  { name: 'signed-US', user: USER, scopes: CUSTOMER, tier: 'basic', mfa: false, region: 'US', how: 'signed' },
  { name: 'signed-KP', user: USER, scopes: CUSTOMER, tier: 'basic', mfa: false, region: 'KP', how: 'signed' },
  { name: 'tier-none', user: USER, scopes: CUSTOMER, tier: 'none', mfa: false, region: 'DE', how: 'signed' },
  { name: 'vendor', user: VENDOR_USER, scopes: CUSTOMER, tier: 'basic', mfa: false, region: 'DE', how: 'signed' },
  { name: 'ops', user: OPERATOR, scopes: [MARKET_OPS_SCOPE as Scope], tier: 'none', mfa: true, region: 'DE', how: 'signed' },
  { name: 'forged', user: OPERATOR, scopes: [MARKET_OPS_SCOPE as Scope], tier: 'none', mfa: true, region: 'DE', how: 'forged' },
];
/** The callers the generic inputs go to. */
const GENERIC_CALLERS = new Set(['anon', 'signed', 'ops']);

function headers(caller: Caller): Record<string, string> {
  if (caller.how === 'none') return { 'x-intafaced-region': caller.region };
  const principal = {
    sub: caller.user,
    userId: caller.user,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: caller.scopes,
    tier: caller.tier,
    mfa: caller.mfa,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    ...(caller.how === 'signed' ? { 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, caller.region) } : {}),
    'x-intafaced-region': caller.region,
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/** Ids and times the database made, recorded by their place; the numbering carries over the whole run. */
function stable(body: string, ids: Map<string, string>): string {
  return body
    .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
    .replace(/"(nextCursor|cursor)":"(?:[^"\\]|\\.)*"/g, '"$1":"<cursor>"')
    .replace(UUID, (id) => {
      if (FIXED_IDS.has(id)) return id;
      if (!ids.has(id)) ids.set(id, `<uuid-${ids.size + 1}>`);
      return ids.get(id)!;
    })
    .replace(ISO_TIME, '<time>');
}

async function hit(app: Awaited<ReturnType<typeof serve>>, call: Call, input: unknown, h: Record<string, string>) {
  const url = `/trpc/${call.path}${call.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  return call.kind === 'query'
    ? app.inject({ method: 'GET', url, headers: h })
    : app.inject({
        method: 'POST',
        url,
        headers: { ...h, 'content-type': 'application/json' },
        payload: input === undefined ? '' : JSON.stringify(input),
      });
}

interface Golden {
  readonly callers: unknown;
  readonly answers: Record<string, { status: number; body: string }>;
}

/** Most bytes one recording file holds, so each new file stays under the size one review part reads whole. */
const PART_BYTES = 300_000;

/** One set-up's answers in run order, cut into files at call boundaries, each at most `PART_BYTES` where a call fits. */
function parts(setup: string, answers: Golden['answers']): Array<Golden['answers']> {
  const out: Array<Golden['answers']> = [];
  let part: Golden['answers'] = {};
  let size = 0;
  let lastPath = '';
  for (const [key, answer] of Object.entries(answers)) {
    if (!key.startsWith(`${setup} `)) continue;
    const path = key.split(' ')[1]!;
    const bytes = key.length + answer.body.length + 40;
    if (path !== lastPath && size > 0 && size + bytes > PART_BYTES * 0.9) {
      out.push(part);
      part = {};
      size = 0;
    }
    part[key] = answer;
    size += bytes;
    lastPath = path;
  }
  if (size > 0) out.push(part);
  return out;
}

async function replay(): Promise<Golden> {
  const sql = db!.sql;
  const answers: Golden['answers'] = {};
  let callers: unknown;
  for (const [setup, build] of SETUPS) {
    await sql`
      TRUNCATE market.reviews, market.listing_takedowns, market.listing_category_events, market.subscription_state,
               market.purchases, market.listings, market.vendor_slots, market.vendor_status_events, market.vendors,
               market.perp_proposal_status_events, market.perp_proposals
      RESTART IDENTITY CASCADE
    `;
    const ids = new Map<string, string>();
    const { router, seed } = await build(sql);
    callers ??= procedureCallers(router as never);
    const app = await serve(router);
    try {
      for (const call of calls(seed)) {
        const matrix: Array<[string, unknown, readonly Caller[]]> = [
          ...call.own.map(([name, input]): [string, unknown, readonly Caller[]] => [name, input, CALLERS]),
          ...generic(call).map(([name, input]): [string, unknown, readonly Caller[]] => [
            name,
            input,
            CALLERS.filter((c) => GENERIC_CALLERS.has(c.name)),
          ]),
        ];
        for (const [inputName, input, who] of matrix)
          for (const caller of who) {
            const res = await hit(app, call, input, headers(caller));
            answers[`${setup} ${call.path} ${inputName} ${caller.name}`] = { status: res.statusCode, body: stable(res.body, ids) };
          }
      }
    } finally {
      await app.close();
      vi.stubEnv(MARKET_LISTING_PIN_ENV, undefined);
    }
  }
  return { callers, answers };
}

describe('the wire replay: svc-market answers as main did on 2026-11-19', () => {
  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    const now = await replay();
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    if (process.env.WIRE_REPLAY_WRITE === '1') {
      rmSync(GOLDEN, { recursive: true, force: true });
      mkdirSync(GOLDEN, { recursive: true });
      writeFileSync(goldenJson('callers'), json(now.callers));
      for (const [setup] of SETUPS)
        parts(setup, now.answers).forEach((part, i) => writeFileSync(goldenJson(`${setup}-${i + 1}`), json(part)));
    }
    const read = (name: string): unknown => JSON.parse(readFileSync(goldenJson(name), 'utf8'));
    const answerFiles = readdirSync(GOLDEN).filter((f) => f !== 'callers.json');
    const golden: Golden = {
      callers: read('callers'),
      answers: Object.assign({}, ...answerFiles.map((f) => read(f.replace(/\.json$/, '')))) as Golden['answers'],
    };
    expect(Object.keys(golden.answers)).toHaveLength(Object.keys(now.answers).length);
    expect(now.callers).toEqual(golden.callers);
    const diffs = Object.entries(golden.answers)
      .filter(([key, was]) => now.answers[key]?.status !== was.status || now.answers[key]?.body !== was.body)
      .map(
        ([key, was]) =>
          `${key}: ${was.status} ${was.body.slice(0, 160)} != ${now.answers[key]?.status} ${now.answers[key]?.body.slice(0, 160)}`,
      );
    expect(diffs).toEqual([]);
  }, 300_000);
});
