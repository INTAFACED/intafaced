import { describe, expect, it } from 'vitest';
import { DIFF_CELLS_MAX, lineDiff } from './diff.js';

describe('lineDiff (AL-editor-01)', () => {
  it('keeps shared lines and marks one edited line as removed then added', () => {
    expect(lineDiff(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { op: 'same', text: 'a' },
      { op: 'removed', text: 'b' },
      { op: 'added', text: 'x' },
      { op: 'same', text: 'c' },
    ]);
    expect(lineDiff([], ['a'])).toEqual([{ op: 'added', text: 'a' }]);
    expect(lineDiff(['a'], ['a'])).toEqual([{ op: 'same', text: 'a' }]);
  });

  it('stays bounded on a very large change: the middle reads removed then added, and every line is accounted for', () => {
    const size = Math.ceil(Math.sqrt(DIFF_CELLS_MAX)) + 10;
    const before = Array.from({ length: size }, (_, i) => `buy BTC ${i}`);
    const after = Array.from({ length: size }, (_, i) => `sell BTC ${i}`);
    const started = Date.now();
    const diff = lineDiff(['head', ...before, 'tail'], ['head', ...after, 'tail']);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(diff[0]).toEqual({ op: 'same', text: 'head' });
    expect(diff.at(-1)).toEqual({ op: 'same', text: 'tail' });
    expect(diff.filter((line) => line.op === 'removed')).toHaveLength(size);
    expect(diff.filter((line) => line.op === 'added')).toHaveLength(size);
  });
});
