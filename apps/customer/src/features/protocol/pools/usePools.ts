import { useMemo } from 'react';
import { useApi } from '../../session/session';
import { usePreferences } from '../../../shared/preferences';
import { poolsCopy, type PoolsTranslate } from './copy';
import { createPoolsApi, type PoolsApi } from './pools-api';

/** The pool pages' copy, API and time formats in the reader's language. */
export function usePools(): { t: PoolsTranslate; api: PoolsApi; when: (date: Date) => string } {
  const { language } = usePreferences();
  const { t, renderedLocale } = poolsCopy.forLocale(language);
  const transport = useApi();
  const api = useMemo(() => createPoolsApi(transport), [transport]);
  const when = (date: Date) => date.toLocaleString(renderedLocale, { dateStyle: 'medium', timeStyle: 'short' });
  return { t, api, when };
}
