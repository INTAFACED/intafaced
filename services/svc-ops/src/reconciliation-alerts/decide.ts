import type { ReconciliationEvaluation } from '@intafaced/contracts/ledger-reconciliation';
import type { OPS_ALERT_NOTICE_OUTCOMES } from '@intafaced/contracts/ops-reconciliation-alerts';

export type NoticeOutcome = (typeof OPS_ALERT_NOTICE_OUTCOMES)[number];
type AssetEvidence = ReconciliationEvaluation['run']['assets'][number];

/** A decimal string as a scaled integer, so no amount ever passes through a float. */
function scaled(value: string, scale: number): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace(/^[-+]/, '').split('.');
  const digits = BigInt(whole + fraction.padEnd(scale, '0').slice(0, scale));
  return negative ? -digits : digits;
}

function scaleOf(...values: string[]): number {
  return Math.max(0, ...values.map((value) => value.split('.')[1]?.length ?? 0));
}

/** The ledger's own rule (svc-ledger withinStored): a set, non-zero difference outside a set tolerance fails. */
export function assetFails(asset: AssetEvidence): boolean {
  if (asset.difference === 'unset') return false;
  const scale = scaleOf(asset.difference, asset.tolerance === 'unset' ? '0' : asset.tolerance);
  const difference = scaled(asset.difference, scale);
  if (difference === 0n) return false;
  if (asset.tolerance === 'unset') return true;
  const abs = difference < 0n ? -difference : difference;
  return abs > scaled(asset.tolerance, scale);
}

/**
 * The fingerprints a failing evaluation raises: one per failing asset, or one with no asset when the run failed with no
 * asset evidence to name (a broken chain). A run that is not FAIL raises none.
 */
export function failingTargets(evaluation: ReconciliationEvaluation): Array<AssetEvidence | null> {
  if (evaluation.run.status !== 'FAIL') return [];
  const failing = evaluation.run.assets.filter(assetFails);
  return failing.length ? failing : [null];
}

/**
 * What a repeat failure does to the in-console notice. A blank repeat interval never re-sends; a set one re-sends once it
 * has passed since the last notice, unless a snooze is in force. Either way the alert still counts the failure.
 */
export function repeatNotice(options: {
  repeatSeconds: number | null;
  lastNoticeAt: Date | null;
  now: Date;
  snoozed: boolean;
}): NoticeOutcome {
  if (options.repeatSeconds === null) return 'repeat_unset';
  if (options.lastNoticeAt && options.now.getTime() < options.lastNoticeAt.getTime() + options.repeatSeconds * 1000) return 'not_due';
  if (options.snoozed) return 'snoozed';
  return 'sent';
}
