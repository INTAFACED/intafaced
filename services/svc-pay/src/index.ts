import Fastify from 'fastify';
import postgres from 'postgres';
import { env } from './env.js';
import { PayError, PayService } from './payment-service.js';
import { UserMoneyService } from './user-money-service.js';
import { createLedgerClient } from './ledger-client.js';
import { BankPayoutAbsentAdapter } from './rails/bank-payout.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { CryptoNativeAdapter } from './rails/crypto-native.js';
import { RailRegistry } from './rails/registry.js';
import { CryptoChainWatcher } from './rails/chain-watcher.js';
import { EvmLiveChain } from './rails/evm-chain.js';
import { PostgresBroadcastStore } from './rails/broadcast-store.js';
import { PostgresRestIdempotencyStore } from './rest-idempotency.js';
import { MerchantWebhookService, PostgresMerchantWebhookStore } from './merchant-webhooks.js';
import {
  assertRailPosture,
  defaultChainFor,
  railPostureStatus,
  selectPublicCheckoutRail,
  shouldRegisterCardSandbox,
} from './rails/posture.js';
import { createPayRouter } from './router.js';
import { MerchantPayoutDestinationStore } from './merchant-payout-destination.js';
import { createAffiliateAccrueClient } from './affiliate-accrue.js';
import { MerchantStateService } from './merchant-state-service.js';
import { createMerchantStateRouter } from './merchant-state-router.js';
import { KybService } from './kyb-service.js';
import { PspModeService, assertNoThirdPartyMoneyLibrary } from './psp-mode.js';
import { createKybPspRouter } from './kyb-router.js';
import { SubMerchantService } from './submerchants.js';
import { createSubMerchantRouter } from './submerchant-router.js';
import { createSubscriptionRouter } from './subscription-router.js';
import { registerCheckoutRoutes } from './checkout-page.js';
import { registerPublicPayRest } from './public-rest.js';
import { SubscriptionService, registerSubscriptionCycleRoutes } from './subscriptions/index.js';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createEdgeContext, mergeRouters } from '@intafaced/contracts';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';

// §9 — register the TracerProvider before the first span is created.
// `@opentelemetry/api` alone is a no-op: without this call every span in
// ./tracing.ts is built, tagged and then discarded before it reaches the
// collector. Tracers grabbed at module scope resolve lazily through the proxy
// provider, so registering here still captures them.
registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-pay — the payments core (§6.1).
 *
 * Gateway mode, the `RailAdapter` interface, and the two v1 adapters. PSP mode
 * (digital KYB + custom pricing durability, no third-party money library —
 * D-S-10) is mounted beside merchant state. PayFac trees, smart routing, fraud
 * scoring, the checkout builder, subscriptions and plugins are each a separate
 * tracker feature, and none of them requires a change to the adapter interface
 * — which is the claim `src/rails/conformance.ts` exists to keep testable.
 */

// D-S-10 / Doctrine 5 — refuse boot if a third-party money orchestrator landed
// in svc-pay's package.json. Socket.psp-partners stays a commercial relationship.
assertNoThirdPartyMoneyLibrary();

const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'pay,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});

await sql`SELECT 1 FROM pay.merchants LIMIT 1`.catch(() => {
  throw new Error('pay schema is missing — run migrations before starting svc-pay');
});

// Value moves through svc-ledger, never through this service's own tables
// (Doctrine §0.6). This client is the only path.
const ledger = createLedgerClient(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET);

/**
 * The chain behind `crypto-native`.
 *
 * `defaultChainFor` picks:
 *   · `EvmLiveChain` when `PAY_CRYPTO_RPC_URL` (+ keys/assets) are set — LIVE
 *   · `UnconfiguredChain` in staging/prod with nothing set — refuses
 *   · `MemoryChain` in dev/test with nothing set — suite fixture
 *
 * `card-sandbox` is registered only when `shouldRegisterCardSandbox` says so
 * (dev/test by default). A staging/prod deployment with a live crypto rail must
 * not also register the sandbox acquirer, or boot fails unless the operator
 * deliberately sets `PAY_ALLOW_SANDBOX_RAILS=true`.
 */
/**
 * Live crypto outbound broadcasts journal in Postgres so multi-replica fleets
 * share claim→putSigned→sendRaw→put (MemoryBroadcastStore alone is single-process).
 * Unconfigured/Memory chain paths ignore the store.
 */
const broadcasts = new PostgresBroadcastStore(sql);
const chain = defaultChainFor(process.env, broadcasts);

const cryptoRail = new CryptoNativeAdapter({
  chain,
  secret: env.PAY_CRYPTO_WEBHOOK_SECRET,
  minConfirmations: env.PAY_MIN_CONFIRMATIONS,
  toleranceSeconds: env.PAY_WEBHOOK_TOLERANCE_SECONDS,
});
const rails = new RailRegistry([
  cryptoRail,
  // Always registered. mode:'absent' — not a sandbox, so staging/prod boot is
  // fine. Merchants who ask for bank settlement get pay.rail_not_live before any
  // hold, instead of a silent "rail unknown" or a card-sandbox lie.
  new BankPayoutAbsentAdapter(),
  ...(shouldRegisterCardSandbox(process.env)
    ? [
        new CardSandboxAdapter({
          secret: env.PAY_CARD_SANDBOX_WEBHOOK_SECRET,
          toleranceSeconds: env.PAY_WEBHOOK_TOLERANCE_SECONDS,
        }),
      ]
    : []),
]);

/**
 * IS THIS DEPLOYMENT ALLOWED TO MOVE REAL MONEY THROUGH A RAIL THAT IS NOT REAL?
 *
 * Asserted before the listener opens, in the same spirit as `createEdgeContext`
 * below and `assertScreeningConfigured` in packages/config: a property the
 * platform claims is checked at startup, and the process refuses to run rather
 * than quietly mislead users about their money.
 *
 * Throws in `staging`/`prod` while any registered rail is a sandbox, unless an
 * operator has said `PAY_ALLOW_SANDBOX_RAILS=true` by name. The returned policy
 * is handed to both services below, so the boot refusal and the per-call refusal
 * are one decision rather than two that can drift apart.
 */
const railPosture = assertRailPosture(rails, { ...process.env, PAY_ALLOW_SANDBOX_RAILS: env.PAY_ALLOW_SANDBOX_RAILS });
const railStatus = railPostureStatus(rails, railPosture.policy);

/**
 * A rail named in `PAY_CHECKOUT_RAILS` that is not registered would mean the
 * public checkout silently falling through to the next entry — or, on a
 * single-entry list, refusing every payer with "no rail configured" while the
 * operator believes one is. That is a deployment mistake and it belongs at boot,
 * exactly like `PAY_OPERATOR_CREDIT_RAILS` below.
 */
for (const { railId } of env.PAY_CHECKOUT_RAILS) {
  if (!rails.has(railId)) {
    throw new Error(`PAY_CHECKOUT_RAILS names "${railId}", which is not a registered rail. Registered: ${rails.ids().join(', ')}`);
  }
}

/**
 * Outbound merchant webhooks (pay.public-api step 3 / ADR §2.4).
 * Durable journal — Memory alone is not multi-replica safe.
 * Does not move value; enqueue runs after money commits.
 */
const merchantWebhooks = new MerchantWebhookService(new PostgresMerchantWebhookStore(sql));

const payoutDestinations = new MerchantPayoutDestinationStore(sql);
const pay = new PayService(sql, ledger, rails, {
  payoutDestinations,
  defaultFeeBps: env.PAY_DEFAULT_FEE_BPS,
  valueMovement: railPosture.policy,
  // NOT `railPosture.policy`. `PAY_ALLOW_SANDBOX_RAILS` relaxes the payout gate
  // for a pilot or a demo — a statement about people inside this deployment. A
  // hosted checkout is reachable by strangers, so it follows the environment.
  publicCheckoutMovement: railPosture.publicCheckoutPolicy,
  checkoutRails: env.PAY_CHECKOUT_RAILS,
  checkoutRiskBand: env.PAY_CHECKOUT_RISK_BAND,
  checkoutSessionTtlSeconds: env.PAY_CHECKOUT_SESSION_TTL_SECONDS,
  linkDefaultTtlDays: env.PAY_LINK_DEFAULT_TTL_DAYS,
  linkMaxTtlDays: env.PAY_LINK_MAX_TTL_DAYS,
  maxOpenSessionsPerLink: env.PAY_CHECKOUT_MAX_OPEN_SESSIONS,
  affiliateAccrue: env.IDENTITY_URL ? createAffiliateAccrueClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET) : undefined,
  afterPaymentEvent: async (event) => {
    await merchantWebhooks.enqueue(event);
    // Watch half of invoice-and-watch (SPEC §4): capture settles the execution.
    if (event.type === 'payment.captured') {
      await subscriptions.markExecutionSettledForPayment(event.payment.id);
    }
  },
});

/**
 * Subscriptions — mandate store + due runner (invoice path, no pull).
 * Merchant surface is `createSubscriptionRouter`; cron is POST /internal/jobs/….
 * Instantiated after `pay` so the invoice opener can create payments.
 */
const subscriptions = new SubscriptionService(
  sql,
  () => new Date(),
  async (input) => {
    const payment = await pay.createPayment({
      merchantId: input.merchantId,
      amount: input.amount,
      assetId: input.assetId,
      method: 'crypto',
      railAdapter: 'crypto-native',
      metadata: {
        source: 'subscription',
        subscriptionId: input.subscriptionId,
        occurrence: String(input.occurrence),
        customerId: input.customerId,
        /*
         * The BUSINESS key for the period, carried onto the payment so an
         * operator reconciling a suspected double charge can see which PERIOD a
         * payment belongs to without joining anything. Derived from
         * (subscription, occurrence) and from nothing else — that is the
         * difference between a retry that charges once and the shape that
         * drained a pot here.
         */
        subscriptionCycleKey: input.idempotencyKey,
      },
    });
    return { paymentId: payment.id };
  },
  {
    /*
     * EVERY RATE IS OWNER-ONLY, and the cycle has to refuse EARLIER than
     * settlement does.
     *
     * `PAY_DEFAULT_FEE_BPS` is unset by default on purpose (see `env.ts`), and a
     * merchant may carry no `pricing.feeBps` of its own. `prepareSettlement`
     * already refuses to settle at an unknown price rather than settling at zero
     * — "revenue that is not merely lost but invisible". A subscription must
     * refuse to OPEN the charge, because by settlement time the customer has
     * already paid and the refusal has arrived too late to be honest.
     */
    defaultFeeBps: env.PAY_DEFAULT_FEE_BPS,
    resolveMerchantFeeBps: async (merchantId) => (await pay.getMerchant(merchantId)).pricing.feeBps,
    valueMovement: railPosture.policy,
  },
);

/**
 * User money in and out (§4.2). Merchant money is `PayService`; this is a user's
 * own balance crossing the platform boundary.
 *
 * Fails fast on a misconfigured credit rail. `PAY_OPERATOR_CREDIT_RAILS` naming
 * a rail that is not registered would mean every operator deposit on it failing
 * at request time with an error about a rail id, which reads like a caller
 * mistake; it is a deployment one, and it belongs at boot.
 *
 * Exception: the default list includes `card-sandbox`, and a live staging/prod
 * deployment deliberately does not register that adapter. Skipping the default
 * entry is correct; naming any OTHER missing rail is still a boot failure.
 */
const operatorCreditRails: string[] = [];
for (const railId of env.PAY_OPERATOR_CREDIT_RAILS) {
  if (rails.has(railId)) {
    operatorCreditRails.push(railId);
    continue;
  }
  if (railId === 'card-sandbox' && !shouldRegisterCardSandbox(process.env)) {
    continue;
  }
  throw new Error(`PAY_OPERATOR_CREDIT_RAILS names "${railId}", which is not a registered rail. Registered: ${rails.ids().join(', ')}`);
}

const userMoney = new UserMoneyService(sql, ledger, rails, {
  operatorCreditRails,
  valueMovement: railPosture.policy,
});

/**
 * The writer for `merchants.status`, and the history behind it.
 *
 * Its own service and its own router because `merchants.status` is an OPERATOR
 * control, not a merchant one: `PayService` reads it and refuses payments on it,
 * and nothing in the repository ever wrote it except a line of raw SQL inside a
 * test. See `merchant-state-service.ts` for the ADR clause this closes, and for
 * what it deliberately does not decide.
 */
const merchantState = new MerchantStateService(sql);

/**
 * Digital KYB (live operator decide + history) and PSP custom-pricing durability.
 * Path-disjoint from settlement / fraud. See `kyb-service.ts` / `psp-mode.ts`.
 */
const kyb = new KybService(sql);
const pspMode = new PspModeService(sql);

/**
 * PayFac sub-merchant trees and the permissions over them (§6.1).
 *
 * NO LEDGER CLIENT, ON PURPOSE. This service decides who may act on whose behalf
 * inside one merchant tree; it never moves value, holds a balance or knows an
 * amount. Value still leaves and enters the book through `PayService` /
 * `UserMoneyService` and their recipes, exactly as before (Doctrine §0.6).
 */
const subMerchants = new SubMerchantService(sql);

/**
 * MERGED, not nested.
 *
 * `mergeRouters` keeps one wire surface, so the edge still forwards `/api/pay`
 * to a single tRPC router and no caller has to learn a second mount. The admin
 * procedures live under `merchantState.*` and carry `admin:write` / `admin:read`
 * rather than the `pay:*` scopes the merchant surface uses — see
 * `merchant-state-router.ts` for why those and not the other three.
 *
 * Two routers rather than one file only because `router.ts` is held by open PR
 * #346 and dual-editing a partner's file is how two branches both end up
 * unmergeable. The composition is not a workaround, though: an operator surface
 * and a merchant surface having separate files is the shape this would want
 * anyway.
 */
export const appRouter = mergeRouters(
  // trees fence: gateway money paths check PayFac areas (merchant-ownership).
  createPayRouter(pay, rails, userMoney, subMerchants, payoutDestinations),
  createMerchantStateRouter(merchantState),
  createKybPspRouter(kyb, pspMode),
  // `pay` is passed only as the ACTOR LOOKUP — the router resolves the caller's
  // own merchant node from the authenticated principal, because a merchant node
  // taken from a request body would let any merchant claim to be acting as any
  // other and the subtree fence would be measuring the wrong actor.
  createSubMerchantRouter(subMerchants, pay),
  createSubscriptionRouter(subscriptions, pay, subMerchants),
);
export type { PayRouter } from './router.js';
export type { MerchantStateRouter } from './merchant-state-router.js';
export type { KybPspRouter } from './kyb-router.js';
export type { SubMerchantRouter } from './submerchant-router.js';
export type { SubscriptionRouter } from './subscription-router.js';

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

/**
 * Built before the listener opens: a service that cannot authenticate the edge
 * must fail to start, not start and serve every caller as anonymous.
 */
const edgeContext = createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, serviceName: env.SERVICE_NAME });

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));

/**
 * `/ready` NAMES WHICH RAILS ARE REAL.
 *
 * It used to answer `rails: ['crypto-native', 'card-sandbox']`, which reads as
 * two working rails. An operator dashboard rendering that has no way to know
 * that neither of them can send a payment anywhere. The list of ids is the same;
 * what is added is the only part that matters when somebody asks "can users
 * withdraw".
 */
/**
 * `publicCheckout` IS ITS OWN QUESTION, and it is not answered by `liveRails`.
 *
 * "Which rails are live" and "can an anonymous person on the hosted checkout
 * actually pay this merchant right now" are different, because the public
 * surface is gated more strictly than the merchant integration path is: a
 * sandbox rail that is perfectly usable for `payment.create` is refused for a
 * hosted checkout under `live-only`. An operator console that renders the first
 * and infers the second will tell somebody the checkout works when every payer
 * is getting a 503.
 */
function publicCheckoutStatus(): { rails: string[]; acceptable: boolean; reason?: string } {
  const configured = env.PAY_CHECKOUT_RAILS.map((r) => r.railId);
  try {
    // The SAME policy the request path uses, or `/ready` would report a
    // checkout as working that every payer is being refused from.
    const adapter = selectPublicCheckoutRail(rails, configured, railPosture.publicCheckoutPolicy);
    return { rails: configured, acceptable: true, reason: `would open on ${adapter.id}` };
  } catch (err) {
    return { rails: configured, acceptable: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

app.get('/ready', async () => ({
  ready: true,
  rails: rails.ids(),
  railModes: Object.fromEntries(rails.list().map((r) => [r.id, r.mode])),
  liveRails: railStatus.live,
  sandboxRails: railStatus.sandbox,
  valueMovement: railStatus.policy,
  chain: chain.description,
  publicCheckout: publicCheckoutStatus(),
}));

/**
 * Hosted payment-link checkout (HTML). Public — the token is the capability.
 * Browser reaches it via edge `/api/pay/checkout?token=…` (prefix stripped).
 */
await registerCheckoutRoutes(app, pay, { basePath: env.PAY_PUBLIC_BASE_PATH });

/**
 * Subscription charge cycle (SPEC §4). External cron, not setInterval.
 *
 * The handler used to be inline here. It moved into
 * `subscriptions/internal-cycle-routes.ts` so a test can reach it over HTTP:
 * `reachability` is a doctrine gate, and a route defined in the file that also
 * reads env, opens the pool and calls `listen()` is not reachable from a suite.
 * The mount is this line; there is no second copy of the handler.
 *
 * Crypto path opens a payment/invoice (never pull). Service credentials required
 * so an unauthenticated caller cannot fan out invoices to every customer on the
 * platform.
 */
registerSubscriptionCycleRoutes(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  subscriptions,
});

/**
 * STEP 1–3 — the merchant REST surface (reads + mutations + webhooks).
 *
 * Law: docs/adr/2026-08-07-pay-public-api-law.md. Auth is the same mount
 * boundary the tRPC router uses — svc-edge exchanges the key and signs
 * a principal; this service never sees a raw key and grows no second auth path.
 *
 * Mutating POSTs require Idempotency-Key (ADR §2.2). The durable journal is
 * the same claim→put shape as crypto broadcasts — Memory alone is not
 * multi-replica safe on a money path.
 *
 * Step 3 webhooks: signed outbound deliveries, retry/backoff, failure dashboard.
 * Not Class X go-live. Not sandbox-key routing (step 4). Not a live acquirer.
 */
await registerPublicPayRest(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  serviceName: env.SERVICE_NAME,
  pay,
  idempotency: new PostgresRestIdempotencyStore(sql),
  webhooks: merchantWebhooks,
  trees: subMerchants,
});

/** Drain outbound merchant webhook deliveries (ADR §2.4 retry). */
const webhookDrain = setInterval(() => {
  void merchantWebhooks.processDue().catch((err) => {
    app.log.warn({ err }, 'merchant webhook drain failed');
  });
}, 15_000);
webhookDrain.unref?.();

/**
 * THE WEBHOOK ENDPOINT.
 *
 * Reachable by anyone on the internet, and what it says is "money moved". Two
 * things therefore matter here and nowhere else in this file:
 *
 *  1. The RAW body. `content-type-parser` is disabled for this route so the
 *     bytes that were signed are the bytes that get verified. Fastify's JSON
 *     parser would hand us an object, and re-serialising it changes key order
 *     and whitespace — at which point every honest delivery fails and somebody
 *     "fixes" it by relaxing the check.
 *
 *  2. One response for every rejection. A verification endpoint that explains
 *     why it rejected something is an oracle for forging the next attempt.
 */
/**
 * THE PARSER COLLISION, and why the webhook is encapsulated.
 *
 * This service needs two mutually exclusive body parsers on one port:
 *
 *   · the webhook needs the RAW STRING, or signature verification compares
 *     re-serialised bytes against a signature over the original ones;
 *   · tRPC needs a PARSED OBJECT, and is handed a string it cannot read.
 *
 * Registering the raw parser on the root instance — as this file did while
 * nothing was mounted — makes every tRPC procedure fail to deserialise its
 * input. The failure is not obvious: the request arrives, the router matches,
 * and zod reports a malformed payload, which reads like a client bug.
 *
 * Fastify content-type parsers are per-encapsulation-context, so the webhook
 * gets its own plugin scope and its parser stays inside it. Nothing outside
 * this scope is affected, and the two can share a port without either being
 * compromised for the other's benefit.
 */
await app.register(async (webhookScope) => {
  webhookScope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  webhookScope.post<{ Params: { railId: string }; Body: string }>('/webhooks/:railId', async (request, reply) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
    }

    try {
      const outcome = await pay.handleWebhook(request.params.railId, {
        headers,
        body: typeof request.body === 'string' ? request.body : '',
      });
      // A duplicate is a 200. A rail that gets anything else will keep retrying
      // a delivery we have already handled, forever.
      return reply.code(200).send({ received: true, duplicate: outcome.duplicate });
    } catch (err) {
      if (err instanceof PayError && err.code === 'pay.webhook_invalid') {
        return reply.code(401).send({ error: 'invalid signature' });
      }
      if (err instanceof PayError && err.code === 'pay.webhook_unmatched') {
        // 202: the delivery is genuine but about something we do not know. Not
        // the rail's fault, and not something a retry will fix — an operator
        // signal, and the trace carries the detail.
        app.log.warn({ err: err.message, railId: request.params.railId }, 'verified webhook matched no payment');
        return reply.code(202).send({ received: true, matched: false });
      }
      throw err;
    }
  });
});

/**
 * The user-facing surface, reached only through svc-edge.
 *
 * The mount boundary decision records pay as "gateway only". That was written
 * before svc-edge existed and it meant NOT PUBLICLY EXPOSED — which is now
 * satisfied by the edge being the only public listener. It did not mean "does
 * not serve /trpc": the edge routes `/api/pay` here, so without this mount it
 * forwards to a service with nothing to forward to.
 */
await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => edgeContext({ headers: req.headers, id: req.id }),
  } satisfies FastifyTRPCPluginOptions<typeof appRouter>['trpcOptions'],
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });

/**
 * In-process watcher: when the chain is live, poll for finalized deposits and
 * POST signed webhooks to ourselves. Disabled when the chain is MemoryChain /
 * UnconfiguredChain, or when `PAY_CRYPTO_WATCHER_ENABLED=false`.
 */
let watcher: CryptoChainWatcher | null = null;
if (chain instanceof EvmLiveChain && env.PAY_CRYPTO_WATCHER_ENABLED === 'true') {
  watcher = new CryptoChainWatcher({
    chain,
    secret: env.PAY_CRYPTO_WEBHOOK_SECRET,
    webhookUrl: `http://127.0.0.1:${env.HTTP_PORT}/webhooks/crypto-native`,
    pollIntervalMs: env.PAY_CRYPTO_WATCHER_INTERVAL_MS,
    log: (msg, extra) => app.log.info(extra ?? {}, msg),
  });
  watcher.start();
  app.log.info({ intervalMs: env.PAY_CRYPTO_WATCHER_INTERVAL_MS }, 'crypto chain watcher started');
}

/**
 * The posture goes in the log on every start. In dev, where `assertRailPosture`
 * does not throw, THIS LINE IS THE CONTROL'S ONLY VISIBILITY — the same reason
 * `screeningStatus` returns a summary string rather than just a boolean.
 */
if (railStatus.sandbox.length > 0) {
  app.log.warn({ ...railStatus, chain: chain.description, appEnv: railPosture.appEnv }, railStatus.summary);
}
if (railPosture.sandboxOverride) {
  app.log.warn(
    { appEnv: railPosture.appEnv, sandboxRails: railStatus.sandbox },
    'PAY_ALLOW_SANDBOX_RAILS=true — sandbox rails may move value in a production-like environment. ' +
      'No user of this deployment is being told anything true about their money leaving the platform.',
  );
}

app.log.info(
  {
    port: env.HTTP_PORT,
    rails: rails.ids(),
    liveRails: railStatus.live,
    valueMovement: railStatus.policy,
    cryptoMode: cryptoRail.mode,
    watcher: watcher !== null,
    trpc: true,
  },
  'svc-pay ready',
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      watcher?.stop();
      // Draining, not dropping: an in-flight capture finishes before the
      // process exits, because the alternative is a payment captured at a rail
      // that this service never got to book.
      await app.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
