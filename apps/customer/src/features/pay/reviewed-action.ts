import { useLayoutEffect, useRef, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import type { MoneyKind } from './portal/access/money-step';
import { payStepUp } from './portal/access/step-up-store';
import { stepUpRequired, stepUpWords } from './portal/access/step-up-words';

/**
 * The state behind a reviewed action (`ReviewedAction` in components.tsx, and the kit view of it in `p2p-flow/`): the
 * press opens the review (after "Confirm it's you" for money leaving), the review's confirm performs once, and a
 * closed or replaced review never takes an answer that arrives late. The views draw it; this holds what happens.
 */
export function useReviewedAction<T>({
  perform,
  onConfirmed,
  disabled,
  ready,
  stepUp,
}: {
  perform: (currentReview: () => boolean) => Promise<ApiResult<T>>;
  onConfirmed?: (data: T) => void;
  disabled: boolean;
  ready: boolean;
  stepUp?: MoneyKind;
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
  const uncertain = Boolean(result && !result.ok && result.reason === 'uncertain');
  return { opened, busy, result, uncertain, open, close, confirm };
}
