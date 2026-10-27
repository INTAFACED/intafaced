import { z } from 'zod';
import { Button } from '../../shared/ui';
import { funds, ResourceView, Section, useBankRead, usePageLimit } from './components';
import type { scheduleSchema } from './contracts';
import { standingCopy } from './standing-copy';
import { ReportedTime, currentOwnerRecord, useBankView } from './bank-context';

export type StandingInstruction = z.infer<typeof scheduleSchema>;

export const currentInstruction = currentOwnerRecord<StandingInstruction>;

export function StandingFacts({ instruction }: { instruction: StandingInstruction }) {
  const { Copy } = standingCopy.useCopy();
  return (
    <dl data-testid="money-standing-facts" className="money-standing-facts">
      <div>
        <dt>
          <Copy k="amount" />
        </dt>
        <dd className="numeric" lang="zxx" dir="ltr">
          {funds(instruction.amount, instruction.assetId)}
        </dd>
      </div>
      <div>
        <dt>
          <Copy k="cadenceStatus" />
        </dt>
        <dd lang="und" dir="auto">
          {instruction.cadence} · {instruction.status}
        </dd>
      </div>
      <div>
        <dt>
          <Copy k="nextRun" />
        </dt>
        <dd>
          <ReportedTime value={instruction.nextRunAt} />
        </dd>
      </div>
      <div>
        <dt>
          <Copy k="endsAt" />
        </dt>
        <dd>{instruction.endsAt ? <ReportedTime value={instruction.endsAt} /> : <Copy k="noEnd" />}</dd>
      </div>
      <div>
        <dt>
          <Copy k="revision" />
        </dt>
        <dd lang="zxx" dir="ltr">
          {instruction.revision}
        </dd>
      </div>
    </dl>
  );
}

export function ScheduleExecutions({ id, asset }: { id: string; asset: string }) {
  const { Copy } = standingCopy.useCopy();
  return (
    <Section title={<Copy k="outcomes" />}>
      <dl data-testid="money-standing-reference" className="money-standing-reference">
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

export function ExecutionHistory({ id, asset, refreshInstructions }: { id: string; asset: string; refreshInstructions?: () => void }) {
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
  const query = useBankRead('transfers.executions', { scheduleId: id, limit });
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
                      <article
                        data-testid="money-execution-outcome"
                        className="money-execution-outcome"
                        aria-label={t('occurrence', { occurrence: row.occurrence })}
                      >
                        <header>
                          <h4>
                            <Copy k="occurrence" params={{ occurrence: row.occurrence }} />
                          </h4>
                          <dl data-testid="money-execution-status" className="money-execution-status">
                            <dt className="money-execution-label">
                              <Copy k="status" />
                            </dt>
                            <dd lang="und" dir="auto">
                              {row.status}
                            </dd>
                          </dl>
                        </header>
                        <dl data-testid="money-execution-quantity" className="money-execution-quantity">
                          <dt className="money-execution-label">
                            <Copy k="quantity" />
                          </dt>
                          <dd className="numeric" lang="zxx" dir="ltr">
                            {funds(row.amount, asset)}
                          </dd>
                        </dl>
                        {row.rejectionCode !== null && (
                          <dl data-testid="money-execution-refusal" className="money-execution-refusal">
                            <dt className="money-visually-hidden">
                              <Copy k="refusal" />
                            </dt>
                            <dd className="money-caption" lang="zxx" dir="ltr">
                              {row.rejectionCode === '' ? <Copy k="emptyReference" /> : row.rejectionCode}
                            </dd>
                          </dl>
                        )}
                        <dl data-testid="money-execution-ledger" className="money-execution-ledger">
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
