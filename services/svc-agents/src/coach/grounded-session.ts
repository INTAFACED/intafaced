/**
 * AI Coach — curriculum-grounded coaching (§8.2, §25:708).
 *
 * A coach grounded in nothing is a chatbot. The licensed curriculum library
 * import is residual (academy.curriculum, not this service). This door cites
 * only catalog rows it is given. It never invents library titles, never
 * writes lesson bodies, and never references the user's positions — that
 * ruling is owner-only (education vs regulated advice).
 *
 * Production can load academy over S2S (`ACADEMY_URL` →
 * `createAcademyCurriculumSource`). `envCoachGrounding()` is still the empty
 * default (unset URL, tests, fail-closed). Tests inject a spine seam.
 */

import type { CopyKey } from '../copy.js';

export const COACH_REFUSE_COPY = 'agents.error.capability_unavailable' as const satisfies CopyKey;

export type CoachCatalogItem = {
  readonly slug: string;
  readonly title: string;
};

export type CoachGrounding = {
  readonly items: readonly CoachCatalogItem[];
  /** Licensed third-party library import. False on tip — do not invent it. */
  readonly licensedLibraryImported: boolean;
};

export type CoachRefuseReason =
  'curriculum_empty' | 'library_import_pending' | 'invented_library' | 'positions_not_decided' | 'advice_forbidden';

export type CoachSessionRefuse = {
  readonly status: 'refuse';
  readonly reason: CoachRefuseReason;
  readonly kind: 'not_advice';
  readonly isAdvice: false;
  readonly positionsReferenced: false;
  readonly licensedLibraryImported: boolean;
  readonly inventedLibrary: false;
  readonly citedCount: 0;
  readonly userMessageKey: typeof COACH_REFUSE_COPY;
};

export type CoachSessionCitation = {
  readonly status: 'grounded';
  readonly kind: 'citation';
  readonly isAdvice: false;
  readonly positionsReferenced: false;
  readonly licensedLibraryImported: boolean;
  readonly inventedLibrary: false;
  readonly citedCount: number;
  readonly citations: readonly CoachCatalogItem[];
  readonly userMessageKey: typeof COACH_REFUSE_COPY;
};

export type CoachSessionResult = CoachSessionRefuse | CoachSessionCitation;

export type CoachSessionInput = {
  readonly ask?: string;
  readonly requestedSlug?: string;
  /** Owner has not ruled: Coach may not reference live positions. */
  readonly includePositions?: boolean;
  /** Asking the agent to recommend a trade is always refused. */
  readonly asAdvice?: boolean;
  /** Test seam. Production uses `loadCoachGrounding` or `envCoachGrounding()`. */
  readonly grounding?: CoachGrounding;
};

const POSITION_ASK = /\b(position|positions|holdings?|pnl|unrealised|unrealized|liquidation)\b/i;

export function envCoachGrounding(): CoachGrounding {
  return { items: [], licensedLibraryImported: false };
}

function refuse(reason: CoachRefuseReason, grounding: CoachGrounding): CoachSessionRefuse {
  return {
    status: 'refuse',
    reason,
    kind: 'not_advice',
    isAdvice: false,
    positionsReferenced: false,
    licensedLibraryImported: grounding.licensedLibraryImported,
    inventedLibrary: false,
    citedCount: 0,
    userMessageKey: COACH_REFUSE_COPY,
  };
}

function looksLikePositionAsk(ask: string): boolean {
  return POSITION_ASK.test(ask);
}

/**
 * Ground a coaching ask, or refuse when the catalog / owner line cannot support one.
 *
 * Empty catalog → chatbot (refuse). Missing licensed library → not invented.
 * Position-grounded asks → refuse until an owner ruling.
 */
export function runCoachSession(input: CoachSessionInput = {}): CoachSessionResult {
  const grounding = input.grounding ?? envCoachGrounding();
  const ask = input.ask?.trim() ?? '';
  const requestedSlug = input.requestedSlug?.trim() ?? '';

  if (input.asAdvice === true) {
    return refuse('advice_forbidden', grounding);
  }

  if (input.includePositions === true || looksLikePositionAsk(ask)) {
    return refuse('positions_not_decided', grounding);
  }

  if (grounding.items.length === 0) {
    return refuse('curriculum_empty', grounding);
  }

  if (requestedSlug !== '') {
    const hit = grounding.items.find((item) => item.slug === requestedSlug);
    if (!hit) {
      return refuse('invented_library', grounding);
    }
    return {
      status: 'grounded',
      kind: 'citation',
      isAdvice: false,
      positionsReferenced: false,
      licensedLibraryImported: grounding.licensedLibraryImported,
      inventedLibrary: false,
      citedCount: 1,
      citations: [{ slug: hit.slug, title: hit.title }],
      userMessageKey: COACH_REFUSE_COPY,
    };
  }

  if (!grounding.licensedLibraryImported) {
    return refuse('library_import_pending', grounding);
  }

  // A blank ask is not an empty catalog. The empty check already returned.
  // Cite only catalog rows this door was given.
  const citations = grounding.items.slice(0, 3);
  return {
    status: 'grounded',
    kind: 'citation',
    isAdvice: false,
    positionsReferenced: false,
    licensedLibraryImported: true,
    inventedLibrary: false,
    citedCount: citations.length,
    citations,
    userMessageKey: COACH_REFUSE_COPY,
  };
}

export function looksLikeAdvice(result: CoachSessionResult | Record<string, unknown>): boolean {
  if ('isAdvice' in result && result.isAdvice === true) return true;
  if ('kind' in result && result.kind === 'advice') return true;
  if (result.status === 'ok' || result.status === 'recommend') return true;
  if ('positionsReferenced' in result && result.positionsReferenced === true) return true;
  return false;
}

export function inventedLibraryTitles(result: CoachSessionResult | Record<string, unknown>): boolean {
  if ('inventedLibrary' in result && result.inventedLibrary === true) return true;
  return false;
}

export function assertNotAdvice(result: CoachSessionResult): void {
  if (looksLikeAdvice(result)) {
    throw new Error('coach session presented as advice or position recommendation');
  }
  if (inventedLibraryTitles(result)) {
    throw new Error('coach must not invent licensed library titles');
  }
}
