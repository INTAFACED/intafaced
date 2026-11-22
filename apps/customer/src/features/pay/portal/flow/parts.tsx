import { useContext, useId, useState, type ReactNode } from 'react';
import { useRelease } from '../../../../shared/outside';
import { Button, EmptyState, RefusalBox, Select, Tag } from '@intafaced/ui/lit';
import { Skeleton, Table, type Column } from '@intafaced/ui/lit/templates';
import { formatDateTime, formatDay, formatMoney, isRounded } from '../ui/format';
import { parseAmount } from '../../../../shared/money';
import type { Resource } from '../../../../shared/resource';
import { useExactMoneyScope } from '../ui/ExactMoneyScope';
import { activeHalts } from '../model';
import type { HaltScope, HaltStatus } from '../schemas';
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

/** A summary line of key facts: label and value pairs, on the kit's key-value rows. Journeys find it as `dl[data-testid="pp-facts"] > div`. */
export function Facts({ items }: { items: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl data-testid="pp-facts" className="lt-kv">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Loading and refusal for one read that is not a list. */
export function Gate<T>({
  resource,
  retry,
  rows,
  children,
}: {
  resource: Resource<T>;
  retry: () => void;
  rows?: number;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'loading') return <Loading rows={rows} />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={retry} />;
  return <>{children(resource.data)}</>;
}

/** A link drawn as the kit's button (the portal's `LinkButton`). */
export function LinkButton({
  href,
  children,
  variant = 'secondary',
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <a className="lt-button" data-slot="button" data-variant={variant} data-tone={variant} data-size="md" role="link" href={href}>
      {children}
    </a>
  );
}

/** The portal's TEST mark on a value nobody may take for real. */
export function TestTag() {
  const { t } = portalCopy.useCopy();
  return <Tag title={t('testValueTip')}>{t('testValue')}</Tag>;
}

/** A figure or setting nobody has configured. It is never a zero and never a default. */
export function NotConfigured({ children }: { children?: ReactNode }) {
  const { t } = portalCopy.useCopy();
  return <span className="lt-hint">{children ?? t('notConfigured')}</span>;
}

function isZero(value: string): boolean {
  try {
    return parseAmount(value) === 0n;
  } catch {
    return false;
  }
}

/**
 * An amount with its asset code on one line (the portal's `MoneyText`, same words and rules): every digit inside a
 * review (`ExactMoneyScope`), elsewhere a rounded figure carries the exact one in its tooltip; `test` marks sandbox money.
 */
export function MoneyText({
  value,
  asset,
  hideZero = false,
  test = false,
  sign,
}: {
  value: string;
  asset: string;
  hideZero?: boolean;
  test?: boolean;
  sign?: 'minus' | 'plus';
}) {
  const { t } = uiCopy.useCopy();
  const exactScope = useExactMoneyScope();
  if (hideZero && isZero(value)) return null;
  const text = formatMoney(value, asset, { exact: exactScope, sign });
  const rounded = !exactScope && isRounded(value, asset);
  const exactTag = exactScope && isRounded(value, asset);
  return (
    <span className="lt-mono" data-money="" title={rounded ? `${formatMoney(value, asset, { exact: true })} ${asset}` : undefined}>
      {text} <span lang="zxx">{asset}</span>
      {exactTag && <span> ({t('exactTag')})</span>}
      {test && (
        <>
          {' '}
          <Tag title={t('testTip')}>{t('testTag')}</Tag>
        </>
      )}
    </span>
  );
}

/** Operation pauses: which operation is paused and since when. An unreadable pause store counts as paused. */
export function HaltBanner({ resource, scopes }: { resource: Resource<HaltStatus>; scopes: readonly HaltScope[] }) {
  const { t } = portalCopy.useCopy();
  if (resource.status === 'loading') return null;
  const parked = (title: string, body: ReactNode = null, key?: string) => (
    <RefusalBox key={key} role={undefined} refusal={{ variant: 'parked', title, body: '' }}>
      {body}
    </RefusalBox>
  );
  // A refused or failed read (a team member's read is refused too) is not "nothing is paused": say we could not check.
  if (resource.status === 'failed')
    return (
      <div role="alert" data-halt="">
        {parked(t('haltCheckFailed', { ops: scopes.map((s) => t(`haltOpName_${s}` as 'haltOpName_intake')).join(t('haltOr')) }))}
      </div>
    );
  const { unreadable, halts } = activeHalts(resource.data, scopes);
  if (unreadable)
    return (
      <div role="alert" data-halt="">
        {parked(t('haltUnreadable'))}
      </div>
    );
  if (halts.length === 0) return null;
  return (
    <div role="alert" data-halt="">
      {halts.map((h) => {
        const where =
          h.level === 'merchant' ? t('haltYours') : h.level === 'rail' ? t('haltRail', { rail: h.railId ?? '' }) : t('haltGlobal');
        return parked(
          `${t(`haltOp_${h.scope}` as 'haltOp_intake')} ${where}`,
          <p>
            {h.changedAt ? (
              <>
                {t('haltSince')} <DateTime value={h.changedAt} />.{' '}
              </>
            ) : null}
            {t('haltEffect')}
          </p>,
          `${h.scope}:${h.level}:${h.railId ?? ''}`,
        );
      })}
    </div>
  );
}
