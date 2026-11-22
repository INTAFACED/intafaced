import { useSyncExternalStore, type ReactNode } from 'react';
import { Button, RefusalBox, ReviewSheet } from '@intafaced/ui/lit';
import type { ApiResult } from '../../../shared/api';
import { uiCopy, uiMessage } from '../../../shared/ui-copy';
import { payAuthoredMessage, payCopy } from '../copy';
import { useReviewedAction } from '../reviewed-action';
import type { MoneyKind } from '../portal/access/money-step';
import { payStepUp } from '../portal/access/step-up-store';
import { stepUpCopy } from '../portal/access/step-up-copy';
import { useNow } from '../portal/hooks';

/**
 * The kit views of Pay's reviewed action and what it answers (`../components.tsx`'s `ReviewedAction`,
 * `MutationResult` and `PayFailure`): the same words, states and handlers, drawn only from `@intafaced/ui/lit`. The
 * state is `useReviewedAction` (`../reviewed-action.ts`), the one the old view runs, so a press opens the review once
 * (after "Confirm it's you" for money leaving) and its confirm performs once. The person-to-person rooms and the
 * merchant portal's flow rooms both draw their confirmations here.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

function FailureView({ result, retry }: { result: Failed; retry?: () => void }) {
  const { t, languageFor, requestedLocale } = uiCopy.useCopy();
  const signIn = result.reason === 'unauthorized';
  return (
    <div role={result.reason === 'uncertain' ? 'alert' : 'status'}>
      <div lang={result.messageCopy ? languageFor(result.messageCopy.key) : undefined}>
        <RefusalBox
          refusal={{
            variant: 'refused',
            title: t(result.reason),
            body: result.messageCopy ? uiMessage(result.messageCopy, requestedLocale) : result.message,
            ...(signIn
              ? { action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(location.pathname + location.search)}` } }
              : {}),
          }}
        />
      </div>
      {!signIn && retry && result.reason !== 'uncertain' ? <Button onClick={retry}>{t('retry')}</Button> : null}
    </div>
  );
}

/** `PayFailure`: a refused or failed call, in the service's authored words when it has them. */
export function PayFailure({ result, retry }: { result: Failed; retry?: () => void }) {
  const { requestedLocale } = payCopy.useCopy();
  const authored = payAuthoredMessage(result);
  return (
    <div lang={authored === undefined ? 'und' : requestedLocale}>
      <FailureView result={authored === undefined ? result : { ...result, message: authored }} retry={retry} />
    </div>
  );
}

/** `MutationResult`: what the service said to an action. `refreshed`: the page already shows the new state itself. */
export function MutationResult({
  result,
  title,
  refreshed = false,
}: {
  result: ApiResult<unknown> | null;
  title: string;
  refreshed?: boolean;
}) {
  if (!result) return null;
  return result.ok ? (
    <p role="status">{payCopy.t(refreshed ? 'theServiceConfirmedTheAction' : 'theServiceConfirmedTheActionRefreshThe', { title })}</p>
  ) : (
    <PayFailure result={result} />
  );
}

/** How long the "Confirm it's you" just given still covers this kind of money (the old view's `StepUpNote`). */
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

/**
 * `ReviewedAction`: the press opens a review sheet (the kit's `ReviewSheet`); its button performs once. With `stepUp`
 * (money leaving the account) the press first asks "Confirm it's you", and the review says how long that lasts.
 */
export function ReviewedAction<T>({
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
  variant?: 'primary' | 'secondary';
  /** Money leaving the account: see `../components.tsx`'s `ReviewedAction`. */
  stepUp?: MoneyKind;
  ready?: boolean;
  notReadyReason?: string;
}) {
  const { opened, busy, result, uncertain, open, close, confirm } = useReviewedAction({ perform, onConfirmed, disabled, ready, stepUp });
  const outcome = <MutationResult result={result} title={title} refreshed={Boolean(onConfirmed)} />;
  return (
    <ReviewSheet
      label={title}
      reviewTitle={payCopy.t('review', { title })}
      description={description}
      tone={variant}
      disabled={disabled}
      disabledReason={disabledReason}
      opened={opened}
      busy={busy}
      busyLabel={payCopy.t('waitingForConfirmation')}
      blocked={uncertain}
      ready={ready}
      notReadyReason={notReadyReason}
      onOpen={open}
      onClose={close}
      onConfirm={() => void confirm()}
      outcome={outcome}
      note={stepUp ? <StepUpNote kind={stepUp} /> : undefined}
    >
      {review}
    </ReviewSheet>
  );
}
