import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import type { BLUEPRINT_CARD_OF } from '@intafaced/contracts/blueprint-procedures';

export const sharedCardSelection = z.object({ userId: z.string().guid(), size: z.enum(['portrait', 'landscape']) }).strict();
export type SharedCardSelection = z.infer<typeof sharedCardSelection>;
export const sharedCardDimensions = { portrait: { width: 1080, height: 1350 }, landscape: { width: 1200, height: 630 } } as const;
/** This caller's check over a `cardOf` reply: the card is the size asked for, at that size's canonical dimensions. */
export function sharedCardMatches(selection: SharedCardSelection) {
  const dimensions = sharedCardDimensions[selection.size];
  return (card: SharedCard) => card.size === selection.size && card.width === dimensions.width && card.height === dimensions.height;
}
export type SharedCard = ProcedureOutput<typeof BLUEPRINT_CARD_OF>;
export function sharedCardHref(selection: SharedCardSelection) {
  const exact = sharedCardSelection.parse(selection);
  return `/blueprint?subject=${encodeURIComponent(exact.userId)}&size=${exact.size}`;
}
export function sharedCardRoute(href: string): { selection: SharedCardSelection | null; invalid: boolean } {
  const url = new URL(href, location.origin);
  const subjects = url.searchParams.getAll('subject'),
    sizes = url.searchParams.getAll('size');
  if (!subjects.length && !sizes.length) return { selection: null, invalid: false };
  const parsed = sharedCardSelection.safeParse({ userId: subjects[0], size: sizes[0] ?? 'portrait' });
  return subjects.length === 1 && sizes.length <= 1 && parsed.success
    ? { selection: Object.freeze(parsed.data), invalid: false }
    : { selection: null, invalid: true };
}
export function sharedCardFailure(result: Extract<ApiResult<unknown>, { ok: false }>) {
  if (result.status === 404 && result.code === 'blueprint.not_found') return 'unavailable' as const;
  if (result.reason === 'unauthorized') return 'unauthorized' as const;
  if (result.reason === 'forbidden') return 'forbidden' as const;
  if (result.reason === 'not_mounted') return 'routeUnavailable' as const;
  if (result.reason === 'invalid_response') return 'invalidResponse' as const;
  return 'failed' as const;
}
