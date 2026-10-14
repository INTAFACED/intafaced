/**
 * The order types the ticket shows but the back end does not accept yet.
 *
 * At origin/main the spot order path takes market and limit only: a stop, stop-limit or take-profit order is refused
 * (`trade.order_type_unsupported`), and OCO, trailing, iceberg and TWAP are refused or switched off. Until each lands,
 * its tab shows the form with a Preview chip, and submitting opens the "nothing was sent" sheet. These forms never build an
 * order, never call the service and never show a number that could be mistaken for a real one.
 */
export type AdvancedKind = 'stop' | 'stop-limit' | 'tp-sl' | 'trailing' | 'oco' | 'iceberg' | 'twap';

export const ADVANCED_KINDS: readonly AdvancedKind[] = ['stop', 'stop-limit', 'tp-sl', 'trailing', 'oco', 'iceberg', 'twap'];

/**
 * Kinds the service accepts today. Empty on purpose: when the back end takes one, it moves here and its tab becomes a
 * live form (its own PR, with its own money review).
 */
export const LIVE_ADVANCED_KINDS: readonly AdvancedKind[] = [];

export const isPreviewKind = (kind: AdvancedKind): boolean => !LIVE_ADVANCED_KINDS.includes(kind);

export type FieldUnit = 'quote' | 'base' | 'percent' | 'minutes' | 'count';
export type FieldLabel =
  | 'Trigger price'
  | 'Limit price'
  | 'Take-profit price'
  | 'Stop-loss price'
  | 'Stop-limit price'
  | 'Callback rate'
  | 'Activation price'
  | 'Visible amount'
  | 'Duration'
  | 'Slices'
  | 'Amount'
  | 'Price';
export interface PreviewField {
  key: string;
  label: FieldLabel;
  unit: FieldUnit;
}

export const FIELDS: Record<AdvancedKind, readonly PreviewField[]> = {
  stop: [
    { key: 'trigger', label: 'Trigger price', unit: 'quote' },
    { key: 'amount', label: 'Amount', unit: 'base' },
  ],
  'stop-limit': [
    { key: 'trigger', label: 'Trigger price', unit: 'quote' },
    { key: 'limit', label: 'Limit price', unit: 'quote' },
    { key: 'amount', label: 'Amount', unit: 'base' },
  ],
  'tp-sl': [
    { key: 'tp', label: 'Take-profit price', unit: 'quote' },
    { key: 'sl', label: 'Stop-loss price', unit: 'quote' },
    { key: 'amount', label: 'Amount', unit: 'base' },
  ],
  trailing: [
    { key: 'callback', label: 'Callback rate', unit: 'percent' },
    { key: 'activation', label: 'Activation price', unit: 'quote' },
    { key: 'amount', label: 'Amount', unit: 'base' },
  ],
  oco: [
    { key: 'limit', label: 'Limit price', unit: 'quote' },
    { key: 'trigger', label: 'Trigger price', unit: 'quote' },
    { key: 'stopLimit', label: 'Stop-limit price', unit: 'quote' },
    { key: 'amount', label: 'Amount', unit: 'base' },
  ],
  iceberg: [
    { key: 'price', label: 'Price', unit: 'quote' },
    { key: 'amount', label: 'Amount', unit: 'base' },
    { key: 'visible', label: 'Visible amount', unit: 'base' },
  ],
  twap: [
    { key: 'amount', label: 'Amount', unit: 'base' },
    { key: 'duration', label: 'Duration', unit: 'minutes' },
    { key: 'slices', label: 'Slices', unit: 'count' },
  ],
};
