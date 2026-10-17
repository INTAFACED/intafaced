import { useState } from 'react';
import { Button } from '@intafaced/ui';
import { Field } from '../../ui-kit';
import { SelectField } from '../components';
import type { PortalApi } from '../api';
import { useNow } from '../hooks';
import { buildCsv, downloadText } from '../csv';
import { DateTime } from '../ui/DateTime';
import { Freshness } from '../ui/Freshness';
import { dateRange, useListFilters, type DatePreset } from '../ui/FilterRow';
import { KpiStrip } from '../ui/Kpi';
import { MoneyText } from '../ui/MoneyText';
import { useServerList } from '../ui/useServerList';
import { ListBody, MoneyFailure, TestBanner, useTestMode } from './common';
import { mc } from './copy';
import { defaultStatementRange, runningView, STATEMENT_MAX_DAYS, statementRangeTooWide, tieView, lineSign } from './model';
import type { StatementLine, StatementPage } from './schemas';

type Words = ReturnType<typeof mc.useCopy>['t'];
const KNOWN_KINDS = ['payment_captured', 'fee', 'refund', 'chargeback', 'settlement', 'payout', 'reserve'] as const;
const KNOWN_ACCOUNTS = ['clearing', 'proceeds', 'userAvailable', 'houseFees', 'payoutHold'] as const;
export const kindWords = (t: Words, kind: string) =>
  (KNOWN_KINDS as readonly string[]).includes(kind) ? t(`stmKind_${kind}` as 'stmKind_fee') : t('stmKind_other');
export const accountWords = (t: Words, account: string) =>
  (KNOWN_ACCOUNTS as readonly string[]).includes(account) ? t(`stmAccount_${account}` as 'stmAccount_clearing') : t('stmAccount_other');
const runningOf = (l: StatementLine) =>
  l.account === 'clearing' ? l.runningClearing : l.account === 'proceeds' ? l.runningProceeds : null;

/** The signed amount of one line, in words a merchant reads: "+ 12.50 USDT" in, "− 3.00 USDT" out. */
export function SignedAmount({
  line,
  test,
}: {
  line: Pick<StatementLine, 'amount' | 'assetId' | 'direction' | 'account' | 'kind'>;
  test: boolean;
}) {
  const sign = lineSign(line);
  return (
    <span className="pp-nowrap">
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
            <small className="pay-cell-note">
              <a className="text-link" href={`/pay/payments/${encodeURIComponent(l.paymentId)}`}>
                {t('stmOpenPayment')}
              </a>
            </small>
          )}
          {l.settlementId && (
            <small className="pay-cell-note">
              <a className="text-link" href={`/pay/settlements/${encodeURIComponent(l.settlementId)}`}>
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
export const statementCard = (t: Words, test: boolean) => (l: StatementLine) => ({
  title: kindWords(t, l.kind),
  time: <DateTime value={l.at} />,
  amount: <SignedAmount line={l} test={test} />,
  status: <span className="muted">{accountWords(t, l.account)}</span>,
});

/** `/pay/money/activity`: every credit and debit on your balance, newest first, with whether it matches your balance. */
export function Statement({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
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
  const tieRow = meta?.page.tieOut?.accounts.find((a) => a.assetId === asset);
  const opening = meta?.page.opening?.find((o) => o.assetId === asset) ?? null;
  const here = `/pay/money/activity${filters.asset ? `?asset=${encodeURIComponent(filters.asset)}` : ''}`;
  const rangeLabel = t(preset === 'today' ? 'stmToday' : preset === '7d' ? 'stmLast7' : preset === 'custom' ? 'stmCustom' : 'stmLast30');
  return (
    <div className="stack">
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
      <div className="pp-filterbar" role="search" aria-label={t('stmFilters')}>
        <div className="pp-filter-row">
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
          <div className="pp-filter-row">
            <Field label={t('stmFrom')} type="date" value={filters.from} onChange={(e) => filters.setFrom(e.target.value)} />
            <Field label={t('stmTo')} type="date" value={filters.to} onChange={(e) => filters.setTo(e.target.value)} />
          </div>
        )}
      </div>
      {list.state.status === 'ready' && meta && (
        <p className={tie === 'differs' ? 'pp-callout pp-callout--warn' : 'muted pp-note'} role={tie === 'differs' ? 'alert' : 'status'}>
          {tie === 'matches' ? t('stmTies') : tie === 'differs' ? t('stmDiffers') : t('stmTieUnknown')}
        </p>
      )}
      {list.state.status === 'ready' && items.length > 0 && !running.shown && (
        <p className="muted pp-note" role="note">
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
          card={statementCard(t, test)}
        />
      )}
      <div className="pp-actions">
        <Button
          variant="secondary"
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
        <small className="muted">{t('stmDownloadShownNote')}</small>
      </div>
      {meta && (
        <p className="muted pp-note">
          {t('stmAsOfEnd')} <DateTime value={meta.at} />
        </p>
      )}
    </div>
  );
}
