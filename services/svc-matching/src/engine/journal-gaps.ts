/**
 * Reconstruct transitions from the engine journal plus gateway timestamps (PTX-M03-R07).
 * Gaps are named. Never heal a hole with an invented cancel or fill.
 */
import type { JournalRecord } from './journal-codec.js';

export const JOURNAL_GAP = 'journal_gap' as const;

export type GatewayStamp = {
  readonly at: string;
  readonly seq?: number;
  readonly kind?: string;
};

export type JournalGap = {
  readonly code: typeof JOURNAL_GAP;
  readonly afterSeq: number | null;
  readonly beforeSeq: number | null;
  readonly afterAt: string | null;
  readonly beforeAt: string | null;
  readonly message: string;
};

export type TransitionReconstruction = {
  readonly transitions: readonly JournalRecord[];
  readonly gaps: readonly JournalGap[];
};

function gapMessage(afterSeq: number | null, beforeSeq: number | null): string {
  return `journal gap after seq ${afterSeq ?? 'none'} before seq ${beforeSeq ?? 'none'}; the engine does not invent a cancel or fill to close it`;
}

export function namedGap(
  after: { readonly seq: number; readonly at: string } | null,
  before: { readonly seq: number; readonly at: string } | null,
): JournalGap {
  return {
    code: JOURNAL_GAP,
    afterSeq: after?.seq ?? null,
    beforeSeq: before?.seq ?? null,
    afterAt: after?.at ?? null,
    beforeAt: before?.at ?? null,
    message: gapMessage(after?.seq ?? null, before?.seq ?? null),
  };
}

/** Named hole when `next.seq !== prev.seq + 1`. Null when the tape is contiguous. */
export function seqGap(prev: JournalRecord, next: JournalRecord): JournalGap | null {
  if (next.seq === prev.seq + 1) return null;
  return namedGap(prev, next);
}

function stampMatches(record: JournalRecord, stamp: GatewayStamp): boolean {
  if (stamp.seq !== undefined) return stamp.seq === record.seq;
  return stamp.at === record.at;
}

/**
 * Pass-through journalled transitions plus named gaps.
 * Never synthesizes submit/cancel/fill/amend records.
 */
export function reconstructTransitions(records: readonly JournalRecord[], stamps: readonly GatewayStamp[] = []): TransitionReconstruction {
  const gaps: JournalGap[] = [];
  for (let i = 1; i < records.length; i += 1) {
    const hole = seqGap(records[i - 1]!, records[i]!);
    if (hole !== null) gaps.push(hole);
  }
  for (const stamp of stamps) {
    if (records.some((record) => stampMatches(record, stamp))) continue;
    const seq = stamp.seq ?? null;
    gaps.push({
      code: JOURNAL_GAP,
      afterSeq: seq === null ? null : seq - 1,
      beforeSeq: seq,
      afterAt: null,
      beforeAt: stamp.at,
      message: gapMessage(seq === null ? null : seq - 1, seq),
    });
  }
  return { transitions: records, gaps };
}
