import { useLayoutEffect, useRef, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import type { MoneyKind } from './portal/access/money-step';
import { payStepUp } from './portal/access/step-up-store';
import { stepUpRequired, stepUpWords } from './portal/access/step-up-words';

/**
 * What a reviewed action does, without its look: open the review (asking "Confirm it's you" first for money out), send
 * once while the same review is open, and close on a yes or an unknown answer. `ReviewedAction` in `./components` draws it
 * with the old kit; `./volt/parts` and `portal/volt/Review.tsx` draw the same steps with the Volt kit, so both behave exactly alike.
 */
export function useReviewedAction<T>({
  perform,
  onConfirmed,
  disabled = false,
  stepUp,
  ready = true,
}: {
  perform: (currentReview: () => boolean) => Promise<ApiResult<T>>;
  onConfirmed?: (data: T) => void;
  disabled?: boolean;
  stepUp?: MoneyKind;
  ready?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiResult<T> | null>(null);
  const inFlight = useRef(false);
  const asking = useRef(false);
  const lifetime = useRef({ mounted: true, opened, disabled, ready, review: 0 });
  const reviewId = lifetime.current.review;
  useLayoutEffect(() => {
    lifetime.current.opened = opened;
    lifetime.current.disabled = disabled;
    lifetime.current.ready = ready;
  });
  useLayoutEffect(() => {
    lifetime.current.mounted = true;
    return () => {
      lifetime.current.mounted = false;
    };
  }, []);
  const currentReview = () => lifetime.current.mounted && lifetime.current.opened && lifetime.current.review === reviewId;
  async function confirm() {
    if (inFlight.current || !currentReview() || lifetime.current.disabled || !lifetime.current.ready) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const outcome = stepUp ? await payStepUp.run(stepUp, () => perform(currentReview), stepUpWords) : await perform(currentReview);
      if (!currentReview()) return;
      setResult(outcome);
      if (outcome.ok) {
        lifetime.current.opened = false;
        lifetime.current.review += 1;
        onConfirmed?.(outcome.data);
        setOpened(false);
      } else if (outcome.reason === 'uncertain') {
        // The answer is unknown: close the review so the recovery message and its check button are not covered.
        lifetime.current.opened = false;
        lifetime.current.review += 1;
        setOpened(false);
      }
    } finally {
      if (lifetime.current.mounted) setBusy(false);
      inFlight.current = false;
    }
  }
  function open() {
    if (!lifetime.current.mounted || lifetime.current.disabled || inFlight.current || asking.current) return;
    if (!stepUp) {
      lifetime.current.review += 1;
      setResult(null);
      setOpened(true);
      return;
    }
    // Money out: confirm it's them first, then show the review.
    asking.current = true;
    void payStepUp.ensure(stepUp).then((confirmed) => {
      asking.current = false;
      if (!lifetime.current.mounted || lifetime.current.disabled) return;
      if (!confirmed) {
        // Declining is the person's own choice and needs no message; a page with no one to ask says what is needed.
        setResult(payStepUp.canAsk ? null : stepUpRequired());
        return;
      }
      lifetime.current.review += 1;
      setResult(null);
      setOpened(true);
    });
  }
  function close() {
    if (!inFlight.current) {
      lifetime.current.opened = false;
      lifetime.current.review += 1;
      setOpened(false);
    }
  }
  /** The answer is unknown: nothing may be sent again until the person has checked. */
  const unknown = Boolean(result && !result.ok && result.reason === 'uncertain');
  return { opened, busy, result, unknown, open, close, confirm };
}
