import { useResource, type Resource } from '../../shared/resource';
import { usePreferences } from '../../shared/preferences';
import { useSession } from '../session/session';
import { maintenancePhase } from '../public/notices-api';
import { fundingNoticesCopy } from './funding-notices-copy';
import { isNoticePair, readFundingNotices, type FundingNotice, type FundingNotices, type FundingPhase } from './funding-notices-reads';

const STAGE_WORDS: Record<FundingPhase, 'stageInvestigating' | 'stageIdentified' | 'stageUpdate' | 'stageMonitoring' | 'stageResolved'> = {
  investigating: 'stageInvestigating',
  identified: 'stageIdentified',
  update: 'stageUpdate',
  monitoring: 'stageMonitoring',
  resolved: 'stageResolved',
};

/** A date and time in the person's language and chosen clock, with the zone named (dateStyle cannot carry a zone name). Null when there is none to show. */
function useFormatWhen() {
  const { requestedLocale } = fundingNoticesCopy.useCopy();
  const { timeZone } = usePreferences();
  const zone = timeZone === 'device' ? {} : { timeZone: timeZone === 'UTC+8' ? 'Asia/Singapore' : 'UTC' };
  const format = new Intl.DateTimeFormat(requestedLocale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...zone,
  });
  return (iso: string | null) => {
    const at = iso === null ? NaN : Date.parse(iso);
    return Number.isNaN(at) ? null : format.format(at);
  };
}

/**
 * Open funding incidents and maintenance the founders published for this asset on this network only (W-compliance-notices-01),
 * each with its stage and dates. Nothing open shows nothing; a failed read says so and points to the status page. A pair
 * spelled outside the registry's pattern can carry no notice, so it is not asked about.
 */
export function FundingNoticesBanner({ asset, networkId, networkLabel }: { asset: string; networkId: string; networkLabel: string }) {
  const { api } = useSession();
  const asked = isNoticePair(asset, networkId);
  const { resource } = useResource<FundingNotices>(
    (signal) =>
      asked
        ? readFundingNotices(api, asset, networkId, signal)
        : Promise.resolve({ ok: true, data: { asset, network: networkId, incidents: [], maintenance: [] } }),
    `funding-notices:${asset}:${networkId}`,
  );
  return <FundingNoticesView asset={asset} networkLabel={networkLabel} notices={resource} />;
}

export function FundingNoticesView({
  asset,
  networkLabel,
  notices,
}: {
  asset: string;
  networkLabel: string;
  notices: Resource<FundingNotices>;
}) {
  const { t } = fundingNoticesCopy.useCopy();
  const formatWhen = useFormatWhen();
  const where = { asset, network: networkLabel };
  // The wrapper is always there and says where the read stands, so "nothing open" is an answer, not a read still running.
  const state =
    notices.status !== 'ready' ? notices.status : notices.data.incidents.length + notices.data.maintenance.length > 0 ? 'open' : 'none';
  return (
    <div data-testid="funding-notices" data-state={state}>
      {notices.status === 'failed' && (
        <p className="bd-address" role="status" data-testid="funding-notices-failed">
          {t('loadFailed', where)}{' '}
          <a className="text-link" href="/status">
            {t('statusLink')} ↗
          </a>
        </p>
      )}
      {notices.status === 'ready' &&
        notices.data.incidents.map(({ root, latest }) => (
          <section key={root.id} className="bd-address" role="alert" data-testid={`funding-incident-${root.id}`}>
            <strong>{t('incidentTitle', where)}</strong>
            <h4 lang="und">{root.title}</h4>
            <p>{t('lead', where)}</p>
            <p data-testid="funding-incident-stage">
              {t('stage', { stage: latest.phase === null ? t('stageUnset') : t(STAGE_WORDS[latest.phase]) })}
            </p>
            <p data-testid="funding-incident-dates">
              {t('started', { date: formatWhen(root.startsAt ?? root.publishedAt) ?? t('timeUnset') })}
              {latest.id !== root.id && ` · ${t('updated', { date: formatWhen(latest.publishedAt) ?? t('timeUnset') })}`}
            </p>
            <p lang="und">{latest.body}</p>
          </section>
        ))}
      {notices.status === 'ready' &&
        notices.data.maintenance.map((row) => <MaintenanceNotice key={row.id} row={row} where={where} formatWhen={formatWhen} />)}
    </div>
  );
}

function MaintenanceNotice({
  row,
  where,
  formatWhen,
}: {
  row: FundingNotice;
  where: { asset: string; network: string };
  formatWhen: (iso: string | null) => string | null;
}) {
  const { t } = fundingNoticesCopy.useCopy();
  const phase = maintenancePhase(row, Date.now());
  const start = formatWhen(row.startsAt);
  const end = formatWhen(row.endsAt);
  return (
    <section className="bd-address" role="status" data-testid={`funding-maintenance-${row.id}`}>
      <strong>{t('maintenanceTitle', where)}</strong>
      <h4 lang="und">{row.title}</h4>
      <p data-testid="funding-maintenance-window">
        {phase === 'time_unset' || start === null
          ? t('timeUnset')
          : phase === 'end_unset' || end === null
            ? t('windowOpenEnd', { start })
            : t('window', { start, end })}
      </p>
      <p lang="und">{row.body}</p>
    </section>
  );
}
