import 'server-only';
import type { ProcedureInput } from '@intafaced/contracts/procedure';
import {
  CAMPAIGNS_OPS_CAMPAIGNS_CODES_GENERATE,
  CAMPAIGNS_OPS_CAMPAIGNS_CODES_IMPORT,
  CAMPAIGNS_OPS_CAMPAIGNS_CODES_PUBLISH,
  CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_DOWNLOAD,
  CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_REQUEST,
  CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_DEACTIVATE,
  CAMPAIGNS_OPS_CAMPAIGNS_WATCH_ALERT,
  CAMPAIGNS_OPS_CAMPAIGNS_WATCH_CAMPAIGN,
  CAMPAIGNS_OPS_CAMPAIGNS_WATCH_OVERVIEW,
} from '@intafaced/contracts/campaigns-procedures';
import { founderRecordCall, type FounderCallContext } from '@/lib/desk';
import { check, ruleReply } from './builder-server';

/**
 * The campaign watch desk as the signed-in founder (J-campaigns-17): svc-campaigns counts every figure from its own rows
 * on each read and records the founder from their own token on every change. Nothing here moves money. A code made in a
 * batch passes through here once, in the generate's answer, and is never stored by the console.
 */

export const checkWatchCampaign = check(CAMPAIGNS_OPS_CAMPAIGNS_WATCH_CAMPAIGN.input, 'Which campaign?');
export const checkAlert = check(CAMPAIGNS_OPS_CAMPAIGNS_WATCH_ALERT.input, 'Which alert, on or off?');
export const checkGenerate = check(
  CAMPAIGNS_OPS_CAMPAIGNS_CODES_GENERATE.input,
  'A batch needs a name (letters, digits, spaces and . _ : -, up to 80) and a whole number of codes.',
);
export const checkImport = check(
  CAMPAIGNS_OPS_CAMPAIGNS_CODES_IMPORT.input,
  'A batch needs a name and a CSV with one code (4 to 32 letters, digits or hyphens) per row.',
);
export const checkPublish = check(CAMPAIGNS_OPS_CAMPAIGNS_CODES_PUBLISH.input, 'Which batch?');
export const checkDeactivate = check(CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_DEACTIVATE.input, 'Which voucher?');
export const checkExport = check(CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_REQUEST.input, 'Which campaign, which export and which of its fields?');
export const checkDownload = check(CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_DOWNLOAD.input, 'Which export?');

/** A batch of codes or an export can take longer than a read: up to 30 seconds. */
const SLOW = { timeoutMs: 30_000 } as const;

export async function loadOverview(ctx: FounderCallContext) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_CAMPAIGNS_WATCH_OVERVIEW, undefined, SLOW));
}

export async function loadWatchCampaign(ctx: FounderCallContext, input: ProcedureInput<typeof CAMPAIGNS_OPS_CAMPAIGNS_WATCH_CAMPAIGN>) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_CAMPAIGNS_WATCH_CAMPAIGN, input, SLOW));
}

export async function setAlert(ctx: FounderCallContext, input: ProcedureInput<typeof CAMPAIGNS_OPS_CAMPAIGNS_WATCH_ALERT>) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_CAMPAIGNS_WATCH_ALERT, input, SLOW));
}

export async function generateCodes(ctx: FounderCallContext, input: ProcedureInput<typeof CAMPAIGNS_OPS_CAMPAIGNS_CODES_GENERATE>) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_CAMPAIGNS_CODES_GENERATE, input, SLOW));
}

export async function importCodes(ctx: FounderCallContext, input: ProcedureInput<typeof CAMPAIGNS_OPS_CAMPAIGNS_CODES_IMPORT>) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_CAMPAIGNS_CODES_IMPORT, input, SLOW));
}

export async function publishBatch(ctx: FounderCallContext, input: ProcedureInput<typeof CAMPAIGNS_OPS_CAMPAIGNS_CODES_PUBLISH>) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_CAMPAIGNS_CODES_PUBLISH, input, SLOW));
}

export async function deactivateVoucher(
  ctx: FounderCallContext,
  input: ProcedureInput<typeof CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_DEACTIVATE>,
) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_DEACTIVATE, input, SLOW));
}

export async function requestExport(ctx: FounderCallContext, input: ProcedureInput<typeof CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_REQUEST>) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_REQUEST, input, SLOW));
}

export async function downloadExport(ctx: FounderCallContext, input: ProcedureInput<typeof CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_DOWNLOAD>) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_DOWNLOAD, input, SLOW));
}
