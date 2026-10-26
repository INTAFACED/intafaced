import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { FX_PRESETS, LitFx, sharesFromPercents, sphereCallouts } from '@intafaced/ui/lit/fx';
import poster from '@intafaced/ui/lit/fx/posters/sphere-home-blue.jpg';
import { isLook } from '../../app/look';
import { homeCopy } from './copy';
import { fmtUsd, type HomePortfolio, type Loadable } from './deps';
import { sphereShares, type SpherePart } from './lit-shares';
// the kit's role tokens (@intafaced/ui/lit/lit.css) load once at the app shell, in main.tsx
import './lit-spike.css';

const PRESET = FX_PRESETS['sphere-home-blue'];

type Leaders = { d: string; starts: Array<[number, number]>; ends: Array<[number, number]> };

/** The sphere box's size in CSS pixels, for finding where its segments sit; follows the box as it mounts and resizes. */
function useBoxSize() {
  const [el, ref] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    if (!el) return setSize(null);
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return { el, ref, size };
}

/**
 * Leader lines from each legend row to its segment: out of the row's inline end, across, then once down (or up) onto
 * the segment, ending on a ringed node there. The lowest row goes to the segment nearest the legend and the top row
 * to the farthest, so no two lines cross; under right-to-left the rows keep their order and only x mirrors (the
 * sphere's picture and the lines).
 */
function useLeaders(panel: RefObject<HTMLDivElement | null>, sphere: HTMLDivElement | null, points: Array<[number, number]>) {
  const [leaders, setLeaders] = useState<Leaders | null>(null);
  // the panel's size and direction: a legend that re-wraps, or a page that turns right-to-left, moves the lines
  const [layout, setLayout] = useState('');
  const key = points.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(' ');
  // the points are a new array each render; the effect follows their rounded values and reads the latest ones
  const latest = useRef(points);
  latest.current = points;
  useLayoutEffect(() => {
    const host = panel.current;
    if (!host) return;
    const read = () => setLayout(`${host.clientWidth}x${host.clientHeight} ${getComputedStyle(host).direction}`);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(host);
    for (const part of host.querySelectorAll('.home-lit-legend__part')) observer.observe(part);
    // a language switch can turn the page right-to-left without resizing anything
    const direction = new MutationObserver(read);
    direction.observe(document.documentElement, { attributes: true, attributeFilter: ['dir', 'lang'] });
    return () => {
      observer.disconnect();
      direction.disconnect();
    };
  }, [panel, key]);
  useLayoutEffect(() => {
    const host = panel.current;
    if (!host || !sphere || key === '') return setLeaders(null);
    const rtl = layout.endsWith('rtl');
    const origin = host.getBoundingClientRect();
    const at = sphere.getBoundingClientRect();
    const targets = new Map(latest.current.map((point, i) => [String(i), point]));
    let d = '';
    const starts: Leaders['starts'] = [];
    const ends: Leaders['ends'] = [];
    for (const row of host.querySelectorAll<HTMLElement>('[data-leader-from]')) {
      const target = targets.get(row.dataset.leaderFrom ?? '');
      if (!target) continue;
      const r = row.getBoundingClientRect();
      const [startX, startY] = [(rtl ? r.left : r.right) - origin.left, r.top + r.height / 2 - origin.top];
      // the sphere box is mirrored under right-to-left (lit-spike.css), and its segments with it
      const [x, y] = [at.left - origin.left + (rtl ? at.width - target[0] : target[0]), at.top - origin.top + target[1]];
      d += `M${startX},${startY} H${x} V${y} `;
      starts.push([startX, startY]);
      ends.push([x, y]);
    }
    setLeaders({ d: d.trim(), starts, ends });
  }, [panel, sphere, key, layout]);
  return leaders;
}

/**
 * Redesign stage A: "Where your money is", the light sphere split by the holdings, with a legend column naming each
 * part as Home's rows do (Cash, each crypto asset, Other) with its share and value, and a leader line to its segment.
 * No text is drawn over the 3D. Only with the Lit glass look on (`?look=lit`). The legend is the meaning (the 3D is
 * decorative); with balances hidden, or any share unknown, the sphere draws no split and there is no legend.
 */
/** Placeholder rows in the legend while the holdings load: a fixed count, never a guess at how many there are. */
const LOADING_ROWS = 3;

export function LitSphere({ portfolio, hidden }: { portfolio: Loadable<HomePortfolio>; hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  const panel = useRef<HTMLDivElement>(null);
  const { el, ref, size } = useBoxSize();
  const look = isLook('lit');
  const parts = look && portfolio.status === 'ready' && !hidden ? sphereShares(portfolio.data.holdings) : null;
  // a holding without a price: say why there is no split (with balances hidden, say nothing)
  const unsplit =
    look &&
    !parts &&
    !hidden &&
    portfolio.status === 'ready' &&
    portfolio.data.holdings.some((h) => h.share === null || h.usdValue === null);
  // while the holdings load: placeholder rows where the legend goes, and the sphere dimmed with no split
  const loading = look && !hidden && portfolio.status === 'loading';
  const shares = parts ? sharesFromPercents(parts.map((p) => p.percent)) : null;
  const points = shares && size ? sphereCallouts(shares, size.w, size.h, PRESET.options) : [];
  const leaders = useLeaders(panel, el, points);
  if (!look) return null;
  // rows keep one order in both directions (the lowest row goes to the segment nearest the legend); right-to-left
  // mirrors only x, the picture with the lines, so the order never waits on the measured direction
  const x = (i: number) => points[i]?.[0] ?? i;
  const order = parts ? parts.map((_, i) => i).sort((a, b) => x(a) - x(b)) : [];
  const name = (part: SpherePart) => (part.kind === 'cash' ? t('Cash') : part.kind === 'other' ? t('Sphere other') : part.asset);
  return (
    <section className="home-lit-where" aria-labelledby="home-lit-where-title">
      <h2 id="home-lit-where-title" className="home-h2">
        {t('Where your money is')}
      </h2>
      <div
        ref={panel}
        className="home-lit-where__panel"
        data-loading={loading || undefined}
        style={{ '--rows': parts?.length ?? (loading ? LOADING_ROWS : 0) } as CSSProperties}
      >
        <div ref={ref} className="home-lit-sphere">
          <LitFx kind="sphere" options={shares ? { ...PRESET.options, shares } : PRESET.options} poster={poster} />
        </div>
        {parts ? (
          <>
            <svg className="home-lit-leaders" aria-hidden="true">
              {leaders ? <path d={leaders.d} /> : null}
              {leaders?.starts.map(([x, y], i) => (
                <circle key={`from-${i}`} className="home-lit-leaders__from" cx={x} cy={y} r={2} />
              ))}
              {leaders?.ends.map(([x, y], i) => (
                <circle key={`to-${i}`} className="home-lit-leaders__to" cx={x} cy={y} r={3.5} />
              ))}
            </svg>
            <ol className="home-lit-legend">
              {parts.map((part, i) => (
                <li
                  key={part.asset ?? part.kind}
                  className="home-lit-legend__part"
                  data-seg={i}
                  style={{ '--row': order.indexOf(i) } as CSSProperties}
                >
                  <span className="home-lit-legend__head" data-leader-from={i}>
                    <span className="home-lit-legend__chip" aria-hidden="true" />
                    <span className="home-lit-legend__name">{name(part)}</span>
                    <span className="home-lit-legend__pct">
                      {part.percent === 0n ? t('Sphere under one percent') : t('Sphere percent', { value: String(part.percent) })}
                    </span>
                  </span>
                  <span className="home-lit-legend__value">{fmtUsd(part.usd)}</span>
                </li>
              ))}
            </ol>
          </>
        ) : loading ? (
          <ol className="home-lit-legend" aria-hidden="true" data-testid="home-lit-legend-skeleton">
            {Array.from({ length: LOADING_ROWS }, (_, i) => (
              <li key={i} className="home-lit-legend__part" style={{ '--row': LOADING_ROWS - 1 - i } as CSSProperties}>
                <span className="home-lit-legend__bar" />
                <span className="home-lit-legend__bar home-lit-legend__bar--value" />
              </li>
            ))}
          </ol>
        ) : unsplit ? (
          <p className="home-lit-where__note">{t('Sphere no split')}</p>
        ) : null}
      </div>
    </section>
  );
}
