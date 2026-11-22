import { useLayoutEffect, useRef, useState } from 'react';

import { Button } from '@intafaced/ui/lit';

import { t as copyText, Text } from '../copy';

import { date, funds, usePageLimit, type ActionSpec } from '../components';
import { useBankView } from '../bank-context';

import {
  currentInstruction,
  scheduleCancelSpec,
  scheduleEditSpec,
  schedulePauseSpec,
  useSchedulesRead,
  type StandingInstruction,
} from '../ScheduleHistory';

import { standingCopy } from '../standing-copy';

import { ExecutionHistory, StandingFacts } from './TransferHistory';

import { Continuation, Loaded as ResourceView, Part as Section } from './TransferParts';

/**
 * Standing orders on Transfers: each instruction, its outcomes, and edit, pause, resume and cancel through `open(spec)`.
 */
function ScheduleActions({
  row,
  open,
  disabled = false,
}: {
  row: StandingInstruction;
  open: (spec: ActionSpec) => void;
  disabled?: boolean;
}) {
  const current = useBankView();
  const protectedOpen = (spec: ActionSpec) => {
    if (!disabled && current()) open(spec);
  };
  return (
    <div className="lt-actions">
      {' '}
      {row.status !== 'cancelled' && (
        <>
          {(row.status === 'active' || row.status === 'paused') && (
            <Button tone="secondary" disabled={disabled} onClick={() => protectedOpen(scheduleEditSpec(row))}>
              <Text k="rooms.edit" />
            </Button>
          )}
          <Button tone="secondary" disabled={disabled} onClick={() => protectedOpen(schedulePauseSpec(row))}>
            {row.status === 'paused' ? copyText('rooms.resume') : copyText('rooms.pause')}
          </Button>
          <Button tone="quiet" disabled={disabled} onClick={() => protectedOpen(scheduleCancelSpec(row))}>
            <Text k="rooms.cancel" />
          </Button>
        </>
      )}
    </div>
  );
}
export function Schedules({ open }: { open: (spec: ActionSpec) => void }) {
  const { Copy, t, languageFor, directionFor } = standingCopy.useCopy();
  const current = useBankView();
  const [limit, setLimit] = usePageLimit();
  const [selected, setSelected] = useState<{ id: string; serial: number } | null>(null);
  const serial = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLSpanElement>(null);
  const query = useSchedulesRead(limit);
  const rows = query.resource.status === 'ready' ? query.resource.data : [];
  const instruction = selected ? currentInstruction(rows, selected.id) : undefined;
  const other = instruction ? rows.filter((row) => row.id !== instruction.id) : rows;
  const refresh = () => {
    if (current()) query.reload();
  };
  const arrive = (element: HTMLElement | null) => {
    if (!current() || document.querySelector('[role="dialog"]')) return;
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: 'start' });
  };
  useLayoutEffect(() => {
    if (selected) arrive(heading.current);
  }, [selected?.serial]);
  return (
    <div lang={languageFor('instructions')} dir={directionFor('instructions')}>
      {selected && (
        <section data-testid="money-selected-instruction" aria-labelledby="money-selected-instruction-heading">
          <header>
            <h2 id="money-selected-instruction-heading" ref={heading} tabIndex={-1}>
              <Copy k="outcomes" />
            </h2>
            <dl className="lt-kv">
              <dt>
                <Copy k="instruction" />
              </dt>
              <dd lang="zxx" dir="ltr">
                {instruction?.id ?? selected.id}
              </dd>
            </dl>
          </header>
          <ResourceView resource={query.resource} reload={refresh}>
            {() =>
              instruction ? (
                <>
                  <StandingFacts instruction={instruction} />
                  <ScheduleActions row={instruction} open={open} />
                  <ExecutionHistory id={instruction.id} asset={instruction.assetId} refreshInstructions={refresh} />
                </>
              ) : (
                <div role="status">
                  <h3>
                    <Copy k={rows.some((row) => row.id.toLowerCase() === selected.id.toLowerCase()) ? 'conflict' : 'missing'} />
                  </h3>
                  <p>
                    <Copy k={rows.some((row) => row.id.toLowerCase() === selected.id.toLowerCase()) ? 'conflictNote' : 'missingNote'} />
                  </p>
                  <Button tone="secondary" onClick={refresh}>
                    <Copy k="refresh" />
                  </Button>
                </div>
              )
            }
          </ResourceView>
          <Button tone="quiet" onClick={() => arrive(listHeading.current)}>
            <Copy k="return" />
          </Button>
        </section>
      )}
      <Section
        title={
          <span id="money-standing-list-heading" ref={listHeading} tabIndex={-1}>
            <Copy k={instruction ? 'other' : 'instructions'} />
          </span>
        }
        actions={
          <Button tone="quiet" onClick={refresh}>
            <Copy k="refresh" />
          </Button>
        }
      >
        <ResourceView resource={query.resource} reload={refresh}>
          {() => (
            <>
              {other.length ? (
                other.map((row, index) => (
                  <article data-testid="money-standing-record" key={`${row.id}:${index}`}>
                    <header>
                      <div>
                        <h3 lang="und" dir="auto">
                          {row.cadence} · {row.status}
                        </h3>
                        <p>
                          <span className="lt-sr">
                            <Copy k="reference" />
                          </span>
                          <bdi lang="zxx" dir="ltr">
                            {row.id}
                          </bdi>
                        </p>
                        <p>
                          <Copy k="nextRun" /> ·{' '}
                          <span lang="und" dir="auto">
                            {date(row.nextRunAt)}
                          </span>
                        </p>
                      </div>
                      <strong className="lt-mono" lang="zxx" dir="ltr">
                        {funds(row.amount, row.assetId)}
                      </strong>
                    </header>
                    <div className="lt-actions">
                      <Button
                        tone="secondary"
                        aria-label={t('inspect', { reference: row.id })}
                        lang={languageFor('inspect')}
                        dir={directionFor('inspect')}
                        disabled={!currentInstruction(rows, row.id)}
                        aria-controls="money-selected-instruction-heading"
                        onClick={() => {
                          if (current() && currentInstruction(rows, row.id) === row && !document.querySelector('[role="dialog"]'))
                            setSelected({ id: row.id, serial: ++serial.current });
                        }}
                      >
                        <Text k="rooms.execution.history" />
                      </Button>
                      <ScheduleActions row={row} open={open} disabled={!currentInstruction(rows, row.id)} />
                    </div>
                  </article>
                ))
              ) : (
                <div role="status">
                  <h3>
                    <Copy k={instruction ? 'noOther' : 'noInstructions'} />
                  </h3>
                  <p>
                    <Copy k="listWindow" />
                  </p>
                </div>
              )}
              <Continuation
                count={rows.length}
                limit={limit}
                onMore={() => {
                  if (current()) setLimit(Math.min(200, limit + 50));
                }}
              />
              <p className="lt-hint">
                <Copy k="listWindow" />
              </p>
            </>
          )}
        </ResourceView>
      </Section>
    </div>
  );
}
