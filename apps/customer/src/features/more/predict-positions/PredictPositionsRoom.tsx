// volt-room: /predict/positions
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { PredictMarkets } from '../predict-room/PredictRoom';
import { predictionCatalogueCopy } from '../prediction-catalogue-copy';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';

/**
 * /predict/positions on the record-list template (J-more-catalogue-01 #3): under its own title it shows the Prediction
 * room, the same reads, controls and words as before, until the slice that owns this section fills it.
 */
export function PredictPositionsRoom() {
  const { t } = predictionCatalogueCopy.useCopy();
  const routes = moreRoomRoutesCopy.useCopy();
  return <RecordListTemplate title={routes.t('positions')} description={t('scope')} state={{ kind: 'ready' }} list={<PredictMarkets />} />;
}
