import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { pointsConvertInputSchema, pointsProgrammeSchema, pointsRedeemInputSchema } from '@intafaced/contracts/campaigns-catalogue';
import { pointsProgramme, refusePoints } from '../points.js';
import { guard, mapError } from './kit.js';

/** The points programme (J-campaigns-15): its layout, and conversion and redemption refused on the owner decision. */
export function pointsRoutes() {
  return {
    customer: {
      points: router({
        /** The points programme: its full layout, with every number blank and the owner question named while it is open. */
        programme: scopedProcedure('campaigns:read', guard)
          .output(pointsProgrammeSchema)
          .query(() => pointsProgramme()),
        /** Converting points to cash waits for the owner decision: always refuses, before anything is read or stored. */
        convert: scopedProcedure('campaigns:write', guard)
          .input(pointsConvertInputSchema)
          .output(z.never())
          .mutation(() => {
            try {
              refusePoints('convert');
            } catch (err) {
              mapError(err);
            }
          }),
        /** Redeeming a catalogue reward waits for the owner decision: always refuses, before anything is read or stored. */
        redeem: scopedProcedure('campaigns:write', guard)
          .input(pointsRedeemInputSchema)
          .output(z.never())
          .mutation(() => {
            try {
              refusePoints('redeem');
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
  };
}
