/**
 * The trade rooms' notices drawn from the Volt kit: a refusal in plain words with its code, the state of the last
 * write, the device note of an unresolved request, and a freshness chip. The same words and behaviour as
 * `../rooms/RoomNotices.tsx`, which the rooms not yet in Volt still use. Status is a shape plus a word, never colour alone.
 */
import type { ReactNode } from 'react';
import type { KeyValueRow } from '@intafaced/ui/lit/templates';
import { Button } from '@intafaced/ui/lit';
import { FreshnessChip, RefusalBox, Tabs } from '@intafaced/ui/lit/templates';
import type { Words } from '../rooms/refusals';
import { STALE_AFTER_MS } from '../rooms/read';
import { BLOCK_WORDS, type RoomWriter } from '../rooms/write';
import { optionsCopy } from './copy';

/** A refusal in plain words, its code small underneath, and Try again when the read can be asked again. */
export function Refusal({ words, onRetry, variant = 'refused' }: { words: Words; onRetry?: () => void; variant?: 'refused' | 'parked' }) {
  const { t } = optionsCopy.useCopy();
  return (
    <div className="lt-stack">
      <RefusalBox refusal={{ variant, title: words.title, body: words.body, reference: words.code ?? undefined }} />
      {onRetry ? (
        <div className="lt-actions">
          <Button onClick={onRetry}>{t('Try again')}</Button>
        </div>
      ) : null}
    </div>
  );
}

/** Freshness of a polled region. `asOf` null means no good answer (unknown), `refused` means the service said no. */
export function Freshness({ asOf, refused = false, now }: { asOf: number | null; refused?: boolean; now?: number }) {
  return <FreshnessChip asOf={asOf} refused={refused} staleAfterMs={STALE_AFTER_MS} now={now} showAsOf={asOf !== null} />;
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
  const { t } = optionsCopy.useCopy();
  const { outcome, note } = writer;
  const pendingId = note.state === 'pending' ? note.pending.id : outcome.kind === 'uncertain' ? outcome.id : null;
  return (
    <div className="lt-stack" aria-live="polite">
      {outcome.kind === 'done' && done ? <p className="lt-text">{done}</p> : null}
      {outcome.kind === 'refused' ? <Refusal words={outcome.words} /> : null}
      {outcome.kind === 'blocked' ? (
        <p role="alert" className="lt-alert">
          {BLOCK_WORDS[outcome.reason]}
        </p>
      ) : null}
      {outcome.kind === 'uncertain' ? (
        <p role="alert" className="lt-alert">
          {outcome.words.title}. {outcome.words.body}
        </p>
      ) : null}
      {note.state === 'unreadable' ? (
        <p role="alert" className="lt-alert">
          {BLOCK_WORDS.unreadable}
        </p>
      ) : null}
      {pendingId ? (
        <div className="lt-toolbar">
          <span className="lt-hint">
            {t('Unconfirmed request')} <span className="lt-mono">{pendingId}</span>. {t('Requests locked')}
          </span>
          {onCheck ? <Button onClick={() => onCheck(pendingId)}>{t('Check status')}</Button> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The trade rooms, in the order the trade sub-navigation (`../TradeSubNav.tsx`) lists them. */
const TRADE_ROOMS = [
  { id: 'spot', label: 'Spot', href: '/trade/spot/BTC-USDT' },
  { id: 'margin', label: 'Margin', href: '/trade/margin' },
  { id: 'futures', label: 'Futures', href: '/trade/futures' },
  { id: 'options', label: 'Options', href: '/trade/options' },
  { id: 'copy', label: 'Copy', href: '/trade/copy' },
  { id: 'bots', label: 'Bots', href: '/trade/bots' },
  { id: 'convert', label: 'Convert', href: '/trade/convert' },
  { id: 'execution', label: 'Execution', href: '/execution' },
  { id: 'otc', label: 'Quote desk', href: '/otc' },
] as const;

/** The row every trade room carries, so a trader moves between rooms in one click. */
export function TradeRoomsNav({ active }: { active: (typeof TRADE_ROOMS)[number]['id'] }) {
  const current = TRADE_ROOMS.find((r) => r.id === active)!.href;
  return <Tabs label="Trading rooms" items={TRADE_ROOMS} current={current} />;
}

/** A value that is not known: the dash, read aloud as "unknown", never 0. */
export function unknownValue() {
  return <UnknownValue />;
}

function UnknownValue() {
  const { t } = optionsCopy.useCopy();
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="lt-sr">{t('Unknown value')}</span>
    </>
  );
}

/** One label and value row; a value not known is drawn as unknown (never 0), with its note under it. */
export function kvRow(label: string, value: ReactNode | null | undefined, note?: string): KeyValueRow {
  return { label, value: value ?? unknownValue(), unset: value == null || undefined, note };
}
