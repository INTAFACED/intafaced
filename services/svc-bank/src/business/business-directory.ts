/**
 * Public handles and exact recipient lookup for business bank.
 *
 * svc-identity owns handles and emails. This service does not read
 * `identity.users` and does not keep a copy. With no IDENTITY_URL, or when
 * identity has not published POST /internal/business-directory, every read that
 * must show a handle refuses. It does not invent one.
 *
 * A miss is one answer: unknown, frozen, closed and a badly shaped handle or
 * email all come back empty. The query is never logged.
 */

import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { z } from 'zod';

export const BUSINESS_DIRECTORY_HANDLES_PATH = '/internal/business-directory/handles';
export const BUSINESS_DIRECTORY_RECIPIENT_PATH = '/internal/business-directory/recipient';

const FETCH_MS = 3_000;
const HANDLE_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class BusinessDirectoryError extends Error {
  constructor(
    message: string,
    readonly reason: 'unset' | 'unavailable',
  ) {
    super(message);
    this.name = 'BusinessDirectoryError';
  }
}

export interface BusinessDirectoryPort {
  /** Public handles for these user ids. Unknown ids are omitted. Never invents a handle. */
  handlesOf(userIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * Display names the owner chose to show. An id with no published choice is omitted.
   * Identity does not publish that choice, so the live client returns an empty map.
   */
  publishedNames(userIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * An active account, exact match. Null for unknown, frozen and closed.
   * The caller has already checked the shape. The answer never includes an email.
   */
  findActive(query: { readonly handle: string } | { readonly email: string }): Promise<{ userId: string; handle: string } | null>;
}

export interface BusinessLookupLimiter {
  tryTake(callerId: string): boolean;
}

/** 30 per minute per caller: a person typing handles never gets near it. */
export class BusinessLookupLimiter implements BusinessLookupLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: { readonly max: number; readonly windowMs: number } = { max: 30, windowMs: 60_000 },
    private readonly now: () => number = Date.now,
  ) {}

  tryTake(callerId: string): boolean {
    const now = this.now();
    const since = now - this.limit.windowMs;
    const recent = (this.hits.get(callerId) ?? []).filter((t) => t > since);
    if (recent.length >= this.limit.max) {
      this.hits.set(callerId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(callerId, recent);
    return true;
  }
}

export function unconfiguredBusinessDirectory(
  why = 'IDENTITY_URL is unset, so svc-bank cannot read public handles from svc-identity. Team list, approval history and recipient lookup stay closed until that directory is connected (bank.business_directory_unset)',
): BusinessDirectoryPort {
  return {
    async handlesOf() {
      throw new BusinessDirectoryError(why, 'unset');
    },
    async publishedNames() {
      throw new BusinessDirectoryError(why, 'unset');
    },
    async findActive() {
      throw new BusinessDirectoryError(why, 'unset');
    },
  };
}

/** One well-formed handle, or null. A leading @ is how the screen shows it. */
export function normaliseHandleQuery(raw: string): string | null {
  const trimmed = raw.trim();
  const bare = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  return HANDLE_PATTERN.test(bare) ? bare : null;
}

/** One well-formed email, or null. No pattern characters, no stored copy. */
export function normaliseEmailQuery(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length > 320 || !EMAIL_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export interface DirectoryPerson {
  readonly userId: string;
  readonly handle: string;
  readonly email: string;
  readonly status: 'active' | 'frozen' | 'closed';
  /** Shown only when the owner chose to publish it. Absent means handle only. */
  readonly displayName?: string;
  readonly showDisplayName?: boolean;
}

/** Test double. Exact, case-insensitive. Frozen and closed are misses on findActive. */
export function memoryBusinessDirectory(people: readonly DirectoryPerson[]): BusinessDirectoryPort {
  return {
    async handlesOf(userIds) {
      const wanted = new Set(userIds);
      const out = new Map<string, string>();
      for (const person of people) {
        if (wanted.has(person.userId)) out.set(person.userId, person.handle);
      }
      return out;
    },
    async publishedNames(userIds) {
      const wanted = new Set(userIds);
      const out = new Map<string, string>();
      for (const person of people) {
        if (!wanted.has(person.userId) || person.showDisplayName !== true) continue;
        const name = person.displayName?.trim() ?? '';
        if (name) out.set(person.userId, name);
      }
      return out;
    },
    async findActive(query) {
      const person = people.find((row) => {
        if (row.status !== 'active') return false;
        if ('handle' in query) return row.handle.toLowerCase() === query.handle.toLowerCase();
        return row.email.toLowerCase() === query.email.toLowerCase();
      });
      return person ? { userId: person.userId, handle: person.handle } : null;
    },
  };
}

const handlesBody = z.object({
  handles: z.array(z.object({ userId: z.string().min(1).max(128), handle: z.string().min(1).max(64) })),
});

const recipientBody = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({ found: z.literal(true), userId: z.string().min(1).max(128), handle: z.string().min(1).max(64) }),
]);

function logDirectoryFailure(detail: { reason: string; httpStatus?: number }): void {
  console.error(JSON.stringify({ level: 'error', service: 'svc-bank', event: 'bank.business_directory_failed', ...detail }));
}

const UNSET_404 = `svc-identity has not published POST ${BUSINESS_DIRECTORY_HANDLES_PATH}. Handles, approval history and recipient lookup stay closed until that directory route exists (bank.business_directory_unset)`;

export function createIdentityBusinessDirectory(
  baseUrl: string,
  internalSecret: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): BusinessDirectoryPort {
  const base = baseUrl.replace(/\/+$/, '');
  const sign = serviceCallSigner({ service: 'svc-bank', audience: 'svc-identity', legacySecret: internalSecret, s2s });

  async function post(path: string, body: string): Promise<unknown> {
    let response: Response;
    try {
      const target = `${base}${path}`;
      response = await fetchFn(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...sign(body, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
        },
        body,
        signal: AbortSignal.timeout(FETCH_MS),
      });
    } catch (err) {
      logDirectoryFailure({ reason: `identity request failed: ${err instanceof Error ? err.name : 'unknown'}` });
      throw new BusinessDirectoryError(
        'svc-identity did not answer the business directory. Nothing was listed. Retry shortly (bank.business_directory_unavailable)',
        'unavailable',
      );
    }
    if (response.status === 404) {
      logDirectoryFailure({ reason: 'directory route is not published', httpStatus: 404 });
      throw new BusinessDirectoryError(UNSET_404, 'unset');
    }
    if (!response.ok) {
      logDirectoryFailure({ reason: 'identity answered non-2xx', httpStatus: response.status });
      throw new BusinessDirectoryError(
        `svc-identity refused the business directory (${response.status}). Nothing was listed (bank.business_directory_unavailable)`,
        'unavailable',
      );
    }
    try {
      return await response.json();
    } catch {
      logDirectoryFailure({ reason: 'identity body was not JSON', httpStatus: response.status });
      throw new BusinessDirectoryError(
        'svc-identity returned an unreadable business directory. Nothing was listed (bank.business_directory_unavailable)',
        'unavailable',
      );
    }
  }

  return {
    async handlesOf(userIds) {
      const ids = [...new Set(userIds.map((id) => id.trim()).filter((id) => id.length > 0))];
      if (ids.length === 0) return new Map();
      const body = JSON.stringify({ userIds: ids });
      const parsed = handlesBody.safeParse(await post(BUSINESS_DIRECTORY_HANDLES_PATH, body));
      if (!parsed.success) {
        throw new BusinessDirectoryError(
          'svc-identity returned an unreadable business directory. Nothing was listed (bank.business_directory_unavailable)',
          'unavailable',
        );
      }
      const out = new Map<string, string>();
      for (const row of parsed.data.handles) {
        if (ids.includes(row.userId)) out.set(row.userId, row.handle);
      }
      return out;
    },
    async publishedNames() {
      // Identity's handle route does not publish a show-name choice. A name
      // the owner did not choose to show is not returned.
      return new Map();
    },
    async findActive(query) {
      const body = JSON.stringify(query);
      const parsed = recipientBody.safeParse(await post(BUSINESS_DIRECTORY_RECIPIENT_PATH, body));
      if (!parsed.success) {
        throw new BusinessDirectoryError(
          'svc-identity returned an unreadable business directory. Nothing was listed (bank.business_directory_unavailable)',
          'unavailable',
        );
      }
      if (!parsed.data.found) return null;
      return { userId: parsed.data.userId, handle: parsed.data.handle };
    },
  };
}
