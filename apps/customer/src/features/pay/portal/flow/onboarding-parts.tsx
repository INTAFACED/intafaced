import type { ReactNode } from 'react';
import { Button, Field, RefusalBox } from '@intafaced/ui/lit';
import type { ApiResult } from '../../../../shared/api';
import { portalCopy, type PlainKey } from '../copy';
import { uiCopy } from '../ui/copy';
import { chips, type ChipKind, type Tone } from '../ui/status-vocabulary';
import type { ListState } from '../hooks';
import { refusalText } from '../refusal';
import { stepUpCopy } from '../access/step-up-copy';
import type { DestinationProof } from '../access/destination-step-up';
import { accountCopy } from '../settings/account/copy';
import { DateTime, Empty, Failure, Loading } from './parts';

/**
 * The onboarding room's kit views of the portal parts `./parts.tsx` does not hold: the not-live blocker
 * (`settings/account/ui.tsx`'s `Blocker`), the status chip (`components.tsx`'s `Chip`), a timeline, a list's loading,
 * refusal and empty states and its Load more (`ListShell`, `MoreFooter`), the destination step-up inside a review
 * (`access/DestinationConfirm.tsx`) and the team member's "the owner sets up" page (`OwnerSetsUp`). Each keeps the ids,
 * words and behaviour its original had; only the drawing is the kit's.
 */
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * A part of a page that cannot work yet, for a reason outside the page. `reason` names what it is waiting for; `needs`
 * is the service read it waits for: never shown, listed on the review board. It is never a fake row.
 */
export function Blocker({ reason, title, needs, children }: { reason: string; title?: string; needs?: string; children?: ReactNode }) {
  return (
    <RefusalBox
      data-testid="pfo-soon"
      role={undefined}
      aria-label={title ?? reason}
      data-needs={needs}
      refusal={{ variant: 'parked', title: reason, body: title ?? '' }}
    >
      {children && <p>{children}</p>}
    </RefusalBox>
  );
}

const statusOf: Record<Tone, 'done' | 'pending' | 'failed' | undefined> = {
  good: 'done',
  attention: 'pending',
  bad: 'failed',
  neutral: undefined,
};

/** A record's status in its plain word (the portal's status vocabulary), the kit's chip backing it up. */
export function Chip({ kind, value }: { kind: ChipKind; value: string }) {
  const { t } = portalCopy.useCopy();
  const legacy = (chips as Record<string, Record<string, readonly [PlainKey, PlainKey, Tone]>>)[kind]?.[value];
  // A status the vocabulary has not met is shown as the service sent it, in the quiet tone, never hidden.
  const label = legacy ? t(legacy[0]) : value;
  const tip = legacy ? t(legacy[1]) : undefined;
  return (
    <span
      data-testid="pp-chip"
      className="lt-chip"
      data-status={legacy ? statusOf[legacy[2]] : undefined}
      title={tip}
      aria-label={tip ? `${label} (${tip})` : undefined}
    >
      <span className="lt-chip-mark" aria-hidden="true" />
      {label}
    </span>
  );
}

/** `at` is left out when the service does not record when it happened; the page then says so instead of guessing. */
export type TimelineItem = { at?: string; title: string; detail?: string };

/** Events in the page's order, each with its time, on the kit's step rows. */
export function Timeline({ items, label }: { items: readonly TimelineItem[]; label: string }) {
  const { t } = uiCopy.useCopy();
  return (
    <ol className="lt-steps" aria-label={label}>
      {items.map((item, i) => (
        <li key={`${item.at ?? 'unrecorded'}:${i}`} className="lt-step" data-step="done">
          <span className="lt-step-dot" aria-hidden="true" />
          <div>
            <strong>{item.title}</strong>
            {item.detail && <p className="lt-hint">{item.detail}</p>}
          </div>
          <small className="lt-step-at">{item.at ? <DateTime value={item.at} /> : t('timeNotRecorded')}</small>
        </li>
      ))}
    </ol>
  );
}

/** A list's loading, refusal and empty states; its rows once there are some. */
export function ListShell<T>({
  state,
  empty,
  retry,
  children,
}: {
  state: ListState<T>;
  empty: { title: string; body: string; action?: ReactNode };
  retry: () => void;
  children: (items: T[]) => ReactNode;
}) {
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'failed') return <Failure result={state.failure} retry={retry} />;
  if (state.items.length === 0) return <Empty title={empty.title} body={empty.body} action={empty.action} />;
  return <>{children(state.items)}</>;
}

/** Row count and "Load more". The count says "so far" while another page exists, so it is never read as a total. */
export function MoreFooter<T>({ state, onMore }: { state: Extract<ListState<T>, { status: 'ready' }>; onMore: () => void }) {
  const { t } = portalCopy.useCopy();
  const failed = typeof state.more === 'object';
  return (
    <div className="lt-actions">
      <p className="lt-hint" role="status">
        {state.hasMore ? t('rowsSoFar', { count: state.items.length }) : t('rowsAll', { count: state.items.length })}
      </p>
      {state.hasMore && (
        <Button tone="secondary" onClick={onMore} disabled={state.more === 'loading'}>
          {state.more === 'loading' ? t('loadingMore') : failed ? t('tryAgain') : t('loadMore')}
        </Button>
      )}
      {failed && <p role="alert">{refusalText(state.more as Failed)}</p>}
    </div>
  );
}

/**
 * Inside the destination review: the authenticator code, or a passkey instead. The review's own button then confirms
 * and saves in one go. The code is the owner's to type each time: it is cleared after every try, right or wrong.
 */
export function DestinationConfirm({ proof, onChange }: { proof: DestinationProof; onChange: (proof: DestinationProof) => void }) {
  const { t } = stepUpCopy.useCopy();
  if (!('code' in proof))
    return (
      <div data-testid="form-stack">
        <p className="lt-hint">{t('suDestinationPasskey')}</p>
        <Button tone="quiet" onClick={() => onChange({ code: '' })}>
          {t('suOr')}
        </Button>
      </div>
    );
  return (
    <div data-testid="form-stack">
      <Field
        label={`${t('suCode')} *`}
        name="destination-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={proof.code}
        hint={t('suWhyDestination')}
        onChange={(event) => onChange({ code: event.target.value.replace(/\D/g, '').slice(0, 6) })}
        data-security-sensitive="true"
      />
      <Button tone="quiet" onClick={() => onChange({ passkey: true })}>
        {t('suPasskey')}
      </Button>
    </div>
  );
}

/** Setup belongs to the account owner. A team member who opens it is told so, instead of being led into steps they cannot finish. */
export function OwnerSetsUp() {
  const { t } = accountCopy.useCopy();
  return <Empty title={t('ownerSetsUpTitle')} body={t('ownerSetsUpBody')} />;
}
