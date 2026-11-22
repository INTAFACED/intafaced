import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import type { Resource } from '../../../shared/resource';
import type { ApiResult } from '../../../shared/api';
import { useFailureWords } from '../../../shared/failure-words';
import { t as copyText } from '../copy';

/* The Repeat buy room's own parts, drawn on the kit: a read's states, a titled lane and a bounded list's more. */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** A failed read, in the words the shared failure line gives, with its try-again. */
function FailureNote({ result, retry }: { result: Failed; retry?: () => void }) {
  const w = useFailureWords(result, Boolean(retry));
  return (
    <div data-testid="failure" role={w.alert ? 'alert' : 'status'}>
      <h3>{w.title}</h3>
      <p lang={w.bodyLang}>{w.body}</p>
      {w.action && (
        <a className="lt-link" href={w.action.href}>
          {w.action.label}
        </a>
      )}
      {w.reference && <small>{w.reference}</small>}
      {w.retry && retry && (
        <Button tone="secondary" onClick={retry}>
          {w.retry}
        </Button>
      )}
    </div>
  );
}

/** A read: the skeleton while it loads, the failure line if it failed, else what it read. */
export function Read<T>({ resource, reload, children }: { resource: Resource<T>; reload: () => void; children: (data: T) => ReactNode }) {
  if (resource.status === 'loading') return <Skeleton shape="rows" count={3} />;
  if (resource.status === 'failed') return <FailureNote result={resource.failure} retry={reload} />;
  return <>{children(resource.data)}</>;
}

/** A titled part of the room with its own refresh. */
export function Lane({
  lane,
  title,
  description,
  actions,
  children,
}: {
  /** Which of the room's two lanes: setting a rule up, or the rules already set. */
  lane: 'setup' | 'rules';
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-repeat-lane={lane}>
      <header>
        <div>
          <h2>{title}</h2>
          {description && <p className="lt-hint">{description}</p>}
        </div>
        {actions && <div className="lt-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** How many records a bounded read returned, and the way to ask for more. */
export function More({ count, limit, onMore }: { count: number; limit: number; onMore: () => void }) {
  return (
    <div>
      <span>
        {count}
        {copyText('components.records.returned.requested.limit')}.{' '}
        {count >= limit
          ? limit < 200
            ? copyText('components.more.records.may.exist')
            : copyText('components.this.service.has.no.continuation.beyond.200')
          : copyText('components.this.list.has.no.total.count.or')}
      </span>
      {count >= limit && limit < 200 && (
        <Button tone="secondary" onClick={onMore}>
          {copyText('components.load.up.to')}
          {Math.min(200, limit + 50)}
        </Button>
      )}
    </div>
  );
}
