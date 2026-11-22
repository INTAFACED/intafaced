/**
 * The account default API version (DV-versioning-01, J-developer-16 #5). One row per account in
 * `identity.api_version_defaults`; no row is "not set". svc-edge reads it from the key exchange and applies it to an
 * API-key call that sends no `intafaced-version` header.
 */
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { Context } from '@intafaced/contracts';
import { TRPCError } from '@intafaced/contracts/trpc';
import { API_VERSION_UNKNOWN, API_VERSIONS, parseApiVersion, type ApiVersion } from '@intafaced/contracts/api-versions';
import {
  API_VERSION_SESSION_ONLY,
  IDENTITY_API_VERSION_PROCEDURES,
  type ApiVersionDefault,
} from '@intafaced/contracts/identity-api-version-procedures';
import { mountRecords, type RefusalOf } from '@intafaced/contracts/procedure-mount';

class ApiVersionError extends Error {
  constructor(
    message: string,
    readonly code: typeof API_VERSION_UNKNOWN | typeof API_VERSION_SESSION_ONLY,
  ) {
    super(message);
    this.name = 'ApiVersionError';
  }
}

const DefaultRow = z.object({ version: z.string(), updated_at: z.date() });
type DefaultRow = z.infer<typeof DefaultRow>;

const view = (row: DefaultRow | undefined): ApiVersionDefault =>
  row ? { version: row.version, setAt: row.updated_at.toISOString() } : { version: null, setAt: null };

export class ApiVersionDefaults {
  constructor(private readonly sql: Sql) {}

  async get(userId: string): Promise<ApiVersionDefault> {
    const rows = DefaultRow.array().parse(await this.sql`SELECT version, updated_at FROM api_version_defaults WHERE user_id = ${userId}`);
    return view(rows[0]);
  }

  /** The default the key exchange carries: a version the API still implements, else null. */
  async versionOf(userId: string): Promise<ApiVersion | null> {
    return parseApiVersion((await this.get(userId)).version);
  }

  /** Sets the default. The same value again writes nothing and answers `changed: false`. */
  async set(userId: string, value: string): Promise<ApiVersionDefault & { changed: boolean }> {
    const version = parseApiVersion(value);
    if (!version) {
      throw new ApiVersionError(
        `No API version ${JSON.stringify(value)}. Versions: ${API_VERSIONS.join(', ')} (${API_VERSION_UNKNOWN})`,
        API_VERSION_UNKNOWN,
      );
    }
    const written = DefaultRow.array().parse(
      await this.sql`
      INSERT INTO api_version_defaults (user_id, version) VALUES (${userId}, ${version})
      ON CONFLICT (user_id) DO UPDATE SET version = EXCLUDED.version, updated_at = now()
        WHERE api_version_defaults.version IS DISTINCT FROM EXCLUDED.version
      RETURNING version, updated_at
    `,
    );
    if (written[0]) return { ...view(written[0]), changed: true };
    return { ...(await this.get(userId)), changed: false };
  }
}

const refusal: RefusalOf = (err) =>
  err instanceof ApiVersionError
    ? {
        code: err.code,
        error: new TRPCError({
          code: err.code === API_VERSION_SESSION_ONLY ? 'FORBIDDEN' : 'BAD_REQUEST',
          message: err.message,
          cause: err,
        }),
      }
    : undefined;

/** The signed-in person. A key is a delegate: like every key-management call, this one needs a session. */
function sessionOwner(ctx: Context): string {
  if (!ctx.principal) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in first' });
  if (ctx.principal.kid) {
    throw new ApiVersionError(
      `The API version default is set from a signed-in session (${API_VERSION_SESSION_ONLY})`,
      API_VERSION_SESSION_ONLY,
    );
  }
  return ctx.principal.userId;
}

/** `developer.apiVersion.get` / `set`, mounted from their records (`@intafaced/contracts/identity-api-version-procedures`). */
export function createApiVersionRouter(defaults: ApiVersionDefaults) {
  return mountRecords(
    IDENTITY_API_VERSION_PROCEDURES,
    {
      'identity.apiVersion.get': ({ ctx }) => defaults.get(sessionOwner(ctx)),
      'identity.apiVersion.set': ({ ctx, input }) => defaults.set(sessionOwner(ctx), input.version),
    },
    refusal,
  );
}
