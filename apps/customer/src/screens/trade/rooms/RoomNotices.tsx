/**
 * Shared notices for the rooms: a refusal in plain words, the state of the last write, the device note of an unresolved
 * request. Status is a shape plus a word, never colour alone. The freshness chip is in RoomFreshness.tsx.
 */
import type { ReactNode } from 'react';
import { Button, RefusalBox } from '@intafaced/ui/lit';
import type { Words } from './refusals';
import { BLOCK_WORDS, type RoomWriter } from './write';

/** The retry's words, as the old kit's refusal drew them (these rooms have no copy catalogue yet). */
const TRY_AGAIN = 'Try again';

/** A refusal in the service's words, with its code; `size` is kept for callers and draws the same kit refusal. */
export function Refusal({ words, onRetry }: { words: Words; onRetry?: () => void; size?: 'inline' | 'panel' }) {
  return (
    <RefusalBox refusal={{ variant: 'refused', title: words.title, body: words.body, ...(words.code ? { reference: words.code } : {}) }}>
      {onRetry ? <Button onClick={onRetry}>{TRY_AGAIN}</Button> : null}
    </RefusalBox>
  );
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
    <div aria-live="polite">
      {outcome.kind === 'done' && done ? <p>{done}</p> : null}
      {outcome.kind === 'refused' ? <Refusal words={outcome.words} size="inline" /> : null}
      {outcome.kind === 'blocked' ? <p role="alert">{BLOCK_WORDS[outcome.reason]}</p> : null}
      {outcome.kind === 'uncertain' ? (
        <p role="alert">
          {outcome.words.title}. {outcome.words.body}
        </p>
      ) : null}
      {note.state === 'unreadable' ? <p role="alert">{BLOCK_WORDS.unreadable}</p> : null}
      {pendingId ? (
        <div className="lt-toolbar">
          <span>
            Unconfirmed request <span className="lt-mono">{pendingId}</span>. New requests stay locked until it is checked.
          </span>
          {onCheck ? <Button onClick={() => onCheck(pendingId)}>Check status</Button> : null}
        </div>
      ) : null}
    </div>
  );
}
