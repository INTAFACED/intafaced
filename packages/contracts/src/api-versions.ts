/**
 * Dated versions of the developer REST API (`/api/v1`, DV-versioning-01, journey J-developer-16 #5 and #6).
 *
 * A caller names the behaviour it was written against in the `intafaced-version` header. Without the header an API-key
 * call takes its account's default; with neither the call is refused (`version.unset`), never answered as the latest.
 * A value that is not one of `API_VERSIONS` is refused (`version.unknown`). svc-edge negotiates; svc-identity keeps the
 * account default.
 *
 * `API_VERSIONS` is what the code implements, a fact of the code and not an owner value. A deprecation's `sunset` (the
 * date the field stops working) is the owner's: blank (`null`) until set, and never invented.
 *
 * Browser safe: nothing here imports Node.
 */
import { z } from 'zod';

/** The request and reply header. Not under `x-intafaced-`: that prefix is the edge's own and is stripped from callers. */
export const API_VERSION_HEADER = 'intafaced-version';
/** On the reply: whether the version came from the caller's header or its account default. */
export const API_VERSION_SOURCE_HEADER = 'intafaced-version-source';
/** On the reply: the deprecations the request touched, as a JSON array of `ApiDeprecation`. */
export const API_ADVISORIES_HEADER = 'intafaced-advisories';

/** Every version the API implements, oldest first; the last is the newest, the one a client released today pins. */
export const API_VERSIONS = ['2026-11-20'] as const;
export type ApiVersion = (typeof API_VERSIONS)[number];
export const LATEST_API_VERSION: ApiVersion = API_VERSIONS[API_VERSIONS.length - 1]!;

export type ApiVersionSource = 'header' | 'account';

export const API_VERSION_UNSET = 'version.unset';
export const API_VERSION_UNKNOWN = 'version.unknown';
export const API_VERSION_REFUSALS = [API_VERSION_UNSET, API_VERSION_UNKNOWN] as const;
export type ApiVersionRefusal = (typeof API_VERSION_REFUSALS)[number];

/** The version a value names, or null when it names none the API implements (any other date, a typo, a number). */
export function parseApiVersion(value: unknown): ApiVersion | null {
  return typeof value === 'string' && (API_VERSIONS as readonly string[]).includes(value) ? (value as ApiVersion) : null;
}

export const apiVersionSchema = z.enum(API_VERSIONS);

/** A request field that still works and will be removed. The reply to a request that sends it carries this entry. */
export interface ApiDeprecation {
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The exact `/api/v1` path the field belongs to. */
  readonly path: string;
  readonly in: 'body';
  readonly field: string;
  readonly replacement: string;
  readonly deprecatedIn: ApiVersion;
  /** The removal date: the owner's to set. Null means not set, and no `Sunset` header is sent. */
  readonly sunset: string | null;
  readonly changelog: string;
}

export const API_DEPRECATIONS: readonly ApiDeprecation[] = [
  {
    // svc-trade still reads `stopPx` before `stopPrice` (services/svc-trade/src/spot/stop-limit-place.ts); the published
    // order types document only `stopPrice` (spot-order-types.ts).
    id: 'orders.stopPx',
    method: 'POST',
    path: '/api/v1/orders',
    in: 'body',
    field: 'stopPx',
    replacement: 'stopPrice',
    deprecatedIn: '2026-11-20',
    sunset: null,
    changelog: '/developers/changelog',
  },
];

/** The RFC 9745 `Deprecation` value: `@` and the unix seconds of the version's date at 00:00 UTC. */
export function deprecationHeaderValue(version: ApiVersion): string {
  return `@${Date.parse(`${version}T00:00:00Z`) / 1000}`;
}
