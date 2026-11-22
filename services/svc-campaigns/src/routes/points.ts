import { router } from '@intafaced/contracts';
import { pointsProgramme, refusePoints } from '../points.js';
import { mapError, refusalOf } from './kit.js';
import {
  CAMPAIGNS_POINTS_PROGRAMME,
  CAMPAIGNS_POINTS_CONVERT,
  CAMPAIGNS_POINTS_REDEEM,
} from '@intafaced/contracts/campaigns-points-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';

/** The points programme (J-campaigns-15): its layout, and conversion and redemption refused on the owner decision. */
export function pointsRoutes() {
  return {
    customer: {
      points: router({
        /** The points programme: its full layout, with every number blank and the owner question named while it is open. */
        programme: mountRecord(CAMPAIGNS_POINTS_PROGRAMME, () => pointsProgramme(), refusalOf),
        /** Converting points to cash waits for the owner decision: always refuses, before anything is read or stored. */
        convert: mountRecord(
          CAMPAIGNS_POINTS_CONVERT,
          () => {
            try {
              refusePoints('convert');
            } catch (err) {
              mapError(err);
            }
          },
          refusalOf,
        ),
        /** Redeeming a catalogue reward waits for the owner decision: always refuses, before anything is read or stored. */
        redeem: mountRecord(
          CAMPAIGNS_POINTS_REDEEM,
          () => {
            try {
              refusePoints('redeem');
            } catch (err) {
              mapError(err);
            }
          },
          refusalOf,
        ),
      }),
    },
  };
}
