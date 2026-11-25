import { Button } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';

/**
 * A live read's own waiting and failed lines, inside a developer room on its template: the skeleton while it loads (named
 * for a screen reader), and the failure with its retry, both drawn from the Volt kit. The room around them keeps drawing.
 */
export function ReadLoading({ label, rows }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} data-kind="loading">
      <Skeleton shape="rows" count={rows} />
    </div>
  );
}

export function ReadFailed({ title, onRetry, retryLabel }: { title: string; onRetry: () => void; retryLabel: string }) {
  return (
    <div role="alert" data-kind="error">
      <p>{title}</p>
      <Button tone="secondary" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}
