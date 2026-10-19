import { deskCopy } from './copy';
import { fmtAmount, fmtPrice } from './deps';
import type { DeskMarket } from './market';
import type { Problem } from './order-math';
import { placesOf } from './text';

/** A client-side order check failure as words (the rules the market publishes, before anything is sent). */
export function problemText(problem: Problem, market: DeskMarket, t: ReturnType<typeof deskCopy.useCopy>['t']): string {
  switch (problem.kind) {
    case 'amountEmpty':
      return t('Enter an amount');
    case 'priceEmpty':
      return t('Enter a price');
    case 'stopEmpty':
      return t('Enter a stop price');
    case 'stopTick':
      return t('Stop price must be a whole number of steps', { tick: fmtPrice(problem.tick, problem.tick), asset: market.quote });
    case 'amountLot':
      return t('Amount must be a whole number of steps', {
        lot: fmtAmount(problem.lot, { places: placesOf(problem.lot) }),
        asset: market.base,
      });
    case 'amountMin':
      return t('Amount too small', { min: fmtAmount(problem.min, { places: placesOf(market.lotSize) }), asset: market.base });
    case 'priceTick':
      return t('Price must be a whole number of steps', { tick: fmtPrice(problem.tick, problem.tick), asset: market.quote });
    case 'valueMin':
      return t('Value too small', { min: fmtAmount(problem.min, { places: 8 }), asset: market.quote });
    case 'noPrice':
      return t('No prices to judge a market order');
  }
}
