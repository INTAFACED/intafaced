import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { coinCopy } from './copy';
import { CoinIcon } from './deps';

/** Smooth scrolling, unless the person asked their system for less motion. */
const behavior = (): ScrollBehavior =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

/**
 * The coin bar (UI-SPEC 5.5): 64 px, sticky under the top bar. Coin icon, name over ticker, the star, and on the right
 * the page's own sections. Sections are buttons that scroll, never `#` links; "About" is there only when the page has
 * an About section.
 */
export function CoinBar({
  asset,
  name,
  hasAbout,
  star,
}: {
  asset: string;
  name: string | null;
  hasAbout: boolean;
  /** Absent for a coin with no market: there is nothing to put on a watchlist. */
  star: { on: boolean; toggle: () => void } | null;
}) {
  const { t } = coinCopy.useCopy();
  const [section, setSection] = useState<'overview' | 'about'>('overview');

  useEffect(() => {
    const about = document.getElementById('coin-about');
    if (!hasAbout || !about || typeof IntersectionObserver === 'undefined') return;
    const watch = new IntersectionObserver((entries) => setSection(entries.some((e) => e.isIntersecting) ? 'about' : 'overview'), {
      rootMargin: '-30% 0px -50% 0px',
    });
    watch.observe(about);
    return () => watch.disconnect();
  }, [hasAbout]);

  const go = (target: 'overview' | 'about') => {
    if (target === 'overview') window.scrollTo({ top: 0, behavior: behavior() });
    else document.getElementById('coin-about')?.scrollIntoView({ behavior: behavior(), block: 'start' });
  };

  return (
    <div data-testid="coin-bar" className="coin-bar">
      <div className="coin-bar__id">
        <CoinIcon asset={asset} size={32} />
        <span className="coin-bar__names">
          <span className="coin-bar__name" data-testid="coin-name">
            {name ?? asset}
          </span>
          {name ? (
            <span data-testid="coin-bar__ticker" className="coin-bar__ticker">
              {asset}
            </span>
          ) : null}
        </span>
        {star ? (
          <button
            type="button"
            className={`coin-star ${star.on ? 'coin-star--on' : ''}`}
            aria-pressed={star.on}
            aria-label={star.on ? t('Remove {asset} from watchlist', { asset }) : t('Add {asset} to watchlist', { asset })}
            onClick={star.toggle}
          >
            <Star size={16} aria-hidden="true" fill={star.on ? 'currentColor' : 'none'} />
          </button>
        ) : null}
      </div>
      {hasAbout ? (
        <nav data-testid="coin-bar__tabs" className="coin-bar__tabs" aria-label={t('Coin sections')}>
          <button type="button" aria-current={section === 'overview' ? 'true' : undefined} onClick={() => go('overview')}>
            {t('Overview')}
          </button>
          <button type="button" aria-current={section === 'about' ? 'true' : undefined} onClick={() => go('about')}>
            {t('About')}
          </button>
        </nav>
      ) : null}
    </div>
  );
}
