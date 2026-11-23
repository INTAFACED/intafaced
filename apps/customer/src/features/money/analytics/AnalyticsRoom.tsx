// volt-room: /bank/analytics
import { useMemo, useState } from 'react';
import { Button, Field, Select } from '@intafaced/ui/lit';
import { Bars, MonitorTemplate } from '@intafaced/ui/lit/templates';
import { BANK_ANALYTICS_SPEND } from '@intafaced/contracts/bank-analytics-procedures';
import { currentPreferences } from '../../../shared/preferences';
import { t as copyText, Text } from '../copy';
import { date, funds, iso, useBankRecord } from '../components';
import { categoryLabel } from '../analytics-copy';
import { splitAnalytics } from '../analytics-model';
import { BankSection, BankTabs, NoRows, bankRoomProps } from '../bank-frame/BankFrame';
import { ResourceView } from '../bank-settings/parts';
import { goalChartCopy } from '../goal-chart-copy';
import { movementShares } from '../goal-progress';
import { useHoldings } from '../holdings';
import { PERIOD_PRESETS, periodRange, type PeriodPreset } from '../periods';
import { statementCentreCopy } from '../statement-centre-copy';
import { transferDepthCopy } from '../transfer-depth-copy';
import { AnalyticsBudgets, AnalyticsCompare } from './AnalyticsBudgets';

/**
 * `/bank/analytics` (J-bank-16, J-portfolio-11): the Bank's Analytics room on the monitor template: the way to the
 * statement centre, budgets and the month comparison, and the movement of one asset over a chosen window, with its
 * outflow by category and money in, from the bank's own ledger fold.
 */

/**
 * Inflow against outflow over the chosen window, drawn from the two totals the bank returned. The bank does not return a
 * point per day, so there is no line and no invented step. The kit's bars carry their own table for screen readers.
 */
function MovementChart({ inflow, outflow, assetId }: { inflow: string; outflow: string; assetId: string }) {
  const { t } = goalChartCopy.useCopy();
  if (!movementShares(inflow, outflow) || currentPreferences().hideBalances) return null;
  return (
    <Bars
      label={t('chartTitle')}
      asset={assetId}
      bars={[
        { label: t('inflow'), value: inflow },
        { label: t('outflow'), value: outflow },
      ]}
    />
  );
}

/** The way into the statement and export centre from Analytics. */
function StatementsLink() {
  const { t } = statementCentreCopy.useCopy();
  return (
    <p className="lt-hint">
      <a className="lt-link" href="/bank/statements">
        {t('open')}
      </a>{' '}
      {t('openHint')}
    </p>
  );
}
/** A range is sent only while the read is on; this stands in for it while the read is off, and is never sent. */
const NO_RANGE = { assetId: '', from: '', to: '' };
export function AnalyticsRoom() {
  const depth = transferDepthCopy.useCopy();
  const held = useHoldings();
  const assets = held.resource.status === 'ready' ? held.resource.data.assets : [];
  const [chosen, setChosen] = useState('');
  const [preset, setPreset] = useState<PeriodPreset>('30d');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [useCustom, setUseCustom] = useState(false);
  const assetId = chosen || assets[0]?.assetId || '';
  const range = useMemo(() => {
    if (!assetId) return null;
    if (useCustom) {
      if (!Number.isFinite(Date.parse(custom.from)) || !Number.isFinite(Date.parse(custom.to))) return null;
      if (Date.parse(custom.from) >= Date.parse(custom.to)) return null;
      return { assetId, from: iso(custom.from), to: iso(custom.to) };
    }
    return { assetId, ...periodRange(preset, new Date(Math.floor(Date.now() / 60_000) * 60_000)) };
  }, [assetId, preset, useCustom, custom.from, custom.to]);
  const query = useBankRecord(BANK_ANALYTICS_SPEND, range ?? NO_RANGE, range !== null);
  const presetLabel = (value: PeriodPreset) =>
    depth.t(value === '7d' ? 'period7d' : value === '30d' ? 'period30d' : value === 'month' ? 'periodMonth' : 'periodLastMonth');
  return (
    <MonitorTemplate
      {...bankRoomProps('Analytics', copyText('rooms.ledger.movements.by.asset.and.date.movement'))}
      state={{ kind: 'ready' }}
      mode="pro"
      figures={[]}
      section={<BankTabs />}
      related={<StatementsLink />}
      panels={
        <div className="lt-stack">
          {assetId && (
            <>
              <AnalyticsBudgets assetId={assetId} />
              <AnalyticsCompare assetId={assetId} />
            </>
          )}
          <BankSection title={copyText('rooms.movement.window')}>
            <div className="lt-stack">
              <Select
                label={depth.t('assetPicker')}
                value={assetId}
                onChange={setChosen}
                disabled={assets.length === 0}
                options={assets.length === 0 ? [{ value: '', label: '—' }] : assets.map((asset) => asset.assetId)}
                hint={assets.length === 0 && held.resource.status === 'ready' ? depth.t('noAssets') : depth.t('assetPickerHint')}
              />
              <div className="lt-actions" role="group" aria-label={depth.t('period')}>
                {PERIOD_PRESETS.map((value) => (
                  <Button
                    key={value}
                    tone="secondary"
                    aria-pressed={!useCustom && preset === value}
                    onClick={() => {
                      setUseCustom(false);
                      setPreset(value);
                    }}
                  >
                    {presetLabel(value)}
                  </Button>
                ))}
                <Button tone="secondary" aria-pressed={useCustom} onClick={() => setUseCustom(true)}>
                  {depth.t('periodCustom')}
                </Button>
              </div>
              {useCustom && (
                <>
                  <Field
                    label={copyText('rooms.from')}
                    type="datetime-local"
                    value={custom.from}
                    onChange={(event) => setCustom({ ...custom, from: event.target.value })}
                  />
                  <Field
                    label={copyText('rooms.to')}
                    type="datetime-local"
                    value={custom.to}
                    onChange={(event) => setCustom({ ...custom, to: event.target.value })}
                  />
                  {!range && custom.from && custom.to && (
                    <p className="lt-refusal" role="alert">
                      {copyText('rooms.choose.a.valid.start.before.the.end')}
                    </p>
                  )}
                </>
              )}
            </div>
          </BankSection>
          {range ? (
            <ResourceView resource={query.resource} reload={query.reload}>
              {(summary) => (
                <>
                  <BankSection
                    title={copyText('rooms.movement', { value1: summary.assetId })}
                    description={copyText('rooms.to.2', { value1: date(summary.from), value2: date(summary.to) })}
                  >
                    <dl data-testid="money-movement-stats" className="lt-kv">
                      <div>
                        <dt>
                          <Text k="rooms.inflow" />
                        </dt>
                        <dd className="lt-mono">{funds(summary.totalInflow, summary.assetId)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.outflow" />
                        </dt>
                        <dd className="lt-mono">{funds(summary.totalOutflow, summary.assetId)}</dd>
                      </div>
                      <div>
                        <dt>
                          <Text k="rooms.net.movement" />
                        </dt>
                        <dd className="lt-mono">{funds(summary.net, summary.assetId)}</dd>
                      </div>
                    </dl>
                    <MovementChart inflow={summary.totalInflow} outflow={summary.totalOutflow} assetId={summary.assetId} />
                    <p className="lt-hint">
                      {summary.movements}
                      <Text k="rooms.ledger.movements.transfers.between.your.spaces.may" />
                    </p>
                  </BankSection>
                  {(() => {
                    const split = splitAnalytics(summary);
                    return (
                      <>
                        <BankSection title={copyText('rooms.outflow.categories')}>
                          {split.outflow.length ? (
                            <dl className="lt-kv">
                              {split.outflow.map((row) => (
                                <div data-testid="money-space-row" key={row.category}>
                                  <dt>{row.category === 'deposits' ? copyText('rooms.deposit.outflow') : categoryLabel(row.category)}</dt>
                                  <dd className="lt-mono">{funds(row.amount, summary.assetId)}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : (
                            <NoRows title={copyText('rooms.no.outflow.categories.returned')}>
                              <Text k="rooms.the.service.returned.no.categorized.outflow.for" />
                            </NoRows>
                          )}
                        </BankSection>
                        {split.moneyInDeposits !== null && (
                          <BankSection title={copyText('rooms.money.in.deposits')}>
                            <dl className="lt-kv">
                              <div data-testid="money-space-row">
                                <dt>{categoryLabel('deposits')}</dt>
                                <dd className="lt-mono">{funds(split.moneyInDeposits, summary.assetId)}</dd>
                              </div>
                            </dl>
                            <p className="lt-hint">{copyText(split.exact ? 'rooms.money.in.note' : 'rooms.money.in.inexact')}</p>
                          </BankSection>
                        )}
                      </>
                    );
                  })()}
                </>
              )}
            </ResourceView>
          ) : (
            <NoRows title={copyText('rooms.choose.an.asset.and.time.window')}>
              <Text k="rooms.this.view.does.not.invent.a.default" />
            </NoRows>
          )}
        </div>
      }
    />
  );
}
