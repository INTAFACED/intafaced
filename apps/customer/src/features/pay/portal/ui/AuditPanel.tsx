import { formatDateTime } from './DateTime';
import { uiCopy } from './copy';

/** "Last changed by Sam · Oct 15, 10:40 PM". When the record does not say, it says so instead of guessing. */
export function AuditPanel({ who, at }: { who: string | null; at: string | null }) {
  const { t, requestedLocale } = uiCopy.useCopy();
  const when = at ? formatDateTime(at, requestedLocale)?.short : undefined;
  return <p className="pp-audit muted">{who && when ? t('lastChanged', { who, when }) : t('lastChangedUnknown')}</p>;
}
