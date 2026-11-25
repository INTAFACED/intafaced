// volt-room: /pay/activity
// volt-room: portal:activity
import { Fragment, type ReactNode } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { useSession } from '../../../../session';
import { useMemberNames, useUrlParam, type ListState } from '../../hooks';
import type { PortalApi } from '../../api';
import { DateTime } from '../../ui/DateTime';
import { countText, dateRange, useListFilters, type ListFilters } from '../../ui/FilterRow';
import { uiCopy } from '../../ui/copy';
import { EntityList, ListShell, MoneyText, MoreFooter, Section, SelectField } from '../../volt/parts';
import { RecordListRoom } from '../../volt/RecordListRoom';
import { plainCode } from '../../ui/plain-code';
import { useServerList } from '../../ui/useServerList';
import { actorName } from '../account/actors';
import { accountCopy } from '../account/copy';
import { ACTIVITY_TYPES, type ActivityItem } from '../account/schemas';
import { portalCopy } from '../copy';
import { approvalStatuses } from '../../schemas';
import { activityHref, actionWords } from './model';

/** The words the Approvals page uses for an approval's status ("consumed" reads "Used"). */
function approvalStatusWords(status: string, p: ReturnType<typeof portalCopy.useCopy>['t']): string {
  return (approvalStatuses as readonly string[]).includes(status)
    ? p(`chipApproval_${status}` as 'chipApproval_consumed')
    : actionWords('', status);
}

type Filters = Record<string, string>;

/** `/pay/activity` on the record-list template: the account's activity, once the business is known. */
export function ActivityRoom({ portal }: { portal: PortalApi }) {
  return <RecordListRoom>{() => ({ list: <Activity portal={portal} /> })}</RecordListRoom>;
}

/** `/pay/activity`: who changed what on the account, and when. Operator changes read "INTAFACED". */
function Activity({ portal }: { portal: PortalApi }) {
  const filters = useListFilters();
  const [type, setType] = useUrlParam('type');
  const [actor, setActor] = useUrlParam('actor');
  const { userId } = useSession();
  const names = useMemberNames(portal);
  const range = dateRange(filters.date, Date.now(), { from: filters.from, to: filters.to });
  const query: Filters = {
    objectType: type,
    actorId: actor,
    search: filters.search.trim(),
    from: range.from ?? '',
    to: range.to ?? '',
  };
  const list = useServerList(
    (f: Filters, cursor, signal) =>
      portal.activityList(cursor, { objectType: f.objectType!, actorId: f.actorId!, search: f.search!, from: f.from!, to: f.to! }, signal),
    query,
    (item: ActivityItem) => item.id,
  );
  return (
    <ActivityView
      filters={filters}
      type={type}
      setType={setType}
      actor={actor}
      setActor={setActor}
      names={names}
      me={userId}
      state={list.state}
      loadMore={list.loadMore}
      reload={list.reload}
    />
  );
}

export function ActivityView(props: {
  filters: ListFilters;
  type: string;
  setType: (v: string) => void;
  actor: string;
  setActor: (v: string) => void;
  names: ReadonlyMap<string, string>;
  me: string | null;
  state: ListState<ActivityItem>;
  loadMore: () => void;
  reload: () => void;
}) {
  const { t } = accountCopy.useCopy();
  const { t: p } = portalCopy.useCopy();
  const typeLabel = (type: string) => ((ACTIVITY_TYPES as readonly string[]).includes(type) ? t(`type_${type}` as 'type_payment') : type);
  const who = (item: ActivityItem) => actorName(item.actorId, props.me, props.names);
  const title = (item: ActivityItem) => {
    if (item.objectType === 'kyb') {
      const to = item.detail.toStatus ?? item.action;
      const key = `chipKyb_${to}` as 'chipKyb_none';
      return `${typeLabel('kyb')}: ${['none', 'pending', 'approved', 'rejected'].includes(to) ? p(key) : actionWords('kyb', to)}`;
    }
    // One row per payout approval, so the row says what was done (asked for); where it stands now goes in the details.
    if (item.objectType === 'approval') return t('payoutRequested');
    return `${typeLabel(item.objectType)}: ${actionWords(item.objectType, item.action)}`;
  };
  const details = (item: ActivityItem) => {
    const d = item.detail;
    const parts: ReactNode[] = [];
    if (d.amount && d.asset) parts.push(<MoneyText key="m" value={d.amount} asset={d.asset} />);
    if (d.fee && d.asset) parts.push(`${t('detailFee')} ${d.fee} ${d.asset}`);
    if (d.role) parts.push(`${t('detailRole')}: ${p(`role_${d.role}` as 'role_owner')}`);
    if (d.destinationKind && d.destinationMasked)
      parts.push(
        `${t('detailDestination')}: ${d.destinationKind === 'crypto' || d.destinationKind === 'bank' ? t(`destKind_${d.destinationKind}`) : plainCode(d.destinationKind)} ${d.destinationMasked}`,
      );
    if (d.host) parts.push(`${t('detailHost')}: ${d.host}`);
    if (d.eventType) parts.push(`${t('detailEvent')}: ${d.eventType.replace(/[._]+/g, ' ')}`);
    if (d.attempts) parts.push(t('detailAttempts', { n: d.attempts }));
    if (d.status && item.objectType === 'approval') parts.push(`${t('detailStatusNow')}: ${approvalStatusWords(d.status, p)}`);
    else if (d.status && item.objectType !== 'kyb') parts.push(actionWords('', d.status));
    return parts.length ? (
      parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && ' · '}
          {part}
        </Fragment>
      ))
    ) : (
      <span className="lt-muted">{t('detailNone')}</span>
    );
  };
  const shown = props.state.status === 'ready' ? props.state.items.length : undefined;
  const actorOptions = [...props.names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  return (
    <div className="lt-stack">
      <Section title={t('activityFeedTitle')} description={t('activityFeedBody')}>
        <div className="lt-toolbar">
          <SelectField
            label={t('filterType')}
            value={props.type}
            onChange={props.setType}
            options={[['', t('anyType')], ...ACTIVITY_TYPES.map((x) => [x, t(`type_${x}` as 'type_payment')] as const)]}
          />
          {actorOptions.length > 0 && (
            <SelectField
              label={t('filterActor')}
              value={props.actor}
              onChange={props.setActor}
              options={[['', t('anyActor')], ...actorOptions.map(([id, name]) => [id, name] as const)]}
            />
          )}
        </div>
        <Filters
          filters={props.filters}
          label={t('activityFeedTitle')}
          shown={shown}
          hasMore={props.state.status === 'ready' ? props.state.hasMore : false}
        />
        <p className="lt-muted">{t('searchHint')}</p>
        <p className="lt-muted">{t('activityPayoutNote')}</p>
        <ListShell state={props.state} retry={props.reload} empty={{ title: t('activityEmpty'), body: t('activityEmptyBody') }}>
          {(rows) => (
            <>
              <EntityList
                label={t('activityFeedTitle')}
                rows={rows}
                rowKey={(r) => r.id}
                href={(r) => activityHref(r) ?? '/pay/activity'}
                columns={[
                  { header: t('colWhen'), cell: (r) => <DateTime value={r.occurredAt} /> },
                  { header: t('colWho'), cell: who },
                  { header: t('colWhat'), cell: (r) => <strong>{title(r)}</strong> },
                  { header: t('colDetails'), cell: details },
                ]}
              />
              {props.state.status === 'ready' && <MoreFooter state={props.state} onMore={props.loadMore} />}
            </>
          )}
        </ListShell>
      </Section>
    </div>
  );
}

/** Search and date, in the address (`FilterRow` in `../../ui/FilterRow`, drawn with the kit): the honest count and a way to clear them. */
function Filters({ filters, label, shown, hasMore }: { filters: ListFilters; label: string; shown?: number; hasMore: boolean }) {
  const { t } = uiCopy.useCopy();
  const active = Boolean(filters.search || filters.status || filters.date || filters.asset);
  return (
    <div className="lt-stack" role="search" aria-label={label}>
      <div className="lt-toolbar">
        <Field label={t('search')} value={filters.search} onChange={(e) => filters.setSearch(e.target.value)} />
        <SelectField
          label={t('date')}
          value={filters.date}
          onChange={filters.setDate}
          options={[
            ['', t('anyDate')],
            ['today', t('today')],
            ['7d', t('last7')],
            ['30d', t('last30')],
            ['custom', t('custom')],
          ]}
        />
      </div>
      {filters.date === 'custom' && (
        <div className="lt-toolbar">
          <Field label={t('from')} type="date" value={filters.from} onChange={(e) => filters.setFrom(e.target.value)} />
          <Field label={t('to')} type="date" value={filters.to} onChange={(e) => filters.setTo(e.target.value)} />
        </div>
      )}
      <p className="lt-muted" role="status">
        {shown !== undefined ? countText(t, shown, hasMore) : ''}
        {active && (
          <>
            {' '}
            <Button
              tone="quiet"
              onClick={() => {
                filters.setSearch('');
                filters.setStatus('');
                filters.setDate('');
                filters.setFrom('');
                filters.setTo('');
                filters.setAsset('');
              }}
            >
              {t('clearFilters')}
            </Button>
          </>
        )}
      </p>
    </div>
  );
}
