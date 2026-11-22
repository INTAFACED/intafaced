import { useContext, useId, useState, type ReactNode } from 'react';
import { useRelease } from '../../../../shared/outside';
import { Button, EmptyState, RefusalBox, Select, Tag } from '@intafaced/ui/lit';
import { Skeleton, Table, type Column } from '@intafaced/ui/lit/templates';
import { formatDateTime, formatDay } from '../ui/format';
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
function NotLive({ reason, title, children }: { reason: string; title?: string; children?: ReactNode }) {
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
  useRelease(`${key}|${id}`, () => once?.release(key, id));
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
function CopyReference({ value, what }: { value: string; what?: string }) {
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

/** Every timestamp in the portal, in one format with its zone named; the tooltip holds the full date, time and zone. */
export function DateTime({ value, timeZone, dayOnly = false }: { value: string; timeZone?: string; dayOnly?: boolean }) {
  const { requestedLocale } = uiCopy.useCopy();
  const parts = formatDateTime(value, requestedLocale, timeZone);
  if (!parts) return <span lang="zxx">{value}</span>;
  return (
    <time dateTime={value} title={parts.full} lang={requestedLocale}>
      {dayOnly ? (formatDay(value, requestedLocale, timeZone) ?? parts.short) : parts.short}
    </time>
  );
}

export interface ListColumn<T> {
  header: string;
  cell: (row: T) => ReactNode;
  align?: 'start' | 'end';
  ltr?: boolean;
}

/**
 * Rows of records as a kit table in a named region (a stacked list on a phone). With `href`, each row ends in an Open
 * link to its record.
 */
export function List<T>({
  label,
  rows,
  rowKey,
  columns,
  href,
}: {
  label: string;
  rows: readonly T[];
  rowKey: (row: T) => string;
  columns: readonly ListColumn<T>[];
  href?: (row: T) => string;
}) {
  const { t } = uiCopy.useCopy();
  const cols: Column<T>[] = columns.map((c, i) => ({ key: String(i), label: c.header, cell: c.cell, align: c.align, ltr: c.ltr }));
  if (href)
    cols.push({
      key: 'open',
      label: t('open'),
      cell: (row) => (
        <a className="lt-link" href={href(row)}>
          {t('open')}
        </a>
      ),
    });
  return (
    <section data-testid="pe-table" role="region" aria-label={label}>
      <Table caption={label} columns={cols} rows={rows} rowKey={rowKey} />
    </section>
  );
}

/** A choice from a short list: the kit's select, answering with the chosen value. */
export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<readonly [string, string]>;
  hint?: string;
  disabled?: boolean;
}) {
  return <Select label={label} hint={hint} value={value} disabled={disabled} options={options} onChange={onChange} />;
}
