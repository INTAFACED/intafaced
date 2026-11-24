import { Star } from 'lucide-react';
import { Button } from '@intafaced/ui/lit';
import { homeCopy } from './copy';

/**
 * Add to or remove from the watchlist (the device-stored favourites). A real button beside the row's link,
 * never inside it: a button in a link is invalid and the click would also follow the link.
 */
export function StarButton({ asset, on, toggle }: { asset: string; on: boolean; toggle: () => void }) {
  const { t } = homeCopy.useCopy();
  return (
    <Button
      tone="quiet"
      aria-pressed={on}
      aria-label={on ? t('Remove {asset} from watchlist', { asset }) : t('Add {asset} to watchlist', { asset })}
      onClick={toggle}
    >
      <Star size={16} aria-hidden="true" fill={on ? 'currentColor' : 'none'} />
    </Button>
  );
}
