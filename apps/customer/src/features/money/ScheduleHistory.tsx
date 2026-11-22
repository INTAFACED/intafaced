import { z } from 'zod';

import { Button } from '../../shared/ui';

import {
  amount,
  endsField,
  funds,
  iso,
  positiveMoney,
  ResourceView,
  Section,
  useBankRead,
  usePageLimit,
  useBankRecord,
  type ActionSpec,
} from './components';

import { t as copyText } from './copy';

import type { scheduleSchema } from './contracts';

import { standingCopy } from './standing-copy';

import { currentOwnerRecord, useBankView } from './bank-context';
import { BANK_TRANSFERS_EXECUTIONS } from '@intafaced/contracts/bank-transfers-procedures';

export type StandingInstruction = z.infer<typeof scheduleSchema>;

export const currentInstruction = currentOwnerRecord<StandingInstruction>;

export function ScheduleExecutions({ id, asset }: { id: string; asset: string }) {
  const { Copy } = standingCopy.useCopy();
  return (
    <Section title={<Copy k="outcomes" />}>
      <dl className="money-standing-reference">
        <dt>
          <Copy k="reference" />
        </dt>
        <dd lang="zxx" dir="ltr">
          {id}
        </dd>
      </dl>
      <ExecutionHistory id={id} asset={asset} />
    </Section>
  );
}

function ExecutionHistory({ id, asset, refreshInstructions }: { id: string; asset: string; refreshInstructions?: () => void }) {
  const { Copy } = standingCopy.useCopy();
  return z.string().guid().safeParse(id).success ? (
    <ExecutionRead key={JSON.stringify([id, asset])} id={id} asset={asset} refreshInstructions={refreshInstructions} />
  ) : (
    <div role="status">
      <h3>
        <Copy k="conflict" />
      </h3>
      <p>
        <Copy k="conflictNote" />
      </p>
    </div>
  );
}

function ExecutionRead({ id, asset, refreshInstructions }: { id: string; asset: string; refreshInstructions?: () => void }) {
  const { Copy, t, languageFor, directionFor } = standingCopy.useCopy();
  const current = useBankView();
  const [limit, setLimit] = usePageLimit();
  const query = useExecutionsRead(id, limit);
  const retry = () => {
    if (current()) query.reload();
  };
  const failure = query.resource.status === 'failed' ? query.resource.failure : null;
  return (
    <div
      data-testid="money-execution-history"
      className="money-execution-history"
      role="region"
      aria-label={t('returned')}
      lang={languageFor('returned')}
      dir={directionFor('returned')}
    >
      <header>
        <h3>
          <Copy k="returned" />
        </h3>
        <p className="money-caption">
          <Copy k="oldest" params={{ limit }} />
        </p>
      </header>
      {failure?.status === 404 && failure.code === 'bank.schedule_not_found' ? (
        <div className="money-instruction-missing" role="status">
          <h3>
            <Copy k="notFound" />
          </h3>
          <p>
            <Copy k="notFoundNote" />
          </p>
          <details>
            <summary>
              <Copy k="serviceDetail" />
            </summary>
            <p lang="und" dir="auto">
              {failure.message}
            </p>
            <code lang="zxx" dir="ltr">
              {failure.code}
            </code>
          </details>
          {refreshInstructions && (
            <Button
              variant="secondary"
              onClick={() => {
                if (current()) refreshInstructions();
              }}
            >
              <Copy k="refresh" />
            </Button>
          )}
        </div>
      ) : (
        <ResourceView resource={query.resource} reload={retry}>
          {(rows) => (
            <>
              {rows.length ? (
                <ol className="money-execution-list">
                  {rows.map((row, index) => (
                    <li key={`${row.occurrence}:${index}`}>
                      <article className="money-execution-outcome" aria-label={t('occurrence', { occurrence: row.occurrence })}>
                        <header>
                          <h4>
                            <Copy k="occurrence" params={{ occurrence: row.occurrence }} />
                          </h4>
                          <dl className="money-execution-status">
                            <dt className="money-execution-label">
                              <Copy k="status" />
                            </dt>
                            <dd lang="und" dir="auto">
                              {row.status}
                            </dd>
                          </dl>
                        </header>
                        <dl className="money-execution-quantity">
                          <dt className="money-execution-label">
                            <Copy k="quantity" />
                          </dt>
                          <dd className="numeric" lang="zxx" dir="ltr">
                            {funds(row.amount, asset)}
                          </dd>
                        </dl>
                        {row.rejectionCode !== null && (
                          <dl className="money-execution-refusal">
                            <dt className="money-visually-hidden">
                              <Copy k="refusal" />
                            </dt>
                            <dd className="money-caption" lang="zxx" dir="ltr">
                              {row.rejectionCode === '' ? <Copy k="emptyReference" /> : row.rejectionCode}
                            </dd>
                          </dl>
                        )}
                        {row.partnerMoveId !== null && (
                          <dl className="money-execution-ledger" data-testid="money-execution-partner">
                            <dt>
                              <Copy k="partnerMove" />
                            </dt>
                            <dd lang="zxx" dir="ltr">
                              {row.partnerMoveId}
                            </dd>
                          </dl>
                        )}
                        <dl className="money-execution-ledger">
                          <dt>
                            <Copy k="ledger" />
                          </dt>
                          <dd lang="zxx" dir="ltr">
                            {row.ledgerTxId === null ? (
                              <Copy k="noLedger" />
                            ) : row.ledgerTxId === '' ? (
                              <Copy k="emptyReference" />
                            ) : (
                              row.ledgerTxId
                            )}
                          </dd>
                        </dl>
                      </article>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="money-instruction-missing" role="status">
                  <h3>
                    <Copy k="empty" />
                  </h3>
                  <p>
                    <Copy k="emptyNote" />
                  </p>
                </div>
              )}
              <div className="money-execution-continuation">
                <p className="money-caption" role="status">
                  <Copy k="count" params={{ count: rows.length, limit }} />
                </p>
                <p className="money-caption">
                  <Copy k="window" />
                </p>
                {rows.length >= limit &&
                  (limit < 200 ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        if (current()) setLimit(limit + 50);
                      }}
                    >
                      <Copy k="more" params={{ limit: limit + 50 }} />
                    </Button>
                  ) : (
                    <p className="money-caption">
                      <Copy k="cap" />
                    </p>
                  ))}
                <Button variant="ghost" onClick={retry}>
                  <Copy k="refreshOutcomes" />
                </Button>
              </div>
            </>
          )}
        </ResourceView>
      )}
    </div>
  );
}

/** One standing instruction's executions, newest first, as the bank reports them. Shared with the Transfers room. */
export function useExecutionsRead(scheduleId: string, limit: number) {
  return useBankRecord(BANK_TRANSFERS_EXECUTIONS, { scheduleId, limit });
}

/** The person's standing instructions, newest first. */
export function useSchedulesRead(limit: number) {
  return useBankRead('transfers.listSchedules', { limit });
}

/** A stored instant as the minutes a datetime-local field shows. */
function localInput(at: string): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function scheduleEditSpec(row: StandingInstruction): ActionSpec {
  return {
    title: copyText('rooms.edit.standing.order'),
    procedure: 'transfers.updateSchedule',
    fields: [positiveMoney(row.assetId), ...(row.cadence === 'once' ? [] : [endsField])],
    initial: { amount: row.amount, ...(row.endsAt ? { endsAt: localInput(row.endsAt) } : {}) },
    formFacts: [[copyText('rooms.revision'), String(row.revision)]],
    facts: [
      [copyText('rooms.schedule'), row.id],
      [copyText('rooms.revision'), String(row.revision)],
      [copyText('rooms.current.amount'), amount(row.amount, row.assetId)],
    ],
    notes: [copyText('rooms.edit.changes.future.runs'), copyText('rooms.edit.revision.note')],
    validate: (input) =>
      typeof input.endsAt === 'string' && Date.parse(input.endsAt) <= Math.max(Date.now(), Date.parse(row.startsAt))
        ? copyText('components.choose.an.end.after.first.run')
        : null,
    input: (values) => ({
      scheduleId: row.id,
      revision: row.revision,
      amount: values.amount,
      // The form shows minutes: an end left as it was keeps the stored instant, seconds included.
      endsAt: !values.endsAt ? null : row.endsAt && values.endsAt === localInput(row.endsAt) ? row.endsAt : iso(values.endsAt),
    }),
  };
}

export function schedulePauseSpec(row: StandingInstruction): ActionSpec {
  return {
    title: row.status === 'paused' ? copyText('rooms.resume.standing.order') : copyText('rooms.pause.standing.order'),
    procedure: row.status === 'paused' ? 'transfers.resume' : 'transfers.pause',
    facts: [
      [copyText('rooms.schedule'), row.id],
      [copyText('rooms.amount'), amount(row.amount, row.assetId)],
    ],
    notes: [
      row.status === 'paused'
        ? copyText('rooms.occurrences.missed.while.paused.are.skipped.they')
        : copyText('rooms.pause.future.scheduled.transfers.past.posted.transfers'),
    ],
    input: () => ({ scheduleId: row.id }),
  };
}

export function scheduleCancelSpec(row: StandingInstruction): ActionSpec {
  return {
    title: copyText('rooms.cancel.standing.order'),
    procedure: 'transfers.cancel',
    notes: [copyText('rooms.cancel.future.occurrences.this.does.not.reverse')],
    facts: [[copyText('rooms.schedule'), row.id]],
    input: () => ({ scheduleId: row.id }),
  };
}
