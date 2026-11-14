import 'server-only';
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
  voucherDeactivateInputSchema,
  watchAlertSchema,
  watchCampaignInputSchema,
  watchCampaignSchema,
  watchOverviewSchema,
  watchVoucherSchema,
  type ExportFile,
} from '@intafaced/contracts/campaigns-watch';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { check, ruleReply } from './builder-server';

/**
 * The campaign watch desk as the signed-in founder (J-campaigns-17): svc-campaigns counts every figure from its own rows
 * on each read and records the founder from their own token on every change. Nothing here moves money. A code made in a
 * batch passes through here once, in the generate's answer, and is never stored by the console.
 */

export const checkWatchCampaign = check(watchCampaignInputSchema, 'Which campaign?');
export const checkAlert = check(alertEnableInputSchema, 'Which alert, on or off?');
export const checkGenerate = check(
  codeGenerateInputSchema,
  'A batch needs a name (letters, digits, spaces and . _ : -, up to 80) and a whole number of codes.',
);
export const checkImport = check(
  codeImportInputSchema,
  'A batch needs a name and a CSV with one code (4 to 32 letters, digits or hyphens) per row.',
);
export const checkPublish = check(codePublishInputSchema, 'Which batch?');
export const checkDeactivate = check(voucherDeactivateInputSchema, 'Which voucher?');
export const checkExport = check(exportRequestInputSchema, 'Which campaign, which export and which of its fields?');
export const checkDownload = check(exportDownloadInputSchema, 'Which export?');

/** A batch of codes or an export can take longer than a read: up to 30 seconds. */
const call = <T>(
  ctx: FounderCallContext,
  procedure: string,
  method: 'GET' | 'POST',
  input: unknown,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
) => founderCall(ctx, 'campaigns', procedure, method, input, parseWith(schema), { timeoutMs: 30_000 });

export async function loadOverview(ctx: FounderCallContext) {
  return ruleReply(await call(ctx, 'ops.campaigns.watch.overview', 'GET', undefined, watchOverviewSchema));
}

export async function loadWatchCampaign(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await call(ctx, 'ops.campaigns.watch.campaign', 'GET', input, watchCampaignSchema));
}

export async function setAlert(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await call(ctx, 'ops.campaigns.watch.alert', 'POST', input, watchAlertSchema));
}

export async function generateCodes(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await call(ctx, 'ops.campaigns.codes.generate', 'POST', input, codeBatchResultSchema));
}

export async function importCodes(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await call(ctx, 'ops.campaigns.codes.import', 'POST', input, codeBatchResultSchema));
}

export async function publishBatch(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await call(ctx, 'ops.campaigns.codes.publish', 'POST', input, codeBatchSchema));
}

export async function deactivateVoucher(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await call(ctx, 'ops.campaigns.vouchers.deactivate', 'POST', input, watchVoucherSchema));
}

export async function requestExport(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await call(ctx, 'ops.campaigns.exports.request', 'POST', input, exportRequestResultSchema));
}

export async function downloadExport(ctx: FounderCallContext, input: unknown): Promise<ReturnType<typeof ruleReply<ExportFile>>> {
  return ruleReply(await call(ctx, 'ops.campaigns.exports.download', 'GET', input, exportFileSchema));
}
