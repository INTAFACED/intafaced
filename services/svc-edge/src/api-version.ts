/**
 * The dated API version on the developer REST API, `/api/v1` (DV-versioning-01, J-developer-16 #5 and #6). Pure: the
 * proxy (`index.ts`) asks `negotiateApiVersion` once the caller is known and before anything is forwarded.
 *
 *   · `intafaced-version` sent: a version the API implements applies and is echoed; any other value is refused 400
 *     `version.unknown` and forwarded nowhere. The same for every caller, signed in, signed out or a key.
 *   · No header, an API key: the account default applies and is echoed; with no default the call is refused 400
 *     `version.unset`, whose message names both fixes. Never a silent latest.
 *   · No header, signed out or a signed-in session: forwarded as before, with no echo. Our own app and off-the-shelf
 *     CCXT clients read the public and session routes without a version.
 *
 * A request that sends a deprecated field (`API_DEPRECATIONS`) gets the advisory on its reply, whatever the status: the
 * RFC 9745 `Deprecation` date, a `Link` to the changelog, and `intafaced-advisories` with the entries. No `Sunset`
 * header while the owner has not set a removal date.
 */
import {
  API_ADVISORIES_HEADER,
  API_DEPRECATIONS,
  API_VERSION_HEADER,
  API_VERSION_SOURCE_HEADER,
  API_VERSION_UNKNOWN,
  API_VERSION_UNSET,
  API_VERSIONS,
  deprecationHeaderValue,
  parseApiVersion,
  type ApiDeprecation,
  type ApiVersion,
  type ApiVersionRefusal,
  type ApiVersionSource,
} from '@intafaced/contracts/api-versions';

/** The reply headers this module sets, which a browser on an allowed origin may read (`reply-envelope.ts`). */
export const API_VERSION_REPLY_HEADERS = [
  API_VERSION_HEADER,
  API_VERSION_SOURCE_HEADER,
  API_ADVISORIES_HEADER,
  'deprecation',
  'link',
] as const;

export type VersionDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'apply'; readonly version: ApiVersion; readonly source: ApiVersionSource }
  | { readonly kind: 'refuse'; readonly status: 400; readonly code: ApiVersionRefusal; readonly message: string };

const isVersioned = (pathname: string) => pathname === '/api/v1' || pathname.startsWith('/api/v1/');

const UNSET_MESSAGE =
  `This call names no API version. Send the ${API_VERSION_HEADER} header (for example ${API_VERSIONS[API_VERSIONS.length - 1]}), ` +
  'or set your account default API version on the API keys page.';
const UNKNOWN_MESSAGE = `The ${API_VERSION_HEADER} header names no API version. Versions: ${API_VERSIONS.join(', ')}.`;

export function negotiateApiVersion(input: {
  readonly pathname: string;
  /** The caller's `intafaced-version` header as Node gives it. */
  readonly header: string | string[] | undefined;
  /** True for a call made with an API key. */
  readonly apiKey: boolean;
  /** The key's account default from the exchange; null or absent when not set. */
  readonly accountDefault?: ApiVersion | null;
}): VersionDecision {
  if (!isVersioned(input.pathname)) return { kind: 'none' };
  if (input.header !== undefined) {
    const version = parseApiVersion(Array.isArray(input.header) ? input.header.join(',') : input.header.trim());
    return version
      ? { kind: 'apply', version, source: 'header' }
      : { kind: 'refuse', status: 400, code: API_VERSION_UNKNOWN, message: UNKNOWN_MESSAGE };
  }
  if (!input.apiKey) return { kind: 'none' };
  return input.accountDefault
    ? { kind: 'apply', version: input.accountDefault, source: 'account' }
    : { kind: 'refuse', status: 400, code: API_VERSION_UNSET, message: UNSET_MESSAGE };
}

/** The echo on the reply of an applied version. */
export function versionReplyHeaders(decision: VersionDecision): Record<string, string> {
  return decision.kind === 'apply' ? { [API_VERSION_HEADER]: decision.version, [API_VERSION_SOURCE_HEADER]: decision.source } : {};
}

/** The request's JSON body when it is an object, else null. */
function bodyObject(body: Buffer): object | null {
  if (body.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The deprecations a request touches: its method and path, and a JSON body object that has the field. */
export function advisoriesFor(input: { readonly method: string; readonly pathname: string; readonly body: Buffer }): ApiDeprecation[] {
  const candidates = API_DEPRECATIONS.filter((d) => d.method === input.method.toUpperCase() && d.path === input.pathname);
  if (candidates.length === 0) return [];
  const body = bodyObject(input.body);
  return body ? candidates.filter((d) => Object.hasOwn(body, d.field)) : [];
}

/** The advisory on the reply. The oldest deprecation date leads; `Sunset` only once an owner has set a removal date. */
export function advisoryReplyHeaders(advisories: readonly ApiDeprecation[]): Record<string, string> {
  const first = advisories.reduce<ApiDeprecation | null>((a, b) => (a === null || b.deprecatedIn < a.deprecatedIn ? b : a), null);
  if (first === null) return {};
  const sunset = advisories
    .map((a) => a.sunset)
    .filter((s): s is string => s !== null)
    .sort()
    .at(0);
  return {
    deprecation: deprecationHeaderValue(first.deprecatedIn),
    link: [...new Set(advisories.map((a) => a.changelog))].map((href) => `<${href}>; rel="deprecation"`).join(', '),
    ...(sunset === undefined ? {} : { sunset: new Date(sunset).toUTCString() }),
    [API_ADVISORIES_HEADER]: JSON.stringify(advisories),
  };
}
