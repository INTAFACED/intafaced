import { useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { Button, EmptyState, RefusalBox, Tag } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../../shared/api';
import { portalCopy } from '../copy';
import { uiCopy } from '../ui/copy';
import { mc } from '../money/copy';
import { useTestMode } from '../money/common';
import { RefusalOnce } from '../refusal-once';
import { isNotLive, notLiveReason, refusalText, refusalTitle } from '../refusal';

/**
 * The merchant portal's flow rooms draw their shared parts from the kit, here: one section, a refusal, a not-live card,
 * a loading ghost, the test-money note and a reference to copy. Each keeps the ids and words its portal original had,
 * so the journeys and unit tests that find them by those still do.
 */
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** One part of a page: its heading, a line on what it is for, an optional action, and its body. */
export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-testid="pay-section">
      <header>
        <h2>{title}</h2>
        {description && <p className="lt-hint">{description}</p>}
        {action}
      </header>
      {children}
    </section>
  );
}

/** While a read is on its way: the shape of what is coming, announced once. */
export function Loading({ rows = 3, label }: { rows?: number; label?: string }) {
  const { t } = portalCopy.useCopy();
  return (
    <div data-slot="state-block" data-kind="loading" role="status" aria-busy="true" aria-label={label ?? t('loading')}>
      <Skeleton shape="rows" count={rows} />
    </div>
  );
}

/** A part that is not live yet: a calm card naming what it waits for (the portal's not-live card, on the kit). */
export function NotLive({ reason, title, children }: { reason: string; title?: string; children?: ReactNode }) {
  return (
    <RefusalBox
      data-testid="pfo-soon"
      role={undefined}
      aria-label={title ?? reason}
      refusal={{ variant: 'parked', title: reason, body: title ?? '' }}
    >
      {children && <p>{children}</p>}
    </RefusalBox>
  );
}

/**
 * A refusal in plain words. When the service has not switched the feature on, it is the not-live card instead: pass
 * `notLive` to word it for the page. The same refusal, twice on one page, is said once.
 */
export function Failure({ result, retry, notLive }: { result: Failed; retry?: () => void; notLive?: string }) {
  const { t } = portalCopy.useCopy();
  const { t: u } = uiCopy.useCopy();
  const once = useContext(RefusalOnce);
  const id = useId();
  const key = `${refusalTitle(result)}|${refusalText(result)}`;
  useEffect(() => () => once?.release(key, id), [once, key, id]);
  if (isNotLive(result)) return <NotLive reason={notLive ?? notLiveReason(result)} />;
  if (once && !once.claim(key, id)) return null;
  return (
    <RefusalBox
      data-testid="failure"
      role={result.reason === 'uncertain' ? 'alert' : 'status'}
      refusal={{
        variant: result.reason === 'unreachable' ? 'unreachable' : 'refused',
        title: refusalTitle(result),
        body: refusalText(result),
      }}
    >
      {result.requestId && (
        <p>
          {u('reference')} <CopyReference value={result.requestId} what={u('reference')} />
        </p>
      )}
      {result.reason === 'unauthorized' ? (
        <a
          className="lt-link"
          href={`/login?redirect=${encodeURIComponent(typeof location === 'undefined' ? '/pay/merchant' : location.pathname + location.search)}`}
        >
          {t('signIn')}
        </a>
      ) : (
        // Asking again never turns a "you may not" into a "yes", so a refusal for permission has no Try again.
        retry &&
        result.reason !== 'uncertain' &&
        result.reason !== 'forbidden' && (
          <Button tone="secondary" onClick={retry}>
            {t('tryAgain')}
          </Button>
        )
      )}
    </RefusalBox>
  );
}

/** Nothing here yet, with at most one next step. */
export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return <EmptyState data-slot="state-block" data-kind="empty" title={title} body={body} action={action} />;
}

/** The note a business on test money sees at the top of a money page. */
export function TestBanner() {
  const { t } = mc.useCopy();
  const { t: p } = portalCopy.useCopy();
  if (!useTestMode()) return null;
  return (
    <p role="note">
      <Tag title={p('testValueTip')}>{p('testValue')}</Tag> {t('mnTestBanner')}
    </p>
  );
}

/** An ID the merchant may need to quote. Copying says it worked, or says it didn't, to everyone including screen readers. */
export function CopyReference({ value, what }: { value: string; what?: string }) {
  const { t } = uiCopy.useCopy();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <span>
      <code className="lt-mono">{value}</code>{' '}
      <Button
        tone="quiet"
        aria-label={what ? t('copyLabel', { what }) : undefined}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState('copied');
          } catch {
            setState('failed');
          }
        }}
      >
        {t('copy')}
      </Button>
      <span role={state === 'failed' ? 'alert' : 'status'}>
        {state === 'copied' ? t('copied') : state === 'failed' ? t('copyFailed') : ''}
      </span>
    </span>
  );
}

/** A form's button row. */
export function Actions({ children }: { children: ReactNode }) {
  return <div className="lt-actions">{children}</div>;
}
