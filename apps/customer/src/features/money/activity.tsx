import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button, Page, Tabs } from '../../shared/ui';
import { useSession } from '../session/session';
import { savePreferences, usePreferences } from '../../shared/preferences';
import { t, Text } from './copy';
import { ScheduleExecutions } from './ScheduleHistory';
import { onrampSchema, offrampSchema, scheduleSchema } from './contracts';
import { Continuation, date, funds, NoRows, ResourceView, Section, useBankRead, usePageLimit } from './components';

type Record = z.infer<typeof onrampSchema> | z.infer<typeof offrampSchema> | z.infer<typeof scheduleSchema>;
const sources = {
  incoming: { procedure: 'ramps.onramps', label: 'activity.incoming', title: 'rooms.incoming.rail.records' },
  outgoing: { procedure: 'ramps.offramps', label: 'activity.outgoing', title: 'rooms.outgoing.rail.records' },
  scheduled: { procedure: 'transfers.listSchedules', label: 'activity.scheduled', title: 'rooms.standing.orders' },
} as const;
type Source = keyof typeof sources;
const sourceKeys = Object.keys(sources) as Source[];
function recordTitle(row: Record) {
  return 'cadence' in row ? t('activity.scheduled.transfer') : row.kind === 'crypto' ? t('activity.crypto.rail') : t('activity.fiat.rail');
}

export function MoneyActivity() {
  const { mode } = useSession();
  const { hideBalances } = usePreferences();
  const [source, setSource] = useState<Source>('incoming');
  const values = new URLSearchParams(location.search).getAll('asset');
  const context = values.length === 0 ? undefined : values.length === 1 ? z.string().min(1).max(16).safeParse(values[0]) : null;
  const invalid = context === null || (context !== undefined && !context.success);
  const asset = context?.success ? context.data : undefined;
  if (invalid || mode === 'Business')
    return (
      <Page eyebrow={t('rooms.money')} title={t('rooms.money.activity')}>
        <Section title={t(invalid ? 'activity.invalid.context' : 'activity.company.unavailable')}>
          <p>{t(invalid ? 'activity.invalid.help' : 'activity.company.help')}</p>
          <a className="text-link" href={invalid ? '/uc/record' : '/bank/business'}>
            {t(invalid ? 'activity.all.assets' : 'nav.business')}
          </a>
        </Section>
      </Page>
    );
  return (
    <Page
      eyebrow={t('rooms.money')}
      title={asset ? t('rooms.activity', { value1: asset }) : t('rooms.money.activity')}
      description={t(asset ? 'activity.description' : 'activity.description.all')}
      actions={
        <>
          <Button variant="ghost" aria-pressed={hideBalances} onClick={() => savePreferences({ hideBalances: !hideBalances })}>
            {t(hideBalances ? 'index.show.amounts' : 'index.hide.amounts')}
          </Button>
          <a className="button button--secondary" href={asset ? `/portfolio/${encodeURIComponent(asset)}` : '/portfolio'}>
            {asset ? t('activity.back.asset', { asset }) : t('rooms.back.to.holdings')}
          </a>
        </>
      }
    >
      <div data-testid="money-activity" className="money-activity">
        <aside className="money-activity-coverage" aria-label={t('activity.coverage')}>
          <strong>{t('activity.bank.only')}</strong>
          <p>{t('activity.history.dependency')}</p>
        </aside>
        <Tabs
          items={sourceKeys}
          value={source}
          onChange={(value) => setSource(value as Source)}
          label={t('activity.sources')}
          labels={{ incoming: t(sources.incoming.label), outgoing: t(sources.outgoing.label), scheduled: t(sources.scheduled.label) }}
        />
        <ActivitySource key={`${asset ?? ''}:${source}`} source={source} asset={asset} />
        <div className="money-activity-related">
          <a className="text-link" href="/bank/transfers">
            {t('activity.manage.schedules')} ↗
          </a>
          <a className="text-link" href="/bank/cards">
            {t('rooms.card.decisions.and.declines')} ↗
          </a>
          <a className="text-link" href="/bank/analytics">
            {t('rooms.movement.analysis')} ↗
          </a>
        </div>
      </div>
    </Page>
  );
}

function ActivitySource({ source, asset }: { source: Source; asset?: string }) {
  const [limit, setLimit] = usePageLimit();
  const [selected, setSelected] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const query = useBankRead(sources[source].procedure, { limit });
  const all = query.resource.status === 'ready' ? query.resource.data : [];
  const rows = asset ? all.filter((row) => row.assetId === asset) : all;
  const row = rows.find((record) => record.id === selected);
  useEffect(() => {
    if (selected) {
      heading.current?.focus({ preventScroll: true });
      heading.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [selected]);
  return (
    <div className="money-activity-layout">
      <Section
        title={t(sources[source].title)}
        actions={
          <Button variant="ghost" onClick={query.reload}>
            <Text k="rooms.refresh" />
          </Button>
        }
      >
        {source === 'scheduled' && <p className="muted">{t('activity.instructions')}</p>}
        <ResourceView resource={query.resource} reload={query.reload}>
          {() => (
            <>
              {rows.length ? (
                <div data-testid="money-activity-list" className="money-activity-list">
                  {rows.map((record) => (
                    <button
                      type="button"
                      key={record.id}
                      data-testid="money-activity-row"
                      className="money-activity-row"
                      aria-controls="money-record-details"
                      aria-pressed={selected === record.id}
                      aria-label={t('activity.inspect', { title: recordTitle(record), reference: record.id })}
                      onClick={() => setSelected(record.id)}
                    >
                      <span className="money-activity-icon" aria-hidden="true">
                        {source === 'incoming' ? '↙' : source === 'outgoing' ? '↗' : '↻'}
                      </span>
                      <span className="money-activity-identity">
                        <strong>{recordTitle(record)}</strong>
                        <small>
                          {record.status} · {'nextRunAt' in record ? date(record.nextRunAt) : date(record.createdAt)}
                          {'simulated' in record && record.simulated && ` · ${t('activity.simulated')}`}
                        </small>
                      </span>
                      <span className="money-activity-amount numeric">{funds(record.amount, record.assetId)}</span>
                      <span className="money-activity-chevron" aria-hidden="true">
                        →
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <NoRows title={t('activity.no.matches')}>
                  {asset ? t('activity.no.asset.read', { asset }) : t('activity.no.records.read')}
                </NoRows>
              )}
              {asset && <p className="money-caption">{t('activity.matches', { count: rows.length, asset, returned: all.length })}</p>}
              <Continuation count={all.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
            </>
          )}
        </ResourceView>
      </Section>
      <section id="money-record-details" className="money-activity-details" aria-labelledby="money-record-heading">
        <h2 id="money-record-heading" ref={heading} tabIndex={-1}>
          {t('activity.details')}
        </h2>
        {selected ? (
          <>
            <dl className="money-activity-facts">
              <div>
                <dt>{t('activity.original')}</dt>
                <dd>{selected}</dd>
              </div>
            </dl>
            {row ? (
              <RecordDetails row={row} />
            ) : (
              <p role="status" className="muted">
                {t(query.resource.status === 'ready' ? 'activity.absent.selected' : 'activity.current.unavailable')}
              </p>
            )}
            <a className="text-link" href="/support">
              {t('index.open.support')} ↗
            </a>
          </>
        ) : (
          <p className="muted">{t('activity.select')}</p>
        )}
      </section>
    </div>
  );
}

function RecordDetails({ row }: { row: Record }) {
  const facts: [string, string][] = [
    [t('rooms.amount'), funds(row.amount, row.assetId)],
    [t('activity.reported.status'), row.status],
  ];
  if ('cadence' in row) facts.push([t('activity.cadence'), row.cadence], [t('repeat-buy.next.run'), date(row.nextRunAt)]);
  else {
    facts.push([t('activity.rail'), row.rail], [t('activity.created'), date(row.createdAt)]);
    if ('ledgerTxId' in row)
      facts.push([t('rooms.ledger.transaction'), row.ledgerTxId ?? t('rooms.not.posted')], [t('activity.rail.reference'), row.railRef]);
    else
      facts.push(
        [t('rooms.destination.reference'), row.destinationRef],
        [t('rooms.client.reference'), row.clientRef],
        [t('rooms.reservation.transaction'), row.holdLedgerTxId ?? t('rooms.none.supplied')],
        [t('rooms.settlement.transaction'), row.settleLedgerTxId ?? t('rooms.not.supplied')],
      );
  }
  return (
    <>
      <dl className="money-activity-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {'simulated' in row && row.simulated && <p className="money-activity-coverage">{t('rooms.this.record.does.not.confirm.a.live')}</p>}
      {'cadence' in row && <ScheduleExecutions key={row.id} id={row.id} asset={row.assetId} />}
    </>
  );
}
