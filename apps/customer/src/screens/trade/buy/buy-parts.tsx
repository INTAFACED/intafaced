import { Button, EmptyState, Freshness, RefusalBox } from '@intafaced/ui/lit';
import { buyCopy } from './copy';

/**
 * The card's and the orders list's states, drawn from the kit: what the old StateBlock said, word for word. `error`
 * offers Try again (a kit Button), `refused` gives the service's title, body, code and next step, `empty` says so with
 * at most one link. `data-kind` names which, as the old block did.
 */
export type StateNoteProps =
  | { kind: 'error'; title: string; onRetry: () => void; retryLabel: string; 'data-testid'?: string }
  | {
      kind: 'refused';
      title: string;
      body: string;
      code?: string | null;
      action?: { label: string; href: string };
      'data-testid'?: string;
    }
  | { kind: 'empty'; title: string; body?: string; action?: { label: string; href: string }; 'data-testid'?: string };

export function StateNote(props: StateNoteProps) {
  const testId = props['data-testid'];
  if (props.kind === 'error')
    return (
      <RefusalBox refusal={{ variant: 'unreachable', title: props.title, body: '' }} role="alert" data-kind="error" data-testid={testId}>
        <Button onClick={props.onRetry}>{props.retryLabel}</Button>
      </RefusalBox>
    );
  if (props.kind === 'refused')
    return (
      <RefusalBox
        refusal={{
          variant: 'refused',
          title: props.title,
          body: props.body,
          ...(props.code ? { reference: props.code } : {}),
          ...(props.action ? { action: props.action } : {}),
        }}
        data-kind="refused"
        data-testid={testId}
      />
    );
  return (
    <EmptyState
      title={props.title}
      body={props.body}
      data-kind="empty"
      data-testid={testId}
      action={
        props.action ? (
          <a className="lt-link" href={props.action.href}>
            {props.action.label}
          </a>
        ) : undefined
      }
    />
  );
}

/**
 * Freshness of a figure: the kit's Live, Stale or Unknown with its as-of time; a source that refused says Refused, with
 * its reason in words beside it, as the old chip did.
 */
export function FreshWord({
  asOf,
  staleAfterMs,
  refused = false,
  reason,
  'data-testid': testId,
}: {
  asOf: number | null;
  staleAfterMs: number;
  refused?: boolean;
  reason?: string;
  'data-testid'?: string;
}) {
  const { t } = buyCopy.useCopy();
  if (refused)
    return (
      <span role="status" data-testid={testId} data-freshness="refused" title={reason}>
        {t('Fresh refused')}
        {reason ? ` · ${reason}` : null}
      </span>
    );
  return (
    <span data-testid={testId}>
      <Freshness
        asOf={asOf}
        staleAfterMs={staleAfterMs}
        reason={reason}
        words={{ live: t('Fresh live'), stale: t('Fresh stale'), unknown: t('Fresh unknown'), asOf: t('Fresh as of') }}
      />
    </span>
  );
}
