import type { StrategyVersionRecord } from './repository.js';

/** One line of a diff: kept in both versions, only in the earlier one, or only in the later one. */
export interface DiffLine {
  readonly op: 'same' | 'removed' | 'added';
  readonly text: string;
}

/** The difference between two stored versions of one strategy, line by line. Derived on read; nothing is stored. */
export interface VersionDiff {
  readonly from: number;
  readonly to: number;
  readonly source: DiffLine[];
  readonly blocks: DiffLine[];
  readonly rules: DiffLine[];
  readonly changed: boolean;
}

/**
 * The largest middle part, in table cells, compared line by line. Beyond it the middle reads as removed then added:
 * still a true difference, never a wrong one, and the work stays bounded whatever a version holds.
 */
export const DIFF_CELLS_MAX = 250_000;

/**
 * Longest common subsequence of lines, so a moved or edited line reads as one removal and one addition. The lines both
 * versions share at the start and the end are kept first, so a usual edit compares only the few lines around it.
 */
export function lineDiff(before: readonly string[], after: readonly string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) {
    end += 1;
  }
  const same = (lines: readonly string[]) => lines.map((text): DiffLine => ({ op: 'same', text }));
  const middle = middleDiff(before.slice(start, before.length - end), after.slice(start, after.length - end));
  return [...same(before.slice(0, start)), ...middle, ...same(before.slice(before.length - end))];
}

function middleDiff(before: readonly string[], after: readonly string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  if ((n + 1) * (m + 1) > DIFF_CELLS_MAX) {
    return [...before.map((text): DiffLine => ({ op: 'removed', text })), ...after.map((text): DiffLine => ({ op: 'added', text }))];
  }
  const longest: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      longest[i]![j] = before[i] === after[j] ? longest[i + 1]![j + 1]! + 1 : Math.max(longest[i + 1]![j]!, longest[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ op: 'same', text: before[i]! });
      i += 1;
      j += 1;
    } else if (longest[i + 1]![j]! >= longest[i]![j + 1]!) {
      out.push({ op: 'removed', text: before[i]! });
      i += 1;
    } else {
      out.push({ op: 'added', text: after[j]! });
      j += 1;
    }
  }
  while (i < n) out.push({ op: 'removed', text: before[i++]! });
  while (j < m) out.push({ op: 'added', text: after[j++]! });
  return out;
}

const lines = (text: string) => (text ? text.split('\n') : []);
const blockLines = (version: StrategyVersionRecord) => version.blocks.map((block) => `${block.side} ${block.symbol} ${block.qty}`);
const ruleLines = (version: StrategyVersionRecord) => (version.modules ? lines(JSON.stringify(version.modules, null, 2)) : []);

export function versionDiff(from: StrategyVersionRecord, to: StrategyVersionRecord): VersionDiff {
  const source = lineDiff(lines(from.source), lines(to.source));
  const blocks = lineDiff(blockLines(from), blockLines(to));
  const rules = lineDiff(ruleLines(from), ruleLines(to));
  const changed = [source, blocks, rules].some((part) => part.some((line) => line.op !== 'same'));
  return { from: from.version, to: to.version, source, blocks, rules, changed };
}
