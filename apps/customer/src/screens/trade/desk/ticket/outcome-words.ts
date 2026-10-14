import type { Order } from '../../../../features/trade/trade-api';
import type { ItemOutcome } from './scale-flow';
import type { ticketCopy } from './copy';

type Words = ReturnType<typeof ticketCopy.useCopy>['t'];

/** What happened to an order the service knows, in a word. Only open and filled orders are "in". */
export function orderWord(order: Order, t: Words): string {
  switch (order.status) {
    case 'open':
      return t('Scale result placed');
    case 'closed':
      return t('Scale result filled');
    case 'rejected':
      return order.postOnly ? t('Scale result rejected post-only') : t('Scale result rejected');
    default:
      return t('Scale result ended');
  }
}

/** The result column of a sent batch, one order at a time. `refusedWords` turns a refusal code into plain words. */
export function itemWord(item: ItemOutcome, t: Words, refusedWords: (code: string | null) => string): string {
  if (item.kind === 'placed' || item.kind === 'rejected' || item.kind === 'ended') return orderWord(item.order, t);
  if (item.kind === 'refused') return refusedWords(item.code);
  return t('Scale result unsure');
}
