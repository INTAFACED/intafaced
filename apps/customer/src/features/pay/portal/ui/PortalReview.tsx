import type { ComponentProps } from 'react';
import { ReviewedAction } from '../../components';
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
