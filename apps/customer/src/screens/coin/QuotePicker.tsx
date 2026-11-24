import { Select } from '@intafaced/ui/lit';
import { coinCopy } from './copy';

/** The "price in USDT / USDC" choice: the kit's select. Drawn only when the coin has more than one quote to choose from. */
export function QuotePicker({ quotes, quote, onQuote }: { quotes: readonly string[]; quote: string; onQuote: (quote: string) => void }) {
  const { t } = coinCopy.useCopy();
  if (quotes.length < 2) return null;
  return (
    <Select
      label={t('Price in {quote}', { quote })}
      aria-label={t('Price in {quote}', { quote })}
      data-testid="quote-pill"
      options={quotes}
      value={quote}
      onChange={onQuote}
    />
  );
}
