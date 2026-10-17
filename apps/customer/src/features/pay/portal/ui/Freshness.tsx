import { STALE_AFTER_SECONDS } from '../model';
import { useNow } from '../hooks';
import { uiCopy } from './copy';

/** How old the figures are: the time since they were read, plus any lag the server reported. */
export function ageSeconds(asOf: string, now: number, lagSeconds = 0): number {
  const read = Date.parse(asOf);
  if (!Number.isFinite(read)) return 0;
  return Math.max(0, Math.floor((now - read) / 1000)) + Math.max(0, lagSeconds);
}

/**
 * "Updated 2 min ago", once per page, in the header slot. Past the stale line it adds a calm amber note. One
 * shared clock (`useNow`) keeps every Freshness on a page agreeing.
 */
export function Freshness({ asOf, lagSeconds = 0 }: { asOf: string | null; lagSeconds?: number }) {
  const { t } = uiCopy.useCopy();
  const now = useNow();
  if (!asOf) return null;
  const age = ageSeconds(asOf, now, lagSeconds);
  const text =
    age < 60
      ? t('updatedJustNow')
      : age < 3600
        ? t('updatedMinutes', { n: Math.floor(age / 60) })
        : age < 86_400
          ? t('updatedHours', { n: Math.floor(age / 3600) })
          : t('updatedDays', { n: Math.floor(age / 86_400) });
  const stale = age > STALE_AFTER_SECONDS;
  return (
    <p className={`pp-asof${stale ? ' pp-asof--warn' : ''}`} role="status">
      {text}
      {stale && <> · {t('figuresBehind')}</>}
    </p>
  );
}
