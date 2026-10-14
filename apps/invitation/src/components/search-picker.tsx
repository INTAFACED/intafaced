'use client';

/**
 * One searchable picker (Base UI Combobox) for currency, country and multi-country answers.
 * Single mode shows the chosen option in the field; multiple mode shows removable chips.
 * Popup styling lives in outreach.css (`.picker-*`) because Base UI portals it outside the page root.
 */
import { useRef, type RefObject } from 'react';
import { Combobox } from '@base-ui/react/combobox';

export interface PickerOption {
  value: string;
  label: string;
}
export interface PickerGroup {
  /** Unique key for the group (also its accessible name when `label` is set). */
  value: string;
  label?: string;
  items: PickerOption[];
}

const same = (a: PickerOption, b: PickerOption) => a.value === b.value;
const toLabel = (item: PickerOption | null) => item?.label ?? '';

function Chevron() {
  return (
    <svg className="picker-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none">
      <path d="m4 6.25 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none">
      <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Popup({
  groups,
  emptyText,
  anchor,
  align = 'start',
}: {
  groups: PickerGroup[];
  emptyText: string;
  anchor: RefObject<HTMLElement | null>;
  align?: 'start' | 'end';
}) {
  return (
    <Combobox.Portal>
      <Combobox.Positioner className="picker-positioner" anchor={anchor} align={align} sideOffset={8} collisionPadding={12}>
        <Combobox.Popup className="picker-popup">
          <Combobox.Empty className="picker-empty">{emptyText}</Combobox.Empty>
          <Combobox.List className="picker-list">
            {(group: PickerGroup) => (
              <Combobox.Group key={group.value} items={group.items} className="picker-group">
                {group.label && <Combobox.GroupLabel className="picker-group-label">{group.label}</Combobox.GroupLabel>}
                <Combobox.Collection>
                  {(item: PickerOption) => (
                    <Combobox.Item key={item.value} value={item} className="picker-item">
                      <span className="picker-item-label">{item.label}</span>
                      <Combobox.ItemIndicator className="picker-item-check">
                        <Check />
                      </Combobox.ItemIndicator>
                    </Combobox.Item>
                  )}
                </Combobox.Collection>
              </Combobox.Group>
            )}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  );
}

interface CommonProps {
  id: string;
  label: string;
  hideLabel?: boolean;
  placeholder?: string;
  groups: PickerGroup[];
  disabled?: boolean;
  emptyText?: string;
  /** Which edge of the field the popup lines up with. A field in a narrow right-hand column opens with `end` so the popup grows inwards. */
  align?: 'start' | 'end';
}

export function SearchPicker({
  id,
  label,
  hideLabel,
  placeholder,
  groups,
  value,
  onValueChange,
  disabled,
  emptyText = 'No match. Try a name or a code.',
  align = 'start',
}: CommonProps & { value: PickerOption | null; onValueChange: (value: PickerOption | null) => void }) {
  const anchor = useRef<HTMLDivElement | null>(null);
  return (
    <div className="picker-field">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'picker-label'}>
        {label}
      </label>
      <Combobox.Root
        items={groups}
        value={value}
        onValueChange={(next) => onValueChange(next as PickerOption | null)}
        itemToStringLabel={toLabel}
        isItemEqualToValue={same}
        disabled={disabled}
        autoHighlight
      >
        <div className="picker-shell" ref={anchor} data-disabled={disabled || undefined}>
          <Combobox.Input
            id={id}
            className="picker-input"
            placeholder={placeholder}
            autoComplete="off"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Combobox.Trigger className="picker-trigger" aria-label={`Show ${label.toLowerCase()} options`}>
            <Chevron />
          </Combobox.Trigger>
        </div>
        <Popup groups={groups} emptyText={emptyText} anchor={anchor} align={align} />
      </Combobox.Root>
    </div>
  );
}

export function SearchPickerMulti({
  id,
  label,
  hideLabel,
  placeholder,
  groups,
  value,
  onValueChange,
  disabled,
  emptyText = 'No match. Try a name.',
  align = 'start',
}: CommonProps & { value: PickerOption[]; onValueChange: (value: PickerOption[]) => void }) {
  const anchor = useRef<HTMLDivElement | null>(null);
  return (
    <div className="picker-field">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'picker-label'}>
        {label}
      </label>
      <Combobox.Root
        items={groups}
        multiple
        value={value}
        onValueChange={(next) => onValueChange(next as PickerOption[])}
        itemToStringLabel={toLabel}
        isItemEqualToValue={same}
        disabled={disabled}
        autoHighlight
      >
        <Combobox.Chips className="picker-shell picker-chips" ref={anchor} data-disabled={disabled || undefined}>
          <Combobox.Value>
            {(selected: PickerOption[]) => (
              <>
                {selected.map((item) => (
                  <Combobox.Chip key={item.value} className="picker-chip" aria-label={item.label}>
                    <span>{item.label}</span>
                    <Combobox.ChipRemove className="picker-chip-remove" aria-label={`Remove ${item.label}`}>
                      <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" fill="none">
                        <path d="m3 3 6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </Combobox.ChipRemove>
                  </Combobox.Chip>
                ))}
                <Combobox.Input
                  id={id}
                  className="picker-input picker-input-chips"
                  placeholder={selected.length ? 'Add another' : placeholder}
                  autoComplete="off"
                />
              </>
            )}
          </Combobox.Value>
        </Combobox.Chips>
        <Popup groups={groups} emptyText={emptyText} anchor={anchor} align={align} />
      </Combobox.Root>
    </div>
  );
}
