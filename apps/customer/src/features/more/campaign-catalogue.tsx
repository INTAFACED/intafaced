import { useMemo, useState } from 'react';
import {
  CAMPAIGN_TYPES,
  CATALOGUE_CAMPAIGN_STATES,
  campaignCatalogueSchema,
  campaignJoinResultSchema,
  campaignViewSchema,
  myCampaignsSchema,
  type CampaignType,
  type CampaignView,
} from '@intafaced/contracts/campaigns-catalogue';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, EmptyState, Failure, Loading, Panel } from '../../shared/ui';
import { Select } from './common';
import { StatRow } from './depth-kit';
import { campaignCatalogueCopy } from './campaign-catalogue-copy';

/**
 * The campaign rooms read from svc-campaigns (CM-campaign-types-01, J-campaigns-01): the catalogue at /campaigns, one
 * campaign at /campaigns/:campaignId, and the campaigns I joined at /campaigns/mine. Only published campaigns are listed;
 * an empty catalogue says so. Parked types show their blocker. Times show in the reader's own time zone.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** Refusals these rooms put into their own words; any other failure goes to the shared Failure. */
const JOIN_CODES = ['campaign.unknown', 'campaign.not_active', 'campaign.outside_window', 'campaigns.timezone_unset'] as const;
type JoinCode = (typeof JOIN_CODES)[number];
const joinCode = (code: string | undefined): JoinCode | null =>
  (JOIN_CODES as readonly string[]).find((c) => c === code) as JoinCode | null;

/** A time in the reader's own zone, with the zone named. */
function useWhen() {
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

function useWeekdays() {
  const { renderedLocale } = campaignCatalogueCopy.useCopy();
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(renderedLocale, { weekday: 'long', timeZone: 'UTC' });
    // 2026-10-19 is a Monday.
    return (days: readonly number[]) => days.map((d) => format.format(new Date(Date.UTC(2026, 9, 18 + d)))).join(', ');
  }, [renderedLocale]);
}

const campaignHref = (id: string) => `/campaigns/${encodeURIComponent(id)}`;

export function CampaignCatalogue() {
  const api = useApi();
  const { Copy, t } = campaignCatalogueCopy.useCopy();
  const when = useWhen();
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const catalogue = useResource(
    (signal) => api.query('campaigns', 'catalogue.list', undefined, campaignCatalogueSchema, { signal }),
    'campaigns-catalogue',
  );
  const any = { value: '', label: t('filterAny') };
  return (
    <div className="more-columns">
      <Panel title={t('catalogueTitle')}>
        <div className="depth-filters">
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
            <Loading label={t('catalogueLoading')} />
          ) : catalogue.resource.status === 'failed' ? (
            <Failure result={catalogue.resource.failure} retry={catalogue.reload} />
          ) : catalogue.resource.data.campaigns.length === 0 ? (
            <EmptyState title={<Copy k="catalogueNone" />}>
              <Copy k="catalogueNoneBody" />
            </EmptyState>
          ) : (
            <CampaignTable
              campaigns={catalogue.resource.data.campaigns.filter((c) => (!type || c.type === type) && (!status || c.state === status))}
              when={when}
            />
          )}
        </div>
      </Panel>
      <Panel title={t('typesTitle')}>
        {catalogue.resource.status === 'ready' ? (
          <ul className="depth-list" aria-label={t('typesLabel')} data-testid="campaign-types">
            {catalogue.resource.data.types.map((row) => (
              <li key={row.type} data-testid="campaign-type" data-type={row.type} data-code={row.blocker ?? undefined}>
                <strong>{t(`type_${row.type}`)}</strong>: {row.blocker ? t('typeParked') : t('typeOpen')}
                {row.blocker ? <p className="muted">{t(`owner.decision.${row.type as 'gift_card' | 'points'}`)}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <Loading label={t('catalogueLoading')} />
        )}
        <a className="text-link" href="/campaigns/mine">
          <Copy k="myCampaigns" />
        </a>
      </Panel>
    </div>
  );
}

function CampaignTable({ campaigns, when }: { campaigns: readonly CampaignView[]; when: (iso: string) => string }) {
  const { t } = campaignCatalogueCopy.useCopy();
  if (campaigns.length === 0) return <p className="muted">{t('filterNone')}</p>;
  return (
    <DataTable
      label={t('campaignsLabel')}
      headers={[t('colName'), t('colType'), t('colState'), t('colWindow'), t('colWho'), t('colJoined')]}
    >
      {campaigns.map((c) => (
        <tr key={c.id} data-testid="campaign-card" data-campaign-id={c.id}>
          <th scope="row">
            <a className="text-link" href={campaignHref(c.id)}>
              {c.name}
            </a>
          </th>
          <td>{t(`type_${c.type}`)}</td>
          <td data-testid="campaign-state">{t(`state_${c.state}`)}</td>
          <td data-testid="campaign-window">{t('windowValue', { start: when(c.startsAt), end: when(c.endsAt) })}</td>
          <td data-testid="campaign-who">{t('whoEveryone')}</td>
          <td>{c.mine ? t('joined') : t('notJoined')}</td>
        </tr>
      ))}
    </DataTable>
  );
}

/** /campaigns/:campaignId. After any join answer, or none, the page reads the stored campaign again. */
export function CampaignDetail({ campaignId }: { campaignId: string }) {
  const api = useApi();
  const { Copy, t } = campaignCatalogueCopy.useCopy();
  const campaign = useResource(
    (signal) => api.query('campaigns', 'catalogue.get', { id: campaignId }, campaignViewSchema, { signal }),
    `campaign-${campaignId}`,
  );
  const [refusal, setRefusal] = useState<Failed | null>(null);
  return (
    <div className="more-grid" data-testid="campaign-detail">
      {campaign.resource.status === 'loading' ? (
        <Panel title={t('detailTitle')}>
          <Loading label={t('detailLoading')} />
        </Panel>
      ) : campaign.resource.status === 'failed' ? (
        <Panel title={t('detailTitle')}>
          {campaign.resource.failure.code === 'campaign.unknown' ? (
            <EmptyState title={<Copy k="campaign.unknown" />} />
          ) : (
            <Failure result={campaign.resource.failure} retry={campaign.reload} />
          )}
        </Panel>
      ) : (
        <CampaignBody
          campaign={campaign.resource.data}
          refusal={refusal}
          settle={(failure) => {
            setRefusal(failure);
            campaign.reload();
          }}
        />
      )}
      <a className="text-link" href="/campaigns">
        <Copy k="backToCatalogue" />
      </a>
    </div>
  );
}

function CampaignBody({
  campaign: c,
  refusal,
  settle,
}: {
  campaign: CampaignView;
  refusal: Failed | null;
  settle: (failure: Failed | null) => void;
}) {
  const api = useApi();
  const { t } = campaignCatalogueCopy.useCopy();
  const when = useWhen();
  const weekdays = useWeekdays();
  const [busy, setBusy] = useState(false);
  const join = async () => {
    setBusy(true);
    const result = await api.mutate('campaigns', 'participation.join', { campaignId: c.id }, campaignJoinResultSchema);
    setBusy(false);
    settle(result.ok ? null : result);
  };
  const code = refusal && !c.mine ? joinCode(refusal.code) : null;
  return (
    <>
      <Panel title={c.name}>
        <StatRow
          items={[
            { label: t('colType'), value: <span data-testid="campaign-type-name">{t(`type_${c.type}`)}</span> },
            { label: t('colState'), value: <span data-testid="campaign-state">{t(`state_${c.state}`)}</span> },
            {
              label: t('timeFrame'),
              value: <span data-testid="campaign-window">{t('windowValue', { start: when(c.startsAt), end: when(c.endsAt) })}</span>,
            },
            { label: t('colWho'), value: <span data-testid="campaign-who">{t('whoEveryone')}</span> },
          ]}
        />
        <StatRow
          items={[
            {
              label: t('days'),
              value: <span data-testid="campaign-days">{c.windows.weekdays ? weekdays(c.windows.weekdays) : t('daysEvery')}</span>,
            },
            {
              label: t('hours'),
              value: (
                <span data-testid="campaign-hours">
                  {c.windows.hours
                    ? t('hoursValue', { from: c.windows.hours.from, to: c.windows.hours.to, zone: c.timeZone })
                    : t('hoursAll')}
                </span>
              ),
            },
            {
              label: t('budgetLeft'),
              value: (
                <span data-testid="campaign-budget-left">
                  {t('budgetLeftValue', { left: c.budget.left, limit: c.budget.limit, asset: c.budget.asset })}
                </span>
              ),
            },
            {
              label: t('reward'),
              value: (
                <span data-testid="campaign-reward">
                  {c.reward ? t('rewardValue', { amount: c.reward.amount, asset: c.reward.asset }) : t('rewardUnset')}
                </span>
              ),
            },
          ]}
        />
      </Panel>
      <Panel title={t('rulesTitle')}>
        <p data-testid="campaign-rules" lang="und">
          {c.rules || t('rulesNone')}
        </p>
      </Panel>
      <Panel title={t('joinShort')}>
        {c.mine ? (
          <p role="status" data-testid="campaign-joined">
            {t('joinedAt', { when: when(c.mine.joinedAt) })}
          </p>
        ) : (
          <Button onClick={() => void join()} disabled={busy} aria-label={t('join', { name: c.name })}>
            {busy ? t('joining') : t('joinShort')}
          </Button>
        )}
        {refusal && !c.mine ? (
          code ? (
            <p role="status" className="muted" data-testid="campaign-refusal" data-code={code}>
              {t(code)}
            </p>
          ) : (
            <Failure result={refusal} />
          )
        ) : null}
        <p className="muted">{t('joinNote')}</p>
      </Panel>
    </>
  );
}

/** /campaigns/mine: the campaigns I joined, newest first. */
export function MyCampaigns() {
  const api = useApi();
  const { Copy, t } = campaignCatalogueCopy.useCopy();
  const when = useWhen();
  const mine = useResource(
    (signal) => api.query('campaigns', 'participation.mine', undefined, myCampaignsSchema, { signal }),
    'campaigns-mine',
  );
  return (
    <Panel title={t('mineTitle')}>
      <div data-testid="campaigns-mine">
        {mine.resource.status === 'loading' ? (
          <Loading label={t('mineLoading')} />
        ) : mine.resource.status === 'failed' ? (
          <Failure result={mine.resource.failure} retry={mine.reload} />
        ) : mine.resource.data.campaigns.length === 0 ? (
          <EmptyState title={<Copy k="mineNone" />} />
        ) : (
          <DataTable label={t('mineLabel')} headers={[t('colName'), t('colType'), t('colState'), t('colWindow'), t('colJoined')]}>
            {mine.resource.data.campaigns.map(({ campaign: c, participation }) => (
              <tr key={c.id} data-testid="my-campaign" data-campaign-id={c.id}>
                <th scope="row">
                  <a className="text-link" href={campaignHref(c.id)}>
                    {c.name}
                  </a>
                </th>
                <td>{t(`type_${c.type as CampaignType}`)}</td>
                <td>{t(`state_${c.state}`)}</td>
                <td>{t('windowValue', { start: when(c.startsAt), end: when(c.endsAt) })}</td>
                <td>{t('joinedAt', { when: when(participation.joinedAt) })}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </div>
      <a className="text-link" href="/campaigns">
        <Copy k="backToCatalogue" />
      </a>
    </Panel>
  );
}
