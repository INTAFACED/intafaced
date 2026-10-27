import { describe, expect, it } from 'vitest';
import { FIAT_CURRENCIES } from '@intafaced/config/fiat';
import {
  AmountFormatError,
  formatCompact,
  formatCompactToParts,
  formatIban,
  formatMoney,
  formatMoneyToParts,
  formatNumber,
  formatNumberToParts,
  formatPercent,
  formatPercentToParts,
  isolate,
  joinParts,
  shortenIdentifier,
  type Rounding,
} from './format.js';
import { SUPPORTED_LOCALES, intlTagFor } from './locales.js';

// ── Signs, rounding and parts ───────────────────────────────────────────────

describe('rounding', () => {
  it('floors with "floor", so a balance never shows more than is there, overdrawn or not', () => {
    expect(formatMoney('0.129', 'USD', 'en', { rounding: 'floor' })).toBe('$0.12');
    expect(formatMoney('-0.121', 'USD', 'en', { rounding: 'floor' })).toBe('-$0.13');
    expect(formatMoney('-0.12', 'USD', 'en', { rounding: 'floor' })).toBe('-$0.12');
    expect(formatMoney('-0.001', 'USD', 'en', { rounding: 'floor' })).toBe('-$0.01');
    expect(formatMoney('9.999', 'USD', 'en', { rounding: 'floor' })).toBe('$9.99');
    expect(formatMoney('-9.991', 'USD', 'en', { rounding: 'floor' })).toBe('-$10.00');
    expect(formatMoney('0.123456789', 'BTC', 'en', { rounding: 'floor' })).toBe('0.12345678 BTC');
    expect(formatNumber('1.99', 'en', { maxFractionDigits: 0, rounding: 'floor' })).toBe('1');
    expect(formatNumber(1.99, 'en', { maxFractionDigits: 0, rounding: 'floor' })).toBe('1');
    expect(formatPercent('0.123456', 'en', { rounding: 'floor' })).toBe('12.34%');
  });

  it('keeps half-up as the default', () => {
    expect(formatMoney('0.125', 'USD', 'en')).toBe('$0.13');
    expect(formatMoney('-0.125', 'USD', 'en')).toBe('-$0.13');
  });

  it('never shows a minus on a figure whose shown digits are all zero', () => {
    expect(formatMoney('-0.001', 'USD', 'en')).toBe('$0.00');
    expect(formatMoney('-0.004', 'EUR', 'de')).toMatch(/^0,00\s€$/);
    expect(formatNumber('-0.0001', 'en', { maxFractionDigits: 2 })).toBe('0');
    expect(formatPercent('-0.00001', 'en')).toBe('0%');
  });
});

describe('signDisplay', () => {
  it('shows a plus on gains and a minus on losses for change and P&L', () => {
    expect(formatMoney('134.46', 'USD', 'en', { signDisplay: 'exceptZero' })).toBe('+$134.46');
    expect(formatMoney('-12', 'USD', 'en', { signDisplay: 'exceptZero' })).toBe('-$12.00');
    expect(formatMoney('0', 'USD', 'en', { signDisplay: 'exceptZero' })).toBe('$0.00');
    expect(formatMoney('0', 'USD', 'en', { signDisplay: 'always' })).toBe('+$0.00');
    expect(formatMoney('-12', 'USD', 'en', { signDisplay: 'never' })).toBe('$12.00');
    expect(formatMoney('0.5', 'USDC', 'en', { signDisplay: 'exceptZero' })).toBe('+0.5 USDC');
    expect(formatNumber(5, 'en', { signDisplay: 'exceptZero' })).toBe('+5');
  });

  it('keeps the plural a currency name has, when the integer part is zero', () => {
    expect(formatMoney('-0.5', 'USD', 'en', { display: 'name' })).toBe('-0.50 US dollars');
    expect(formatMoney('0', 'USD', 'en', { display: 'name', signDisplay: 'always' })).toBe('+0.00 US dollars');
  });

  it("takes a currency name's plural from the shown figure, fraction included", () => {
    expect(formatMoney('1.5', 'USD', 'en', { display: 'name' })).toBe('1.50 US dollars');
    expect(formatMoney('1', 'USD', 'en', { display: 'name', maxFractionDigits: 0 })).toBe('1 US dollar');
    expect(formatMoney('1.5', 'EUR', 'ru', { display: 'name' })).toBe(
      new Intl.NumberFormat(intlTagFor('ru'), { style: 'currency', currency: 'EUR', currencyDisplay: 'name' }).format(1.5),
    );
    // A million or more keeps its plural operands: French says "de" before a round million.
    expect(formatMoney('1000000', 'EUR', 'fr', { display: 'name', maxFractionDigits: 0 })).toBe(
      new Intl.NumberFormat(intlTagFor('fr'), {
        style: 'currency',
        currency: 'EUR',
        currencyDisplay: 'name',
        maximumFractionDigits: 0,
      }).format(1e6),
    );
    expect(formatMoney('123456789000001', 'USD', 'ru', { display: 'name', maxFractionDigits: 0 })).toMatch(/доллар США$/);
  });

  it('matches Intl on currency names wherever Intl is still exact (300 seeded cases)', () => {
    const next = rng(6457);
    const locales = ['en', 'ru', 'pl', 'fr', 'ar', 'cs', 'lv', 'he'];
    for (let i = 0; i < 300; i++) {
      const locale = locales[Math.floor(next() * locales.length)] ?? 'en';
      const whole = String(Math.floor(next() * 10 ** Math.floor(next() * 9)));
      const digits = Math.floor(next() * 3);
      const frac = digits ? String(Math.floor(next() * 10 ** digits)).padStart(digits, '0') : '';
      const amount = frac ? `${whole}.${frac}` : whole;
      const expected = new Intl.NumberFormat(intlTagFor(locale), {
        style: 'currency',
        currency: 'EUR',
        currencyDisplay: 'name',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(Number(amount));
      expect(formatMoney(amount, 'EUR', locale, { display: 'name', minFractionDigits: digits, maxFractionDigits: digits }), amount).toBe(
        expected,
      );
    }
  });

  it('pluralises a currency name after rounding carries into the integer, and past a million', () => {
    expect(formatMoney('0.999', 'USD', 'en', { display: 'name' })).toBe('1.00 US dollars');
    expect(formatMoney('0.6', 'USD', 'en', { display: 'name', maxFractionDigits: 0 })).toBe('1 US dollar');
    const exact = (n: number, locale: string, digits: number): string =>
      new Intl.NumberFormat(intlTagFor(locale), {
        style: 'currency',
        currency: 'EUR',
        currencyDisplay: 'name',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(n);
    for (const [amount, n] of [
      ['1234567.5', 1234567.5],
      ['21000001', 21000001],
      ['5000000', 5000000],
      ['1000002.25', 1000002.25],
    ] as const) {
      const digits = amount.split('.')[1]?.length ?? 0;
      for (const locale of ['ru', 'pl', 'fr', 'lv', 'cs']) {
        expect(
          formatMoney(amount, 'EUR', locale, { display: 'name', minFractionDigits: digits, maxFractionDigits: digits }),
          `${amount} ${locale}`,
        ).toBe(exact(n, locale, digits));
      }
    }
  });

  it('refuses a currency name with more than six fraction digits shown, not asked for', () => {
    expect(() => formatMoney('1.1234567', 'USD', 'en', { display: 'name', maxFractionDigits: 7 })).toThrow(AmountFormatError);
    expect(formatMoney('1.5', 'USD', 'en', { display: 'name', maxFractionDigits: 18 })).toBe('1.50 US dollars');
  });

  it("groups by the locale's own rule: Polish groups from five digits", () => {
    expect(formatMoney('8906.4', 'EUR', 'pl')).toBe(
      new Intl.NumberFormat(intlTagFor('pl'), { style: 'currency', currency: 'EUR' }).format(8906.4),
    );
    expect(formatMoney('8906.4', 'EUR', 'pl')).not.toMatch(/8\s906/);
    expect(formatMoney('89064', 'EUR', 'pl')).toMatch(/89\s064/);
    expect(formatNumber('8906', 'pl', { useGrouping: false })).toBe('8906');
    expect(formatNumber('1234', 'en')).toBe('1,234');
  });

  it('refuses a percent of a ratio too big for toFixed, or one that is not finite', () => {
    expect(() => formatPercent(1e21, 'en')).toThrow(AmountFormatError);
    expect(formatPercent('10000000000000000000', 'en')).toBe('1,000,000,000,000,000,000,000%');
    expect(() => formatPercent(Number.NaN, 'en')).toThrow(AmountFormatError);
    expect(() => formatPercent(Number.POSITIVE_INFINITY, 'en')).toThrow(AmountFormatError);
  });

  it('puts the sign where the locale puts it, even when the integer part is zero', () => {
    // German and French put the sign before the number and the symbol after.
    expect(formatMoney('-0.5', 'USD', 'de')).toMatch(/^-0,50\s\$$/);
    expect(formatMoney('0.5', 'EUR', 'de', { signDisplay: 'exceptZero' })).toMatch(/^\+0,50\s€$/);
    // Arabic (Egypt) wraps the sign in direction marks; the marks stay.
    const parts = formatMoneyToParts('-0.5', 'USD', 'ar');
    const types = parts.map((p) => p.type);
    expect(types.filter((t) => t === 'minusSign')).toHaveLength(1);
    expect(types.indexOf('minusSign')).toBeLessThan(types.indexOf('integer'));
    expect(parts.find((p) => p.type === 'integer')?.value).toBe('٠');
    expect(parts.find((p) => p.type === 'fraction')?.value).toBe('٥٠');
    expect(joinParts(parts)).toContain('\u061c');
  });

  it('keeps the old boolean spelling on percent', () => {
    expect(formatPercent('0.05', 'en', { signDisplay: true })).toBe('+5%');
    expect(formatPercent('0.05', 'en', { signDisplay: 'exceptZero' })).toBe('+5%');
    expect(formatPercent('-0.0532', 'tr')).toBe('-%5,32');
    expect(formatPercent('0.0532', 'fr', { signDisplay: 'exceptZero' })).toMatch(/^\+5,32[\s  ]%$/);
    expect(formatPercent('12.345', 'en')).toBe('1,234.5%');
  });
});

describe('parts', () => {
  it('split the figure so the fraction and currency can be styled apart', () => {
    expect(formatMoneyToParts('1234.5', 'USD', 'en')).toEqual([
      { type: 'currency', value: '$' },
      { type: 'integer', value: '1' },
      { type: 'group', value: ',' },
      { type: 'integer', value: '234' },
      { type: 'decimal', value: '.' },
      { type: 'fraction', value: '50' },
    ]);
    expect(formatMoneyToParts('2.5', 'USDC', 'en')).toEqual([
      { type: 'integer', value: '2' },
      { type: 'decimal', value: '.' },
      { type: 'fraction', value: '5' },
      { type: 'literal', value: ' ' },
      { type: 'unit', value: 'USDC' },
    ]);
    expect(joinParts(formatNumberToParts('-1234.5', 'de'))).toBe('-1.234,5');
    expect(formatPercentToParts('0.0432', 'en').map((p) => p.type)).toEqual(['integer', 'decimal', 'fraction', 'percentSign']);
  });
});

describe('formatCompact', () => {
  it('shortens volumes in the locale’s own words', () => {
    expect(formatCompact('1234567.89', 'en', { currency: 'USD' })).toBe('$1.2M');
    expect(formatCompact('1234567.89', 'de', { currency: 'USD' })).toMatch(/^1,2\sMio\.\s\$$/);
    expect(formatCompact('-98765432', 'en', { currency: 'USDC' })).toBe('-99M USDC');
    expect(formatCompact('25000', 'en')).toBe('25K');
    expect(formatCompact('25000', 'en', { signDisplay: 'exceptZero' })).toBe('+25K');
  });

  it('rounds exactly at the boundary although it drops the fraction', () => {
    expect(formatCompact('1249.999999999999999999', 'en', { currency: 'USD' })).toBe('$1.2K');
    expect(formatCompact('1250', 'en', { currency: 'USD' })).toBe('$1.3K');
    expect(formatCompact('999999.999999999999', 'en')).toBe('1M');
  });

  it('rounds, not cuts, where the locale writes every digit of a thousand', () => {
    expect(formatCompact('1234.56', 'de', { currency: 'EUR' })).toMatch(/^1235\s€$/);
    expect(formatCompact('1234.7', 'ja')).toBe('1235');
    expect(formatCompact('12345.6', 'ja')).toBe('1.2万');
  });

  it('switches to the short form at the shown value, not the raw one', () => {
    expect(formatCompact('999.996', 'en', { currency: 'USD' })).toBe('$1K');
    expect(formatCompact('999.994', 'en', { currency: 'USD' })).toBe('$999.99');
    expect(formatCompactToParts('-98765432', 'en', { currency: 'USDC' }).map((p) => p.type)).toEqual([
      'minusSign',
      'integer',
      'compact',
      'literal',
      'unit',
    ]);
  });

  it('answers with the standard form below a thousand', () => {
    expect(formatCompact('999.5', 'en', { currency: 'USD' })).toBe('$999.50');
    expect(formatCompact('12.3456', 'en')).toBe('12.35');
    expect(formatCompact('0.5', 'en', { currency: 'BTC' })).toBe('0.5 BTC');
  });
});

describe('direction and identifiers', () => {
  it('isolates a run of text for plain-text sinks', () => {
    expect(isolate('0x12ab…9f3c')).toBe('\u20660x12ab…9f3c\u2069');
    expect(isolate('محمد', 'auto')).toBe('\u2068محمد\u2069');
    expect(isolate('שלום', 'rtl')).toBe('\u2067שלום\u2069');
  });

  it('prints an IBAN in groups of four', () => {
    expect(formatIban('gb33bukb20201555555555')).toBe('GB33 BUKB 2020 1555 5555 55');
    expect(formatIban('DE89 3704 0044 0532 0130 00')).toBe('DE89 3704 0044 0532 0130 00');
  });

  it('shortens an address in the middle and keeps both ends', () => {
    expect(shortenIdentifier('0x52908400098527886E0F7030069857D2E4169EE7')).toBe('0x5290…9EE7');
    expect(shortenIdentifier('0x123456789')).toBe('0x123456789');
    expect(shortenIdentifier('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 4, 6)).toBe('bc1q…wf5mdq');
  });
});

// ── Properties: long decimals, every locale, assets Intl doesn't know ───────

/** Seeded so a failure names the case that broke and reruns the same. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCALE = 10n ** 18n;

function digits(next: () => number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(Math.floor(next() * 10));
  return out;
}

interface Case {
  readonly amount: string;
  readonly currency: string;
  readonly locale: string;
  readonly maxFrac: number;
  readonly rounding: Rounding;
}

const TICKERS = ['USDC', 'USDT', 'BTC', 'ETH', 'IFC', 'WBTC', 'SHIB', 'DAI', 'stETH', 'PEPE2'];
const FIAT = FIAT_CURRENCIES.map((c) => c.code);

function makeCase(next: () => number): Case {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const whole = digits(next, 1 + Math.floor(next() * 38)).replace(/^0+(?=\d)/, '');
  const frac = digits(next, Math.floor(next() * 19));
  const sign = next() < 0.4 ? '-' : '';
  return {
    amount: `${sign}${whole}${frac ? `.${frac}` : ''}`,
    currency: next() < 0.5 ? pick(TICKERS) : pick(FIAT),
    locale: pick(SUPPORTED_LOCALES).code,
    maxFrac: Math.floor(next() * 19),
    rounding: next() < 0.5 ? 'half-up' : 'floor',
  };
}

/** The input as an 18-place scaled bigint, absolute, and its sign. */
function scaled(amount: string): { negative: boolean; abs: bigint } {
  const negative = amount.startsWith('-');
  const [whole = '0', frac = ''] = amount.replace(/^[+-]/, '').split('.');
  return { negative, abs: BigInt(whole) * SCALE + BigInt(frac.padEnd(18, '0').slice(0, 18) || '0') };
}

/** Reads the shown figure back as a scaled bigint from the locale's own digit glyphs, using the parts' types. */
function shownValue(parts: ReturnType<typeof formatMoneyToParts>, tag: string): bigint {
  const glyphs = Array.from({ length: 10 }, (_, d) => new Intl.NumberFormat(tag, { useGrouping: false }).format(d));
  const ascii = (text: string): string =>
    [...text]
      .map((ch) => {
        const d = glyphs.indexOf(ch);
        if (d < 0) throw new Error(`not a digit of ${tag}: ${JSON.stringify(ch)}`);
        return String(d);
      })
      .join('');
  const whole = ascii(
    parts
      .filter((p) => p.type === 'integer')
      .map((p) => p.value)
      .join(''),
  );
  const frac = ascii(
    parts
      .filter((p) => p.type === 'fraction')
      .map((p) => p.value)
      .join(''),
  );
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(18, '0') || '0');
}

describe('formatMoney properties (2,000 seeded cases)', () => {
  const next = rng(20261026);
  const cases = Array.from({ length: 2000 }, () => makeCase(next));

  it('never throws, for any locale and any asset, Intl-known or not', () => {
    for (const c of cases) {
      expect(() => formatMoney(c.amount, c.currency, c.locale, { maxFractionDigits: c.maxFrac }), JSON.stringify(c)).not.toThrow();
    }
  });

  it('is the joined parts, and labels an unknown asset with its ticker', () => {
    for (const c of cases) {
      const parts = formatMoneyToParts(c.amount, c.currency, c.locale, { maxFractionDigits: c.maxFrac, rounding: c.rounding });
      expect(formatMoney(c.amount, c.currency, c.locale, { maxFractionDigits: c.maxFrac, rounding: c.rounding }), JSON.stringify(c)).toBe(
        joinParts(parts),
      );
      if (!FIAT.includes(c.currency)) expect(parts.at(-1), JSON.stringify(c)).toEqual({ type: 'unit', value: c.currency.toUpperCase() });
    }
  });

  it('keeps every digit up to 38 whole and 18 fraction places, rounded only as asked', () => {
    for (const c of cases) {
      const options = { minFractionDigits: 0, maxFractionDigits: c.maxFrac, rounding: c.rounding };
      const parts = formatMoneyToParts(c.amount, c.currency, c.locale, options);
      const shown = shownValue(parts, intlTagFor(c.locale));
      const { abs } = scaled(c.amount);
      const step = 10n ** BigInt(18 - c.maxFrac);
      const label = `${JSON.stringify(c)} -> ${joinParts(parts)}`;
      // Shown is a multiple of the display step.
      expect(shown % step, label).toBe(0n);
      if (c.rounding === 'floor') {
        // Toward minus infinity: never above the real value, by less than one step.
        const negative = c.amount.startsWith('-');
        const signedShown = negative ? -shown : shown;
        const signedTrue = negative ? -abs : abs;
        expect(signedShown <= signedTrue && signedTrue - signedShown < step, label).toBe(true);
      } else {
        const diff = shown > abs ? shown - abs : abs - shown;
        expect(diff * 2n <= step, label).toBe(true);
        // A tie goes away from zero.
        if (diff * 2n === step) expect(shown > abs, label).toBe(true);
      }
    }
  });

  it('shows one minus on a non-zero negative and none on a shown zero', () => {
    for (const c of cases) {
      const parts = formatMoneyToParts(c.amount, c.currency, c.locale, {
        minFractionDigits: 0,
        maxFractionDigits: c.maxFrac,
        rounding: c.rounding,
      });
      const minus = parts.filter((p) => p.type === 'minusSign').length;
      const plus = parts.filter((p) => p.type === 'plusSign').length;
      const isZero = shownValue(parts, intlTagFor(c.locale)) === 0n;
      const label = `${JSON.stringify(c)} -> ${joinParts(parts)}`;
      expect(plus, label).toBe(0);
      expect(minus, label).toBe(c.amount.startsWith('-') && !isZero ? 1 : 0);
    }
  });
});

describe('formatPercent properties (500 seeded cases)', () => {
  it('shifts exactly and signs like money', () => {
    const next = rng(4640);
    for (let i = 0; i < 500; i++) {
      const c = makeCase(next);
      const amount = c.amount.replace(/^(-?)\d+/, '$10');
      const parts = formatPercentToParts(amount, c.locale, {
        maxFractionDigits: c.maxFrac,
        rounding: c.rounding,
        signDisplay: 'exceptZero',
      });
      const shown = shownValue(parts, intlTagFor(c.locale));
      const { negative, abs } = scaled(amount);
      const hundredfold = abs * 100n;
      const step = 10n ** BigInt(18 - c.maxFrac);
      const label = `${amount} ${c.locale} -> ${joinParts(parts)}`;
      expect(parts.filter((p) => p.type === 'percentSign').length, label).toBe(1);
      const signedShown = negative ? -shown : shown;
      const signedTrue = negative ? -hundredfold : hundredfold;
      if (c.rounding === 'floor') expect(signedShown <= signedTrue && signedTrue - signedShown < step, label).toBe(true);
      else expect((shown > hundredfold ? shown - hundredfold : hundredfold - shown) * 2n <= step, label).toBe(true);
      const signs = parts.filter((p) => p.type === 'minusSign' || p.type === 'plusSign').map((p) => p.type);
      expect(signs, label).toEqual(shown === 0n ? [] : [negative ? 'minusSign' : 'plusSign']);
    }
  });
});
