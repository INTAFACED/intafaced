// volt-room: /quant/strategies/:strategyId
import {
  quantStrategyDetailSchema,
  type QuantStrategyDetail,
  type QuantStrategyVersion,
  type QuantVersionDiff,
} from '@intafaced/contracts/quant-algo';
import { QUANT_BACKTEST_HISTORY } from '@intafaced/contracts/quant-backtest-procedures';
import { QUANT_STUDIO_DIFF, QUANT_STUDIO_GET } from '@intafaced/contracts/quant-studio-procedures';
import { useState } from 'react';
import { parsesAs } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { EmptyNote, KitRead, preservePaperHref, ScrollTable, Section } from '../more';
import { useApi } from '../session';
import { PaperRuns } from './PaperRuns';
import { StrategyAlerts, StrategyChannels } from './StrategyNotify';
import { QuantRooms } from './QuantRooms';
import { StrategyLifecycle } from './StrategyLifecycle';
import { StrategyRisk } from './StrategyRisk';
import { StrategyTeam } from './StrategyTeam';
import { ApprovalPanel } from './ApprovalPanel';
import { StrategyLineage, StrategyPublish } from './StrategyPublish';
import { strategyPageCopy } from './strategy-page-copy';
import { Button } from '@intafaced/ui/lit';
import { CheckField, ReadingTemplate } from '@intafaced/ui/lit/templates';

/** How many of this strategy's recent runs the page reads. A page size, not a product limit. */
const RUN_PAGE = 20;

/** An ISO instant as its UTC minute, "2026-10-23 03:40". */
const utcText = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/**
 * One saved strategy's page (AL-editor-01): every version with the note written when it was saved and its source,
 * read only; two versions compared line by line; and the account's recent runs of it, each with the code it ran. On the
 * reading template.
 */
export function StrategyPage({ strategyId, paper }: { strategyId: string; paper: boolean }) {
  const api = useApi();
  const { t } = strategyPageCopy.useCopy();
  const detail = useResource(
    (signal) => api.call(QUANT_STUDIO_GET, { id: strategyId }, { signal, accept: parsesAs(quantStrategyDetailSchema) }),
    `quant-strategy:${strategyId}`,
  );
  return (
    <ReadingTemplate
      title={t('roomTitle')}
      description={t('description')}
      state={{ kind: 'ready' }}
      meta={
        <>
          <QuantRooms active="strategies" paper={paper} />
          <p>
            <a className="lt-link" href={preservePaperHref('/quant/strategies', paper)}>
              {t('back')}
            </a>
          </p>
        </>
      }
      body={
        <KitRead resource={detail.resource} retry={detail.reload}>
          {(strategy) => (
            <>
              <StrategyLineage strategy={strategy} />
              <StrategyVersions strategy={strategy} />
              <p>
                <a className="lt-link" href={preservePaperHref(`/quant/studio?open=${encodeURIComponent(strategy.id)}`, paper)}>
                  {t('openInStudio')}
                </a>
              </p>
              <StrategyRisk strategy={strategy} />
              <PaperRuns strategy={strategy} />
              <StrategyChannels strategy={strategy} />
              <StrategyAlerts strategy={strategy} />
              <StrategyLifecycle strategy={strategy} />
              <StrategyTeam strategy={strategy} />
              <ApprovalPanel strategyId={strategy.id} owner />
              <StrategyPublish strategy={strategy} />
            </>
          )}
        </KitRead>
      }
    />
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
    <Section title={t('title', { name: strategy.name })}>
      <div data-testid="quant-versions" data-strategy-id={strategy.id}>
        <p>{t('simulated')}</p>
        <p>{strategy.folder ? t('inFolder', { folder: strategy.folder }) : t('noFolder')}</p>
        {strategy.description && <p lang="und">{strategy.description}</p>}
        <h3>{t('versions')}</h3>
        <ScrollTable label={t('versions')} headers={[t('compare'), t('version'), t('name'), t('saved'), t('note'), t('source')]}>
          {newestFirst.map((row) => (
            <tr key={row.version} data-testid="quant-version-row" data-version={row.version}>
              <td>
                <CheckField
                  label={<span className="lt-sr">{t('pick', { version: row.version })}</span>}
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
                <Button tone="secondary" onClick={() => setShown(shown === row.version ? null : row.version)}>
                  {shown === row.version ? t('hideSource', { version: row.version }) : t('showSource', { version: row.version })}
                </Button>
              </td>
            </tr>
          ))}
        </ScrollTable>
        {shown !== null && sourceOf(shown) && <VersionSource version={sourceOf(shown)!} />}
        {pair ? (
          <VersionDiff strategyId={strategy.id} from={pair[0]} to={pair[1]} />
        ) : (
          <p data-testid="quant-diff-hint">{strategy.versions.length > 1 ? t('pickTwo') : t('oneVersion')}</p>
        )}
        <RunsOfStrategy strategy={strategy} />
      </div>
    </Section>
  );
}

/** A version's source, read only: an older version is never edited in place; Studio saves a new version instead. */
function VersionSource({ version }: { version: QuantStrategyVersion }) {
  const { t } = strategyPageCopy.useCopy();
  return (
    <section aria-label={t('sourceOf', { version: version.version })} data-testid="quant-version-source" data-version={version.version}>
      <h4>{t('sourceOf', { version: version.version })}</h4>
      <pre lang="zxx" className="lt-code" tabIndex={0}>
        {version.source}
      </pre>
    </section>
  );
}

function VersionDiff({ strategyId, from, to }: { strategyId: string; from: number; to: number }) {
  const api = useApi();
  const { t } = strategyPageCopy.useCopy();
  const diff = useResource(
    (signal) => api.call(QUANT_STUDIO_DIFF, { id: strategyId, from, to }, { signal }),
    `quant-diff:${strategyId}:${from}:${to}`,
  );
  return (
    <section aria-label={t('diffTitle', { from, to })} data-testid="quant-diff" data-from={from} data-to={to}>
      <h4>{t('diffTitle', { from, to })}</h4>
      <KitRead resource={diff.resource} retry={diff.reload}>
        {(data) => (data.changed ? <DiffParts diff={data} /> : <p data-testid="quant-diff-same">{t('diffSame')}</p>)}
      </KitRead>
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
  const changed = parts.filter(([, lines]) => lines.some((line) => line.op !== 'same'));
  // The source is built from the blocks and rules, so when they show the change its line diff only repeats it.
  const fold = changed.some(([part]) => part !== 'sourcePart');
  return (
    <>
      {changed.map(([part, lines]) => {
        const body = (
          <pre lang="zxx" className="lt-code">
            {lines.map((line, i) => (
              <span key={i} data-testid="quant-diff-line" data-op={line.op}>
                {marks[line.op]} {line.text}
                {'\n'}
              </span>
            ))}
          </pre>
        );
        return part === 'sourcePart' && fold ? (
          <details key={part} data-testid={`quant-diff-${part}`}>
            <summary>{t('sourcePartFolded')}</summary>
            {body}
          </details>
        ) : (
          <div key={part} data-testid={`quant-diff-${part}`}>
            <h5>{t(part)}</h5>
            {body}
          </div>
        );
      })}
    </>
  );
}

/** The account's recent runs of this strategy, each with the version it ran and that version's code. */
function RunsOfStrategy({ strategy }: { strategy: QuantStrategyDetail }) {
  const api = useApi();
  const { t } = strategyPageCopy.useCopy();
  const runs = useResource(
    (signal) => api.call(QUANT_BACKTEST_HISTORY, { limit: RUN_PAGE, strategyId: strategy.id }, { signal }),
    `quant-strategy-runs:${strategy.id}`,
  );
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section aria-label={t('runs')} data-testid="quant-strategy-runs">
      <h3>{t('runs')}</h3>
      <KitRead resource={runs.resource} retry={runs.reload}>
        {(data) => {
          const mine = data.runs.filter((run) => run.strategyId === strategy.id);
          if (!mine.length) return <EmptyNote title={t('noRuns')} />;
          return (
            <>
              <ScrollTable label={t('runs')} headers={[t('runStarted'), t('runLabel'), t('version'), t('code')]}>
                {mine.map((run) => (
                  <tr key={run.runId} data-testid="quant-strategy-run" data-run-id={run.runId} data-version={run.strategyVersion ?? ''}>
                    <td lang="zxx">{utcText(run.started)}</td>
                    <td lang="und">{run.label ?? t('noLabel')}</td>
                    <td>{run.strategyVersion ? t('versionOf', { version: run.strategyVersion }) : t('versionUnknown')}</td>
                    <td>
                      {run.strategyVersion && (
                        <Button tone="secondary" onClick={() => setOpen(open === run.runId ? null : run.runId)}>
                          {t('showRunCode', { version: run.strategyVersion })}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </ScrollTable>
              {data.nextCursor && <p>{t('runsLatest', { count: RUN_PAGE })}</p>}
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
      </KitRead>
    </section>
  );
}
