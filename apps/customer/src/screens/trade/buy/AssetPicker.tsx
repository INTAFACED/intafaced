import { useMemo, useState, type ReactNode } from 'react';
import { AssetIcon, Button } from '@intafaced/ui/lit';
import { TextField } from '@intafaced/ui/lit/templates';
import { KitDialog } from '../kit-parts';

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
 * Search-and-pick list in a kit dialog, drawn while `open` (UI-SPEC 5.9 item 3). Used for the coin on Buy and for From and To on Convert.
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
  if (!open) return null;
  return (
    <KitDialog title={title} onClose={() => onOpenChange(false)}>
      <TextField
        type="search"
        label={searchLabel}
        value={query}
        onChange={setQuery}
        placeholder={searchLabel}
        autoComplete="off"
        spellCheck={false}
      />
      <ul data-testid="picker__list" className="lt-stack">
        {shown.map((item) => (
          <li key={item.asset}>
            <Button
              data-testid="picker__row"
              block
              aria-pressed={item.asset === selected}
              disabled={item.disabled}
              onClick={() => {
                onPick(item.asset);
                onOpenChange(false);
              }}
            >
              <AssetIcon asset={item.asset} size="md" />
              <span className="lt-stack">
                <span data-testid="picker__ticker">{item.asset}</span>
                {item.name ? <span className="lt-hint">{item.name}</span> : null}
                {item.note ? <span className="lt-hint">{item.note}</span> : null}
              </span>
              {item.detail ? <span className="lt-mono">{item.detail}</span> : null}
            </Button>
          </li>
        ))}
      </ul>
      {shown.length === 0 ? (
        <p data-testid="picker__none" className="lt-hint">
          {noMatch(query.trim())}
        </p>
      ) : null}
    </KitDialog>
  );
}
