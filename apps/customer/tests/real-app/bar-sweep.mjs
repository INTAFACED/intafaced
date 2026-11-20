// What a pointer sweep across the chart found, as loaded-bar indexes: pure arithmetic over the chart's view before and
// after the sweep and the bars the crosshair named, so it is tested without a browser
// (tooling/scripts/real-app-bar-sweep.test.mjs). Used by J-charts-desk-06's `loadedBars`.
//
// A view is `{ from, to, loaded, firstAt, lastAt }`: the chart's logical edges (data-view-from, data-view-to), the loaded
// bar count (data-bars) and the first and last loaded bars' own times in ms (data-drawn-first, data-drawn-last). A swept
// bar is `{ time, min, max }`: its time in seconds and the first and last pixel the crosshair named it at.

/**
 * The swept bars by loaded index (0 is the first loaded bar), or a thrown error naming why the sweep can't be indexed.
 *
 * The live feed may append a bar while the sweep runs (211 bars, then 212, the view unchanged). Appending at the
 * right moves no bar already loaded: every index the sweep found stays the bar it named. Anything else that changed the
 * view (the edges moved, the oldest bar dropped, fewer bars) moved bars under the pointer, and the sweep is refused.
 */
export function indexSweep(before, after, swept) {
  const shown = JSON.stringify({ from: after.from, to: after.to, loaded: after.loaded });
  const appended =
    after.loaded >= before.loaded && after.lastAt >= before.lastAt && after.loaded > before.loaded === after.lastAt > before.lastAt;
  if (before.from !== after.from || before.to !== after.to || before.firstAt !== after.firstAt || !appended)
    throw new Error(`the chart moved during the sweep: ${JSON.stringify(before)} then ${JSON.stringify(after)}`);
  const bars = [...swept].sort((a, b) => a.time - b.time);
  if (bars.length === 0) throw new Error(`the sweep found no bar (view ${shown})`);
  const [head, tail] = [bars[0].time * 1000, bars.at(-1).time * 1000];
  // The view the sweep's right end saw: the bar appended during it if the sweep reached that bar, else the one before.
  const { loaded, lastAt } = tail === after.lastAt ? after : before;
  const { from, to, firstAt } = after;
  // The edge bars may show only in part: the chart points pixel x at bar ceil(to - (width - 1 - x) / spacing), so a
  // fractional left edge still shows bar ceil(from) - 1 in its first pixel. Index from the loaded bar the sweep reached
  // by its own time (the first, else the last), never from the rounded edge (from 0.3 still shows bar 0).
  let first;
  if (head === firstAt) first = 0;
  else if (tail === lastAt) first = loaded - bars.length;
  else throw new Error(`the sweep reached neither the first nor the last loaded bar (view ${shown})`);
  const last = first + bars.length - 1;
  // A bar narrower than a pixel can't be pointed at, and a skipped bar would shift every index after it: the swept bars
  // must run without a gap from the one in the first pixel to the one in the last.
  // Bars ceil(from)..floor(to) show whole and must be found; one more at either edge may show in part.
  const [mayFirst, mayLast] = [Math.max(0, Math.ceil(from) - 1), Math.min(loaded - 1, Math.ceil(to))];
  const [mustFirst, mustLast] = [Math.max(0, Math.ceil(from)), Math.min(loaded - 1, Math.floor(to))];
  const gapless = first >= mayFirst && first <= mustFirst && last >= mustLast && last <= mayLast;
  const ends = (head !== firstAt || first === 0) && (tail !== lastAt || last === loaded - 1);
  if (!gapless || !ends) throw new Error(`the sweep found bars ${first}..${last} of the ${mustFirst}..${mustLast} in view (${shown})`);
  return new Map(bars.map((bar, i) => [first + i, bar]));
}
