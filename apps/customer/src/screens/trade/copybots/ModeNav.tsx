import { TradeSubNav } from '../TradeSubNav';

/** The shared Trade sub-navigation, so every room stays one click away. */
export function ModeNav({ active }: { active: 'copy' | 'bots' }) {
  return <TradeSubNav active={active} />;
}
