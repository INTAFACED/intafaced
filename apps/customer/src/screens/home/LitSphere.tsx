import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { FX_PRESETS, LitFx, sharesFromPercents, sphereCallouts } from '@intafaced/ui/lit/fx';
import poster from '@intafaced/ui/lit/fx/posters/sphere-home-blue.jpg';
import { isLook } from '../../app/look';
import { homeCopy } from './copy';
import { fmtUsd, type HomePortfolio, type Loadable } from './deps';
import { sphereShares, type SpherePart } from './lit-shares';
// the kit's role tokens; flat values unless data-look="lit" (the lead's wiring PR moves this to the app shell)
import '@intafaced/ui/lit/lit.css';
import './lit-spike.css';

const PRESET = FX_PRESETS['sphere-home-blue'];

type Leaders = { d: string; ends: Array<[number, number]> };

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
 * Leader lines from each legend row to its segment: out of the row, across, then once down (or up) onto the segment.
 * Rows sit bottom-up in the order of their segments from the left, so no two lines cross.
 */
function useLeaders(panel: RefObject<HTMLDivElement | null>, sphere: HTMLDivElement | null, points: Array<[number, number]>) {
  const [leaders, setLeaders] = useState<Leaders | null>(null);
  const key = points.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(' ');
  // the points are a new array each render; the effect follows their rounded values and reads the latest ones
  const latest = useRef(points);
  latest.current = points;
  useLayoutEffect(() => {
    const host = panel.current;
    if (!host || !sphere || key === '') return setLeaders(null);
    const origin = host.getBoundingClientRect();
    const at = sphere.getBoundingClientRect();
    const targets = new Map(latest.current.map((point, i) => [String(i), point]));
    let d = '';
    const ends: Leaders['ends'] = [];
    for (const row of host.querySelectorAll<HTMLElement>('[data-leader-from]')) {
      const target = targets.get(row.dataset.leaderFrom ?? '');
      if (!target) continue;
      const r = row.getBoundingClientRect();
      const [startX, startY] = [r.right - origin.left, r.top + r.height / 2 - origin.top];
      const [x, y] = [at.left - origin.left + target[0], at.top - origin.top + target[1]];
      // stop just short of the rim, so the line points at the light rather than drawing on it
      d += `M${startX},${startY} H${x} V${y > startY ? y - 10 : y + 10} `;
      ends.push([startX, startY]);
    }
    setLeaders({ d: d.trim(), ends });
  }, [panel, sphere, key]);
  return leaders;
}

/**
 * Redesign stage A: "Where your money is", the light sphere split by the holdings, with a legend column naming each
 * part as Home's rows do (Cash, each crypto asset, Other) with its share and value, and a leader line to its segment.
 * No text is drawn over the 3D. Only with the Lit glass look on (`?look=lit`). The legend is the meaning (the 3D is
 * decorative); with balances hidden, or any share unknown, the sphere draws no split and there is no legend.
 */
export function LitSphere({ portfolio, hidden }: { portfolio: Loadable<HomePortfolio>; hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  const panel = useRef<HTMLDivElement>(null);
  const { el, ref, size } = useBoxSize();
  const look = isLook('lit');
  const parts = look && portfolio.status === 'ready' && !hidden ? sphereShares(portfolio.data.holdings) : null;
  // holdings shown but not all priced: say why there is no split (with balances hidden, say nothing)
  const unsplit = look && !parts && !hidden && portfolio.status === 'ready' && portfolio.data.holdings.length > 0;
  const shares = parts ? sharesFromPercents(parts.map((p) => p.percent)) : null;
  const points = shares && size ? sphereCallouts(shares, size.w, size.h, PRESET.options) : [];
  const leaders = useLeaders(panel, el, points);
  if (!look) return null;
  // the lowest legend row goes to the leftmost segment
  const order = parts ? parts.map((_, i) => i).sort((a, b) => (points[a]?.[0] ?? a) - (points[b]?.[0] ?? b)) : [];
  const name = (part: SpherePart) => (part.kind === 'cash' ? t('Cash') : part.kind === 'other' ? t('Sphere other') : part.asset);
  return (
    <section className="home-lit-where" aria-labelledby="home-lit-where-title">
      <h2 id="home-lit-where-title" className="home-h2">
        {t('Where your money is')}
      </h2>
      <div ref={panel} className="home-lit-where__panel" style={{ '--rows': parts?.length ?? 0 } as CSSProperties}>
        <div ref={ref} className="home-lit-sphere">
          <LitFx kind="sphere" options={shares ? { ...PRESET.options, shares } : PRESET.options} poster={poster} />
        </div>
        {parts ? (
          <>
            <svg className="home-lit-leaders" aria-hidden="true">
              {leaders ? <path d={leaders.d} /> : null}
              {leaders?.ends.map(([x, y], i) => (
                <circle key={i} cx={x} cy={y} r={2} />
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
        ) : unsplit ? (
          <p className="home-lit-where__note">{t('Sphere no split')}</p>
        ) : null}
      </div>
    </section>
  );
}
