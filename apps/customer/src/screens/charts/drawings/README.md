# Chart drawings

The drawing tools of the chart workbench. Everything lives in this folder; the workbench chart only hands them its host.

## Wiring into WorkbenchChart

```tsx
import { useDrawings, DrawingToolbar, ObjectTree } from './drawings';
// `host` is the ChartHost from WorkbenchChart (null until the chart is ready); `candles` is the chart's own bar array, oldest first.
const drawings = useDrawings(host, candles, {
  userId,
  workbench,
  symbol: market.symbol,
  tickSize: market.tickSize,
  limits: drawingLimits,
});
// Beside the chart element, not inside it: <DrawingToolbar api={drawings} /> and <ObjectTree api={drawings} onIndicatorsSlot={setSlot} />.
```

- Key the component that calls the hook by `` `${symbol}:${workbench}` ``, so a new market or workbench reads its own stored drawings.
- `drawingLimits` is `{ drawingCap, brushPointCap }` from the owner's settings. A blank value (`null`) refuses: no number is assumed.
- The hook attaches one series primitive to `host.main` and detaches it on unmount; it needs `host.chart`, `host.main` and `host.element` only.
- The overlay does not sit in the chart canvas: the tools draw through the primitive and read the pointer from the chart element.

## Files

- `model.ts`, `geometry.ts`, `decimal.ts`, `history.ts`, `store.ts`, `render.ts`: pure rules, unit tested without a canvas.
- `primitive.ts`: the Lightweight Charts series primitive that paints the render plan.
- `useDrawings.ts`: placement, selection, drag, brush, keyboard, undo and device storage.
- `DrawingToolbar.tsx`, `ObjectTree.tsx`: the toolbar groups and the object tree (the exact bar times and prices of every drawing).
