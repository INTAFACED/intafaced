import type { ServiceAuthMode, ServiceSigner } from '@intafaced/contracts';
import { serviceCallSigner } from '@intafaced/contracts/service-auth-http';
import { ACADEMY_INTERNAL_CURRICULUM } from '@intafaced/contracts/academy-procedures';
import { callHttpRecord } from '@intafaced/contracts/procedure-http';
import type { CoachCatalogItem, CoachGrounding } from './grounded-session.js';

/**
 * Academy curriculum read-port for AI Coach (§8.2).
 *
 * Called through svc-academy's record (`ACADEMY_INTERNAL_CURRICULUM`, `{ACADEMY_URL}/internal/curriculum`) with
 * svc-agents service auth; the record parses the reply. Titles come from academy's response — this module never copies
 * catalog titles into source. A refusal, a transport failure or a reply the record refuses is the empty catalog
 * (chatbot refuse), never invention. `licensedLibraryImported` stays false (Class X licensed dump).
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

export function createAcademyCurriculumSource(
  baseUrl: string,
  internalSecret: string,
  fetchImpl: typeof fetch = fetch,
  /** svc-agents' own key. With it the call is key-signed; `dual` also sends the shared-secret form, `keypair` does not. */
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): CoachCurriculumSource {
  const sign = serviceCallSigner({
    service: 'svc-agents',
    audience: ACADEMY_INTERNAL_CURRICULUM.service,
    legacySecret: internalSecret,
    s2s,
  });

  return {
    async load(): Promise<CoachGrounding> {
      try {
        const reply = await callHttpRecord(ACADEMY_INTERNAL_CURRICULUM, {
          baseUrl,
          input: undefined,
          sign,
          errorOf: (path, status) => new Error(`${path}: ${status}`),
          fetcher: fetchImpl,
        });
        return { items: reply.items.map(({ slug, title }) => ({ slug, title })), licensedLibraryImported: false };
      } catch {
        return EMPTY;
      }
    },
  };
}
