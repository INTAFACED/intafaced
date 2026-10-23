import { useState } from 'react';
import { ArrowDown, ArrowUp, SlidersHorizontal } from 'lucide-react';
import { Dialog } from '../../shared/ui';
import { Button } from './deps';
import { homeCopy } from './copy';
import type { HomeLayout, SaveOutcome } from './tiles-data';
import { HOME_TILES, isHidden, moved, orderedTiles, withHidden, type HomeTileId } from './tiles';

const TILE_NAME = {
  started: 'Tile started',
  holdings: 'Tile holdings',
  activity: 'Tile activity',
  markets: 'Tile markets',
  movers: 'Tile movers',
  learn: 'Tile learn',
  'your-crypto': 'Tile your-crypto',
  watchlist: 'Tile watchlist',
} as const satisfies Record<HomeTileId, string>;

const OUTCOME = { saved: 'Layout saved', conflict: 'Layout conflict', 'not-saved': 'Layout not saved' } as const satisfies Record<
  SaveOutcome,
  string
>;

/**
 * "Customise Home" (HM-widgets-01): show, hide and order Home's tiles, or Reset to the shipped order. Each change is stored
 * on the account at once (compare-and-set), so another device shows the same Home; a change refused because another device
 * changed the layout first keeps that newer layout and says so.
 */
export function CustomiseHome({ home, mode }: { home: HomeLayout; mode: 'simple' | 'pro' }) {
  const { t } = homeCopy.useCopy();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const order = orderedTiles(home.layout, mode);

  const store = async (next: Parameters<HomeLayout['save']>[0]) => {
    setBusy(true);
    setOutcome(await home.save(next));
    setBusy(false);
  };

  return (
    <>
      <button type="button" className="home-customise" onClick={() => setOpen(true)}>
        <SlidersHorizontal size={14} aria-hidden="true" />
        {t('Customise Home')}
      </button>
      {open ? (
        <Dialog
          title={t('Customise Home')}
          onClose={() => {
            setOpen(false);
            setOutcome(null);
          }}
        >
          <p className="home-customise__hint">{t('Customise hint')}</p>
          <ul className="home-customise__list" aria-busy={busy || undefined}>
            {order.map((id, index) => {
              const name = t(TILE_NAME[id]);
              const hidden = isHidden(home.layout, id);
              const drawn = HOME_TILES.find((tile) => tile.id === id)?.pro !== false || mode === 'simple';
              return (
                <li key={id} className="home-customise__row" data-tile={id} data-hidden={hidden}>
                  <label className="home-customise__name">
                    <input
                      type="checkbox"
                      checked={!hidden}
                      disabled={busy}
                      aria-label={t('Show tile', { tile: name })}
                      onChange={(event) => void store(withHidden(home.layout, id, !event.target.checked))}
                    />
                    <span>{name}</span>
                    {hidden ? <small>{t('Tile hidden')}</small> : drawn ? null : <small>{t('Tile simple only')}</small>}
                  </label>
                  <span className="home-customise__moves">
                    <Button
                      variant="ghost"
                      size={28}
                      disabled={busy || index === 0}
                      aria-label={t('Move up', { tile: name })}
                      onClick={() => void store(moved(home.layout, id, -1, mode))}
                    >
                      <ArrowUp size={14} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size={28}
                      disabled={busy || index === order.length - 1}
                      aria-label={t('Move down', { tile: name })}
                      onClick={() => void store(moved(home.layout, id, 1, mode))}
                    >
                      <ArrowDown size={14} aria-hidden="true" />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="home-customise__hint">{t('Customise default unset')}</p>
          {outcome ? (
            <p className="home-customise__outcome" role="status" data-outcome={outcome}>
              {t(OUTCOME[outcome])}
            </p>
          ) : null}
          <div className="home-customise__foot">
            <Button variant="secondary" disabled={busy} onClick={() => void store(null)}>
              {t('Reset')}
            </Button>
            <Button
              onClick={() => {
                setOpen(false);
                setOutcome(null);
              }}
            >
              {t('Done')}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
