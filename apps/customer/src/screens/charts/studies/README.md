# Studies (indicator layer) for the chart workbench

The indicators, their dialogs, the legend and the data window for `/charts/:symbol`. Everything lives in this folder;
the workbench's chart only has to hand over its host and its bars.

## Wire it into `WorkbenchChart`

Three things the chart already has, plus one component:

```tsx
import { StudiesBar } from './studies/StudiesBar';

// 1. Keep the chart's host in state. Set it once, when the Lightweight Charts instance is ready. Never rebuild it per render.
const [host, setHost] = useState<ChartHost | null>(null);
// ...where the chart is created, after `main` (the candlestick series) exists:
setHost({
  lib,
  chart: api,
  main,
  element: containerEl,
  tickSize: market.tickSize,
  symbol: market.symbol,
});

// 2. Pass the bars the chart draws (the same array it sets on `main`), memoized, so the studies redraw only when it changes.
// 3. Render the bar under the chart (it is a sibling of the canvas, never inside it):
<StudiesBar
  host={host}
  market={market}
  interval={interval}
  bars={candles}
  workbench={workbenchId}
/>;
```

`workbenchId` is `workbenchId(search)` from `../workbench` (the same value the page uses for its interval and style).
`candles` is the merged list the chart draws. `market` is the `DeskMarket` in the address. `interval` is the workbench's.

`StudiesBar` needs only `host`, `market`, `interval`, `bars` and `workbench`. It fetches the public tape and the
higher-timeframe bars itself, only while a study reads them.

## What it does on the host

- Overlays (moving averages, Bollinger, Ichimoku, VWAP, pivots, auto levels, the higher-timeframe average) draw on pane 0.
- Each oscillator or volume study (RSI, MACD, Stochastic, Volume, Volume delta) gets its own sub-pane, numbered from 1.
- Every change, and unmount, removes every series and pane the hook added, then redraws. Nothing is left behind.
- It subscribes to the crosshair (`subscribeCrosshairMove`) for the legend and the data window, and unsubscribes on unmount.
- It sets the pane stretch factors (pane 0 at 3, sub-panes at 1) when a sub-pane exists. A volume pane the chart adds
  itself is included, so check the heights once wired.

## Files

- `math.ts`: the pure formulas (SMA, EMA, RSI (Wilder), MACD, Stochastic, Bollinger, session VWAP, Ichimoku, pivots,
  prior-day levels, the technical rating, volume delta, volume profile, higher-timeframe alignment). Each formula is
  stated in a comment. `math.test.ts` holds hand-checked vectors.
- `catalogue.ts`: the studies (kind, name, category, search words, inputs and their shown defaults).
- `compute.ts`: one study on the bars to series, facts, notes, a table or a typed refusal. `compute.test.ts`.
- `model.ts`: a study instance, the per-workbench store (device storage), last-settings memory, validation.
- `data.ts`: the public tape (`GET /api/v1/trades/:symbol` with an explicit limit).
- `useStudyDraw.ts`: the hook that draws the series on the host.
- `StudiesBar.tsx`: the component (toolbar, chips, legend, data window, feeds). `StudyDialogs.tsx`: the Add dialog and
  the settings dialog. `studies.render.test.tsx`: the render tests, against a fake host.
- `copy.ts` and `words.ts`: every word the studies show. `studies.css`: tokens only.

## Rules the code keeps

- A blank input is a refusal, never a default. Apply is disabled while a period is blank (`Enter a period`).
- A missing value is a gap, never a zero. Flat series have no RSI. A bar with no volume is not a zero-volume bar.
- Prices stay decimal strings in the bars. The maths reads them as numbers for display arithmetic only; every shown or
  drawn value is rounded to the market's tick (price studies) or lot (volume), or to two decimals for an oscillator
  (a percentage point). The drawn value is the shown text read back as a number.
- Ichimoku span B needs 52 bars: with fewer, span B and the cloud are absent and the legend says `Needs 52 bars`.
- Volume delta and the profile read the public tape (the last 500 prints). A bar the tape does not fully cover is absent.
- Open interest, funding and on-chain series are refused by name (`X is not published for <market>`); nothing is drawn.
- The higher-timeframe study reads only the higher bars that had closed by the end of the chart bar (no look-ahead).

## Not in this build (say so if asked)

- The Ichimoku cloud fill is not drawn: the library draws lines only here, and the two leading lines are drawn.
- The technical rating shows its signals and counts. Its score needs every weight; the weights and the thresholds are the
  owner's decision, so no score shows until they are entered.
- The volume profile is a table in the legend, not bars drawn on the price pane.
- Anchored VWAP, auto trendlines and zigzag (the drawings slice) are not built here.
- Session VWAP resets at the UTC day, not at the market's session boundaries.
- The studies are kept per workbench on this device; account storage waits for the preferences namespace.
