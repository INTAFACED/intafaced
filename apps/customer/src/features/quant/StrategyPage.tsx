import {
  quantBacktestHistorySchema,
  quantStrategyDetailSchema,
  quantVersionDiffSchema,
  type QuantStrategyDetail,
  type QuantStrategyVersion,
  type QuantVersionDiff,
} from '@intafaced/contracts/quant-algo';
import { useState } from 'react';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Panel } from '../../shared/ui';
import { Read } from '../more/common';
import { preservePaperHref } from '../more/trade-context';
import { useApi } from '../session/session';
import { QuantRooms } from './QuantRooms';
import { strategyPageCopy } from './strategy-page-copy';
import './algo.css';

/** How many recent runs the page reads to show which version each one used. A page size, not a product limit. */
const RUN_PAGE = 20;

/** An ISO instant as its UTC minute, "2026-10-23 03:40". */
const utcText = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/**
 * One saved strategy's page (AL-editor-01): every version with the note written when it was saved and its source,
 * read only; two versions compared line by line; and the account's recent runs of it, each with the code it ran.
 */
export function StrategyPage({ strategyId, paper }: { strategyId: string; paper: boolean }) {
  const api = useApi();
  const { t } = strategyPageCopy.useCopy();
  const detail = useResource(
    (signal) => api.query('quant', 'studio.get', { id: strategyId }, quantStrategyDetailSchema, { signal }),
    `quant-strategy:${strategyId}`,
  );
  return (
    <>
      <QuantRooms active="strategies" paper={paper} />
      <p>
        <a className="text-link" href={preservePaperHref('/quant/strategies', paper)}>
          {t('back')}
        </a>
      </p>
      <Read resource={detail.resource} retry={detail.reload}>
        {(strategy) => <StrategyVersions strategy={strategy} />}
      </Read>
    </>
  );
}

function StrategyVersions({ strategy }: { strategy: QuantStrategyDetail }) {
  const { t } = strategyPageCopy.useCopy();
  const [shown, setShown] = useState<number | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const newestFirst = [...strategy.versions].sort((a, b) => b.version - a.version);
  const toggle = (version: number) =>
    setPicked((prev) => (prev.includes(version) ? prev.filter((v) => v !== version) : [...prev, version].slice(-2)));
  const pair = picked.length === 2 ? ([Math.min(...picked), Math.max(...picked)] as const) : null;
  const sourceOf = (version: number) => strategy.versions.find((row) => row.version === version);
  return (
    <Panel title={t('title', { name: strategy.name })}>
      <div data-testid="quant-versions" data-strategy-id={strategy.id}>
        <p className="muted">{t('simulated')}</p>
        <p>{strategy.folder ? t('inFolder', { folder: strategy.folder }) : t('noFolder')}</p>
        {strategy.description && <p lang="und">{strategy.description}</p>}
        <h3>{t('versions')}</h3>
        <DataTable label={t('versions')} headers={[t('compare'), t('version'), t('name'), t('saved'), t('note'), t('source')]}>
          {newestFirst.map((row) => (
            <tr key={row.version} data-testid="quant-version-row" data-version={row.version}>
              <td>
                <input
                  type="checkbox"
                  aria-label={t('pick', { version: row.version })}
                  checked={picked.includes(row.version)}
                  onChange={() => toggle(row.version)}
                />
              </td>
              <td>{t('versionOf', { version: row.version })}</td>
              <td lang="und">{row.name}</td>
              <td lang="zxx">{utcText(row.createdAt)}</td>
              <td lang="und" data-testid="quant-version-note">
                {row.releaseNote || t('noNote')}
              </td>
              <td>
                <Button variant="secondary" onClick={() => setShown(shown === row.version ? null : row.version)}>
                  {shown === row.version ? t('hideSource', { version: row.version }) : t('showSource', { version: row.version })}
                </Button>
              </td>
            </tr>
          ))}
        </DataTable>
        {shown !== null && sourceOf(shown) && <VersionSource version={sourceOf(shown)!} />}
        {pair ? (
          <VersionDiff strategyId={strategy.id} from={pair[0]} to={pair[1]} />
        ) : (
          <p className="muted" data-testid="quant-diff-hint">
            {strategy.versions.length > 1 ? t('pickTwo') : t('oneVersion')}
          </p>
        )}
        <RunsOfStrategy strategy={strategy} />
      </div>
    </Panel>
  );
}

/** A version's source, read only: an older version is never edited in place; Studio saves a new version instead. */
function VersionSource({ version }: { version: QuantStrategyVersion }) {
  const { t } = strategyPageCopy.useCopy();
  return (
    <section aria-label={t('sourceOf', { version: version.version })} data-testid="quant-version-source" data-version={version.version}>
      <h4>{t('sourceOf', { version: version.version })}</h4>
      <pre lang="zxx" className="quant-source" tabIndex={0}>
        {version.source}
      </pre>
    </section>
  );
}

function VersionDiff({ strategyId, from, to }: { strategyId: string; from: number; to: number }) {
  const api = useApi();
  const { t } = strategyPageCopy.useCopy();
  const diff = useResource(
    (signal) => api.query('quant', 'studio.diff', { id: strategyId, from, to }, quantVersionDiffSchema, { signal }),
    `quant-diff:${strategyId}:${from}:${to}`,
  );
  return (
    <section aria-label={t('diffTitle', { from, to })} data-testid="quant-diff" data-from={from} data-to={to}>
      <h4>{t('diffTitle', { from, to })}</h4>
      <Read resource={diff.resource} retry={diff.reload}>
        {(data) => (data.changed ? <DiffParts diff={data} /> : <p data-testid="quant-diff-same">{t('diffSame')}</p>)}
      </Read>
    </section>
  );
}

function DiffParts({ diff }: { diff: QuantVersionDiff }) {
  const { t } = strategyPageCopy.useCopy();
  const marks = { same: ' ', removed: '−', added: '+' } as const;
  const parts = [
    ['blocks', diff.blocks],
    ['rules', diff.rules],
    ['sourcePart', diff.source],
  ] as const;
  return (
    <>
      {parts
        .filter(([, lines]) => lines.some((line) => line.op !== 'same'))
        .map(([part, lines]) => (
          <div key={part} data-testid={`quant-diff-${part}`}>
            <h5>{t(part)}</h5>
            <pre lang="zxx" className="quant-source">
              {lines.map((line, i) => (
                <span key={i} data-testid="quant-diff-line" data-op={line.op}>
                  {marks[line.op]} {line.text}
                  {'\n'}
                </span>
              ))}
            </pre>
          </div>
        ))}
    </>
  );
}

/** The account's recent runs of this strategy, each with the version it ran and that version's code. */
function RunsOfStrategy({ strategy }: { strategy: QuantStrategyDetail }) {
  const api = useApi();
  const { t } = strategyPageCopy.useCopy();
  const runs = useResource(
    (signal) => api.query('quant', 'backtest.history', { limit: RUN_PAGE }, quantBacktestHistorySchema, { signal }),
    `quant-strategy-runs:${strategy.id}`,
  );
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section aria-label={t('runs')} data-testid="quant-strategy-runs">
      <h3>{t('runs')}</h3>
      <Read resource={runs.resource} retry={runs.reload}>
        {(data) => {
          const mine = data.runs.filter((run) => run.strategyId === strategy.id);
          if (!mine.length) return <EmptyState title={t('noRuns', { count: RUN_PAGE })} />;
          return (
            <>
              <DataTable label={t('runs')} headers={[t('runStarted'), t('runLabel'), t('version'), t('code')]}>
                {mine.map((run) => (
                  <tr key={run.runId} data-testid="quant-strategy-run" data-run-id={run.runId} data-version={run.strategyVersion ?? ''}>
                    <td lang="zxx">{utcText(run.started)}</td>
                    <td lang="und">{run.label ?? t('noLabel')}</td>
                    <td>{run.strategyVersion ? t('versionOf', { version: run.strategyVersion }) : t('versionUnknown')}</td>
                    <td>
                      {run.strategyVersion && (
                        <Button variant="secondary" onClick={() => setOpen(open === run.runId ? null : run.runId)}>
                          {t('showRunCode', { version: run.strategyVersion })}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </DataTable>
              {(() => {
                const run = mine.find((row) => row.runId === open);
                const version = run?.strategyVersion ? strategy.versions.find((row) => row.version === run.strategyVersion) : undefined;
                return version ? (
                  <div data-testid="quant-run-code" data-run-id={run!.runId} data-version={version.version}>
                    <VersionSource version={version} />
                  </div>
                ) : null;
              })()}
            </>
          );
        }}
      </Read>
    </section>
  );
}
