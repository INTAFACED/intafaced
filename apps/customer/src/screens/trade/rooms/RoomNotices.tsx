/**
 * Shared notices for the rooms: a refusal in plain words, the state of the last write, the device note of an unresolved
 * request, and a freshness chip. Status is a shape plus a word, never colour alone.
 */
import type { ReactNode } from 'react';
import { Button, EmptyState, StatusChip, formatAsOf } from './ui';
import type { Words } from './refusals';
import { BLOCK_WORDS, type RoomWriter } from './write';
import { STALE_AFTER_MS } from './read';

export function Refusal({ words, onRetry, size = 'panel' }: { words: Words; onRetry?: () => void; size?: 'inline' | 'panel' }) {
  return (
    <EmptyState
      variant="refused"
      size={size}
      title={words.title}
      reason={words.body}
      code={words.code ?? undefined}
      action={onRetry ? { label: 'Try again', onClick: onRetry, variant: 'secondary' } : undefined}
    />
  );
}

/** Freshness of a polled region. `asOf` null means no good answer yet (unknown), `refused` means the service said no. */
export function Freshness({ asOf, refused = false, now }: { asOf: number | null; refused?: boolean; now?: number }) {
  return <StatusChip asOf={asOf} refused={refused} staleAfterMs={STALE_AFTER_MS} now={now} showAsOf={asOf !== null} />;
}

export function asOfText(asOf: number | null): string {
  return asOf === null ? 'not read yet' : (formatAsOf(asOf) ?? 'unknown');
}

/**
 * What happened to the last write, and the note of any request still unconfirmed. `onCheck` re-reads the original from
 * the service; the room decides what "the original" is. Nothing here sends anything.
 */
export function WriteNotice({
  writer,
  onCheck,
  done,
}: {
  writer: RoomWriter;
  /** Re-read the unresolved original and call `writer.resolve(id)` once the service proves its state. */
  onCheck?: (id: string) => void;
  /** Plain-words line shown after a successful write. */
  done?: ReactNode;
}) {
  const { outcome, note } = writer;
  const pendingId = note.state === 'pending' ? note.pending.id : outcome.kind === 'uncertain' ? outcome.id : null;
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      {outcome.kind === 'done' && done ? <p className="m-0 text-sm text-fg">{done}</p> : null}
      {outcome.kind === 'refused' ? <Refusal words={outcome.words} size="inline" /> : null}
      {outcome.kind === 'blocked' ? (
        <p role="alert" className="m-0 text-sm text-warn">
          {BLOCK_WORDS[outcome.reason]}
        </p>
      ) : null}
      {outcome.kind === 'uncertain' ? (
        <p role="alert" className="m-0 text-sm text-warn">
          {outcome.words.title}. {outcome.words.body}
        </p>
      ) : null}
      {note.state === 'unreadable' ? (
        <p role="alert" className="m-0 text-sm text-warn">
          {BLOCK_WORDS.unreadable}
        </p>
      ) : null}
      {pendingId ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-fg-2">
          <span>
            Unconfirmed request <span className="font-mono text-fg">{pendingId}</span>. New requests stay locked until it is checked.
          </span>
          {onCheck ? (
            <Button variant="secondary" size={32} onClick={() => onCheck(pendingId)}>
              Check status
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
