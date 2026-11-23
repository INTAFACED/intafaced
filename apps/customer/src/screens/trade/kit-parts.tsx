import { useId, useRef, type ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import { useModalDialog } from '../../shared/modal-dialog';
import { uiCopy } from '../../shared/ui-copy';

/**
 * The trade screens' shared parts drawn only from the Volt kit (intafaced issue 9564): the buy card, the order and trade
 * tables and the recurring buy use them, wherever they are shown. Each keeps the words, roles and ids of the old kit's
 * part it replaces (`StateBlock`, `Dialog`, `AlertDialog`), so a person or a test reads the same thing.
 */

export interface KitAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

/** A link that looks like a kit button: the kit's Button draws a `<button>`, and a link must stay a link. */
export function LinkButton({
  href,
  tone = 'secondary',
  children,
  ...rest
}: { href: string; tone?: 'primary' | 'secondary'; children: ReactNode } & Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  'href' | 'className' | 'children'
>) {
  return (
    <a {...rest} href={href} className={`lt-button lt-button-${tone}`}>
      {children}
    </a>
  );
}

function ActionButton({ action, tone }: { action: KitAction; tone: 'primary' | 'secondary' }) {
  if (action.href)
    return (
      <LinkButton href={action.href} tone={tone}>
        {action.label}
      </LinkButton>
    );
  return (
    <Button tone={tone} onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

export type KitStateProps = { testId?: string } & (
  | { kind: 'loading'; rows?: number; label?: string }
  | { kind: 'empty'; title: ReactNode; body?: ReactNode; action?: KitAction }
  | { kind: 'error'; title: string; onRetry: () => void; retryLabel: string }
  | { kind: 'refused'; title: string; body: ReactNode; code?: string | null; action?: KitAction }
);

/** Loading, nothing yet, a failed read with Try again, or a refusal in words: the four states a shared part shows. */
export function KitState(props: KitStateProps) {
  if (props.kind === 'loading')
    return (
      <div data-testid={props.testId} data-kind="loading" role="status" aria-busy="true" aria-label={props.label}>
        <Skeleton shape="rows" count={props.rows ?? 3} />
      </div>
    );
  if (props.kind === 'empty')
    return (
      <div data-testid={props.testId} data-kind="empty" className="lt-empty">
        <h3 className="lt-empty-title">{props.title}</h3>
        {props.body ? <p className="lt-empty-body">{props.body}</p> : null}
        {props.action ? <ActionButton action={props.action} tone="primary" /> : null}
      </div>
    );
  if (props.kind === 'error')
    return (
      <div data-testid={props.testId} data-kind="error" className="lt-refusal" data-refusal="unreachable" role="alert">
        <p className="lt-refusal-title">{props.title}</p>
        <Button tone="secondary" onClick={props.onRetry}>
          {props.retryLabel}
        </Button>
      </div>
    );
  return (
    <div data-testid={props.testId} data-kind="refused" className="lt-refusal" data-refusal="refused">
      <p className="lt-refusal-title">{props.title}</p>
      <p className="lt-refusal-body">{props.body}</p>
      {props.action ? <ActionButton action={props.action} tone="secondary" /> : null}
      {props.code ? <p className="lt-ref">{props.code}</p> : null}
    </div>
  );
}

/**
 * A modal dialog on the native element, open while it is drawn: focus stays inside and returns after, Escape closes it.
 * `alert` makes it an alert dialog (a review or a confirmation): no close mark and no closing by the backdrop, as the old
 * kit's AlertDialog. `description` names what the dialog is about to assistive tech, as the old DialogDescription did.
 */
export function KitDialog({
  title,
  description,
  onClose,
  alert = false,
  testId,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  alert?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  const { t, languageFor } = uiCopy.useCopy();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useModalDialog(ref);
  return (
    <dialog
      ref={ref}
      className="lt-sheet"
      role={alert ? 'alertdialog' : undefined}
      data-testid={testId}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (!alert && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="lt-stack">
        <header className="lt-sheet-head">
          <h2 id={titleId} className="lt-sheet-title">
            {title}
          </h2>
          {alert ? null : (
            <Button tone="quiet" aria-label={t('closeDialog')} lang={languageFor('closeDialog')} onClick={onClose}>
              ×
            </Button>
          )}
        </header>
        {description ? (
          <p id={descriptionId} className="lt-hint">
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </dialog>
  );
}

/**
 * What a person typed in an amount box, as a decimal string with a "." mark, or null to refuse the keystroke: a second
 * decimal mark, or more decimals than `places`. Letters and spaces are dropped. "," counts as the decimal mark. The rule
 * the old kit's amount box kept, so the box still refuses what it refused.
 */
export function typedDecimal(raw: string, places: number): string | null {
  const kept = raw.replace(/[^0-9.,]/g, '');
  const marks = kept.match(/[.,]/g)?.length ?? 0;
  if (marks > 1) return null;
  const text = kept.replace(',', '.');
  const at = text.indexOf('.');
  if (at !== -1 && (places === 0 || text.length - at - 1 > places)) return null;
  return text.startsWith('.') ? `0${text}` : text;
}
