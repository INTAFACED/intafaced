import { z } from 'zod';
import { API_KEY_CALL_LIMIT_MAX, API_KEY_KINDS, API_KEY_REVOKED_BY } from './api-keys.js';
import { defineProcedure } from './procedure.js';

/**
 * Support's read of one customer's API keys and calls (J-developer-17, DV-errors-02, DV-keys-06). A support agent helping a
 * developer who says the API is failing reads, for that one account only: its keys (never a secret or a hash), and its
 * keys' call log, which a request id narrows to the one call. A call shows its metadata and the typed error code the reply
 * carried, never a body, a message or a header value. A request id another account's key made is not found here.
 *
 * Staff only (`support:lookup`, interactive-only: no API key can hold it). Each read writes one operator read audit row.
 */

/** A request id that no call of this account's keys made, including one another account's key made. */
export const DEVELOPER_SUPPORT_REQUEST_NOT_FOUND = 'identity.developer_request_not_found';
/** A key id that is not one of this account's keys. */
export const DEVELOPER_SUPPORT_KEY_NOT_FOUND = 'identity.key_not_found';

export const DEVELOPER_SUPPORT_KEY_LIMIT_MAX = 200;

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc', kind: 'query' } as const;
const access = { caller: 'scope', scope: 'support:lookup', module: 'identity' } as const;
const USER = '00000000-0000-4000-8000-000000000017';

export const developerSupportKeysInputSchema = z
  .object({ userId: z.string().guid(), limit: z.number().int().min(1).max(DEVELOPER_SUPPORT_KEY_LIMIT_MAX) })
  .strict();
const instant = z.string().datetime();

/** One key as support sees it: what it may do and whether it works. Never a secret, a hash or the owner's revoke note. */
export const developerSupportKeySchema = z
  .object({
    id: z.string().guid(),
    name: z.string(),
    prefix: z.string(),
    mode: z.enum(['live', 'sandbox']),
    kind: z.enum(API_KEY_KINDS),
    scopes: z.array(z.string()),
    ipAllowlist: z.array(z.string()),
    createdAt: instant,
    expiresAt: instant.nullable(),
    lastUsedAt: instant.nullable(),
    revoked: z.boolean(),
    revokedAt: instant.nullable(),
    revokedBy: z.enum(API_KEY_REVOKED_BY).nullable(),
  })
  .strict();
export type DeveloperSupportKey = z.infer<typeof developerSupportKeySchema>;

export const developerSupportKeysOutputSchema = z.object({ asOf: instant, keys: z.array(developerSupportKeySchema) }).strict();
export type DeveloperSupportKeys = z.infer<typeof developerSupportKeysOutputSchema>;

/** One customer's keys, newest first, as the owner's own list shows them: no secret and no hash. */
export const IDENTITY_DEVELOPER_SUPPORT_KEYS = defineProcedure({
  ...base,
  name: 'identity.developerSupport.keys',
  path: 'developerSupport.keys',
  access,
  refusals: {},
  input: developerSupportKeysInputSchema,
  output: developerSupportKeysOutputSchema,
  samples: [
    { verdict: 'accept', input: { userId: USER, limit: 50 } },
    { verdict: 'refuse', input: { userId: 'not-an-id', limit: 50 } },
  ],
});

export const developerSupportCallsInputSchema = z
  .object({
    userId: z.string().guid(),
    limit: z.number().int().min(1).max(API_KEY_CALL_LIMIT_MAX),
    /** The one call with this request id, when it was made by one of this account's keys; else refused not found. */
    requestId: z.string().trim().min(1).max(128).optional(),
    /** Only this key's calls; a key of another account is refused not found. */
    keyId: z.string().guid().optional(),
  })
  .strict();
export type DeveloperSupportCallsInput = z.infer<typeof developerSupportCallsInputSchema>;

export const developerSupportCallSchema = z
  .object({
    requestId: z.string(),
    keyId: z.string().guid(),
    keyName: z.string(),
    keyPrefix: z.string(),
    method: z.string(),
    path: z.string(),
    status: z.number().int(),
    /** The typed error code the reply carried; null on a success or an error with no code. */
    errorCode: z.string().nullable(),
    /** The caller's address was outside the key's IP list when it called (the address itself is never kept). */
    outsideIpList: z.boolean(),
    at: z.string().datetime(),
  })
  .strict();
export type DeveloperSupportCall = z.infer<typeof developerSupportCallSchema>;

export const developerSupportCallsOutputSchema = z
  .object({ asOf: z.string().datetime(), calls: z.array(developerSupportCallSchema) })
  .strict();
export type DeveloperSupportCalls = z.infer<typeof developerSupportCallsOutputSchema>;

/** One customer's API calls, newest first; a request id narrows it to that one call, a key id to that key's calls. */
export const IDENTITY_DEVELOPER_SUPPORT_CALLS = defineProcedure({
  ...base,
  name: 'identity.developerSupport.calls',
  path: 'developerSupport.calls',
  access,
  refusals: { [DEVELOPER_SUPPORT_REQUEST_NOT_FOUND]: 'NOT_FOUND', [DEVELOPER_SUPPORT_KEY_NOT_FOUND]: 'NOT_FOUND' },
  input: developerSupportCallsInputSchema,
  output: developerSupportCallsOutputSchema,
  samples: [
    { verdict: 'accept', input: { userId: USER, limit: 50 } },
    { verdict: 'accept', input: { userId: USER, limit: 1, requestId: '3f0c8a52-1d3e-4c55-9d0a-6a1f0e2b7c11' } },
    { verdict: 'refuse', input: { userId: USER, limit: 0 } },
    { verdict: 'refuse', input: { userId: USER, limit: 50, body: 'no' } },
  ],
});

export const IDENTITY_DEVELOPER_SUPPORT_PROCEDURES = [IDENTITY_DEVELOPER_SUPPORT_KEYS, IDENTITY_DEVELOPER_SUPPORT_CALLS] as const;
