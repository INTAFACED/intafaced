import { useMemo, useState, type ReactNode } from 'react';
import { Button, CoinMark, Field } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';

export interface PickerItem {
  asset: string;
  /** Plain name when we can say it without guessing. */
  name: string | null;
  /** A line under the ticker: what applies to this coin here (a limit). */
  note?: ReactNode;
  /** Right-aligned detail: a price, or a balance. */
  detail?: ReactNode;
  disabled?: boolean;
}

/**
 * Search-and-pick list in the kit's Sheet (UI-SPEC 5.9 item 3). Used for the coin on Buy and for From and To on Convert.
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
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? items.filter((item) => item.asset.toLowerCase().includes(needle) || (item.name ?? '').toLowerCase().includes(needle))
      : items;
  }, [items, query]);
  const close = () => {
    setQuery('');
    onOpenChange(false);
  };
  return (
    <Sheet open={open} title={title} onClose={close}>
      {/* Drawn only while open, as the old dialog was: a closed picker holds no rows a test or a reader could find. */}
      {open ? (
        <>
          <Field
            type="search"
            label={searchLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchLabel}
            autoComplete="off"
            spellCheck={false}
          />
          <ul data-testid="picker__list">
            {shown.map((item) => (
              <li key={item.asset}>
                <Button
                  tone="quiet"
                  block
                  data-testid="picker__row"
                  aria-pressed={item.asset === selected}
                  disabled={item.disabled}
                  onClick={() => {
                    onPick(item.asset);
                    close();
                  }}
                >
                  <CoinMark asset={item.asset} />
                  <span>
                    <span data-testid="picker__ticker">{item.asset}</span>
                    {item.name ? <span> {item.name}</span> : null}
                    {item.note ? <span> {item.note}</span> : null}
                  </span>
                  {item.detail ? <span>{item.detail}</span> : null}
                </Button>
              </li>
            ))}
          </ul>
          {shown.length === 0 ? (
            <p data-testid="picker__none" className="lt-hint">
              {noMatch(query.trim())}
            </p>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}
