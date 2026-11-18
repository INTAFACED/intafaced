import { router } from '@intafaced/contracts';
import {
  alertEnableInputSchema,
  codeBatchResultSchema,
  codeBatchSchema,
  codeGenerateInputSchema,
  codeImportInputSchema,
  codePublishInputSchema,
  exportDownloadInputSchema,
  exportFileSchema,
  exportRequestInputSchema,
  exportRequestResultSchema,
  watchAlertSchema,
  watchCampaignInputSchema,
  watchCampaignSchema,
  watchOverviewSchema,
} from '@intafaced/contracts/campaigns-watch';
import { mapError, opsProcedure } from './kit.js';
import type { CampaignServices } from '../router.js';

/** The watch desk, code batches and exports (J-campaigns-17). */
export function watchRoutes({ watch }: CampaignServices) {
  return {
    opsCampaigns: {
      /** The watch desk (J-campaigns-17 #1 #2): counted from the rows on each read. */
      watch: router({
        overview: opsProcedure.output(watchOverviewSchema).query(async () => {
          try {
            return await watch.overview();
          } catch (err) {
            mapError(err);
          }
        }),
        campaign: opsProcedure
          .input(watchCampaignInputSchema)
          .output(watchCampaignSchema)
          .query(async ({ input }) => {
            try {
              return await watch.campaign(input);
            } catch (err) {
              mapError(err);
            }
          }),
        /** Switches an alert on or off; on refuses while its owner threshold is blank. */
        alert: opsProcedure
          .input(alertEnableInputSchema)
          .output(watchAlertSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await watch.setAlert({ ...input, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
      /** Code batches (J-campaigns-17 #3 to #5): stored as hashes and last four characters only. */
      codes: router({
        /** Makes a batch and returns its plain codes in this answer only; the same reference again returns none. */
        generate: opsProcedure
          .input(codeGenerateInputSchema)
          .output(codeBatchResultSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await watch.generate({ ...input, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
        import: opsProcedure
          .input(codeImportInputSchema)
          .output(codeBatchResultSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await watch.importCodes({ ...input, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
        publish: opsProcedure
          .input(codePublishInputSchema)
          .output(codeBatchSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await watch.publish({ ...input, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
      /** Exports (J-campaigns-17 #6): one job per export while it is open or its link valid. */
      exports: router({
        request: opsProcedure
          .input(exportRequestInputSchema)
          .output(exportRequestResultSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await watch.requestExport({ ...input, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
        download: opsProcedure
          .input(exportDownloadInputSchema)
          .output(exportFileSchema)
          .query(async ({ ctx, input }) => {
            try {
              return await watch.download({ ...input, actor: ctx.principal!.userId });
            } catch (err) {
              mapError(err);
            }
          }),
      }),
    },
  };
}
