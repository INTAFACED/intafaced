/**
 * Pixel geometry for the desk's depth chart (J-charts-desk-14 #2). Like every chart file here, it turns decimal strings
 * into drawing coordinates, and only into coordinates: nothing it returns is a price or an amount anyone acts on. The
 * curve's values themselves come from desk/order-flow.ts, in scaled bigint.
 */
export interface DepthGeometryPoint {
  price: string;
  /** The cumulative size drawn, in the chosen units. */
  amount: string;
}

export interface DepthGeometry {
  bidPath: string;
  askPath: string;
  /** The x of a price, in the view box. */
  xOf: (price: string) => number;
  /** The point nearest to an x in the view box, or null on an empty curve. */
  nearest: (x: number) => (DepthGeometryPoint & { x: number }) | null;
}

export function depthGeometry(
  bids: readonly DepthGeometryPoint[],
  asks: readonly DepthGeometryPoint[],
  width: number,
  height: number,
): DepthGeometry {
  const all = [...bids, ...asks];
  const prices = all.map((p) => Number(p.price));
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const top = Math.max(...all.map((p) => Number(p.amount)), 0);
  const xOf = (price: string) => (high === low ? width / 2 : ((Number(price) - low) / (high - low)) * width);
  const yOf = (amount: string) => (top <= 0 ? height : height - (Number(amount) / top) * (height - 4));
  const path = (points: readonly DepthGeometryPoint[]) => {
    if (points.length === 0) return '';
    let d = `M ${xOf(points[0]!.price).toFixed(1)} ${height}`;
    let y = height;
    for (const point of points) {
      const x = xOf(point.price).toFixed(1);
      d += ` L ${x} ${y.toFixed(1)}`;
      y = yOf(point.amount);
      d += ` L ${x} ${y.toFixed(1)}`;
    }
    return `${d} L ${xOf(points[points.length - 1]!.price).toFixed(1)} ${height} Z`;
  };
  const nearest = (x: number) => {
    let best: (DepthGeometryPoint & { x: number }) | null = null;
    let distance = Infinity;
    for (const point of all) {
      const px = xOf(point.price);
      const d = Math.abs(px - x);
      if (d < distance) {
        distance = d;
        best = { ...point, x: px };
      }
    }
    return best;
  };
  return { bidPath: path(bids), askPath: path(asks), xOf, nearest };
}
