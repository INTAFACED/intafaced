import { useEffect, useState } from 'react';
import type { ApiResult } from '../../../shared/api';
import type { PersonalPayApi } from '../pay-api';
import { id, type Reputation } from '../schemas';
import { p2pDepth } from './p2p-depth-copy';
import { makerSummary, splitDuration } from './p2p-model';

/** The most makers whose record is fetched for one board. A board is a window, not the whole market. */
const MAX_TRADERS = 24;

/** `null` means no record was asked for (beyond the cap, or not a valid id); a missing key means still loading. */
export type TraderRecords = Record<string, ApiResult<Reputation> | null>;

/**
 * The service's public record for each maker on a board, fetched once per person. A maker that cannot be read shows no
 * record; nothing is filled in.
 */
export function useTraders(pay: PersonalPayApi, makerIds: readonly string[]): TraderRecords {
  const valid = [...new Set(makerIds.filter((value) => id.safeParse(value).success).map((value) => value.toLowerCase()))].sort();
  const key = valid.slice(0, MAX_TRADERS).join(',');
  const notAsked = Object.fromEntries(
    [...makerIds.map((value) => value.toLowerCase()).filter((value) => !valid.slice(0, MAX_TRADERS).includes(value))].map((value) => [
      value,
      null,
    ]),
  );
  const [records, setRecords] = useState<TraderRecords>({});
  useEffect(() => {
    const controller = new AbortController();
    for (const makerId of key ? key.split(',') : []) {
      void pay.reputation(makerId, controller.signal).then((result) => {
        if (!controller.signal.aborted) setRecords((previous) => ({ ...previous, [makerId]: result }));
      });
    }
    return () => controller.abort();
  }, [key, pay]);
  return { ...notAsked, ...records };
}

/** "@handle" when identity gave one, otherwise "Member". Never the account id. */
export function TraderName({ record }: { record: ApiResult<Reputation> | null | undefined }) {
  const { t } = p2pDepth.useCopy();
  if (record === undefined) return <span aria-busy="true" />;
  const handle = record?.ok ? record.data.handle : null;
  if (handle) return <span lang="zxx">{`@${handle}`}</span>;
  // Identity answered and holds no public profile for this member: say so. When identity is not connected at all
  // (`unwired`, or no status) nothing is known about the member, so it stays "Member".
  if (record?.ok && record.data.profile?.status === 'absent')
    return (
      <span>
        <span aria-hidden="true">—</span> <small className="muted">{t('traderNoHandle')}</small>
      </span>
    );
  return <span>{t('traderUnnamed')}</span>;
}

/** Orders, completion rate and average release time, exactly as returned. */
export function TraderSummary({ record }: { record: ApiResult<Reputation> | null | undefined }) {
  const { t, requestedLocale } = p2pDepth.useCopy();
  if (!record) return null;
  if (!record.ok) return <span className="muted">{t('traderRecordOff')}</span>;
  const summary = makerSummary(record.data);
  if (summary.kind === 'new') return <span className="muted">{t('traderNew')}</span>;
  const n = new Intl.NumberFormat(requestedLocale, { maximumFractionDigits: 0 }).format(summary.orders);
  // "1 order", "3 orders": the plural rule of the shown language, not a bare "s".
  const orders = t(new Intl.PluralRules(requestedLocale).select(summary.orders) === 'one' ? 'traderOrdersOne' : 'traderOrdersMany', { n });
  if (summary.kind === 'unfinished') return <span className="muted">{t('traderRecordOpen', { orders })}</span>;
  const rate = new Intl.NumberFormat(requestedLocale, { style: 'percent', maximumFractionDigits: 1 }).format(summary.completionRate);
  if (summary.releaseSecs === null) return <span className="muted">{t('traderRecord', { orders, rate })}</span>;
  const parts = splitDuration(summary.releaseSecs);
  const time =
    parts.unit === 'seconds'
      ? t('durSeconds', { s: parts.major })
      : parts.unit === 'minutes'
        ? t('durMinutes', { m: parts.major })
        : t('durHours', { h: parts.major, m: parts.minor ?? 0 });
  return <span className="muted">{t('traderRecordRelease', { orders, rate, time })}</span>;
}
