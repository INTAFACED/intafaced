import { useId, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { SectionTabs } from '@intafaced/ui/lit/templates';
import { isVerifyFirst, type ApiResult } from '../../../shared/api';
import { VerifyFirstNote } from '../../../shared/verify-first';
import { uiCopy } from '../../../shared/ui-copy';
import { useFailureWords } from '../../../shared/failure-words';
import { useModalDialog } from '../../../shared/modal-dialog';

export { Field };

/**
 * The Web3 rooms' shared parts, drawn only from the Volt kit: the same names, words, roles and ids as the app's
 * old `shared/ui` parts they replace, so a room moves onto its template without changing what a person or a test reads.
 * A part here is judged by volt-count where it lives; one the kit itself should own moves there once a second area needs it.
 */

/** A titled part of a room: its heading, then its body. */
export function Panel({
  title,
  actions,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, 'title'> & { title?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section {...rest}>
      {(title || actions) && (
        <header>
          {title && <h2>{title}</h2>}
          {actions}
        </header>
      )}
      <div className="lt-body">{children}</div>
    </section>
  );
}

/** Nothing to show, said in words. */
export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="lt-empty">
      <h3 className="lt-empty-title">{title}</h3>
      {children && <p className="lt-empty-body">{children}</p>}
      {action}
    </div>
  );
}

/** Data on its way. */
export function Loading({ label }: { label?: ReactNode }) {
  const { Copy } = uiCopy.useCopy();
  return (
    <div className="lt-hint" role="status">
      {label ?? <Copy k="loading" />}…
    </div>
  );
}

/** A table the room fills with its own rows, in a named region that scrolls on its own. */
export function DataTable({ headers, children, label }: { headers: readonly ReactNode[]; children: ReactNode; label: string }) {
  return (
    <div className="lt-scroll-row" tabIndex={0} role="region" aria-label={label}>
      <table className="lt-table">
        <thead>
          <tr>
            {headers.map((head, index) => (
              <th key={index} scope="col">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A room's own sections as pressed buttons, keyed by id with their words. */
export function Tabs({
  items,
  value,
  onChange,
  label,
  labels,
}: {
  items: readonly string[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  labels?: Readonly<Record<string, string>>;
}) {
  return (
    <SectionTabs label={label} value={value} onChange={onChange} items={items.map((id) => ({ value: id, label: labels?.[id] ?? id }))} />
  );
}

/** A modal dialog on the native element: focus stays inside, Escape and the backdrop close it, focus returns after. */
export function Dialog({ title, children, onClose }: { title: ReactNode; children: ReactNode; onClose: () => void }) {
  const { t, languageFor } = uiCopy.useCopy();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useModalDialog(ref);
  return (
    <dialog
      className="lt-sheet"
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="lt-sheet-head">
        <h2 id={titleId} className="lt-sheet-title">
          {title}
        </h2>
        <Button tone="quiet" aria-label={t('closeDialog')} lang={languageFor('closeDialog')} onClick={onClose}>
          ×
        </Button>
      </header>
      <div className="lt-sheet-body">{children}</div>
    </dialog>
  );
}

/** A service's refusal in plain words, with Try again only where a second attempt can change it. */
export function Failure({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
  const w = useFailureWords(result, Boolean(retry));
  if (isVerifyFirst(result)) return <VerifyFirstNote code={result.code} />;
  return (
    <div data-testid="failure" className="lt-refusal" role={w.alert ? 'alert' : 'status'}>
      <h3 className="lt-refusal-title">{w.title}</h3>
      <p className="lt-refusal-body" lang={w.bodyLang}>
        {w.body}
      </p>
      {w.action && (
        <a className="lt-link" href={w.action.href}>
          {w.action.label}
        </a>
      )}
      {w.reference && <small className="lt-ref">{w.reference}</small>}
      {w.retry && retry && (
        <Button tone="secondary" onClick={retry}>
          {w.retry}
        </Button>
      )}
    </div>
  );
}
