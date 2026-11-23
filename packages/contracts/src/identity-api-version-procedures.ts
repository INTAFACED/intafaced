import { z } from 'zod';
import { API_VERSION_UNKNOWN } from './api-versions.js';
import { defineProcedure, NO_INPUT } from './procedure.js';

/**
 * svc-identity's account default API version (DV-versioning-01, J-developer-16 #5): the version an API-key call without
 * an `intafaced-version` header takes. Blank until the owner of the account sets it; svc-edge then refuses such a call
 * (`version.unset`). Key management, so a session only: a key cannot read or change it.
 */

/** A call made with an API key rather than a signed-in session. */
export const API_VERSION_SESSION_ONLY = 'identity.api_version_session_only';

export const apiVersionDefaultSchema = z.object({
  /** The account default, or null while it is not set. */
  version: z.string().nullable(),
  /** When it was last set, or null while it is not set. */
  setAt: z.string().datetime().nullable(),
});
export type ApiVersionDefault = z.infer<typeof apiVersionDefaultSchema>;

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_API_VERSION_GET = defineProcedure({
  ...base,
  name: 'identity.apiVersion.get',
  kind: 'query',
  path: 'developer.apiVersion.get',
  access: { caller: 'scope', scope: 'identity:read', module: 'identity' },
  refusals: { [API_VERSION_SESSION_ONLY]: 'FORBIDDEN' },
  input: NO_INPUT,
  output: apiVersionDefaultSchema,
  samples: [{ verdict: 'accept' }, { verdict: 'refuse', input: { version: '2026-11-20' } }],
});

/** Set the default. Only a version the API implements; the same value again changes nothing and answers the same. */
export const IDENTITY_API_VERSION_SET = defineProcedure({
  ...base,
  name: 'identity.apiVersion.set',
  kind: 'mutation',
  path: 'developer.apiVersion.set',
  access: { caller: 'scope', scope: 'identity:write', module: 'identity' },
  refusals: { [API_VERSION_SESSION_ONLY]: 'FORBIDDEN', [API_VERSION_UNKNOWN]: 'BAD_REQUEST' },
  input: z.object({ version: z.string().min(1).max(32) }).strict(),
  output: apiVersionDefaultSchema.extend({ changed: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { version: '2026-11-20' } },
    // Accepted on the wire; the service then refuses it by name (`version.unknown`).
    { verdict: 'accept', input: { version: '1999-01-01' } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { version: 20261120 } },
  ],
});

export const IDENTITY_API_VERSION_PROCEDURES = [IDENTITY_API_VERSION_GET, IDENTITY_API_VERSION_SET] as const;
