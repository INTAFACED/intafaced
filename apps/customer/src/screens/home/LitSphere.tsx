import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { FX_PRESETS, LitFx, sharesFromPercents, sphereCallouts } from '@intafaced/ui/lit/fx';
import poster from '@intafaced/ui/lit/fx/posters/sphere-home-blue.jpg';
import { isLook } from '../../app/look';
import { homeCopy } from './copy';
import type { HomePortfolio, Loadable } from './deps';
import { sphereShares } from './lit-shares';
// the kit's role tokens; flat values unless data-look="lit" (the lead's wiring PR moves this to the app shell)
import '@intafaced/ui/lit/lit.css';
import './lit-spike.css';

const PRESET = FX_PRESETS['sphere-home-blue'];

/** The box's size in CSS pixels, for placing the labels where the segments sit. */
function useBoxSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

/**
 * Redesign stage A: "Where your money is", the light sphere split by the holdings, each part labelled with its asset
 * and whole percent. Only with the Lit glass look on (`?look=lit`). The labels are the meaning (the 3D is
 * decorative); with balances hidden, or any share unknown, the sphere draws no split and no labels.
 */
export function LitSphere({ portfolio, hidden }: { portfolio: Loadable<HomePortfolio>; hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  const { ref, size } = useBoxSize();
  if (!isLook('lit')) return null;
  const parts = portfolio.status === 'ready' && !hidden ? sphereShares(portfolio.data.holdings) : null;
  const shares = parts ? sharesFromPercents(parts.map((p) => p.percent)) : null;
  const points = shares && size ? sphereCallouts(shares, size.w, size.h, PRESET.options) : [];
  return (
    <section className="home-lit-where" aria-labelledby="home-lit-where-title">
      <h2 id="home-lit-where-title" className="home-h2">
        {t('Where your money is')}
      </h2>
      <div ref={ref} className="home-lit-sphere">
        <LitFx kind="sphere" options={shares ? { ...PRESET.options, shares } : PRESET.options} poster={poster} />
        {parts ? (
          <ol className="home-lit-callouts">
            {parts.map((part, i) => {
              const point = points[i];
              return (
                <li
                  key={part.asset ?? 'other'}
                  className="home-lit-callout"
                  data-side={point && size && point[0] < size.w / 2 ? 'start' : 'end'}
                  data-placed={point ? '' : undefined}
                  style={point ? ({ '--x': point[0], '--y': point[1] } as CSSProperties) : undefined}
                >
                  <span className="home-lit-callout__name">{part.asset ?? t('Sphere other')}</span>{' '}
                  <span className="home-lit-callout__pct">{`${part.percent}%`}</span>
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>
    </section>
  );
}
