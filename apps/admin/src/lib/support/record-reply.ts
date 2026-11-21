import { replyAccepted, type ProcedureOutput, type ProcedureRecord } from '@intafaced/contracts/procedure';

/** A reply as a record reads it: its output schema and its `accept` checks, as `founderRecordCall` does; null when refused. */
export function recordReads<R extends ProcedureRecord>(record: R, raw: unknown): ProcedureOutput<R> | null {
  const parsed = record.output.safeParse(raw);
  return parsed.success && replyAccepted(record, parsed.data) ? (parsed.data as ProcedureOutput<R>) : null;
}
