import { Chip } from '@/components/chip';
import { Card, FailureState, StateBlock } from '@/components/merchants/ui';
import type { PayCallResult } from '@/lib/merchants/pay-call';
import { formatUtc } from '@/lib/merchants/time';
import type { NotePage } from '@/lib/founder-ops/notes';
import { hrefWith, one, type Query } from '@/lib/founder-ops/read-model';
import { Pager } from './section-panels';
import { AddNoteForm, RetractNoteForm } from './note-forms';
import './screens.css';

/**
 * Operator notes for one merchant (`founderAdmin.ops.notes.*`). Listing is a read; adding and retracting go through the
 * console's own founder-gated route. The merchant never sees any of it.
 */
export function NotesPanel({
  merchantId,
  result,
  path,
  query,
}: {
  merchantId: string;
  result: PayCallResult<NotePage> | undefined;
  path: string;
  query: Query | undefined;
}) {
  const retry = hrefWith(path, query, {});
  const flaggedOnly = one(query, 'flagged') === '1';
  const withRetracted = one(query, 'retracted') === '1';
  return (
    <Card id="notes" title="Operator notes" sub="Internal notes, tags and a watch flag about this merchant. The merchant never sees them.">
      <AddNoteForm merchantId={merchantId} />
      <div className="mp-inline mp-mt">
        <nav className="mp-pills" aria-label="Note filters">
          <a
            href={hrefWith(path, query, { flagged: flaggedOnly ? undefined : '1', cursor: undefined })}
            aria-current={flaggedOnly ? 'true' : undefined}
          >
            Flagged only
          </a>
          <a
            href={hrefWith(path, query, { retracted: withRetracted ? undefined : '1', cursor: undefined })}
            aria-current={withRetracted ? 'true' : undefined}
          >
            Include retracted
          </a>
        </nav>
      </div>
      {!result ? null : result.kind !== 'ok' ? (
        <FailureState failure={result} what="Operator notes" retryHref={retry} />
      ) : result.data.items.length === 0 ? (
        <StateBlock kind="empty" title={flaggedOnly || withRetracted ? 'No note matches these filters' : 'No notes yet'}>
          {flaggedOnly || withRetracted
            ? 'Change the filters to see more.'
            : 'Add the first note above. This is a successful read, not an error.'}
        </StateBlock>
      ) : (
        <ol className="mp-notes" aria-label="Notes, newest first">
          {result.data.items.map((n) => (
            <li key={n.noteId} className="mp-note" data-retracted={n.retractedAt ? 'true' : undefined}>
              <p className="mp-note__meta">
                <time dateTime={n.createdAt}>{formatUtc(n.createdAt)}</time> · founder{' '}
                <code title={n.authorId}>{n.authorId.slice(0, 8)}</code>
                {n.flagged ? (
                  <>
                    {' '}
                    <Chip tone="warn" title="This note flags the merchant for watching.">
                      flagged
                    </Chip>
                  </>
                ) : null}
                {n.tags.map((t) => (
                  <span key={t}>
                    {' '}
                    <Chip tone="neutral">{t}</Chip>
                  </span>
                ))}
                {n.retractedAt ? (
                  <>
                    {' '}
                    <Chip tone="dark" title="Withdrawn. The text stays in the history.">
                      retracted
                    </Chip>
                  </>
                ) : null}
              </p>
              <p className="mp-note__body">
                <bdi>{n.body}</bdi>
              </p>
              {n.retractedAt ? (
                <p className="mp-footnote">
                  Retracted <time dateTime={n.retractedAt}>{formatUtc(n.retractedAt)}</time>
                  {n.retractedBy ? (
                    <>
                      {' '}
                      by <code title={n.retractedBy}>{n.retractedBy.slice(0, 8)}</code>
                    </>
                  ) : null}
                  : {n.retractReason ?? 'no reason recorded'}
                </p>
              ) : (
                <RetractNoteForm noteId={n.noteId} />
              )}
            </li>
          ))}
        </ol>
      )}
      {result?.kind === 'ok' ? <Pager path={path} query={query} cursorParam="cursor" nextCursor={result.data.nextCursor} /> : null}
    </Card>
  );
}
