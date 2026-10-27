import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { HOME_CONFIG_PROCEDURE, homeConfigOutputSchema } from '@intafaced/contracts/home-work-items';
import { publishedCopy, publishedLanguageFor } from '../shared/copy';
import type { ApiClient } from '../shared/api';
import { useApi } from '../features/session/session';
import { useResource } from '../shared/resource';
import { helpHref } from '../features/public/help-guards';
import { HIDDEN_FEATURE_ARTICLES } from '../features/more/support-desk';
import { kbSchema, type KbArticle } from '../features/more/support-schemas';
import { isHiddenPath } from './feature-registry';

/**
 * How many help articles the header search shows is an owner value (HM-navigation-04), read from svc-ops' public
 * `home.config` (`searchResultCap`). While it is blank the Help group says so and the search never calls the service;
 * while it cannot be read the Help group says it did not load. Either way Help itself is still offered.
 */
export type HelpCap = number | null | 'loading' | 'failed';
export const HELP_MIN_CHARS = 2;
export const HELP_DEBOUNCE_MS = 250;

export interface HelpRow {
  id: string;
  title: string;
  /** Language of the title, for the `lang` attribute (published copy can differ from the page language). */
  lang: string;
  href: string;
}
export type HelpState =
  { status: 'idle' } | { status: 'unset' } | { status: 'loading' } | { status: 'ready'; rows: HelpRow[] } | { status: 'failed' };

/** Published articles with a published title, minus those about features this release does not offer, capped. */
export function helpRows(articles: readonly KbArticle[], cap: number, depositsHidden: boolean): HelpRow[] {
  const rows: HelpRow[] = [];
  for (const article of articles) {
    if (rows.length >= cap) break;
    if (article.published === false || (depositsHidden && HIDDEN_FEATURE_ARTICLES.has(article.id))) continue;
    const title = publishedCopy(article.titleKey);
    if (!title) continue;
    rows.push({
      id: article.id,
      title,
      lang: publishedLanguageFor(article.titleKey) ?? 'und',
      href: helpHref(article.id, article.version),
    });
  }
  return rows;
}

/** One help search. A refused or lost answer is `failed`; nothing is retried. */
export async function searchHelp(
  api: Pick<ApiClient, 'query'>,
  query: string,
  cap: number | null,
  signal: AbortSignal,
  depositsHidden = isHiddenPath('/uc/recharge'),
): Promise<HelpState> {
  const q = query.trim();
  if (q.length < HELP_MIN_CHARS) return { status: 'idle' };
  if (cap === null || !Number.isInteger(cap) || cap < 1) return { status: 'unset' };
  const answer = await api.query('support', 'searchKb', { q, limit: cap }, z.array(kbSchema), { signal });
  return answer.ok ? { status: 'ready', rows: helpRows(answer.data, cap, depositsHidden) } : { status: 'failed' };
}

/**
 * The owner's help result cap, read when the search is first used. A failed read is read again the next time the
 * results open, so one lost answer does not keep Help articles away for the rest of the visit.
 */
export function useHelpResultCap(open: boolean): HelpCap {
  const api = useApi();
  const { resource, reload } = useResource(
    (signal) => api.query('ops', HOME_CONFIG_PROCEDURE, undefined, homeConfigOutputSchema, { signal }),
    'search-help-cap',
  );
  const failed = resource.status === 'failed';
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current && failed) reload();
    wasOpen.current = open;
  }, [open, failed, reload]);
  if (resource.status === 'loading') return 'loading';
  return resource.status === 'ready' ? resource.data.searchResultCap : 'failed';
}

/** The Help group of the header search: waits for a pause in typing, drops an answer the person has typed past. */
export function useHelpSearch(query: string, enabled: boolean, cap: HelpCap): HelpState {
  const api = useApi();
  const [state, setState] = useState<HelpState>({ status: 'idle' });
  const q = query.trim();
  useEffect(() => {
    if (!enabled || q.length < HELP_MIN_CHARS) return setState({ status: 'idle' });
    if (cap === 'loading') return setState({ status: 'loading' });
    if (cap === 'failed') return setState({ status: 'failed' });
    if (cap === null) return setState({ status: 'unset' });
    const controller = new AbortController();
    setState({ status: 'loading' });
    const timer = setTimeout(() => {
      searchHelp(api, q, cap, controller.signal)
        .then((next) => !controller.signal.aborted && setState(next))
        .catch(() => !controller.signal.aborted && setState({ status: 'failed' }));
    }, HELP_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, q, enabled, cap]);
  return state;
}
