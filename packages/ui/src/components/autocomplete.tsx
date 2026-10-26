'use client';

/*
 * Structure adapted from shadcn/ui (Base UI flavour) `combobox.tsx`.
 * Source: https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/base/ui/combobox.tsx
 * Commit: 30a58d4498f270af1c1e981a7d78a15cf5740841 · Licence: MIT · Copied: 2026-10-13
 * Changed: cn-* placeholder classes replaced with INTAFACED token classes (UI-SPEC 2); adapted to Base UI Autocomplete for the header search (480 px popup under a 32 px pill field).
 */
import * as React from 'react';
import { Autocomplete as AutocompletePrimitive } from '@base-ui/react/autocomplete';
import { Search } from 'lucide-react';
import { cn, popupMotion, popupSurface } from './cn.js';

/** The popup lines up with the whole pill field, not the bare <input> inside it. */
const AnchorContext = React.createContext<React.RefObject<HTMLDivElement | null> | null>(null);

/** Search with suggestions. Pass `items` (flat or grouped `{ value, items }[]`) on the Root. */
export function Autocomplete(props: AutocompletePrimitive.Root.Props<unknown>) {
  const anchorRef = React.useRef<HTMLDivElement | null>(null);
  return (
    <AnchorContext.Provider value={anchorRef}>
      <AutocompletePrimitive.Root {...props} />
    </AnchorContext.Provider>
  );
}

export interface AutocompleteInputProps extends AutocompletePrimitive.Input.Props {
  /** Right-hand hint inside the field, e.g. a `⌘K` badge. */
  hint?: React.ReactNode;
}

/** The 32 px pill field: `field` background, search icon, optional hint. */
export function AutocompleteInput({ className, hint, ...props }: AutocompleteInputProps) {
  const anchorRef = React.useContext(AnchorContext);
  return (
    <div
      ref={anchorRef}
      data-slot="autocomplete-input"
      className={cn(
        'flex h-8 w-60 items-center gap-2 rounded-pill bg-field px-3 text-sm transition-colors duration-(--if-t-fast) ease-if hover:bg-raised',
        'has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus',
        className,
      )}
    >
      <Search size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-fg-2" />
      <AutocompletePrimitive.Input className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-3" {...props} />
      {hint ? <span className="shrink-0 text-xs text-fg-3">{hint}</span> : null}
    </div>
  );
}

export function AutocompleteContent({
  className,
  children,
  sideOffset = 8,
  ...props
}: AutocompletePrimitive.Popup.Props & Pick<AutocompletePrimitive.Positioner.Props, 'sideOffset'>) {
  const anchorRef = React.useContext(AnchorContext);
  return (
    <AutocompletePrimitive.Portal>
      <AutocompletePrimitive.Positioner
        anchor={anchorRef ?? undefined}
        sideOffset={sideOffset}
        align="end"
        className="isolate z-50 outline-none"
      >
        <AutocompletePrimitive.Popup
          data-slot="autocomplete-content"
          className={cn(popupSurface, popupMotion, 'w-120 max-w-(--available-width) rounded-lg p-2 outline-none', className)}
          {...props}
        >
          {children}
        </AutocompletePrimitive.Popup>
      </AutocompletePrimitive.Positioner>
    </AutocompletePrimitive.Portal>
  );
}

export function AutocompleteList({ className, ...props }: AutocompletePrimitive.List.Props) {
  return (
    <AutocompletePrimitive.List
      data-slot="autocomplete-list"
      className={cn(
        'max-h-[min(24rem,var(--available-height))] overflow-y-auto overscroll-contain outline-none data-empty:hidden',
        className,
      )}
      {...props}
    />
  );
}

export function AutocompleteGroup(props: AutocompletePrimitive.Group.Props) {
  return <AutocompletePrimitive.Group data-slot="autocomplete-group" {...props} />;
}

export function AutocompleteGroupLabel({ className, ...props }: AutocompletePrimitive.GroupLabel.Props) {
  return (
    <AutocompletePrimitive.GroupLabel
      data-slot="autocomplete-group-label"
      className={cn('px-3 py-2 text-xs text-fg-2', className)}
      {...props}
    />
  );
}

export function AutocompleteItem({ className, ...props }: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={cn(
        'relative flex min-h-10 w-full cursor-default select-none items-center gap-3 rounded-sm px-3 text-base outline-none data-highlighted:bg-hover',
        className,
      )}
      {...props}
    />
  );
}

/** Shown when nothing matches: `No results for "{query}"`. Pass the sentence as children. */
export function AutocompleteEmpty({ className, ...props }: AutocompletePrimitive.Empty.Props) {
  return (
    <AutocompletePrimitive.Empty
      data-slot="autocomplete-empty"
      className={cn('px-3 py-4 text-base text-fg-2 empty:hidden', className)}
      {...props}
    />
  );
}
