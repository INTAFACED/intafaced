import { RefusalBox } from '@intafaced/ui/lit/templates';
import { optionsCopy } from './copy';

/** There is no door that reads option positions. Building them from fills would invent a position, so none is shown. */
export function PositionsTab() {
  const { t } = optionsCopy.useCopy();
  return <RefusalBox refusal={{ variant: 'parked', title: t('Positions not published'), body: t('Positions blocker') }} />;
}
