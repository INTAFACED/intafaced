import { z } from 'zod';
import { edgeEnvSchema, internalServiceEnvSchema, loadEnv, serviceEnvSchema } from '@intafaced/config';
import { parseOwnerIntegerEnv } from './fee-bps-env.js';
import { operatorCreditRailsSchema } from './operator-credit-rails-env.js';

const schema = serviceEnvSchema
  .merge(internalServiceEnvSchema)
  .merge(edgeEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-pay'),
      HTTP_PORT: z.coerce.number().int().default(4006),

      /** svc-ledger's internal address. All value movement goes through it. */
      LEDGER_URL: z.string().url().default('http://localhost:4001'),

      /**
       * Webhook signing secret for the chain watcher that feeds `crypto-native`.
       *
       * A forged delivery on this endpoint says "this payment was captured" about
       * money that never moved, so there is no development default: an unset
       * secret fails startup rather than quietly verifying everything.
       */
      PAY_CRYPTO_WEBHOOK_SECRET: z.string().min(32),

      /** Same, for the sandbox acquirer. Sandbox money is still a real state machine. */
      PAY_CARD_SANDBOX_WEBHOOK_SECRET: z.string().min(32),

      /**
       * Confirmations before an on-chain transfer counts as final.
       *
       * The reorg risk budget. Too low and a deep reorg takes back money already
       * settled to a merchant out of a clearing account that has since emptied.
       * No git default: blank refuses. Owner may set 6 explicitly.
       */
      PAY_MIN_CONFIRMATIONS: z.coerce.number().int().min(1),

      /**
       * Seconds a signed webhook stays acceptable. Beyond it, a correctly signed
       * delivery is a replay of one somebody observed.
       * No git default: blank refuses. Owner may set 300 explicitly.
       */
      PAY_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30),

      /**
       * Fee rate for merchants whose own pricing does not state one.
       *
       * Blank / unset → null. Callers refuse `pay.fee_bps_unset` — never invent 0.
       * `z.coerce.number()` is forbidden here: Number("") === 0, which would
       * settle merchants free. Owner publishes the integer; 0 is only when they set 0.
       */
      PAY_DEFAULT_FEE_BPS: z
        .union([z.string(), z.number()])
        .optional()
        .transform((raw) => parseOwnerIntegerEnv(raw)),

      /**
       * Rails on which an operator may credit a deposit by hand.
       *
       * No git default: blank refuses. Owner may set `card-sandbox` explicitly.
       * An operator credit is an assertion that value arrived; on a real rail
       * that assertion has a counterparty who can be asked, so deposits there
       * belong to that rail's own confirmation path. A hand-typed
       * `crypto-native` credit would move `railBoundary('crypto-native')` away
       * from the chain balance it mirrors, and reconciliation would then report
       * a discrepancy that is really a typo.
       *
       * Widening this is a deliberate operator decision, which is why it is
       * configuration rather than a list in the code.
       */
      PAY_OPERATOR_CREDIT_RAILS: operatorCreditRailsSchema,

      /**
       * Let a SANDBOX rail move value in a production-like environment.
       *
       * Default false, and the default is the whole point: with it unset, an
       * `APP_ENV` of `staging` or `prod` refuses to boot while any registered rail
       * declares itself a sandbox (`rails/posture.ts`). A sandbox payout returns a
       * provider reference this codebase invented and the user is told their money
       * moved — so the honest states are "a live rail exists" or "the process does
       * not start", and this flag is the third one an operator has to ask for by
       * name.
       *
       * Legitimate uses: a pilot, a demo, a load test. It is logged loudly on
       * every boot, because it means no user of that deployment is being told
       * anything true about their money leaving the platform.
       */
      PAY_ALLOW_SANDBOX_RAILS: z.enum(['true', 'false']).default('false'),

      /**
       * LIVE crypto rail — JSON-RPC endpoint for the chain behind `crypto-native`.
       *
       * When set, `defaultChainFor` builds an `EvmLiveChain` (`posture: 'live'`)
       * and the following sibling keys become mandatory. When unset, staging/prod
       * keep `UnconfiguredChain` and dev/test keep `MemoryChain`.
       */
      PAY_CRYPTO_RPC_URL: z.string().url().optional(),
      PAY_CRYPTO_CHAIN_ID: z.coerce.number().int().positive().optional(),
      /**
       * BIP-39 mnemonic that derives per-payment acceptance addresses.
       * Never the hot wallet — deposits land here; payouts leave from the hot key.
       */
      PAY_CRYPTO_DEPOSIT_MNEMONIC: z.string().min(20).optional(),
      /** Hex private key (0x…) that signs outbound payouts and refunds. */
      PAY_CRYPTO_HOT_WALLET_KEY: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x + 64 hex chars')
        .optional(),
      /**
       * Asset map, e.g. `ETH:native` or `ETH:native,USDT:0xabc…:6`.
       * See `rails/evm-assets.ts`.
       */
      PAY_CRYPTO_ASSETS: z.string().min(1).optional(),
      /**
       * Register `card-sandbox` at boot. Default: yes in dev/test, no in
       * staging/prod (so a live crypto deployment is not forced to also carry a
       * sandbox acquirer). See `shouldRegisterCardSandbox`.
       */
      PAY_REGISTER_CARD_SANDBOX: z.enum(['true', 'false']).optional(),
      /** Start the in-process chain watcher that POSTs finalized deposits. Default true when live. */
      PAY_CRYPTO_WATCHER_ENABLED: z.enum(['true', 'false']).default('true'),
      PAY_CRYPTO_WATCHER_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2_000),

      /**
       * WHICH RAILS MAY SERVE THE PUBLIC HOSTED CHECKOUT, in preference order,
       * as `railId:method` — e.g. `crypto-native:crypto`.
       *
       * CONFIGURATION, NEVER A REQUEST FIELD, and that is the entire reason it
       * lives here rather than as an input on `checkout.open`. A hosted checkout
       * that lets its caller name a rail — or a payment link that resolves to
       * one — is exactly where the sandbox-withdrawal P0 (`rails/posture.ts`)
       * comes back, this time with an anonymous third party's money.
       *
       * `crypto-native` alone by default. It is the only v1 rail that can ever
       * be live (§13: "crypto-native is real from day one"), and `card-sandbox`
       * is deliberately absent: a sandbox capture on the MERCHANT INTEGRATION
       * path leaves the platform short and reconciliation against the rail
       * boundary catches it, but a sandbox capture on the PUBLIC path credits a
       * merchant nobody paid, who can then settle and withdraw it. Widening this
       * is an operator decision with that sentence attached to it.
       */
      PAY_CHECKOUT_RAILS: z
        .string()
        .default('crypto-native:crypto')
        .transform((value) =>
          value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((entry) => {
              const [railId, method] = entry.split(':');
              return { railId: (railId ?? '').trim(), method: (method ?? 'crypto').trim() || 'crypto' };
            })
            .filter((r) => r.railId.length > 0),
        ),

      /**
       * How long a payer's browser handoff stays open.
       *
       * Seconds, not days: a session is one payer's attempt at a checkout, and a
       * stale page showing a live acceptance address is something somebody can
       * be phished with. It NEVER expires the payment behind it — funds sent
       * late still land, are still matched by the rail's webhook, and are still
       * credited to the merchant. See `PayService.getCheckoutSession`.
       * No git default: blank refuses. Owner may set 900 explicitly.
       */
      PAY_CHECKOUT_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400),

      /**
       * The lifetime a payment link gets when the merchant does not name one,
       * and the hard ceiling on one that does.
       *
       * A payment link is a capability URL: whoever holds it can pay against it,
       * and it survives in email threads, screenshots and browser history. There
       * is no "never expires" — the service refuses to create one.
       * No git default on default or max lifetime: blank refuses. Owner may set
       * 30 / 365 explicitly.
       */
      PAY_LINK_DEFAULT_TTL_DAYS: z.coerce.number().int().min(1).max(3_650),
      PAY_LINK_MAX_TTL_DAYS: z.coerce.number().int().min(1).max(3_650),

      /**
       * Open checkout sessions allowed against one link at a time.
       *
       * The floor under an anonymous caller opening rows off one URL forever.
       * Not a rate limiter — a rate limiter belongs at the edge, and this is the
       * bound that still holds when the edge is bypassed.
       * No git default: blank refuses. Owner may set 25 explicitly.
       */
      PAY_CHECKOUT_MAX_OPEN_SESSIONS: z.coerce.number().int().min(1).max(10_000),

      /**
       * Operator-declared risk band for hosted checkout smart routing (D26-P1-P3).
       * Blank refuses — never invent `low`. Public callers cannot override this.
       */
      PAY_CHECKOUT_RISK_BAND: z.string().optional().default(''),

      /**
       * svc-identity base for D26-P1-O2 affiliate accrue after merchantSettlement.
       * Blank → noop port (settlement still posts). Never invent rates.
       */
      IDENTITY_URL: z.string().url().optional(),
      /** Owner-specific exact-body admission key. Missing configuration refuses fresh operations. */
      IDENTITY_ADMISSION_SECRET: z.string().min(32).optional(),

      /**
       * The prefix a BROWSER sees the hosted checkout under.
       *
       * svc-pay serves `/checkout`; svc-edge is the only public listener and
       * routes `/api/pay/*` here with the prefix STRIPPED
       * (`services/svc-edge/src/routes.ts`). Every path the page emits — the
       * form action, the redirect Location — has to carry the prefix back, or a
       * form rendered at `/api/pay/checkout` posts to the edge's root and 404s
       * with the payer watching.
       *
       * Configurable rather than hard-coded because the mount is the EDGE's
       * decision, not this service's, and a constant here would be a second copy
       * of somebody else's route table.
       */
      PAY_PUBLIC_BASE_PATH: z
        .string()
        .default('/api/pay')
        .transform((v) => (v === '/' ? '' : v.replace(/\/+$/, ''))),
    }),
  );

export const env = loadEnv(schema);
export type Env = typeof env;
