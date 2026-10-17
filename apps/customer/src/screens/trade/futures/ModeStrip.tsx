import { TradeSubNav } from '../TradeSubNav';

/** Kept so the Margin and Futures rooms import one name; the row itself is the shared Trade sub-navigation. */
export function ModeStrip({ active }: { active: 'Margin' | 'Futures' }) {
  return <TradeSubNav active={active === 'Margin' ? 'margin' : 'futures'} />;
}
