import { useId, useMemo, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { CoinIcon, Dialog, DialogContent, DialogHeader, DialogTitle } from './deps';

export interface PickerItem {
  asset: string;
  /** Plain name when we can say it without guessing. */
  name: string | null;
  /** Right-aligned detail: a price, or a balance. */
  detail?: ReactNode;
  disabled?: boolean;
}

/**
 * Search-and-pick list in a kit Dialog (UI-SPEC 5.9 item 3). Used for the coin on Buy and for From and To on Convert.
 * Rows are real buttons; the first match is reachable with Tab from the search box.
 */
export function AssetPicker({
  open,
  onOpenChange,
  title,
  searchLabel,
  noMatch,
  items,
  selected,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  searchLabel: string;
  /** Called with the query when nothing matches. */
  noMatch: (query: string) => string;
  items: readonly PickerItem[];
  selected: string | null;
  onPick: (asset: string) => void;
}) {
  const [query, setQuery] = useState('');
  const inputId = useId();
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? items.filter((item) => item.asset.toLowerCase().includes(needle) || (item.name ?? '').toLowerCase().includes(needle))
      : items;
  }, [items, query]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="picker">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <label className="picker__search" htmlFor={inputId}>
          <Search size={16} aria-hidden="true" />
          <input
            id={inputId}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchLabel}
            aria-label={searchLabel}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <ul data-testid="picker__list" className="picker__list">
          {shown.map((item) => (
            <li key={item.asset}>
              <button
                type="button"
                data-testid="picker__row"
                className="picker__row"
                aria-pressed={item.asset === selected}
                disabled={item.disabled}
                onClick={() => {
                  onPick(item.asset);
                  setQuery('');
                  onOpenChange(false);
                }}
              >
                <CoinIcon asset={item.asset} size={32} />
                <span className="picker__names">
                  <span data-testid="picker__ticker" className="picker__ticker">
                    {item.asset}
                  </span>
                  {item.name ? <span className="picker__name">{item.name}</span> : null}
                </span>
                {item.detail ? <span className="picker__detail">{item.detail}</span> : null}
              </button>
            </li>
          ))}
        </ul>
        {shown.length === 0 ? (
          <p data-testid="picker__none" className="picker__none">
            {noMatch(query.trim())}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
