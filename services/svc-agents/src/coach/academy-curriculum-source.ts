import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { CoachCatalogItem, CoachGrounding } from './grounded-session.js';

/**
 * Academy curriculum read-port for AI Coach (§8.2).
 *
 * GET `{ACADEMY_URL}/internal/curriculum` with svc-agents service auth.
 * Titles come from academy's response — this module never copies catalog
 * titles into source. Fail closed to empty items (chatbot refuse), never
 * invent. `licensedLibraryImported` stays false (Class X licensed dump).
 */

export interface CoachCurriculumSource {
  load(): Promise<CoachGrounding>;
}

const EMPTY: CoachGrounding = { items: [], licensedLibraryImported: false };

export function emptyCoachGrounding(): CoachGrounding {
  return EMPTY;
}

/** Tests and a stack without academy. Explicit — never a silent production fallback. */
export class EmptyAcademyCurriculumSource implements CoachCurriculumSource {
  async load(): Promise<CoachGrounding> {
    return EMPTY;
  }
}

/** Tests inject a spine. Licensed dump stays false even if callers pass titles. */
export class FixedAcademyCurriculumSource implements CoachCurriculumSource {
  constructor(private readonly items: readonly CoachCatalogItem[]) {}

  async load(): Promise<CoachGrounding> {
    return { items: this.items, licensedLibraryImported: false };
  }
}

function asItems(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body !== null && typeof body === 'object' && 'items' in body) {
    const items = (body as { items: unknown }).items;
    if (Array.isArray(items)) return items;
  }
  return [];
}

function parseItem(raw: unknown): CoachCatalogItem | null {
  if (raw === null || typeof raw !== 'object') return null;
  const slug = (raw as { slug?: unknown }).slug;
  const title = (raw as { title?: unknown }).title;
  if (typeof slug !== 'string' || slug.trim() === '') return null;
  if (typeof title !== 'string' || title.trim() === '') return null;
  return { slug: slug.trim(), title: title.trim() };
}

/** Parse academy's curriculum JSON. Unreadable → empty catalog, never invention. */
export function parseAcademyCurriculumPayload(body: unknown): CoachGrounding {
  const items: CoachCatalogItem[] = [];
  for (const raw of asItems(body)) {
    const item = parseItem(raw);
    if (item) items.push(item);
  }
  return { items, licensedLibraryImported: false };
}

export function createAcademyCurriculumSource(
  baseUrl: string,
  internalSecret: string,
  fetchImpl: typeof fetch = fetch,
  /** svc-agents' own key. With it the call is key-signed; `dual` also sends the shared-secret form, `keypair` does not. */
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): CoachCurriculumSource {
  const url = baseUrl.replace(/\/$/, '');
  const sign = serviceCallSigner({ service: 'svc-agents', audience: 'svc-academy', legacySecret: internalSecret, s2s });

  return {
    async load(): Promise<CoachGrounding> {
      let response: Response;
      try {
        const target = `${url}/internal/curriculum`;
        response = await fetchImpl(target, {
          method: 'GET',
          headers: {
            'content-type': 'application/json',
            ...sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
          },
        });
      } catch {
        return EMPTY;
      }

      if (!response.ok) return EMPTY;

      const body = await response.json().catch(() => null);
      return parseAcademyCurriculumPayload(body);
    },
  };
}
