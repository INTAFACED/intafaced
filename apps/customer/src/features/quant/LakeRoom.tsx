// volt-room: /quant/data
import { QUANT_LAKE_KINDS, type QuantLakeCatalogue } from '@intafaced/contracts/quant-research';
import { useState } from 'react';
import { useResource } from '../../shared/resource';
import { Select } from '@intafaced/ui/lit';
import { Coverage, KeyValue, RecordListTemplate } from '@intafaced/ui/lit/templates';
import { FailureBox, LoadingLine, RecordTable } from '../../shared/record/record-parts';
import { useApi } from '../session';
import { QuantRooms } from './QuantRooms';
import { researchCopy } from './research-copy';
import { refusalCode } from './refusal-code';
import { QUANT_LAKE_CATALOGUE } from '@intafaced/contracts/quant-lake-procedures';

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
  const catalogue = useResource((signal) => api.call(QUANT_LAKE_CATALOGUE, undefined, { signal }), 'quant-lake-catalogue');
  const r = catalogue.resource;
  return (
    <RecordListTemplate
      title={t('dataTitle')}
      description={t('dataIntro')}
      state={{ kind: 'ready' }}
      section={<QuantRooms paper={paper} />}
      list={
        <section>
          <h2>{t('dataTitle')}</h2>
          <section data-testid="quant-lake" aria-label={t('dataTitle')}>
            <p className="lt-hint">{t('dataIntro')}</p>
            {r.status === 'loading' ? (
              <LoadingLine />
            ) : r.status === 'failed' ? (
              refusalCode(r.failure) === 'quant.lake_store_unset' || refusalCode(r.failure) === 'quant.lake_retention_unset' ? (
                <p role="status" data-testid="quant-lake-refusal" data-code={refusalCode(r.failure)}>
                  {refusalCode(r.failure) === 'quant.lake_store_unset' ? t('dataStoreUnset') : t('dataRetentionUnset')}
                </p>
              ) : (
                <FailureBox result={r.failure} retry={catalogue.reload} />
              )
            ) : (
              <>
                <p
                  data-testid="quant-lake-settings"
                  data-capture-seconds={r.data.captureSeconds}
                  data-retention-days={r.data.retentionDays}
                >
                  {t('dataSettings', { seconds: r.data.captureSeconds, days: r.data.retentionDays, from: utc(r.data.keptFrom) })}
                </p>
                <div className="lt-toolbar">
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
                    <section key={s.symbol} data-testid="quant-lake-symbol" data-symbol={s.symbol} aria-label={s.symbol}>
                      <h3 lang="zxx">{s.symbol}</h3>
                      <p className="lt-hint" data-testid="quant-lake-capturing" data-capturing={s.capturing}>
                        {s.capturing ? t('capturing') : t('paused')}
                      </p>
                      {s.datasets
                        .filter((d) => !kind || d.kind === kind)
                        .map((d) => (
                          <DatasetView key={d.kind} symbol={s.symbol} dataset={d} from={r.data.keptFrom} to={r.data.asOf} />
                        ))}
                    </section>
                  ))}
                <p className="lt-hint">{t('source')}</p>
              </>
            )}
          </section>
        </section>
      }
    />
  );
}

function DatasetView({ symbol, dataset, from, to }: { symbol: string; dataset: Dataset; from: string; to: string }) {
  const { t } = researchCopy.useCopy();
  const windowFrom = dataset.coverage[0]?.from ?? from;
  return (
    <article
      data-testid="quant-lake-dataset"
      data-kind={dataset.kind}
      data-rows={dataset.rows}
      data-ranges={dataset.coverage.length}
      data-gaps={dataset.gaps.length}
    >
      <h4>{t(`kind_${dataset.kind}`)}</h4>
      <KeyValue
        rows={[
          { label: t('rows'), value: <span lang="zxx">{dataset.rows}</span> },
          { label: t('first'), value: <span lang="zxx">{dataset.first ? utc(dataset.first) : '—'}</span> },
          { label: t('last'), value: <span lang="zxx">{dataset.last ? utc(dataset.last) : '—'}</span> },
        ]}
      />
      {dataset.coverage.length === 0 ? (
        <p className="lt-hint">{t('noRows')}</p>
      ) : (
        <Coverage
          label={t('barLabel', {
            symbol,
            kind: t(`kind_${dataset.kind}`),
            from: utc(new Date(Date.parse(windowFrom)).toISOString()),
            to: utc(to),
          })}
          from={windowFrom}
          to={to}
          ranges={dataset.coverage}
          rangeTestId="quant-lake-range"
        />
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
        <p className="lt-hint">{t('noGaps')}</p>
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
        <RecordTable label={`${symbol} ${t(`kind_${dataset.kind}`)} — ${t('latest')}`} headers={[t('colTime'), t('colValue')]}>
          {dataset.latest.map((row) => (
            <tr key={`${row.observedAt}:${JSON.stringify(row.payload).length}`} data-testid="quant-lake-row">
              <td lang="zxx">{utc(row.observedAt)}</td>
              <td>
                <code lang="zxx">{summary(dataset.kind, row.payload)}</code>
              </td>
            </tr>
          ))}
        </RecordTable>
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
