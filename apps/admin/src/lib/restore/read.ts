import 'server-only';
import { founderCall, type FounderCallContext, partFrom, type Part, founderRecordRead } from '@/lib/desk';
import {
  parseBackups,
  parseRunDetail,
  parseRuns,
  parseStamps,
  refusalWords,
  type RestoreRun,
  type RunDetail,
  type StampRow,
} from './model';
import { OPS_RESTORE_WATERMARKS } from '@intafaced/contracts/ops-restore-procedures';

const labels = {
  service: 'svc-ops',
  forbiddenMessage: 'svc-ops did not accept this founder session for the restore desk. It needs the treasury read permission (admin:read).',
  refusedMessage: refusalWords,
} as const;

export interface RestoreRoom {
  readonly asOf: string;
  readonly backups: Part<{ reason: string; backups: unknown[] }>;
  readonly stamps: Part<{ stamped: boolean; rows: StampRow[] }>;
  readonly runs: Part<readonly RestoreRun[]>;
  /** Null until a run is chosen. */
  readonly run: Part<RunDetail> | null;
}

/** Everything the room shows, each part read on its own so one failure never hides the others. */
export async function readRestoreRoom(ctx: FounderCallContext, runNo: string | null): Promise<RestoreRoom> {
  const [backups, stamps, runs, run] = await Promise.all([
    founderCall(ctx, 'ops', 'restore.backups', 'GET', undefined, parseBackups),
    founderRecordRead(ctx, OPS_RESTORE_WATERMARKS, undefined, parseStamps),
    founderCall(ctx, 'ops', 'restore.runs', 'GET', undefined, parseRuns),
    runNo ? founderCall(ctx, 'ops', 'restore.run', 'GET', { restoreNo: runNo }, parseRunDetail) : Promise.resolve(null),
  ]);
  return {
    asOf: new Date().toISOString(),
    backups: partFrom(backups, (d) => ({ reason: d.reason, backups: d.backups }), labels),
    stamps: partFrom(stamps, (d) => d, labels),
    runs: partFrom(runs, (d) => d.runs, labels),
    run: run ? partFrom(run, (d) => d, labels) : null,
  };
}
