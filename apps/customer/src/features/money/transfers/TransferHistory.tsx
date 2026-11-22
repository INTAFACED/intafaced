import { z } from 'zod';

import { Button } from '@intafaced/ui/lit';

import { usePreferences } from '../../../shared/preferences';

import { stamp } from '../../../screens/money/time';

import { Text } from '../copy';

import { funds, usePageLimit } from '../components';
import { useBankView } from '../bank-context';

import { useExecutionsRead, type StandingInstruction } from '../ScheduleHistory';

import { standingCopy } from '../standing-copy';

import { Loaded as ResourceView } from './TransferParts';

/**
 * The Transfers room's drawing of `StandingFacts` and `ExecutionHistory` (../ScheduleHistory.tsx, which activity still
 * draws) and of `ReportedTime` (../bank-context.tsx): the same reads, words, ids and states, in the Volt kit
 *.
 */

export function StandingFacts({ instruction }: { instruction: StandingInstruction }) {
  const { Copy } = standingCopy.useCopy();
  return (
    <dl data-testid="money-standing-facts" className="lt-kv">
      <div>
        <dt>
          <Copy k="amount" />
        </dt>
        <dd className="lt-mono" lang="zxx" dir="ltr">
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
  const query = useExecutionsRead(id, limit);
  const retry = () => {
    if (current()) query.reload();
  };
  const failure = query.resource.status === 'failed' ? query.resource.failure : null;
  return (
    <div
      data-testid="money-execution-history"
      role="region"
      aria-label={t('returned')}
      lang={languageFor('returned')}
      dir={directionFor('returned')}
    >
      <header>
        <h3>
          <Copy k="returned" />
        </h3>
        <p className="lt-hint">
          <Copy k="oldest" params={{ limit }} />
        </p>
      </header>
      {failure?.status === 404 && failure.code === 'bank.schedule_not_found' ? (
        <div role="status">
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
              tone="secondary"
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
                <ol>
                  {rows.map((row, index) => (
                    <li key={`${row.occurrence}:${index}`}>
                      <article aria-label={t('occurrence', { occurrence: row.occurrence })}>
                        <header>
                          <h4>
                            <Copy k="occurrence" params={{ occurrence: row.occurrence }} />
                          </h4>
                          <dl className="lt-kv">
                            <dt>
                              <Copy k="status" />
                            </dt>
                            <dd lang="und" dir="auto">
                              {row.status}
                            </dd>
                          </dl>
                        </header>
                        <dl className="lt-kv">
                          <dt>
                            <Copy k="quantity" />
                          </dt>
                          <dd className="lt-mono" lang="zxx" dir="ltr">
                            {funds(row.amount, asset)}
                          </dd>
                        </dl>
                        {row.rejectionCode !== null && (
                          <dl className="lt-kv">
                            <dt className="lt-sr">
                              <Copy k="refusal" />
                            </dt>
                            <dd lang="zxx" dir="ltr">
                              {row.rejectionCode === '' ? <Copy k="emptyReference" /> : row.rejectionCode}
                            </dd>
                          </dl>
                        )}
                        {row.partnerMoveId !== null && (
                          <dl className="lt-kv" data-testid="money-execution-partner">
                            <dt>
                              <Copy k="partnerMove" />
                            </dt>
                            <dd lang="zxx" dir="ltr">
                              {row.partnerMoveId}
                            </dd>
                          </dl>
                        )}
                        <dl className="lt-kv">
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
                <div role="status">
                  <h3>
                    <Copy k="empty" />
                  </h3>
                  <p>
                    <Copy k="emptyNote" />
                  </p>
                </div>
              )}
              <div>
                <p className="lt-hint" role="status">
                  <Copy k="count" params={{ count: rows.length, limit }} />
                </p>
                <p className="lt-hint">
                  <Copy k="window" />
                </p>
                {rows.length >= limit &&
                  (limit < 200 ? (
                    <Button
                      tone="secondary"
                      onClick={() => {
                        if (current()) setLimit(limit + 50);
                      }}
                    >
                      <Copy k="more" params={{ limit: limit + 50 }} />
                    </Button>
                  ) : (
                    <p className="lt-hint">
                      <Copy k="cap" />
                    </p>
                  ))}
                <Button tone="quiet" onClick={retry}>
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

/** Returned timestamps share the app's one look ("18 Oct, 01:05") in the viewer's zone, with a picked zone named. */
export function ReportedTime({ value }: { value: string }) {
  const { timeZone } = usePreferences();
  return Number.isFinite(Date.parse(value)) ? (
    <time dateTime={value} lang="en-GB" dir="auto">
      {stamp(value, timeZone)}
    </time>
  ) : (
    <Text k="components.date.unavailable" />
  );
}
