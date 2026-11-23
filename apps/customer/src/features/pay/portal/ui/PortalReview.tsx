import type { ComponentProps } from 'react';
import type { ApiResult } from '../../../../shared/api';
import { ReviewedAction, useReviewedAction } from '../../components';
import { ExactMoneyScope } from './ExactMoneyScope';
import { plainFailure } from '../refusal';

/**
 * The one way the portal asks a merchant to confirm something. It wraps the shared review dialog and puts the
 * review body inside `ExactMoneyScope`, so every amount in it is exact. No other file under `portal/` may import
 * `ReviewedAction` (a test enforces it).
 */
export function PortalReview<T>({ review, perform, ...rest }: ComponentProps<typeof ReviewedAction<T>>) {
  return (
    <ReviewedAction<T>
      {...rest}
      perform={async (current) => plainFailure(await perform(current))}
      review={review === undefined ? undefined : <ExactMoneyScope>{review}</ExactMoneyScope>}
    />
  );
}

/**
 * The same door for a page on its Volt template (`volt/Review.tsx` draws it with the kit): the review's steps exactly as
 * `PortalReview` runs them, with every refusal in plain words.
 */
export function usePortalReview<T>({
  perform,
  ...rest
}: Omit<Parameters<typeof useReviewedAction<T>>[0], 'perform'> & {
  perform: (currentReview: () => boolean) => Promise<ApiResult<T>>;
}) {
  return useReviewedAction<T>({ ...rest, perform: async (current) => plainFailure(await perform(current)) });
}
