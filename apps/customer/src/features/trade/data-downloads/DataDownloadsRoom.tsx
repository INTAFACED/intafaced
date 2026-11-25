// volt-room: /trade/markets/downloads
import { useMemo, useState } from 'react';
import {
  HISTORY_DATASETS_PATH,
  HISTORY_SCHEMAS_PATH,
  TRADE_HISTORY_BOOK_INTERVAL_UNSET,
  historyDatasetsResponseSchema,
  historySchemasResponseSchema,
  type HistoryDatasetKind,
  type HistoryDatasetManifest,
} from '@intafaced/contracts/trade-history';
import { Button, SearchField, Segmented, StatusNote } from '@intafaced/ui/lit';
import { RecordListTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { dataDownloadsCopy } from './data-downloads-copy';

type KindFilter = 'all' | HistoryDatasetKind;

function kindLabelKey(kind: HistoryDatasetKind): 'kindTrades' | 'kindCandles' | 'kindBookSnapshots' {
  if (kind === 'trades') return 'kindTrades';
  if (kind === 'candles') return 'kindCandles';
  return 'kindBookSnapshots';
}

function formatGaps(gaps: HistoryDatasetManifest['gaps']): string {
  return gaps.map((g) => (g.fromSequence === g.toSequence ? String(g.fromSequence) : `${g.fromSequence}..${g.toSequence}`)).join(', ');
}

function downloadHref(downloadPath: string): string {
  return downloadPath.startsWith('/') ? downloadPath : `${HISTORY_DATASETS_PATH}/${downloadPath}`;
}

/**
 * Historical tick, book and trade data downloads, /trade/markets/downloads (RC-cex-spot-05; J-cex-spot-15 #10).
 * Reads `GET /api/v1/history/datasets` and `GET /api/v1/history/schemas` through the public REST client and lists
 * each published window with its row count, completeness %, sequence gaps, SHA-256 checksum, append-only corrections
 * and direct gzipped NDJSON download link.
 */
export function DataDownloadsRoom() {
  const { t } = dataDownloadsCopy.useCopy();
  const { api } = useSession();
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');

  const datasetsRead = useResource(
    (signal) =>
      api.rest(HISTORY_DATASETS_PATH.replace(/^\/api\/v1/, ''), historyDatasetsResponseSchema, {
        query: kind === 'all' ? undefined : { kind },
        signal,
      }),
    `history-datasets:${kind}`,
  );
  const schemasRead = useResource(
    (signal) => api.rest(HISTORY_SCHEMAS_PATH.replace(/^\/api\/v1/, ''), historySchemasResponseSchema, { signal }),
    'history-schemas',
  );

  const visible = useMemo(() => {
    if (datasetsRead.resource.status !== 'ready') return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return datasetsRead.resource.data.datasets;
    return datasetsRead.resource.data.datasets.filter(
      (row) => row.symbol.toLowerCase().includes(needle) || row.day.includes(needle) || row.kind.includes(needle),
    );
  }, [datasetsRead.resource, query]);

  const state: RoomState = useMemo(() => {
    const r = datasetsRead.resource;
    if (r.status === 'loading') return { kind: 'loading' };
    if (r.status === 'failed') {
      const code = r.failure.code ?? '';
      if (code === TRADE_HISTORY_BOOK_INTERVAL_UNSET) {
        return {
          kind: 'refused',
          refusal: {
            variant: 'refused',
            title: t('bookUnsetTitle'),
            body: t('bookUnsetBody'),
            reference: code,
          },
        };
      }
      if (r.failure.status !== undefined && r.failure.status >= 400 && r.failure.status < 500) {
        return {
          kind: 'refused',
          refusal: {
            variant: 'refused',
            title: t('refusedTitle'),
            body: r.failure.message || t('refusedBody'),
            reference: code || undefined,
          },
        };
      }
      return {
        kind: 'refused',
        refusal: {
          variant: 'unreachable',
          title: t('failedTitle'),
          body: t('failedBody'),
          reference: code || undefined,
        },
      };
    }
    if (r.data.datasets.length === 0) {
      return {
        kind: 'empty',
        title: t('emptyTitle'),
        body: t('emptyBody'),
      };
    }
    return { kind: 'ready' };
  }, [datasetsRead.resource, t]);

  const data = datasetsRead.resource.status === 'ready' ? datasetsRead.resource.data : null;
  const schemas = schemasRead.resource.status === 'ready' ? schemasRead.resource.data : null;

  return (
    <div data-testid="data-downloads-room">
      <RecordListTemplate
        title={t('title')}
        description={t('description')}
        state={state}
        tools={
          <a className="lt-link" href="/trade">
            ← {t('backToMarkets')}
          </a>
        }
        filters={
          <div className="lt-toolbar" data-testid="history-filters">
            <Segmented
              label={t('filterKind')}
              options={[
                { value: 'all', label: t('kindAll') },
                { value: 'trades', label: t('kindTrades') },
                { value: 'candles', label: t('kindCandles') },
                { value: 'book_snapshots', label: t('kindBookSnapshots') },
              ]}
              value={kind}
              onChange={(value) => setKind(value as KindFilter)}
            />
            <SearchField
              label={t('searchLabel')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('searchPlaceholder')}
            />
            {query.trim() !== '' ? (
              <Button tone="quiet" onClick={() => setQuery('')}>
                {t('clearFilter')}
              </Button>
            ) : null}
          </div>
        }
        list={
          data ? (
            <div className="lt-stack">
              {data.bookSnapshotsStatus === 'unset' ? (
                <StatusNote data-testid="history-book-unset" tone="warn" title={t('bookUnsetTitle')}>
                  {t('bookUnsetBody')} {data.bookSnapshotsCode ? <span className="lt-ref">{data.bookSnapshotsCode}</span> : null}
                </StatusNote>
              ) : null}

              {visible.length === 0 ? (
                <StatusNote data-testid="history-empty-filtered" tone="neutral" title={t('emptyFilteredTitle')}>
                  {t('emptyFilteredBody')}
                </StatusNote>
              ) : (
                <div tabIndex={0} role="region" aria-label={t('title')}>
                  <table className="lt-table" data-testid="history-datasets-table">
                    <thead>
                      <tr>
                        <th scope="col">{t('colMarket')}</th>
                        <th scope="col">{t('colKind')}</th>
                        <th scope="col">{t('colWindow')}</th>
                        <th scope="col">{t('colRows')}</th>
                        <th scope="col">{t('colCompleteness')}</th>
                        <th scope="col">{t('colChecksum')}</th>
                        <th scope="col">{t('colCorrections')}</th>
                        <th scope="col">{t('colFile')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((row) => (
                        <tr
                          key={row.id}
                          data-dataset-id={row.id}
                          data-dataset-kind={row.kind}
                          data-dataset-day={row.day}
                          data-sha256={row.sha256}
                        >
                          <th scope="row">{row.symbol}</th>
                          <td>{t(kindLabelKey(row.kind))}</td>
                          <td>
                            <div>{row.day}</div>
                            <small className="lt-hint">
                              {row.windowStart.slice(0, 16).replace('T', ' ')} – {row.windowEnd.slice(0, 16).replace('T', ' ')} UTC
                            </small>
                          </td>
                          <td>{row.rowCount}</td>
                          <td>
                            <div>{row.completenessPct}%</div>
                            <small className="lt-hint">
                              {row.gaps.length === 0 ? t('noGaps') : t('gapsLabel', { gaps: formatGaps(row.gaps) })}
                            </small>
                          </td>
                          <td>
                            <code data-testid={`checksum-${row.id}`}>{row.sha256}</code>
                          </td>
                          <td>
                            {row.corrections.length === 0 ? (
                              <span className="lt-hint">{t('noCorrections')}</span>
                            ) : (
                              <ul className="lt-rows">
                                {row.corrections.map((c) => (
                                  <li key={c.id}>
                                    <span>
                                      {t('correctionDetail', {
                                        from: String(c.sequenceFrom),
                                        to: String(c.sequenceTo),
                                        reason: c.reason,
                                      })}
                                    </span>{' '}
                                    <a
                                      className="lt-link"
                                      href={downloadHref(`/api/v1/history/datasets/${encodeURIComponent(c.supersedingDatasetId)}/download`)}
                                    >
                                      {t('downloadSuperseding')}
                                    </a>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                          <td>
                            <a className="lt-link" href={downloadHref(row.downloadPath)} data-testid={`download-${row.id}`}>
                              {t('download')}
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {schemas ? (
                <section aria-labelledby="history-schemas-heading" className="lt-stack" data-testid="history-schemas">
                  <h2 id="history-schemas-heading">{t('schemasHeading')}</h2>
                  <p className="lt-hint">{t('schemasLead', { provenance: schemas.provenance })}</p>
                  <ul className="lt-rows">
                    {schemas.schemas.map((entry) => (
                      <li key={entry.kind}>
                        <strong>{t(kindLabelKey(entry.kind))}</strong>{' '}
                        <span className="lt-hint">
                          {t('schemaVersion', { version: entry.schemaVersion })} · {entry.format}.{entry.compression} ·{' '}
                          {entry.checksumAlgorithm}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <p className="lt-hint">{t('explain')}</p>
            </div>
          ) : null
        }
      />
    </div>
  );
}
