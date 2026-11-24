// volt-room: /predict/settings
import { SettingsTemplate } from '@intafaced/ui/lit/templates';
import { PredictMarkets } from '../predict-room/PredictRoom';
import { predictionCatalogueCopy } from '../prediction-catalogue-copy';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';

/**
 * /predict/settings on the settings template (J-more-catalogue-01 #3): under its own title it shows the Prediction room,
 * the same reads, controls and words as before, until the slice that owns this section (MC-predict-05) fills it.
 */
export function PredictSettingsRoom() {
  const { t } = predictionCatalogueCopy.useCopy();
  const routes = moreRoomRoutesCopy.useCopy();
  return (
    <SettingsTemplate
      title={routes.t('predictSettings')}
      description={t('scope')}
      state={{ kind: 'ready' }}
      sections={<PredictMarkets />}
    />
  );
}
