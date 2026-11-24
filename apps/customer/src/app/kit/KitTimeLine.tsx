import { TimeLine, type TimePoint } from '@intafaced/ui/lit/templates';

const START = Date.UTC(2026, 10, 20, 0, 0, 0);
const HOUR = 3_600_000;

/**
 * TEST profit and loss, hourly over two days: it starts at zero, dips below and climbs back, and hours 18 to 23 have
 * no figure, so the line breaks and the gap keeps its width. Hours 30 to 35 were never recorded, so the line runs
 * straight across them.
 */
const POINTS: TimePoint[] = Array.from({ length: 48 }, (_, i) => i)
  .filter((i) => i < 30 || i > 35)
  .map((i) => ({
    at: new Date(START + i * HOUR).toISOString(),
    value: i >= 18 && i <= 23 ? null : (i === 0 ? 0 : 40 * Math.sin(i / 5) + i * 3 - 20).toFixed(2),
  }));

const when = (iso: string) => `${iso.slice(8, 10)} Nov ${iso.slice(11, 16)} UTC`;
const readout = (p: TimePoint) => `${when(p.at)}: ${p.value === null ? 'no figure at this time' : `$${p.value}`} TEST`;
const KEYS = 'Use the left and right arrow keys to read each point';

/** The kit's line over time: placed by time, its zero line, its readout, and its empty line. */
export function TimeLines() {
  return (
    <div className="lt-stack">
      <TimeLine
        label="TEST profit and loss over two days"
        keys={KEYS}
        points={POINTS}
        readout={readout}
        empty="No points in this range."
        caption={
          <>
            <span>{when(POINTS[0]!.at)}</span>
            <span>Six hours with no figure break the line. TEST</span>
            <span>{when(POINTS.at(-1)!.at)}</span>
          </>
        }
        marks={{ 'data-chart': 'kit-time-line' }}
      />
      <TimeLine
        label="TEST profit and loss, no points"
        keys={KEYS}
        points={[]}
        readout={readout}
        empty="No points in this range, so there is no line to draw."
      />
    </div>
  );
}
