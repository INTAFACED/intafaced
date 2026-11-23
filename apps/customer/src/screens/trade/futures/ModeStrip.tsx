import { TradeSubNav } from '../TradeSubNav';

/**
 * The shared Trade sub-navigation for the Margin and Futures rooms, which draw full width: set in the page's content
 * column and gutter, so it lines up with the room below it.
 */
export function ModeStrip() {
  return (
    <div className="mx-auto w-full max-w-(--if-w-content,1224px) px-(--if-gutter) pt-4">
      <TradeSubNav />
    </div>
  );
}
