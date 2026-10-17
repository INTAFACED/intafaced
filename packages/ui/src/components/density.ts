/**
 * Density, shared by every kit component that has two sizes.
 *
 * `comfortable` (default) is the 44 px control of DESIGN.md. `dense` is the pro-desk size: 32 px
 * controls, 28 px table headers. The pixel values are tokens (`--if-ctl-h`, `--if-ctl-h-dense`,
 * `--if-table-row-h`, ...), so changing a size is a tokens.ts edit and never a component edit.
 */
export type Density = 'dense' | 'comfortable';

export const DEFAULT_DENSITY: Density = 'comfortable';

/** Control height (inputs, selects, buttons that sit in a form row). */
export const controlHeight: Record<Density, string> = {
  dense: 'h-(--if-ctl-h-dense)',
  comfortable: 'h-(--if-ctl-h)',
};

/** Text size that goes with each density. Dense uses the 13 px `sm`, comfortable the 14 px `base`. */
export const controlText: Record<Density, string> = {
  dense: 'text-sm',
  comfortable: 'text-base',
};

/** Horizontal padding that goes with each density. */
export const controlPadX: Record<Density, string> = {
  dense: 'px-2',
  comfortable: 'px-3',
};
