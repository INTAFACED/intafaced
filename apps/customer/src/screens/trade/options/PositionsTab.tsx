import { EmptyState } from '../rooms/ui';
import { optionsCopy } from './copy';

/** There is no door that reads option positions. Building them from fills would invent a position, so none is shown. */
export function PositionsTab() {
  const { t } = optionsCopy.useCopy();
  return <EmptyState variant="unavailable" title={t('Positions not published')} reason={t('Positions blocker')} />;
}
