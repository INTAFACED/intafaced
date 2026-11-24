// volt-room: /pay/money/activity
// volt-room: portal:money-activity
import { useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import type { PortalApi } from '../api';
import { useNow } from '../hooks';
import { buildCsv, downloadText } from '../csv';
import { DateTime } from '../ui/DateTime';
import { dateRange, useListFilters, type DatePreset } from '../ui/FilterRow';
import { useServerList } from '../ui/useServerList';
import { Freshness, KpiStrip, MoneyText, SelectField } from '../volt/parts';
import { RecordListRoom } from '../volt/RecordListRoom';
import { ListBody, MoneyFailure, TestBanner } from './kit-parts';
import { useTestMode } from './test-mode';
import { mc } from './copy';
import { accountWords, kindWords } from './statement-columns';
import { defaultStatementRange, runningView, STATEMENT_MAX_DAYS, statementRangeTooWide, tieView, lineSign } from './model';
import type { PayStatementLine as StatementLine, PayStatementPage as StatementPage } from '@intafaced/contracts/pay-portal-reads';

type Words = ReturnType<typeof mc.useCopy>['t'];
/** A line that needs attention, and one that only informs. */
const WARN_LOOK = 'lt-stale';
const NOTE_LOOK = 'lt-hint';
const runningOf = (l: StatementLine) =>
  l.account === 'clearing' ? l.runningClearing : l.account === 'proceeds' ? l.runningProceeds : null;

/** The signed amount of one line, in words a merchant reads: "+ 12.50 USDT" in, "− 3.00 USDT" out. */
function SignedAmount({
  line,
  test,
}: {
  line: Pick<StatementLine, 'amount' | 'assetId' | 'direction' | 'account' | 'kind'>;
  test: boolean;
}) {
  const sign = lineSign(line);
  return (
    <span className="lt-nowrap">
      <span aria-hidden="true">{sign === 1 ? '+ ' : sign === -1 ? '− ' : ''}</span>
      <MoneyText value={line.amount} asset={line.assetId} test={test} />
    </span>
  );
}

export function statementColumns(t: Words, test: boolean, showRunning: boolean) {
  return [
    { header: t('mnColWhen'), cell: (l: StatementLine) => <DateTime value={l.at} /> },
    {
      header: t('mnColWhat'),
      cell: (l: StatementLine) => (
        <>
          {kindWords(t, l.kind)}
          {l.paymentId && (
            <small className="lt-hint">
              <a className="lt-link" href={`/pay/payments/${encodeURIComponent(l.paymentId)}`}>
                {t('stmOpenPayment')}
              </a>
            </small>
          )}
          {l.settlementId && (
            <small className="lt-hint">
              <a className="lt-link" href={`/pay/settlements/${encodeURIComponent(l.settlementId)}`}>
                {t('stmOpenSettlement')}
              </a>
            </small>
          )}
        </>
      ),
    },
    { header: t('mnColAccount'), cell: (l: StatementLine) => accountWords(t, l.account) },
    { header: t('colAmount'), cell: (l: StatementLine) => <SignedAmount line={l} test={test} /> },
    ...(showRunning
      ? [
          {
            header: t('mnColBalanceAfter'),
            cell: (l: StatementLine) => {
              const v = runningOf(l);
              return v == null ? '—' : <MoneyText value={v} asset={l.assetId} />;
            },
          },
        ]
      : []),
  ];
}
/**
 * `/pay/money/activity` on the record-list template, for the business the access resolved; a person whose role may not
 * read settlements sees the template's own state.
 */
export function StatementRoom({ portal }: { portal: PortalApi }) {
  return (
    <RecordListRoom need="settlements.read">
      {({ merchantId }) => ({ list: <Statement portal={portal} merchantId={merchantId} /> })}
    </RecordListRoom>
  );
}

/** `/pay/money/activity`: every credit and debit on your balance, newest first, with whether it matches your balance. */
function Statement({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const filters = useListFilters();
  const test = useTestMode();
  const now = useNow(300_000);
  const preset = (filters.date || '30d') as DatePreset;
  const range = preset === 'custom' ? dateRange('custom', now, { from: filters.from, to: filters.to }) : dateRange(preset, now);
  const complete = Boolean(range.from && range.to);
  const tooWide = statementRangeTooWide(range);
  const fallback = defaultStatementRange(now);
  const [meta, setMeta] = useState<{ page: StatementPage; at: string } | null>(null);
  const query = { assetId: filters.asset, from: range.from ?? fallback.from, to: range.to ?? fallback.to };
  const list = useServerList(
    async (f, cursor, signal) => {
      if (!complete || tooWide)
        return {
          ok: false as const,
          reason: 'error' as const,
          code: 'portal.local',
          message: tooWide ? t('stmRangeTooWide', { days: STATEMENT_MAX_DAYS }) : t('stmRangeNeeded'),
        };
      const result = await portal.statementPage(merchantId, { assetId: f.assetId, from: f.from, to: f.to }, cursor, signal);
      if (result.ok && !cursor && !signal.aborted) setMeta({ page: result.data, at: new Date().toISOString() });
      return result;
    },
    { assetId: query.assetId, from: range.from ?? '', to: range.to ?? '' },
    (l: StatementLine) => l.id,
  );
  const items = list.state.status === 'ready' ? list.state.items : [];
  const running = runningView(items);
  const assets = [
    ...new Set((meta?.page.tieOut?.accounts ?? []).map((a) => a.assetId).concat(filters.asset ? [filters.asset] : [])),
  ].sort();
  const asset = filters.asset || (assets.length === 1 ? assets[0]! : '');
  const tie = tieView(meta?.page.tieOut, asset);
  const tieDiffers = tie === 'differs';
  const tieRow = meta?.page.tieOut?.accounts.find((a) => a.assetId === asset);
  const opening = meta?.page.opening?.find((o) => o.assetId === asset) ?? null;
  const here = `/pay/money/activity${filters.asset ? `?asset=${encodeURIComponent(filters.asset)}` : ''}`;
  const rangeLabel = t(preset === 'today' ? 'stmToday' : preset === '7d' ? 'stmLast7' : preset === 'custom' ? 'stmCustom' : 'stmLast30');
  return (
    <div className="lt-stack">
      <TestBanner />
      <Freshness asOf={list.state.status === 'ready' ? (meta?.at ?? null) : null} />
      <KpiStrip
        label={t('stmTiles')}
        tiles={[
          {
            label: t('stmAvailableNow'),
            period: t('stmNow'),
            href: '/pay/money',
            value: tieRow ? <MoneyText value={tieRow.proceeds.ledger} asset={asset} test={test} /> : '—',
            note: tieRow ? undefined : t('stmPickAsset'),
          },
          {
            label: t('stmPendingNow'),
            period: t('stmNow'),
            href: '/pay/money',
            value: tieRow ? <MoneyText value={tieRow.clearing.ledger} asset={asset} test={test} /> : '—',
            note: tieRow ? undefined : t('stmPickAsset'),
          },
          {
            label: t('stmOpening'),
            period: t('stmStartOfRange'),
            href: here,
            value: opening ? <MoneyText value={opening.proceeds} asset={asset} test={test} /> : '—',
            note: opening ? t('stmOpeningNote') : t('stmOpeningNone'),
          },
          {
            label: t('stmEntries'),
            period: rangeLabel,
            href: here,
            value: list.state.status === 'ready' ? (list.state.hasMore ? t('stmNewest', { n: items.length }) : String(items.length)) : '—',
          },
        ]}
      />
      <div className="lt-stack" role="search" aria-label={t('stmFilters')}>
        <div className="lt-field-row">
          <SelectField
            label={t('stmRange')}
            value={preset}
            onChange={(v) => filters.setDate(v === '30d' ? '' : v)}
            options={[
              ['today', t('stmToday')],
              ['7d', t('stmLast7')],
              ['30d', t('stmLast30')],
              ['custom', t('stmCustom')],
            ]}
          />
          {assets.length > 0 && (
            <SelectField
              label={t('stmAsset')}
              value={filters.asset}
              onChange={filters.setAsset}
              options={[['', t('stmAllAssets')] as const, ...assets.map((a) => [a, a] as const)]}
            />
          )}
        </div>
        {preset === 'custom' && (
          <div className="lt-field-row">
            <Field label={t('stmFrom')} type="date" value={filters.from} onChange={(e) => filters.setFrom(e.target.value)} />
            <Field label={t('stmTo')} type="date" value={filters.to} onChange={(e) => filters.setTo(e.target.value)} />
          </div>
        )}
      </div>
      {list.state.status === 'ready' && meta && (
        <p className={tieDiffers ? WARN_LOOK : NOTE_LOOK} role={tie === 'differs' ? 'alert' : 'status'}>
          {tie === 'matches' ? t('stmTies') : tie === 'differs' ? t('stmDiffers') : t('stmTieUnknown')}
        </p>
      )}
      {list.state.status === 'ready' && items.length > 0 && !running.shown && (
        <p className="lt-hint" role="note">
          {t('stmNoRunning')}{' '}
          {running.reason === 'no_opening' ? t('stmNoRunningOpening') : running.reason === 'order_ambiguous' ? t('stmNoRunningOrder') : ''}
        </p>
      )}
      {list.state.status === 'failed' && !complete ? (
        <MoneyFailure result={list.state.failure} retry={() => list.reload()} />
      ) : (
        <ListBody
          state={list.state}
          retry={() => list.reload()}
          onMore={list.loadMore}
          empty={{ title: t('stmEmptyTitle'), body: t('stmEmptyBody') }}
          label={t('stmTable')}
          rowKey={(l) => l.id}
          columns={statementColumns(t, test, running.shown)}
        />
      )}
      <div className="lt-actions">
        <Button
          tone="secondary"
          disabled={items.length === 0}
          onClick={() =>
            downloadText(
              'statement-this-page.csv',
              buildCsv(
                ['time', 'what', 'account', 'direction', 'amount', 'asset'],
                items.map((l) => [l.at, kindWords(t, l.kind), accountWords(t, l.account), l.direction, l.amount, l.assetId]),
                { generatedAt: new Date().toISOString(), asOf: meta?.at ?? '' },
              ),
            )
          }
        >
          {t('stmDownloadShown')}
        </Button>
        <small className="lt-muted">{t('stmDownloadShownNote')}</small>
      </div>
      {meta && (
        <p className="lt-hint">
          {t('stmAsOfEnd')} <DateTime value={meta.at} />
        </p>
      )}
    </div>
  );
}
