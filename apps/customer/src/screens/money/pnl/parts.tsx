import { Button } from '@intafaced/ui/lit';
import type { RefusalCopy } from '../../../data/types';

/**
 * The profit and loss room's small parts, drawn only from the Volt kit, with the same words, roles and test ids as the
 * old kit's parts they replace (`Amount`, `StateBlock`, the pressed switches).
 */

/** The mask a hidden figure shows: the old kit's, so a hidden figure reads the same. */
const MASK = '••••';

/** A money figure, masked when balances are hidden. */
export function Amount({ value, hidden }: { value: string; hidden: boolean }) {
  return hidden ? (
    <span data-hidden="true" aria-label="Hidden">
      {MASK}
    </span>
  ) : (
    <bdi dir="ltr">{value}</bdi>
  );
}

/** A row of pressed buttons, one per option, named as a group. */
export function Pressed<T extends string>({
  label,
  options,
  value,
  words,
  onChoose,
}: {
  label: string;
  options: readonly T[];
  value: T | null;
  words: (option: T) => string;
  onChoose: (option: T) => void;
}) {
  return (
    <div className="lt-actions" role="group" aria-label={label}>
      {options.map((option) => (
        <Button key={option} tone="secondary" aria-pressed={value === option} onClick={() => onChoose(option)}>
          {words(option)}
        </Button>
      ))}
    </div>
  );
}

/** A read that failed, with a way to read it again. */
export function ErrorNote({ title, onRetry, retryLabel }: { title: string; onRetry: () => void; retryLabel: string }) {
  return (
    <div data-testid="money-state" data-kind="error" className="lt-refusal" data-refusal="unreachable" role="alert">
      <p className="lt-refusal-title">{title}</p>
      <Button tone="secondary" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}

/** A refusal, in the service's or the screen's words, with its next step and reference when there are ones. */
export function RefusedNote({ words }: { words: Pick<RefusalCopy, 'title' | 'body' | 'action' | 'reference'> }) {
  return (
    <div data-testid="money-state" data-kind="refused" className="lt-refusal" data-refusal="refused">
      <p className="lt-refusal-title">{words.title}</p>
      <p className="lt-refusal-body">{words.body}</p>
      {words.action ? (
        <a className="lt-link" href={words.action.href}>
          {words.action.label}
        </a>
      ) : null}
      {words.reference ? <p className="lt-ref">{words.reference}</p> : null}
    </div>
  );
}

/** Nothing to show yet, said in words, with the one way on. */
export function EmptyNote({ title, body, action }: { title: string; body?: string; action?: { label: string; href: string } }) {
  return (
    <div data-testid="money-state" data-kind="empty" className="lt-empty">
      <h3 className="lt-empty-title">{title}</h3>
      {body ? <p className="lt-empty-body">{body}</p> : null}
      {action ? (
        <a className="lt-button lt-button-primary" href={action.href}>
          {action.label}
        </a>
      ) : null}
    </div>
  );
}
