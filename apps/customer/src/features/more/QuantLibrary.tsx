import { useState } from 'react';
import { displayAmount } from '../../shared/money';
import { Button, DataTable, Field, Panel } from '../../shared/ui';
import { Details, Select } from './common';
import { downloadCsv, toCsv } from './depth-csv';
import { StatusPill } from './depth-kit';
import { filterLibrary, LIBRARY_CSV_HEADER, libraryRows, strategySummary, type LibraryFilter, type LibraryStrategy } from './quant-library';
import { quantLibraryCopy } from './quant-library-copy';

/** Searchable library of the strategies the quant service holds in memory. */
export function QuantLibrary({
  strategies,
  onPick,
  footer,
}: {
  strategies: readonly LibraryStrategy[];
  onPick: (strategy: LibraryStrategy) => void;
  footer?: React.ReactNode;
}) {
  const { Copy, t } = quantLibraryCopy.useCopy();
  const [filter, setFilter] = useState<LibraryFilter>({ query: '', environment: 'all', sort: 'name' });
  const [open, setOpen] = useState<string | null>(null);
  const [exported, setExported] = useState<boolean | null>(null);
  const shown = filterLibrary(strategies, filter);
  return (
    <Panel title={t('title')}>
      <div className="depth-memory" role="note">
        <strong>
          <Copy k="memoryTitle" />
        </strong>
        <p>
          <Copy k="memoryBody" />
        </p>
        <p>
          <Copy k="paperLabel" />
        </p>
      </div>
      <div className="depth-filters">
        <Field label={t('search')} value={filter.query} maxLength={64} onChange={(e) => setFilter({ ...filter, query: e.target.value })} />
        <Select
          label={t('environment')}
          value={filter.environment}
          onChange={(value) => setFilter({ ...filter, environment: value as LibraryFilter['environment'] })}
          options={[
            { value: 'all', label: t('any') },
            { value: 'paper', label: t('env_paper') },
            { value: 'backtest', label: t('env_backtest') },
            { value: 'shadow', label: t('env_shadow') },
          ]}
        />
        <Select
          label={t('sort')}
          value={filter.sort}
          onChange={(value) => setFilter({ ...filter, sort: value as LibraryFilter['sort'] })}
          options={[
            { value: 'name', label: t('sortName') },
            { value: 'blocks', label: t('sortBlocks') },
          ]}
        />
      </div>
      <p className="muted" role="status">
        {t('showing', { shown: shown.length, total: strategies.length })}
      </p>
      {shown.length ? (
        <div className="depth-cards">
          {shown.map((s) => {
            const summary = strategySummary(s);
            const expanded = open === s.id;
            return (
              <article key={s.id} className="depth-card" aria-current={expanded}>
                <h3 lang="und">{s.name}</h3>
                <StatusPill state="paper">{t(`env_${s.environment}`)}</StatusPill>
                <small lang="und">{s.claimLabel}</small>
                <p>
                  {t('symbols')}: <span lang="zxx">{summary.symbols.join(', ') || t('noBlocks')}</span>
                  <br />
                  {t('split', { buys: summary.buys, sells: summary.sells })}
                </p>
                {expanded ? (
                  <>
                    <Details
                      items={[
                        [t('cash'), displayAmount(s.cash)],
                        [t('drawdown'), displayAmount(s.risk.maxDrawdown)],
                        [t('notional'), displayAmount(s.risk.maxNotional)],
                        [t('kill'), displayAmount(s.risk.kill)],
                      ]}
                    />
                    <DataTable headers={[t('side'), t('symbol'), t('qty')]} label={t('blocks')}>
                      {s.blocks.map((b, i) => (
                        <tr key={i}>
                          <td>{t(b.side)}</td>
                          <td lang="zxx">{b.symbol}</td>
                          <td>{displayAmount(b.qty)}</td>
                        </tr>
                      ))}
                    </DataTable>
                  </>
                ) : null}
                <div className="depth-card-actions">
                  <Button variant="secondary" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : s.id)}>
                    {expanded ? <Copy k="hideDetails" /> : <Copy k="details" />}
                  </Button>
                  <Button onClick={() => onPick(s)}>
                    <Copy k="use" />
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p role="status">
          <Copy k="noneMatch" />
        </p>
      )}
      <Button
        variant="secondary"
        onClick={() => setExported(downloadCsv('quant-strategies.csv', toCsv(LIBRARY_CSV_HEADER, libraryRows(strategies))))}
        disabled={!strategies.length}
      >
        <Copy k="export" />
      </Button>
      {exported !== null ? (
        <p role="status">
          <Copy k={exported ? 'exported' : 'exportFail'} />
        </p>
      ) : null}
      {footer}
    </Panel>
  );
}
