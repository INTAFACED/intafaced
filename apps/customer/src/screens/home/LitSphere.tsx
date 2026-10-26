import { FX_PRESETS, LitFx } from '@intafaced/ui/lit/fx';
import poster from '@intafaced/ui/lit/fx/posters/sphere-home-blue.jpg';
import { isLook } from '../../app/look';
import type { HomePortfolio, Loadable } from './deps';
import { sphereShares } from './lit-shares';
import './lit-spike.css';

const PRESET = FX_PRESETS['sphere-home-blue'];

/**
 * Redesign stage A0: the light sphere under the total, only with the Lit glass look on (`?look=lit`). Decorative:
 * the holdings it splits into are listed in text on this screen. Off-look Home renders nothing here.
 */
export function LitSphere({ portfolio }: { portfolio: Loadable<HomePortfolio> }) {
  if (!isLook('lit')) return null;
  const shares = portfolio.status === 'ready' ? sphereShares(portfolio.data.holdings) : null;
  return (
    <div className="home-lit-sphere">
      <LitFx kind="sphere" options={shares ? { ...PRESET.options, shares } : PRESET.options} poster={poster} />
    </div>
  );
}
