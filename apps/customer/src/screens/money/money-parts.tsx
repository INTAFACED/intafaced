import { Change, HeroFigure, type FigurePart } from '@intafaced/ui/lit';
import { formatMoneyToParts, formatNumberToParts } from '@intafaced/i18n/format';

/**
 * The Money room's figures, drawn from the Volt kit: the one hero total, a figure as text that hides with balances, and a
 * change line. Every figure arrives as a decimal string or the screen's own formatted text; nothing is held in a number.
 */

const LOCALE = 'en-US';

/** A USD total to the cent ("$12,481.91"), half-up, as the kit's figure parts. */
export function usdParts(value: string): FigurePart[] {
  return formatMoneyToParts(value, 'USD', LOCALE, { minFractionDigits: 2, maxFractionDigits: 2 });
}

/** A BTC total to 8 places ("₿0.18406000"), as the kit's figure parts. */
export function btcParts(value: string): FigurePart[] {
  return [{ type: 'currency', value: '₿' }, ...formatNumberToParts(value, LOCALE, { minFractionDigits: 8, maxFractionDigits: 8 })];
}

/** The mask a hidden balance shows in a row. */
const MASK = '••••';

/**
 * The room's one hero total (the kit's HeroFigure). Its spoken text is the figure itself, read as one image, so assistive
 * tech never reads the parts apart; hidden, it is the kit's mask read as "Hidden". No figure is a dash, never a zero.
 */
export function HeroTotal({ parts, hidden, unknownLabel }: { parts: readonly FigurePart[] | null; hidden: boolean; unknownLabel: string }) {
  return (
    <span data-slot="hero-number" data-hidden={hidden || undefined}>
      {hidden || parts === null ? (
        <HeroFigure parts={parts} hidden={hidden} hiddenLabel="Hidden" unknownLabel={unknownLabel} />
      ) : (
        <span role="img" aria-label={parts.map((part) => part.value).join('')}>
          <HeroFigure parts={parts} hiddenLabel="Hidden" unknownLabel={unknownLabel} />
        </span>
      )}
    </span>
  );
}

/**
 * A figure already formatted by the screen ("$6,781.24", "0.1 BTC"): the mask while balances are hidden, a dash when
 * there is none. `slot` keeps the kind of figure it is: a value (`money`) or an amount of a coin (`amount`).
 */
export function Shown({
  text,
  hidden,
  slot = 'money',
  testId,
}: {
  text: string | null;
  hidden: boolean;
  slot?: 'money' | 'amount';
  testId?: string;
}) {
  return (
    <span data-slot={slot} data-hidden={hidden || undefined} data-testid={testId} dir="ltr">
      {hidden ? MASK : (text ?? '—')}
    </span>
  );
}

/** A change line with its arrow and its direction in words (the kit's Change); the mask while balances are hidden. */
export function ChangeLine({
  text,
  sign,
  hidden,
  spoken,
}: {
  text: string | null;
  /** The change's sign, from its decimal string: up, down or none. */
  sign: 'up' | 'down' | 'flat';
  hidden: boolean;
  spoken: Record<'up' | 'down' | 'flat', string>;
}) {
  if (text === null) return <span data-slot="change-text">—</span>;
  return (
    <span data-slot="change-text">
      <Change text={hidden ? MASK : text} dir={hidden ? 'flat' : sign} spoken={hidden ? '' : spoken[sign]} />
    </span>
  );
}

/** The direction of a signed decimal string. */
export function signOf(value: string | null): 'up' | 'down' | 'flat' {
  if (value === null) return 'flat';
  const trimmed = value.trim();
  if (trimmed.startsWith('-') || trimmed.startsWith('−')) return /[1-9]/.test(trimmed) ? 'down' : 'flat';
  return /[1-9]/.test(trimmed) ? 'up' : 'flat';
}
