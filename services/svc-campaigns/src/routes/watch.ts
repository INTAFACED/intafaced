import { router } from '@intafaced/contracts';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  CAMPAIGNS_OPS_CAMPAIGNS_CODES_GENERATE,
  CAMPAIGNS_OPS_CAMPAIGNS_CODES_IMPORT,
  CAMPAIGNS_OPS_CAMPAIGNS_CODES_PUBLISH,
  CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_DOWNLOAD,
  CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_REQUEST,
  CAMPAIGNS_OPS_CAMPAIGNS_WATCH_ALERT,
  CAMPAIGNS_OPS_CAMPAIGNS_WATCH_CAMPAIGN,
  CAMPAIGNS_OPS_CAMPAIGNS_WATCH_OVERVIEW,
} from '@intafaced/contracts/campaigns-procedures';
import { refusalOf, requireOpsMfa } from './kit.js';
import type { CampaignServices } from '../router.js';

/** The watch desk, code batches and exports (J-campaigns-17). */
export function watchRoutes({ watch }: CampaignServices) {
  return {
    opsCampaigns: {
      /** The watch desk (J-campaigns-17 #1 #2). */
      watch: router({
        overview: mountRecord(
          CAMPAIGNS_OPS_CAMPAIGNS_WATCH_OVERVIEW,
          async ({ ctx }) => {
            requireOpsMfa(ctx);
            return watch.overview();
          },
          refusalOf,
        ),
        campaign: mountRecord(
          CAMPAIGNS_OPS_CAMPAIGNS_WATCH_CAMPAIGN,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return watch.campaign(input);
          },
          refusalOf,
        ),
        alert: mountRecord(
          CAMPAIGNS_OPS_CAMPAIGNS_WATCH_ALERT,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return watch.setAlert({ ...input, actor: ctx.principal.userId });
          },
          refusalOf,
        ),
      }),
      /** Code batches (J-campaigns-17 #3 to #5). */
      codes: router({
        generate: mountRecord(
          CAMPAIGNS_OPS_CAMPAIGNS_CODES_GENERATE,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return watch.generate({ ...input, actor: ctx.principal.userId });
          },
          refusalOf,
        ),
        import: mountRecord(
          CAMPAIGNS_OPS_CAMPAIGNS_CODES_IMPORT,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return watch.importCodes({ ...input, actor: ctx.principal.userId });
          },
          refusalOf,
        ),
        publish: mountRecord(
          CAMPAIGNS_OPS_CAMPAIGNS_CODES_PUBLISH,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return watch.publish({ ...input, actor: ctx.principal.userId });
          },
          refusalOf,
        ),
      }),
      /** Exports (J-campaigns-17 #6). */
      exports: router({
        request: mountRecord(
          CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_REQUEST,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return watch.requestExport({ ...input, actor: ctx.principal.userId });
          },
          refusalOf,
        ),
        download: mountRecord(
          CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_DOWNLOAD,
          async ({ ctx, input }) => {
            requireOpsMfa(ctx);
            return watch.download({ ...input, actor: ctx.principal.userId });
          },
          refusalOf,
        ),
      }),
    },
  };
}
