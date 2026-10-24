import { z } from 'zod';
import { edgeEnvSchema, loadEnv, serviceEnvSchema } from '@intafaced/config';
import { assertProdEngine } from './prod-engine.js';

/**
 * An optional URL where the EMPTY STRING means "not set".
 *
 * `loadEnv` hands `process.env` to zod untouched, and compose's usual way of
 * declaring an optional knob — `FOO: ${FOO:-}` — sets the variable to `''`
 * rather than leaving it absent. Against a plain `z.string().url().optional()`
 * that is a validation failure, and because this schema is evaluated at import
 * time the symptom is the whole service refusing to boot over a rail it does
 * not even need.
 *
 * So `''` is normalised to `undefined` before validation. A non-empty value is
 * still required to be a real URL: a typo'd host must fail loudly at startup,
 * which is the case this must not swallow.
 */
export const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.string().url().optional());

/**
 * Owner-published integer. Compose `${VAR:-}` sets `''` rather than absent.
 * Blank / whitespace → unpublished (`undefined`). Never git-default a magnitude.
 */
function unpublishedInt(min: number, max?: number) {
  const num = max === undefined ? z.coerce.number().int().min(min) : z.coerce.number().int().min(min).max(max);
  return z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    return value;
  }, num.optional());
}

/**
 * Owner-published engine URL. Compose `${VAR:-}` sets `''` rather than absent.
 * Blank / whitespace → unpublished (`undefined`). Never git-default localhost
 * or `host.docker.internal`.
 */
function unpublishedUrl() {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    return typeof value === 'string' ? value.trim() : value;
  }, z.string().url().optional());
}

// This service self-mounts /trpc, so it must be able to authenticate the edge.
// `export` and `erase` act on `ctx.principal.userId` and nothing else, which is
// only a privacy guarantee if that userId cannot be asserted by the caller
// (docs/decisions/mount-boundary.md).
const schema = serviceEnvSchema
  .merge(edgeEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-blueprint'),
      HTTP_PORT: z.coerce.number().int().default(4008),

      /**
       * The Neural Engine's HTTP contract (§7.1). The engine is an external
       * deployment; this service owns the `NeuralEngineClient` interface in front
       * of it and nothing behind it.
       *
       * Blank / unset is unpublished. `http` mode refuses boot rather than
       * inventing `http://localhost:4108` or `http://host.docker.internal:4108`.
       * Owner may set that URL explicitly. `mock` mode does not need a URL.
       * `assertProdEngine` still refuses loopback when APP_ENV=prod.
       */
      BLUEPRINT_ENGINE_URL: unpublishedUrl(),

      /**
       * Hard ceiling on one engine call.
       *
       * §7.2 budgets the whole flow at under three minutes, and the engine call
       * is the only unbounded step in it. 20s leaves room for a retry the user
       * can sit through; anything longer and the page has already lost them.
       */
      BLUEPRINT_ENGINE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),

      /** Never logged. Empty string fails; unset omits. */
      BLUEPRINT_ENGINE_API_KEY: z.string().min(1).optional(),

      /**
       * `mock` runs the deterministic in-process engine — for local development
       * and for environments where the external deployment is not reachable. It
       * is not a fallback: the mode is chosen explicitly, so a misconfigured
       * production URL fails loudly instead of quietly serving stub profiles to
       * real people. `assertProdEngine` refuses `mock` when APP_ENV=prod.
       *
       * Compose `${BLUEPRINT_ENGINE_MODE:-}` injects `''` when the host env is
       * blank. That empty string is unset, not mock: the schema default `http`
       * applies. Never compose-default mock.
       */
      BLUEPRINT_ENGINE_MODE: z.preprocess((value) => (value === '' ? undefined : value), z.enum(['http', 'mock']).default('http')),

      /**
       * Owner-published default crew size. Stored per crew; changing this
       * affects new crews only. Blank / unset is unpublished — forming a crew
       * refuses `blueprint.crew_capacity_unset`. Never git-default 6.
       * Owner may set 6 explicitly.
       */
      BLUEPRINT_CREW_CAPACITY: unpublishedInt(2, 24),

      /**
       * Owner-published mentor shortlist length (§7.1). Blank / unset is
       * unpublished — shortlist write refuses `blueprint.mentor_shortlist_unset`.
       * Never git-default 3. Owner may set 3 explicitly.
       */
      BLUEPRINT_MENTOR_SHORTLIST_SIZE: unpublishedInt(1, 10),

      /**
       * Owner-published crew season. Crews are formed and named within a season.
       * Blank / unset is unpublished — placement refuses `blueprint.season_unset`.
       * Never git-default 1. Owner may set 1 explicitly.
       */
      BLUEPRINT_SEASON: unpublishedInt(1),

      /**
       * Active card shares one account may hold (MC-blueprint-01). Blank / unset
       * is unpublished — creating a share refuses `blueprint.share_limit_unset`.
       * 0 is a deliberate cap. Never git-default a count.
       */
      BLUEPRINT_SHARES_PER_OWNER: unpublishedInt(0),

      /**
       * Opener rows returned for one share (MC-blueprint-01). Blank / unset is
       * unpublished — the openers read refuses `blueprint.opens_list_limit_unset`.
       * 0 is a deliberate empty page. Never git-default a page size.
       * Open-log retention is not a setting here: this slice does not sweep and
       * does not invent a window. Rows stay until erase.
       */
      BLUEPRINT_OPENS_LIST_LIMIT: unpublishedInt(0),

      /**
       * The card rasterizer (§7.1 "rendered server-side … → PNG").
       *
       * **Optional, and unset means unset.** There is deliberately no default URL:
       * one pointing at a host that does not exist would turn "this deployment has
       * no renderer" — a permanent, honest state a surface can render immediately
       * — into a timeout on every card request. When this is absent the service
       * boots `UnconfiguredCardRenderer`, the vector card still renders in full,
       * and the response carries a typed code saying why there is no PNG.
       */
      BLUEPRINT_CARD_RENDERER_URL: optionalUrl,

      /**
       * Shorter than the engine's 20s, on purpose. The engine call is the step a
       * user sits through during onboarding; the card is composed instantly and
       * only the hosted PNG is outstanding, so a slow renderer should give up
       * quickly and report `unavailable` rather than hold a share sheet open.
       */
      BLUEPRINT_CARD_RENDERER_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),

      /** Never logged. Empty string fails; unset omits. */
      BLUEPRINT_CARD_RENDERER_API_KEY: z.string().min(1).optional(),
    }),
  )
  .superRefine((data, ctx) => {
    if (data.BLUEPRINT_ENGINE_MODE === 'http' && data.BLUEPRINT_ENGINE_URL === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BLUEPRINT_ENGINE_URL'],
        message: 'BLUEPRINT_ENGINE_URL is unset — will not invent http://host.docker.internal:4108 as live',
      });
    }
  });

export const env = loadEnv(schema);
assertProdEngine(env);
export type Env = typeof env;
