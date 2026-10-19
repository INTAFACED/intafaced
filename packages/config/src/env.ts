import { z } from 'zod';
import { assertProductionPosture } from './production-posture.js';

/**
 * Typed environment loader.
 *
 * Rules:
 *  - Nothing reads `process.env` directly outside this file.
 *  - Every service declares the slice it needs; unknown/missing vars fail loud
 *    at boot, never at 3am inside a ledger post.
 *  - Secrets are never logged, never serialised (see `redactEnv`).
 */

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const port = z.coerce.number().int().min(1).max(65535);

export const APP_ENVS = ['dev', 'test', 'staging', 'prod'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Shared by every process in the monorepo. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(APP_ENVS).default('dev'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SERVICE_NAME: z.string().min(1).default('unknown-service'),
  /** §11 — the drop sequence is configuration, not deployment risk. */
  LAUNCH_DROP: z.enum(['0', 'I', 'II', 'III', 'IV', 'V']).default('0'),
});

export const postgresEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  /**
   * Postgres pool size. Owner-published. Blank / unset refuses boot (never invent 10).
   * Owner may set 10 explicitly. Empty string is not 0 — 0 is not a legal pool.
   */
  DATABASE_POOL_MAX: z.preprocess(
    (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
    z.coerce.number().int().min(1).max(200),
  ),
  DATABASE_SSL: bool.default(false),
});

export const redisEnvSchema = z.object({
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
});

export const natsEnvSchema = z.object({
  NATS_URL: z.string().trim().min(1).default('nats://localhost:4222'),
  NATS_STREAM_PREFIX: z.string().default('INTAFACED'),
});

export const otelEnvSchema = z.object({
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default('http://localhost:4318'),
  OTEL_ENABLED: bool.default(true),
});

export const httpEnvSchema = z.object({
  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: port.default(3000),
});

/**
 * Required by any service that self-mounts `/trpc` (see the mount boundary
 * decision, docs/decisions/mount-boundary.md).
 *
 * There is deliberately NO default. A service that mounts without this must
 * fail to boot: the alternative is a service that starts fine, serves traffic,
 * and accepts whatever principal the caller claims — which looks healthy right
 * up until the first forged withdrawal.
 */
export const edgeEnvSchema = z.object({
  EDGE_PRINCIPAL_SECRET: z.string().min(32),
  /**
   * The edge's raw 32-byte Ed25519 public key, base64url. Verify-only: a service holding just this key cannot mint a
   * principal. Optional while the shared secret is still accepted; setting it makes the service verify the edge's
   * asymmetric signatures too. Needs both limits below, which `createEdgeContext` enforces at boot.
   */
  EDGE_PRINCIPAL_PUBLIC_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, 'must be a raw 32-byte Ed25519 public key, base64url')
    .optional(),
  /** Longest allowed gap between a principal's `iat` and its expiry. No default: an unset value refuses at boot. */
  EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(1).max(300).optional(),
  /** How far in the future an `iat` may be. No default: an unset value refuses at boot. */
  EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(1).max(60).optional(),
});

/**
 * What a receiver passes to `createEdgeContext` so it also verifies the edge's public-key signatures.
 * Empty when `EDGE_PRINCIPAL_PUBLIC_KEY` is unset. With a key and a missing limit, the limit is left out so
 * `createEdgeContext` refuses the boot with its typed error instead of this helper inventing a value.
 */
export function edgeTrustFromEnv(env: {
  EDGE_PRINCIPAL_PUBLIC_KEY?: string | undefined;
  EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS?: number | undefined;
  EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS?: number | undefined;
}): { edgePublicKey?: string; principalLimits?: { maxLifetimeSeconds: number; clockSkewSeconds: number } } {
  if (env.EDGE_PRINCIPAL_PUBLIC_KEY === undefined) return {};
  const { EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: maxLifetimeSeconds, EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: clockSkewSeconds } = env;
  return {
    edgePublicKey: env.EDGE_PRINCIPAL_PUBLIC_KEY,
    ...(maxLifetimeSeconds !== undefined && clockSkewSeconds !== undefined
      ? { principalLimits: { maxLifetimeSeconds, clockSkewSeconds } }
      : {}),
  };
}

/**
 * Service-to-service key pairs (S2S v3). All optional, and `off` changes nothing: the shared secret stays the only form.
 * `s2sFromEnv` in `@intafaced/contracts` turns these into a verifier and a signer and refuses a half-set configuration.
 * The private key is a secret: it comes from the deploy environment, never from the repo.
 */
export const s2sEnvSchema = z.object({
  S2S_AUTH_MODE: z.enum(['off', 'dual', 'keypair']).default('off'),
  /** Public keyring JSON, the same in every service. Public keys only. */
  S2S_KEYRING: z.string().min(2).optional(),
  /** This service's own key id in the keyring. */
  S2S_SIGNING_KID: z.string().min(3).max(64).optional(),
  /** This service's private signing key (PKCS8, base64url). Secret. */
  S2S_SIGNING_KEY: z.string().min(40).optional(),
});

/**
 * Shared secret for service-to-service calls (§2).
 *
 * Required by BOTH sides: a service exposing a `serviceProcedure` (svc-ledger)
 * and every service that calls one. No default — an unauthenticated
 * `ledger.post` accepts anyone who can reach the port, and the only safe
 * failure for that is refusing to start.
 */
export const internalServiceEnvSchema = z.object({
  INTERNAL_SERVICE_SECRET: z.string().min(32),

  /**
   * How strictly this service enforces S2S body binding (L2-6).
   *
   *   `accept-both`  verify v2 body digests when a caller sends one, and still
   *                  accept a legacy v1 caller that does not. The migration
   *                  setting: nothing 401s while the fleet is redeployed one
   *                  service at a time.
   *   `require`      a caller MUST bind its body. The setting under which the
   *                  replay this closes is actually closed.
   *
   * Defaults to `accept-both` — deliberately the weaker value, because a default
   * of `require` would 401 every caller still running the previous build the
   * moment the first service rolled, and every service here shares one secret.
   *
   * In production posture (`APP_ENV` anything but exactly dev/test) the weaker value is refused at boot, not defaulted:
   * a process that holds `INTERNAL_SERVICE_SECRET` must say `require` (`config.s2s_body_bind_not_required`, in
   * `production-posture.ts`).
   *
   * This mirrors `ServiceBodyBindMode` in `@intafaced/contracts`; it is restated
   * rather than imported because contracts depends on config and not the reverse.
   * The flip procedure and the signal that says it is safe are in
   * `docs/decisions/s2s-body-bind.md`.
   */
  INTERNAL_SERVICE_BODY_BIND: z.enum(['accept-both', 'require']).default('accept-both'),
});

export const authEnvSchema = z.object({
  /** Short-lived access token signing key. Rotated via vault (§9). */
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3600)
    .max(60 * 60 * 24 * 90)
    .default(60 * 60 * 24 * 30),
  JWT_ISSUER: z.string().default('intafaced'),
  JWT_AUDIENCE: z.string().default('intafaced.api'),
});

/** Keys whose values must never appear in logs, traces, or error payloads. */
const SECRET_KEY_PATTERN = /(SECRET|PASSWORD|TOKEN|PRIVATE|_KEY|CREDENTIAL|DSN|DATABASE_URL)/i;

export class EnvError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[],
  ) {
    super(message);
    this.name = 'EnvError';
  }
}

/**
 * Parse a schema against a source (defaults to `process.env`).
 * Throws `EnvError` listing every problem at once — agents and operators get
 * the whole picture in one run, not one variable per restart.
 */
export function loadEnv<T extends z.ZodTypeAny>(schema: T, source: Record<string, unknown> = process.env): z.infer<T> {
  // Before the schema: a server on dev keys must refuse with that reason, not a schema error.
  assertProductionPosture(source);
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues.map((i) => {
    const path = i.path.join('.') || '(root)';
    return `${path}: ${i.message}`;
  });
  throw new EnvError(`Invalid environment for ${String(source.SERVICE_NAME ?? 'process')}:\n  - ${issues.join('\n  - ')}`, issues);
}

/** Compose several env slices into one schema. */
export function composeEnv<A extends z.AnyZodObject, B extends z.AnyZodObject>(a: A, b: B) {
  return a.merge(b);
}

/** Safe-to-log view of an env object. */
export function redactEnv(env: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? '«redacted»' : v;
  }
  return out;
}

export type BaseEnv = z.infer<typeof baseEnvSchema>;
export type PostgresEnv = z.infer<typeof postgresEnvSchema>;
export type RedisEnv = z.infer<typeof redisEnvSchema>;
export type NatsEnv = z.infer<typeof natsEnvSchema>;
export type AuthEnv = z.infer<typeof authEnvSchema>;

/**
 * The standard service env: base + postgres + redis + nats + otel + http.
 * Services needing more merge their own slice on top.
 */
export const serviceEnvSchema = baseEnvSchema
  .merge(postgresEnvSchema)
  .merge(redisEnvSchema)
  .merge(natsEnvSchema)
  .merge(otelEnvSchema)
  .merge(httpEnvSchema);

export type ServiceEnv = z.infer<typeof serviceEnvSchema>;
