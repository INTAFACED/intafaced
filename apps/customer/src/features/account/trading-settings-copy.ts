import { defineCopy } from '../../shared/i18n';

const en = {
  title: 'Trading',
  lead: 'How the order form behaves on this device.',
  summary: 'Show the order summary before sending',
  summaryLocked:
    'Always on. The summary can be turned off only for limit orders under a size cap, and no cap is set. Market orders always show it.',
  reset: 'Clear the amount after an order goes through',
  resetHint: 'Off keeps the amount, so the next order starts from the same size.',
  quickSizes: 'Quick sizes',
  quickSizesHint:
    'Amounts in the asset you trade, separated by commas, up to 6. They fill the Amount field and never send an order. Blank shows no quick sizes.',
  save: 'Save quick sizes',
  saved: 'Quick sizes saved.',
  invalid: 'Enter positive decimal amounts such as 0.1, 0.5, 1.',
  tooMany: 'Enter at most 6 quick sizes.',
  share: 'Share an order',
  shareOff: 'Not available. A shared order needs a share window, and none is set; no share record service exists.',
} as const;
export type TradingSettingsKey = keyof typeof en;
export const tradingSettingsCopy = defineCopy('account.trading.settings', en);
