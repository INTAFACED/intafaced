import type { ComponentProps } from 'react';
import { ReviewedAction } from '../../review/ReviewedAction';
import { ExactMoneyScope } from '../ui/ExactMoneyScope';
import { plainFailure } from '../refusal';

/**
 * The flow rooms' door for asking a merchant to confirm something: `ui/PortalReview.tsx`'s twin, drawn from the kit.
 * It wraps the kit's reviewed action (`../../review/ReviewedAction.tsx`, the same state as the old dialog) and puts the
 * review body inside `ExactMoneyScope`, so every amount in it is exact, and words a service code plainly. Only this
 * file and `ui/PortalReview.tsx` under `portal/` may import `ReviewedAction` (`exact-money.test.tsx`).
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
