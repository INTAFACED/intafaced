'use client';

import * as React from 'react';
import NumberFlow, { usePrefersReducedMotion } from '@number-flow/react';
import { motion } from '../theme/tokens.js';
import { HIDDEN_MASK, LTR, UNKNOWN, useHideBalances } from './numbers.js';
import { cn } from './cn.js';

/**
 * NumberFlow hands the value to Intl.NumberFormat, which formats a decimal STRING
 * exactly (no float round trip). Its published type only admits `number` when the
 * consumer's TypeScript lib predates ES2025 Intl, so the string is passed through a
 * named alias instead of being parsed into a float.
 */
type FlowValue = React.ComponentProps<typeof NumberFlow>['value'];
const asFlowValue = (decimal: string) => decimal as unknown as FlowValue;

/** The figure as plain text for assistive tech ("$12,481.29"); Intl formats the decimal string exactly. */
function spokenText(value: string, decimals: number, locales: string, prefix: string | undefined): string {
  const format = new Intl.NumberFormat(locales, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${prefix ?? ''}${format.format(value as unknown as number)}`;
}

export interface HeroNumberProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  /**
   * Decimal string, ALREADY rounded to `decimals` by the app's format helper
   * ("3489.16"). NumberFlow never rounds a second time: min and max fraction
   * digits are both `decimals`. `null` draws "—".
   */
  value: string | null;
  /** Fraction digits of `value`. */
  decimals: number;
  /** "$" for USD values. */
  prefix?: string;
  /** Muted unit after the number ("USD"), `text-md fg-2`, outside the animation. */
  unit?: string;
  /** `hero` 48/56 (Simple total value, coin price) or `hero-pro` 32/40 (Pro). */
  size?: 'hero' | 'hero-pro';
  locales?: string;
  /** Mask like Money does. Defaults to the HideBalancesProvider value. */
  hidden?: boolean;
  /** Prices are not balances: pass `sensitive={false}` to ignore hideBalances. */
  sensitive?: boolean;
}

/**
 * Big animated number (NumberFlow 0.6.2). It counts on load and on change only
 * and is static under prefers-reduced-motion (both NumberFlow's own setting and
 * `animated={false}` here). One per screen at most.
 */
export function HeroNumber({
  value,
  decimals,
  prefix,
  unit,
  size = 'hero',
  locales = 'en-US',
  hidden,
  sensitive = true,
  className,
  ...props
}: HeroNumberProps) {
  const fromContext = useHideBalances();
  const reduced = usePrefersReducedMotion();
  const masked = sensitive && (hidden ?? fromContext);
  const sizeClass = size === 'hero' ? 'text-hero' : 'text-hero-pro';
  // The unit is a ticker (USD, BTC), part of the figure, so it sits inside the left-to-right run.

  return (
    <span
      data-slot="hero-number"
      data-hidden={masked || undefined}
      className={cn('if-num inline-flex items-baseline gap-2 font-bold text-fg tabular-nums', sizeClass, className)}
      {...props}
      {...LTR}
    >
      {masked ? (
        <span aria-label="Hidden" className="font-normal tracking-wider">
          {prefix}
          {HIDDEN_MASK}
        </span>
      ) : value == null ? (
        <span className="text-fg-2">{UNKNOWN}</span>
      ) : (
        // NumberFlow draws digit strips inside a shadow root, which assistive tech reads as a jumble
        // ("01234567890..."), so the whole figure is one image with the real text as its name.
        <span role="img" aria-label={spokenText(value, decimals, locales, prefix)} className="inline-flex">
          <NumberFlow
            value={asFlowValue(value)}
            locales={locales}
            prefix={prefix}
            format={{ minimumFractionDigits: decimals, maximumFractionDigits: decimals }}
            animated={!reduced}
            transformTiming={{ duration: 450, easing: motion.ease }}
            spinTiming={{ duration: 450, easing: motion.ease }}
            opacityTiming={{ duration: 250, easing: 'ease-out' }}
          />
        </span>
      )}
      {unit ? <span className="text-md font-medium tracking-normal text-fg-2">{unit}</span> : null}
    </span>
  );
}
