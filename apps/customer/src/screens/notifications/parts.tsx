import { Button, Tag } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';

/**
 * The notifications centre's read states, drawn with the Volt kit. Each keeps the words, roles and labels of the old kit's
 * StateBlock it stands in for: loading is a named busy status, a failed read is an alert with its Try again, a refusal shows
 * its reason, reference and action.
 */

/** A read on its way: a named, busy status over ghost rows. */
export function Loading({ label, rows }: { label: string; rows: number }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <Skeleton shape="rows" count={rows} />
    </div>
  );
}

/** A read that failed: its title and the button that reads it again. */
export function LoadFailed({ title, retryLabel, onRetry }: { title: string; retryLabel: string; onRetry: () => void }) {
  return (
    <div className="lt-refusal" role="alert">
      <p className="lt-refusal-title">{title}</p>
      <Button tone="secondary" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}

/** A read the platform refused, or a part not set up: why, the reference when there is one, and where to go. */
export function Refused({
  title,
  body,
  code,
  action,
}: {
  title: string;
  body: string;
  code?: string;
  action?: { label: string; href?: string; onClick?: () => void };
}) {
  return (
    <div className="lt-refusal">
      <p className="lt-refusal-title">{title}</p>
      <p className="lt-refusal-body">{body}</p>
      {action?.href ? (
        <a className="lt-button lt-button-secondary" href={action.href}>
          {action.label}
        </a>
      ) : action ? (
        <Button tone="secondary" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
      {code ? <small className="lt-ref">{code}</small> : null}
    </div>
  );
}

/** A record's state word; `ok` marks the good one (an active alert, a confirmed address, a handed-over message). */
export function StateTag({ ok, children, ...rest }: { ok?: boolean; children: string; 'data-testid'?: string }) {
  return (
    <Tag {...rest} tone={ok ? 'accent' : 'neutral'}>
      {children}
    </Tag>
  );
}
