import { QUANT_LAKE_KINDS, quantLakeCatalogueSchema, type QuantLakeCatalogue } from '@intafaced/contracts/quant-research';
import { useState } from 'react';
import { useResource } from '../../shared/resource';
import { DataTable, Failure, Loading, Panel } from '../../shared/ui';
import { Select } from '../more/common';
import { useApi } from '../session/session';
import { QuantRooms } from './QuantRooms';
import { researchCopy } from './research-copy';
import { refusalCode } from './StrategyTeam';
import './algo.css';

const utc = (iso: string) => iso.slice(0, 19).replace('T', ' ');
type Dataset = QuantLakeCatalogue['symbols'][number]['datasets'][number];

/**
 * The Data room, `/quant/data` (RC-algo-dev-02; J-algo-dev-16 #2): what the market data lake holds of the exchange's own
 * public ticks, book snapshots and fills, per symbol, with a coverage bar whose gaps are drawn as gaps.
 */
export function LakeRoom({ paper }: { paper: boolean }) {
  const api = useApi();
  const { t } = researchCopy.useCopy();
  const [kind, setKind] = useState('');
  const [symbol, setSymbol] = useState('');
  const catalogue = useResource(
    (signal) => api.query('quant', 'lake.catalogue', undefined, quantLakeCatalogueSchema, { signal }),
    'quant-lake-catalogue',
  );
  const r = catalogue.resource;
  return (
    <>
      <QuantRooms active="data" paper={paper} />
      <Panel title={t('dataTitle')}>
        <section data-testid="quant-lake" aria-label={t('dataTitle')}>
          <p className="muted">{t('dataIntro')}</p>
          {r.status === 'loading' ? (
            <Loading />
          ) : r.status === 'failed' ? (
            refusalCode(r.failure) === 'quant.lake_store_unset' || refusalCode(r.failure) === 'quant.lake_retention_unset' ? (
              <p role="status" data-testid="quant-lake-refusal" data-code={refusalCode(r.failure)}>
                {refusalCode(r.failure) === 'quant.lake_store_unset' ? t('dataStoreUnset') : t('dataRetentionUnset')}
              </p>
            ) : (
              <Failure result={r.failure} retry={catalogue.reload} />
            )
          ) : (
            <>
              <p data-testid="quant-lake-settings" data-capture-seconds={r.data.captureSeconds} data-retention-days={r.data.retentionDays}>
                {t('dataSettings', { seconds: r.data.captureSeconds, days: r.data.retentionDays, from: utc(r.data.keptFrom) })}
              </p>
              <div className="quant-lake-filters">
                <Select
                  label={t('filterKind')}
                  value={kind}
                  onChange={setKind}
                  options={[{ value: '', label: t('allKinds') }, ...QUANT_LAKE_KINDS.map((k) => ({ value: k, label: t(`kind_${k}`) }))]}
                />
                <Select
                  label={t('filterSymbol')}
                  value={symbol}
                  onChange={setSymbol}
                  options={[{ value: '', label: t('allSymbols') }, ...r.data.symbols.map((s) => s.symbol)]}
                />
              </div>
              {r.data.symbols
                .filter((s) => !symbol || s.symbol === symbol)
                .map((s) => (
                  <section
                    key={s.symbol}
                    className="quant-lake-symbol"
                    data-testid="quant-lake-symbol"
                    data-symbol={s.symbol}
                    aria-label={s.symbol}
                  >
                    <h3 lang="zxx">{s.symbol}</h3>
                    <p className="muted" data-testid="quant-lake-capturing" data-capturing={s.capturing}>
                      {s.capturing ? t('capturing') : t('paused')}
                    </p>
                    {s.datasets
                      .filter((d) => !kind || d.kind === kind)
                      .map((d) => (
                        <DatasetView key={d.kind} symbol={s.symbol} dataset={d} from={r.data.keptFrom} to={r.data.asOf} />
                      ))}
                  </section>
                ))}
              <p className="muted">{t('source')}</p>
            </>
          )}
        </section>
      </Panel>
    </>
  );
}

function DatasetView({ symbol, dataset, from, to }: { symbol: string; dataset: Dataset; from: string; to: string }) {
  const { t } = researchCopy.useCopy();
  const start = Date.parse(dataset.coverage[0]?.from ?? from);
  const end = Date.parse(to);
  const span = Math.max(1, end - start);
  const at = (iso: string) => Math.min(100, Math.max(0, ((Date.parse(iso) - start) / span) * 100));
  return (
    <article
      className="quant-lake-dataset"
      data-testid="quant-lake-dataset"
      data-kind={dataset.kind}
      data-rows={dataset.rows}
      data-ranges={dataset.coverage.length}
      data-gaps={dataset.gaps.length}
    >
      <h4>{t(`kind_${dataset.kind}`)}</h4>
      <dl className="quant-lake-facts">
        <dt>{t('rows')}</dt>
        <dd lang="zxx">{dataset.rows}</dd>
        <dt>{t('first')}</dt>
        <dd lang="zxx">{dataset.first ? utc(dataset.first) : '—'}</dd>
        <dt>{t('last')}</dt>
        <dd lang="zxx">{dataset.last ? utc(dataset.last) : '—'}</dd>
      </dl>
      {dataset.coverage.length === 0 ? (
        <p className="muted">{t('noRows')}</p>
      ) : (
        <div
          className="quant-lake-bar"
          role="img"
          aria-label={t('barLabel', { symbol, kind: t(`kind_${dataset.kind}`), from: utc(new Date(start).toISOString()), to: utc(to) })}
        >
          {dataset.coverage.map((range) => (
            <span
              key={range.from}
              className="quant-lake-covered"
              data-testid="quant-lake-range"
              style={{ insetInlineStart: `${at(range.from)}%`, inlineSize: `${Math.max(0.5, at(range.to) - at(range.from))}%` }}
            />
          ))}
        </div>
      )}
      <h5>{t('coverage')}</h5>
      <ul>
        {dataset.coverage.map((range) => (
          <li key={range.from} lang="zxx">
            {t('coverageRange', { from: utc(range.from), to: utc(range.to) })}
          </li>
        ))}
      </ul>
      <h5>{t('gaps')}</h5>
      {dataset.gaps.length === 0 ? (
        <p className="muted">{t('noGaps')}</p>
      ) : (
        <ul>
          {dataset.gaps.map((gap) => (
            <li key={gap.from} data-testid="quant-lake-gap" data-from={gap.from} data-to={gap.to}>
              {t('gapRange', { from: utc(gap.from), to: utc(gap.to) })}
            </li>
          ))}
        </ul>
      )}
      {dataset.latest.length > 0 && (
        <DataTable label={`${symbol} ${t(`kind_${dataset.kind}`)} — ${t('latest')}`} headers={[t('colTime'), t('colValue')]}>
          {dataset.latest.map((row) => (
            <tr key={`${row.observedAt}:${JSON.stringify(row.payload).length}`} data-testid="quant-lake-row">
              <td lang="zxx">{utc(row.observedAt)}</td>
              <td>
                <code lang="zxx">{summary(dataset.kind, row.payload)}</code>
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </article>
  );
}

/** One normalised row in a line: a tick's bid, ask and last; a book's best levels; a fill's side, price and size. */
function summary(kind: Dataset['kind'], payload: Record<string, unknown>): string {
  const text = (v: unknown) => (typeof v === 'string' ? v : '—');
  if (kind === 'tick') return `bid ${text(payload.bid)} · ask ${text(payload.ask)} · last ${text(payload.last)}`;
  if (kind === 'book') {
    const top = (side: unknown) => (Array.isArray(side) && Array.isArray(side[0]) ? `${side[0][0]} × ${side[0][1]}` : '—');
    const depth = (side: unknown) => (Array.isArray(side) ? side.length : 0);
    return `bids ${depth(payload.bids)} (best ${top(payload.bids)}) · asks ${depth(payload.asks)} (best ${top(payload.asks)})`;
  }
  return `${text(payload.side)} ${text(payload.quantity)} @ ${text(payload.price)}`;
}
