import { z } from 'zod';
import { edgeEnvSchema, internalServiceEnvSchema, loadEnv, s2sEnvSchema, serviceEnvSchema } from '@intafaced/config';
import { marketHouseCommissionBpsSchema } from './house-commission-bps.js';

/**
 * svc-market environment.
 *
 * This service self-mounts /trpc, so it must be able to authenticate the edge:
 * every procedure resolves `ctx.principal.userId` into somebody's vendor
 * application, and an unsigned principal header would let a caller apply as, or
 * vet, anyone (docs/decisions/mount-boundary.md).
 *
 * `internalServiceEnvSchema` arrived with Stage 2, for exactly ONE callee:
 * svc-token's `/internal/stake/:userId`, which is how a listing slot knows what
 * the caller's stake tier entitles them to. Stage 1's comment here said it would
 * arrive "when stake-gated slots need token.stakeOf" — this is that.
 *
 * `INTERNAL_SERVICE_SECRET` has no default, so a container started without it
 * dies at import rather than serving slot claims it cannot gate. Its wiring in
 * `docker-compose.apps.yml` is what `tooling/ci/compose-secret-parity.mjs`
 * checks, and the svc-academy block there records why that gate exists.
 *
 * `LEDGER_URL` arrived with market.commerce. Vendors still move no value; only
 * the purchase path posts recipes. `MARKET_HOUSE_COMMISSION_BPS` has NO default —
 * unset means refuse-closed (`market.commission_not_configured`). Setting `0` is
 * an explicit free-commission decision by the owner, not silence.
 */
const blankAsAbsent = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

const schema = serviceEnvSchema
  .merge(edgeEnvSchema)
  .merge(internalServiceEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-market'),
      /** 4018: every port from 4000 to 4017 is claimed in docker-compose.apps.yml. */
      HTTP_PORT: z.coerce.number().int().positive().default(4018),

      /** svc-token's internal address — the source of `vendorSlots` for listing slots. */
      TOKEN_URL: z.string().url().default('http://localhost:4003'),

      /** svc-ledger — purchase settlement only. */
      LEDGER_URL: z.string().url().default('http://localhost:4001'),

      /**
       * svc-identity base for affiliate accrue + payout after marketPurchase.
       * Blank → noop ports (purchase still posts). Never invent rates. No localhost default.
       */
      IDENTITY_URL: z.string().url().optional(),

      /**
       * House commission in basis points (0..9999). Optional on purpose:
       * missing / whitespace → refuse every purchase. Do not invent 0.
       */
      MARKET_HOUSE_COMMISSION_BPS: marketHouseCommissionBpsSchema,

      /**
       * MC-market-02, owner values with no default. MARKET_PURCHASE_HOLD ('on' | 'off'; blank is off) decides whether a
       * new purchase is held until its refund window ends. MARKET_REFUND_WINDOW_SECONDS is that window; with the switch
       * on and the window blank, a new purchase refuses `market.refund_window_unset`. MARKET_RELEASE_SWEEP_SECONDS is
       * how often the sweep releases held purchases whose window ended; with the switch on and it blank, a new purchase
       * refuses `market.release_sweep_unset`, since nothing would ever release it.
       */
      MARKET_PURCHASE_HOLD: blankAsAbsent(z.enum(['on', 'off']).optional()),
      MARKET_REFUND_WINDOW_SECONDS: blankAsAbsent(z.coerce.number().int().min(1).max(31_536_000).optional()),
      MARKET_RELEASE_SWEEP_SECONDS: blankAsAbsent(z.coerce.number().int().min(1).max(86_400).optional()),
    }),
  );

export type MarketEnv = z.infer<typeof schema>;
export const env: MarketEnv = loadEnv(schema);
