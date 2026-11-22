import { type ReactNode } from 'react';
import { Button, Tag } from '@intafaced/ui/lit';
import { FreshnessChip, Select } from '@intafaced/ui/lit/templates';
import { roomCopy } from './copy';
import { roomRefusal } from './refusals';
import type { Failure, WriteGuard } from './guard';
import type { Live } from './live';
import { isDevBuild } from '../../../app/feature-registry';

/** Where the data on this screen came from and how old it is. Turns Stale by itself; says Unknown before the first read. */
export function Freshness({ live, staleAfterMs }: { live: Pick<Live<unknown>, 'asOf' | 'failure' | 'status'>; staleAfterMs: number }) {
  const { t } = roomCopy.useCopy();
  if (live.status === 'loading') return <FreshnessChip asOf={null} staleAfterMs={staleAfterMs} reason={t('Waiting for the first read')} />;
  if (live.asOf === null) {
    return <FreshnessChip asOf={null} staleAfterMs={staleAfterMs} reason={t('Could not be read')} />;
  }
  return (
    <FreshnessChip
      asOf={live.asOf}
      staleAfterMs={staleAfterMs}
      showAsOf
      reason={live.failure ? t('The last refresh failed; showing the previous read') : undefined}
    />
  );
}

/** Live money, paper or a TEST build, always visible next to the title (workspace safety, TRD-0090). The build decides: a local-test build never claims real orders. */
export function AccountBadge({ paper }: { paper: boolean }) {
  const { t } = roomCopy.useCopy();
  if (isDevBuild()) return <Tag tone="accent">{t('TEST account: no real money')}</Tag>;
  return paper ? <Tag tone="accent">{t('Paper: no money moves')}</Tag> : <Tag tone="neutral">{t('Live account: real orders')}</Tag>;
}

/** A refusal in customer words. The raw code is only a small support reference; a service sentence is never shown. */
export function RefusalNote({ failure, retry }: { failure: Failure; retry?: () => void }) {
  const { t } = roomCopy.useCopy();
  const words = roomRefusal(failure);
  return (
    <div className="lt-refusal" role="alert" data-refusal="refused">
      <div>
        <p className="lt-refusal-title">{words.title}</p>
        <p className="lt-refusal-body">{words.body}</p>
        {words.code ? <p className="lt-ref">{t('Reference {code}', { code: words.code })}</p> : null}
      </div>
      {retry ? <Button onClick={retry}>{t('Try again')}</Button> : null}
    </div>
  );
}

export function InfoNote({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warn' }) {
  return (
    <p className="lt-hint" role="note" data-tone={tone}>
      <span>{children}</span>
    </p>
  );
}

/**
 * Shown while an earlier write has no confirmed outcome. New writes stay locked. "Check" asks the service what
 * happened to that exact request (a follow in the list, a schedule by its ID); only a definite answer unlocks.
 */
export function PendingBanner({
  guard,
  check,
  checking,
  verdict,
  onDismiss,
}: {
  guard: WriteGuard;
  check: () => void;
  checking: boolean;
  verdict: string | null;
  onDismiss: () => void;
}) {
  const { t } = roomCopy.useCopy();
  if (!guard.locked && !verdict) return null;
  if (!guard.locked)
    return (
      <div className="lt-empty" role="status">
        <div>
          <p className="lt-empty-title">{t('Checked')}</p>
          <p className="lt-empty-body">{verdict}</p>
        </div>
        <Button onClick={onDismiss}>{t('Dismiss')}</Button>
      </div>
    );
  return (
    <div className="lt-refusal" role="alert" data-refusal="refused">
      <div>
        <p className="lt-refusal-title">{t('An earlier request has no confirmed result')}</p>
        <p className="lt-refusal-body">
          {guard.pending
            ? t('New actions stay locked until we know what happened to request {id}.', { id: guard.pending.id })
            : t('New actions stay locked until your browser can keep a request safe.')}
        </p>
        {verdict ? <p className="lt-refusal-body">{verdict}</p> : null}
      </div>
      {guard.pending ? (
        <Button onClick={check} disabled={checking}>
          {checking ? t('Checking') : t('Check what happened')}
        </Button>
      ) : null}
    </div>
  );
}

/** A labelled drop-down: the kit's Select, its label shown above it and carried by the combobox. */
export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="lt-field">
      <span aria-hidden="true">{label}</span>
      <Select label={label} value={value} options={options} placeholder={placeholder} disabled={disabled} onChange={onChange} />
    </div>
  );
}
