import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StateBlock,
  StatusTag,
  ToggleGroup,
  ToggleGroupItem,
  type StatusKind,
} from '@intafaced/ui';
import { fmtUsd } from '../../../data/format';
import { PreviewActionButton, PreviewChip } from '../../../preview';
import type { SampleAgent, SampleCheck, SampleLogEntry, SampleResult } from '../../../preview/fixtures/agents';
import { agentsCopy } from './copy';
import { checkKey } from './model';
import { useSampleTime } from './time';

type Outcome = 'all' | 'waiting' | 'done' | 'stopped';

const resultKind: Record<SampleResult, StatusKind> = { done: 'filled', waiting: 'pending', declined: 'cancelled', stopped: 'failed' };
const checkKind: Record<SampleCheck, StatusKind> = { inside: 'working', asked: 'pending', blocked: 'failed' };

function matches(entry: SampleLogEntry, outcome: Outcome): boolean {
  if (outcome === 'all') return true;
  if (outcome === 'stopped') return entry.result === 'stopped' || entry.result === 'declined';
  return entry.result === outcome;
}

/**
 * Every action the agents took, newest first: when, who, what, how big, whether the limits allowed it and how it ended. Rows that wait
 * for an answer carry Approve and Decline, which open the sheet. Filters are local.
 */
export function ActivityLog({ agents, log }: { agents: readonly SampleAgent[]; log: readonly SampleLogEntry[] }) {
  const { t } = agentsCopy.useCopy();
  const time = useSampleTime();
  const [agent, setAgent] = useState<string>('all');
  const [outcome, setOutcome] = useState<Outcome>('all');
  const names = Object.fromEntries(agents.map((a) => [a.id, a.name]));
  const rows = log.filter((entry) => (agent === 'all' || entry.agent === agent) && matches(entry, outcome));
  return (
    <section className="if-preview__panel ag-log" aria-labelledby="ag-log-h" data-testid="agents-log">
      <div className="if-preview__panel-head ag-log__head">
        <h2 className="if-preview__h2" id="ag-log-h">
          {t('Log heading')}
        </h2>
        <PreviewChip />
        <span className="ag-log__tools">
          <span className="ag-field ag-field--select">
            <span className="ag-field__label" id="ag-log-agent">
              {t('Filter agent')}
            </span>
            <Select items={{ all: t('All agents'), ...names }} value={agent} onValueChange={(next) => next && setAgent(next)}>
              <SelectTrigger aria-labelledby="ag-log-agent" size={32} className="ag-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('All agents')}</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
          <ToggleGroup
            aria-label={t('Filter outcome')}
            variant="pill"
            value={outcome}
            onValueChange={(next) => setOutcome(next as Outcome)}
          >
            <ToggleGroupItem value="all">{t('Out all')}</ToggleGroupItem>
            <ToggleGroupItem value="waiting">{t('Out waiting')}</ToggleGroupItem>
            <ToggleGroupItem value="done">{t('Out done')}</ToggleGroupItem>
            <ToggleGroupItem value="stopped">{t('Out stopped')}</ToggleGroupItem>
          </ToggleGroup>
          <PreviewActionButton product="agents" variant="secondary" size={32}>
            {t('Export log')}
          </PreviewActionButton>
        </span>
      </div>
      <p className="ag-fine">{t('Log line')}</p>
      {rows.length === 0 ? (
        log.length === 0 ? (
          <StateBlock kind="empty" title={t('Empty log title')} body={t('Empty log body')} />
        ) : (
          <StateBlock kind="empty" title={t('Empty filter title')} body={t('Empty filter body')} />
        )
      ) : (
        <div className="ag-table-wrap">
          <table className="ag-table">
            <caption className="ag-sr">{t('Log heading')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('Col time')}</th>
                <th scope="col">{t('Col agent')}</th>
                <th scope="col">{t('Col did')}</th>
                <th scope="col" className="ag-num">
                  {t('Col size')}
                </th>
                <th scope="col">{t('Col check')}</th>
                <th scope="col">{t('Col result')}</th>
                <th scope="col" className="ag-sr">
                  {t('Col act')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.id} data-result={entry.result}>
                  <td className="ag-nowrap">{time(entry.at)}</td>
                  <th scope="row" className="ag-who">
                    {names[entry.agent]}
                  </th>
                  <td>{entry.did}</td>
                  <td className="ag-num if-num">
                    {entry.size === null ? <span className="ag-dim">{t('No size')}</span> : fmtUsd(entry.size)}
                  </td>
                  <td>
                    <StatusTag status={checkKind[entry.check]} label={t(checkKey(entry.check))} />
                  </td>
                  <td>
                    <StatusTag
                      status={resultKind[entry.result]}
                      label={
                        entry.result === 'done'
                          ? t('Result done')
                          : entry.result === 'waiting'
                            ? t('Result waiting')
                            : entry.result === 'declined'
                              ? t('Result declined')
                              : t('Result stopped')
                      }
                    />
                  </td>
                  <td className="ag-act">
                    {entry.result === 'waiting' ? (
                      <>
                        <PreviewActionButton product="agents" variant="primary" size={28}>
                          {t('Approve')}
                        </PreviewActionButton>
                        <PreviewActionButton product="agents" variant="secondary" size={28}>
                          {t('Decline')}
                        </PreviewActionButton>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
