import { type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, StatusChip } from '@intafaced/ui';
import { roomCopy } from './copy';
import { roomRefusal } from './refusals';
import type { Failure, WriteGuard } from './guard';
import type { Live } from './live';
import { isDevBuild } from '../../../app/feature-registry';
import { TradeSubNav } from '../TradeSubNav';
import './copybots.css';

/** The shared Trade sub-navigation, so every room stays one click away. */
export function ModeNav({ active }: { active: 'copy' | 'bots' }) {
  return <TradeSubNav active={active} className="px-0" />;
}

/** Where the data on this screen came from and how old it is. Turns Stale by itself; says Unknown before the first read. */
export function Freshness({ live, staleAfterMs }: { live: Pick<Live<unknown>, 'asOf' | 'failure' | 'status'>; staleAfterMs: number }) {
  const { t } = roomCopy.useCopy();
  if (live.status === 'loading') return <StatusChip kind="unknown" reason={t('Waiting for the first read')} />;
  if (live.asOf === null) {
    return <StatusChip kind="unknown" reason={t('Could not be read')} />;
  }
  return (
    <StatusChip
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
  if (isDevBuild()) return <Badge tone="warn">{t('TEST account: no real money')}</Badge>;
  return paper ? <Badge tone="warn">{t('Paper: no money moves')}</Badge> : <Badge tone="neutral">{t('Live account: real orders')}</Badge>;
}

/** A refusal in customer words. The raw code is only a small support reference; a service sentence is never shown. */
export function RefusalNote({ failure, retry }: { failure: Failure; retry?: () => void }) {
  const { t } = roomCopy.useCopy();
  const words = roomRefusal(failure);
  return (
    <div className="cb-note" role="alert" data-tone="warn">
      <AlertTriangle size={16} aria-hidden="true" />
      <div>
        <p className="cb-note-title">{words.title}</p>
        <p className="cb-note-body">{words.body}</p>
        {words.code ? <p className="cb-note-ref">{t('Reference {code}', { code: words.code })}</p> : null}
      </div>
      {retry ? (
        <Button variant="secondary" size={32} onClick={retry}>
          {t('Try again')}
        </Button>
      ) : null}
    </div>
  );
}

export function InfoNote({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warn' }) {
  return (
    <p className="cb-note" role="note" data-tone={tone}>
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
      <div className="cb-note" role="status">
        <div>
          <p className="cb-note-title">{t('Checked')}</p>
          <p className="cb-note-body">{verdict}</p>
        </div>
        <Button variant="secondary" size={32} onClick={onDismiss}>
          {t('Dismiss')}
        </Button>
      </div>
    );
  return (
    <div className="cb-note" role="alert" data-tone="warn">
      <AlertTriangle size={16} aria-hidden="true" />
      <div>
        <p className="cb-note-title">{t('An earlier request has no confirmed result')}</p>
        <p className="cb-note-body">
          {guard.pending
            ? t('New actions stay locked until we know what happened to request {id}.', { id: guard.pending.id })
            : t('New actions stay locked until your browser can keep a request safe.')}
        </p>
        {verdict ? <p className="cb-note-body">{verdict}</p> : null}
      </div>
      {guard.pending ? (
        <Button variant="secondary" size={32} onClick={check} disabled={checking}>
          {checking ? t('Checking') : t('Check what happened')}
        </Button>
      ) : null}
    </div>
  );
}

/** A labelled drop-down (the kit's Field wraps text boxes only). */
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
    <div className="cb-selectfield">
      <span className="cb-label">{label}</span>
      <Select
        items={options}
        value={value}
        onValueChange={(next) => {
          if (typeof next === 'string') onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
