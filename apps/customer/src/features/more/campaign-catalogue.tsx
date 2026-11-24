import { useMemo, useState } from 'react';
import { CAMPAIGN_TYPES, CATALOGUE_CAMPAIGN_STATES, type CampaignType, type CampaignView } from '@intafaced/contracts/campaigns-catalogue';
import { useApi } from '../session';
import { useResource } from '../../shared/resource';
import { Select } from '@intafaced/ui/lit';
import { FailureBox, LoadingLine, RecordTable } from '../../shared/record/record-parts';
import { FirstState } from '@intafaced/ui/lit/templates';
import { Gift } from 'lucide-react';
import { campaignCatalogueCopy } from './campaign-catalogue-copy';
import { CAMPAIGNS_CATALOGUE_LIST, CAMPAIGNS_CATALOGUE_GET } from '@intafaced/contracts/campaigns-catalogue-procedures';
import { CAMPAIGNS_PARTICIPATION_MINE } from '@intafaced/contracts/campaigns-participation-procedures';

/**
 * The campaign rooms read from svc-campaigns (CM-campaign-types-01, J-campaigns-01): the catalogue at /campaigns, one
 * campaign at /campaigns/:campaignId, and the campaigns I joined at /campaigns/mine. Only published campaigns are listed;
 * an empty catalogue says so. Parked types show their blocker. Times show in the reader's own time zone.
 */

/** A time in the reader's own zone, with the zone named. */
export function useWhen() {
  const { renderedLocale } = campaignCatalogueCopy.useCopy();
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(renderedLocale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    return (isoTime: string) => format.format(new Date(isoTime));
  }, [renderedLocale]);
}

export function useWeekdays() {
  const { renderedLocale } = campaignCatalogueCopy.useCopy();
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(renderedLocale, { weekday: 'long', timeZone: 'UTC' });
    // 2026-10-19 is a Monday.
    return (days: readonly number[]) => days.map((d) => format.format(new Date(Date.UTC(2026, 9, 18 + d)))).join(', ');
  }, [renderedLocale]);
}

const campaignHref = (id: string) => `/campaigns/${encodeURIComponent(id)}`;

/** Who can join, from the published rules: every signed-in account, less the excluded kinds and restricted regions. */
export function useWho() {
  const { t, renderedLocale } = campaignCatalogueCopy.useCopy();
  return useMemo(() => {
    const list = new Intl.ListFormat(renderedLocale, { type: 'conjunction' });
    const regions = (() => {
      try {
        return new Intl.DisplayNames(renderedLocale, { type: 'region' });
      } catch {
        return null;
      }
    })();
    return (rules: CampaignView['participation']) => {
      const parts = [
        rules.exclusions.length > 0
          ? t('whoExcept', { list: list.format(rules.exclusions.map((e) => t(`exclusion_${e}`))) })
          : t('whoEveryone'),
      ];
      if (rules.regionScope === 'listed' && rules.restrictedRegions?.length) {
        parts.push(t('whoRegions', { regions: list.format(rules.restrictedRegions.map((r) => regions?.of(r) ?? r)) }));
      }
      return parts.join('. ');
    };
  }, [t, renderedLocale]);
}

export function CampaignCatalogue() {
  const api = useApi();
  const { Copy, t } = campaignCatalogueCopy.useCopy();
  const when = useWhen();
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const catalogue = useResource((signal) => api.call(CAMPAIGNS_CATALOGUE_LIST, undefined, { signal }), 'campaigns-catalogue');
  const any = { value: '', label: t('filterAny') };
  return (
    <div className="lt-stack">
      <section>
        <h2>{t('catalogueTitle')}</h2>
        <div className="lt-actions">
          <Select
            label={t('colType')}
            value={type}
            onChange={setType}
            options={[any, ...CAMPAIGN_TYPES.map((value) => ({ value, label: t(`type_${value}`) }))]}
          />
          <Select
            label={t('colState')}
            value={status}
            onChange={setStatus}
            options={[any, ...CATALOGUE_CAMPAIGN_STATES.map((value) => ({ value, label: t(`state_${value}`) }))]}
          />
        </div>
        <div data-testid="campaign-catalogue">
          {catalogue.resource.status === 'loading' ? (
            <LoadingLine label={t('catalogueLoading')} />
          ) : catalogue.resource.status === 'failed' ? (
            <FailureBox result={catalogue.resource.failure} retry={catalogue.reload} />
          ) : catalogue.resource.data.campaigns.length === 0 ? (
            <FirstState
              icon={<Gift size={24} />}
              title={t('catalogueNone')}
              body={t('catalogueNoneBody')}
              points={[t('firstPointCompete'), t('firstPointTasks'), t('firstPointVouchers')]}
              action={{ label: t('firstCatalogueAction'), href: '/campaigns/mine' }}
            />
          ) : (
            <CampaignTable
              campaigns={catalogue.resource.data.campaigns.filter((c) => (!type || c.type === type) && (!status || c.state === status))}
              when={when}
            />
          )}
        </div>
      </section>
      <section>
        <h2>{t('typesTitle')}</h2>
        {catalogue.resource.status === 'ready' ? (
          <dl className="lt-kv" aria-label={t('typesLabel')} data-testid="campaign-types">
            {catalogue.resource.data.types.map((row) => (
              <div key={row.type} data-testid="campaign-type" data-type={row.type} data-code={row.blocker ?? undefined}>
                <dt>{t(`type_${row.type}`)}</dt>
                <dd>
                  {row.blocker ? t('typeParked') : t('typeOpen')}
                  {row.blocker ? <span className="lt-kv-note">{t(`owner.decision.${row.type as 'gift_card' | 'points'}`)}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <LoadingLine label={t('catalogueLoading')} />
        )}
        <a className="lt-link" href="/campaigns/mine">
          <Copy k="myCampaigns" />
        </a>
      </section>
    </div>
  );
}

function CampaignTable({ campaigns, when }: { campaigns: readonly CampaignView[]; when: (iso: string) => string }) {
  const { t } = campaignCatalogueCopy.useCopy();
  const who = useWho();
  if (campaigns.length === 0) return <p className="lt-hint">{t('filterNone')}</p>;
  return (
    <RecordTable
      label={t('campaignsLabel')}
      headers={[t('colName'), t('colType'), t('colState'), t('colWindow'), t('colWho'), t('colJoined')]}
    >
      {campaigns.map((c) => (
        <tr key={c.id} data-testid="campaign-card" data-campaign-id={c.id}>
          <th scope="row">
            <a className="lt-link" href={campaignHref(c.id)}>
              {c.name}
            </a>
          </th>
          <td>{t(`type_${c.type}`)}</td>
          <td data-testid="campaign-state">{t(`state_${c.state}`)}</td>
          <td data-testid="campaign-window">{t('windowValue', { start: when(c.startsAt), end: when(c.endsAt) })}</td>
          <td data-testid="campaign-who">{who(c.participation)}</td>
          <td>{c.mine ? t('joined') : t('notJoined')}</td>
        </tr>
      ))}
    </RecordTable>
  );
}

/** /campaigns/mine: the campaigns I joined, newest first. */
export function MyCampaigns() {
  const api = useApi();
  const { Copy, t } = campaignCatalogueCopy.useCopy();
  const when = useWhen();
  const mine = useResource((signal) => api.call(CAMPAIGNS_PARTICIPATION_MINE, undefined, { signal }), 'campaigns-mine');
  return (
    <section>
      <h2>{t('mineTitle')}</h2>
      <div data-testid="campaigns-mine">
        {mine.resource.status === 'loading' ? (
          <LoadingLine label={t('mineLoading')} />
        ) : mine.resource.status === 'failed' ? (
          <FailureBox result={mine.resource.failure} retry={mine.reload} />
        ) : mine.resource.data.campaigns.length === 0 ? (
          <FirstState
            icon={<Gift size={24} />}
            title={t('mineNone')}
            body={t('mineNoneBody')}
            action={{ label: t('firstMineAction'), href: '/campaigns' }}
          />
        ) : (
          <RecordTable label={t('mineLabel')} headers={[t('colName'), t('colType'), t('colState'), t('colWindow'), t('colJoined')]}>
            {mine.resource.data.campaigns.map(({ campaign: c, participation }) => (
              <tr key={c.id} data-testid="my-campaign" data-campaign-id={c.id}>
                <th scope="row">
                  <a className="lt-link" href={campaignHref(c.id)}>
                    {c.name}
                  </a>
                </th>
                <td>{t(`type_${c.type as CampaignType}`)}</td>
                <td>{t(`state_${c.state}`)}</td>
                <td>{t('windowValue', { start: when(c.startsAt), end: when(c.endsAt) })}</td>
                <td>{t('joinedAt', { when: when(participation.joinedAt) })}</td>
              </tr>
            ))}
          </RecordTable>
        )}
      </div>
      <a className="lt-link" href="/campaigns">
        <Copy k="backToCatalogue" />
      </a>
    </section>
  );
}

/** One campaign as svc-campaigns publishes it, for its own page (`campaign-detail/CampaignDetailRoom.tsx`). */
export function useCampaignView(campaignId: string) {
  const api = useApi();
  return useResource((signal) => api.call(CAMPAIGNS_CATALOGUE_GET, { id: campaignId }, { signal }), `campaign-${campaignId}`);
}
