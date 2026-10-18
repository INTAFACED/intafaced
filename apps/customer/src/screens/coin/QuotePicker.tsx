import { coinCopy } from './copy';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './deps';

/** The "price in USDT / USDC" pill. Drawn only when the coin has more than one quote to choose from. */
export function QuotePicker({ quotes, quote, onQuote }: { quotes: readonly string[]; quote: string; onQuote: (quote: string) => void }) {
  const { t } = coinCopy.useCopy();
  if (quotes.length < 2) return null;
  return (
    <Select
      items={Object.fromEntries(quotes.map((q) => [q, q]))}
      value={quote}
      onValueChange={(next) => typeof next === 'string' && onQuote(next)}
    >
      <SelectTrigger size={32} aria-label={t('Price in {quote}', { quote })} data-testid="quote-pill" className="rounded-pill">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {quotes.map((q) => (
          <SelectItem key={q} value={q}>
            {q}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
