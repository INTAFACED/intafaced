import { useSyncExternalStore, type ReactNode } from 'react';
import type { ApiResult } from '../../../../shared/api';
import { uiCopy as sharedUi, uiMessage } from '../../../../shared/ui-copy';
import { Button } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { payAuthoredMessage, payCopy } from '../../copy';
import type { MoneyKind } from '../access/money-step';
import { payStepUp } from '../access/step-up-store';
import { stepUpCopy } from '../access/step-up-copy';
import { useNow } from '../hooks';
import { ExactMoneyScope } from '../ui/ExactMoneyScope';
import { usePortalReview } from '../ui/PortalReview';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** How long "Confirm it's you" still holds for money out, while the review is open. */
function StepUpNote({ kind }: { kind: MoneyKind }) {
  const { t } = stepUpCopy.useCopy();
  useSyncExternalStore(payStepUp.subscribe, payStepUp.getSnapshot, payStepUp.getSnapshot);
  useNow(15_000);
  const minutes = payStepUp.minutesLeft(kind);
  if (minutes === null) return null;
  return (
    <p className="lt-hint" role="status">
      {minutes === 1 ? t('suNoteOne') : t('suNoteMany', { n: minutes })}
    </p>
  );
}

/** What the service said: confirmed, or a refusal in its own words (the words `PayFailure` says). */
function Outcome({ result, title, refreshed }: { result: ApiResult<unknown> | null; title: string; refreshed: boolean }) {
  const { t, languageFor, requestedLocale } = sharedUi.useCopy();
  payCopy.useCopy();
  if (!result) return null;
  if (result.ok)
    return (
      <p className="lt-hint" role="status">
        {payCopy.t(refreshed ? 'theServiceConfirmedTheAction' : 'theServiceConfirmedTheActionRefreshThe', { title })}
      </p>
    );
  const authored = payAuthoredMessage(result);
  const failed: Failed = authored === undefined ? result : { ...result, message: authored };
  return (
    <div lang={authored === undefined ? 'und' : requestedLocale} role={failed.reason === 'uncertain' ? 'alert' : 'status'}>
      <div data-slot="state-block" data-kind="refused" className="lt-refusal" data-refusal="refused">
        <h3 className="lt-refusal-title">{t(failed.reason)}</h3>
        <p className="lt-refusal-body">
          <span lang={failed.messageCopy ? languageFor(failed.messageCopy.key) : undefined}>
            {failed.messageCopy ? uiMessage(failed.messageCopy, requestedLocale) : failed.message}
          </span>
        </p>
        {failed.reason === 'unauthorized' ? (
          <a className="lt-link" href={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`}>
            {t('signIn')}
          </a>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The portal's one way to confirm something, drawn with the kit: a button that opens the review in the kit's sheet, and
 * the review's own confirm. It runs exactly the steps `PortalReview` runs (`usePortalReview`); every amount in the review
 * is exact (`ExactMoneyScope`).
 */
export function Review<T>({
  title,
  description,
  review,
  perform,
  onConfirmed,
  disabled = false,
  disabledReason,
  variant = 'secondary',
  stepUp,
  ready = true,
  notReadyReason,
}: {
  title: string;
  description: string;
  review?: ReactNode;
  perform: (currentReview: () => boolean) => Promise<ApiResult<T>>;
  onConfirmed?: (data: T) => void;
  disabled?: boolean;
  disabledReason?: string;
  variant?: 'primary' | 'secondary' | 'sell';
  stepUp?: MoneyKind;
  ready?: boolean;
  notReadyReason?: string;
}) {
  const { opened, busy, result, unknown, open, close, confirm } = usePortalReview<T>({ perform, onConfirmed, disabled, stepUp, ready });
  const tone = variant === 'secondary' ? 'secondary' : 'primary';
  const refreshed = Boolean(onConfirmed);
  return (
    <div title={disabled ? disabledReason : undefined}>
      <Button tone={tone} disabled={disabled || busy || unknown} onClick={open}>
        {title}
      </Button>
      <Outcome result={result} title={title} refreshed={refreshed} />
      {opened && (
        <Sheet open title={payCopy.t('review', { title })} onClose={close}>
          <div data-testid="form-stack">
            <p className="lt-hint">{description}</p>
            {review === undefined ? null : <ExactMoneyScope>{review}</ExactMoneyScope>}
            {stepUp && <StepUpNote kind={stepUp} />}
            <Outcome result={result} title={title} refreshed={refreshed} />
            {!ready && notReadyReason ? <p className="lt-hint">{notReadyReason}</p> : null}
            <Button tone={tone} disabled={!ready || busy || unknown} onClick={() => void confirm()}>
              {busy ? payCopy.t('waitingForConfirmation') : title}
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
