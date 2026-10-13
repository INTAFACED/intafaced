import { LegacyRoom } from './LegacyRoom';

/** Stands in for `screens/home` (owned by B4) until it merges: the old Money view. */
export default function HomeFallback() {
  return <LegacyRoom area="money" path="/money" />;
}
