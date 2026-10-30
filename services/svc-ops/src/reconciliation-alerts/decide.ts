import type { ReconciliationEvaluation } from '@intafaced/contracts/ledger-reconciliation';
import { parseAmount } from '@intafaced/ledger-client';
import type { OPS_ALERT_NOTICE_OUTCOMES } from '@intafaced/contracts/ops-reconciliation-alerts';

export type NoticeOutcome = (typeof OPS_ALERT_NOTICE_OUTCOMES)[number];
type AssetEvidence = ReconciliationEvaluation['run']['assets'][number];

/** The ledger's own rule (svc-ledger withinStored): a set, non-zero difference outside a set tolerance fails. */
export function assetFails(asset: AssetEvidence): boolean {
  if (asset.difference === 'unset') return false;
  const difference = parseAmount(asset.difference);
  if (difference === 0n) return false;
  if (asset.tolerance === 'unset') return true;
  const abs = difference < 0n ? -difference : difference;
  return abs > parseAmount(asset.tolerance);
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

/** What one alert is raised for: a failing asset (or none) to finance, or a run that could not finish to the platform team. */
export type AlertTarget =
  { cause: 'fail'; asset: AssetEvidence | null } | { cause: 'error'; asset: null; errorCode: string; phase: string | null };

/**
 * The alerts an evaluation raises. A FAIL raises one per failing asset (finance); an ERROR raises one with no asset
 * (platform), naming the run's own code and phase, or `unset` when the ledger stored none. PASS and UNSET raise none.
 */
export function alertTargets(evaluation: ReconciliationEvaluation): AlertTarget[] {
  const { run } = evaluation;
  if (run.status === 'ERROR') {
    return [
      {
        cause: 'error',
        asset: null,
        errorCode: run.errorCode.status === 'set' ? run.errorCode.value : 'unset',
        phase: run.phase.status === 'set' ? run.phase.value : null,
      },
    ];
  }
  return failingTargets(evaluation).map((asset) => ({ cause: 'fail' as const, asset }));
}

/**
 * Whether a repeat failure shows the figures an accepted discrepancy froze: the same difference for the same asset (or
 * no asset on both). The same figures change nothing; different ones open a new alert.
 */
export function sameFrozenFigures(frozen: AssetEvidence | null, now: AssetEvidence | null): boolean {
  if (!frozen || !now) return frozen === now;
  if (frozen.assetId !== now.assetId) return false;
  if (frozen.difference === 'unset' || now.difference === 'unset') return frozen.difference === now.difference;
  return parseAmount(frozen.difference) === parseAmount(now.difference);
}
