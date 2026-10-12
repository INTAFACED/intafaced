/**
 * Fiat currency registry — §6.2: "100+ fiat currencies = config, not code".
 *
 * P2P offers, Pay settlement, and display formatting all read this table.
 * Adding a currency is a data change; no service is touched.
 *
 * `minorUnits` follows ISO 4217 exponent. Formatting uses Intl at the edge —
 * this table carries only what Intl cannot tell us (whether we serve it, and
 * the P2P rounding step used in offer pricing).
 */

export interface FiatCurrency {
  readonly code: string;
  readonly name: string;
  readonly symbol: string;
  readonly minorUnits: 0 | 2 | 3;
  /** Enabled for P2P offers + Pay settlement. */
  readonly enabled: boolean;
}

function c(code: string, name: string, symbol: string, minorUnits: 0 | 2 | 3 = 2, enabled = true): FiatCurrency {
  return { code, name, symbol, minorUnits, enabled };
}

export const FIAT_CURRENCIES: readonly FiatCurrency[] = [
  c('USD', 'US Dollar', '$'),
  c('EUR', 'Euro', '€'),
  c('GBP', 'Pound Sterling', '£'),
  c('JPY', 'Japanese Yen', '¥', 0),
  c('CNY', 'Chinese Yuan', '¥'),
  c('CHF', 'Swiss Franc', 'CHF'),
  c('CAD', 'Canadian Dollar', 'C$'),
  c('AUD', 'Australian Dollar', 'A$'),
  c('NZD', 'New Zealand Dollar', 'NZ$'),
  c('SGD', 'Singapore Dollar', 'S$'),
  c('HKD', 'Hong Kong Dollar', 'HK$'),
  c('KRW', 'South Korean Won', '₩', 0),
  c('INR', 'Indian Rupee', '₹'),
  c('IDR', 'Indonesian Rupiah', 'Rp'),
  c('MYR', 'Malaysian Ringgit', 'RM'),
  c('THB', 'Thai Baht', '฿'),
  c('VND', 'Vietnamese Dong', '₫', 0),
  c('PHP', 'Philippine Peso', '₱'),
  c('PKR', 'Pakistani Rupee', '₨'),
  c('BDT', 'Bangladeshi Taka', '৳'),
  c('LKR', 'Sri Lankan Rupee', 'Rs'),
  c('NPR', 'Nepalese Rupee', 'Rs'),
  c('AED', 'UAE Dirham', 'د.إ'),
  c('SAR', 'Saudi Riyal', '﷼'),
  c('QAR', 'Qatari Riyal', '﷼'),
  c('KWD', 'Kuwaiti Dinar', 'د.ك', 3),
  c('BHD', 'Bahraini Dinar', '.د.ب', 3),
  c('OMR', 'Omani Rial', '﷼', 3),
  c('JOD', 'Jordanian Dinar', 'د.ا', 3),
  c('ILS', 'Israeli Shekel', '₪'),
  c('TRY', 'Turkish Lira', '₺'),
  c('EGP', 'Egyptian Pound', 'E£'),
  c('MAD', 'Moroccan Dirham', 'د.م.'),
  c('DZD', 'Algerian Dinar', 'دج'),
  c('TND', 'Tunisian Dinar', 'د.ت', 3),
  c('NGN', 'Nigerian Naira', '₦'),
  c('GHS', 'Ghanaian Cedi', '₵'),
  c('KES', 'Kenyan Shilling', 'KSh'),
  c('UGX', 'Ugandan Shilling', 'USh', 0),
  c('TZS', 'Tanzanian Shilling', 'TSh'),
  c('RWF', 'Rwandan Franc', 'FRw', 0),
  c('ETB', 'Ethiopian Birr', 'Br'),
  c('ZAR', 'South African Rand', 'R'),
  c('ZMW', 'Zambian Kwacha', 'ZK'),
  c('BWP', 'Botswana Pula', 'P'),
  c('MUR', 'Mauritian Rupee', '₨'),
  c('XOF', 'West African CFA Franc', 'CFA', 0),
  c('XAF', 'Central African CFA Franc', 'FCFA', 0),
  c('BRL', 'Brazilian Real', 'R$'),
  c('MXN', 'Mexican Peso', 'Mex$'),
  c('ARS', 'Argentine Peso', '$'),
  c('CLP', 'Chilean Peso', '$', 0),
  c('COP', 'Colombian Peso', '$'),
  c('PEN', 'Peruvian Sol', 'S/'),
  c('UYU', 'Uruguayan Peso', '$U'),
  c('BOB', 'Bolivian Boliviano', 'Bs'),
  c('PYG', 'Paraguayan Guarani', '₲', 0),
  c('CRC', 'Costa Rican Colon', '₡'),
  c('GTQ', 'Guatemalan Quetzal', 'Q'),
  c('DOP', 'Dominican Peso', 'RD$'),
  c('JMD', 'Jamaican Dollar', 'J$'),
  c('TTD', 'Trinidad & Tobago Dollar', 'TT$'),
  c('PAB', 'Panamanian Balboa', 'B/.'),
  c('HNL', 'Honduran Lempira', 'L'),
  c('NIO', 'Nicaraguan Cordoba', 'C$'),
  c('SEK', 'Swedish Krona', 'kr'),
  c('NOK', 'Norwegian Krone', 'kr'),
  c('DKK', 'Danish Krone', 'kr'),
  c('ISK', 'Icelandic Krona', 'kr', 0),
  c('PLN', 'Polish Zloty', 'zł'),
  c('CZK', 'Czech Koruna', 'Kč'),
  c('HUF', 'Hungarian Forint', 'Ft'),
  c('RON', 'Romanian Leu', 'lei'),
  c('BGN', 'Bulgarian Lev', 'лв'),
  c('HRK', 'Croatian Kuna', 'kn', 2, false),
  c('RSD', 'Serbian Dinar', 'дин'),
  c('MKD', 'Macedonian Denar', 'ден'),
  c('ALL', 'Albanian Lek', 'L'),
  c('BAM', 'Bosnia-Herzegovina Mark', 'KM'),
  c('MDL', 'Moldovan Leu', 'L'),
  c('UAH', 'Ukrainian Hryvnia', '₴'),
  c('GEL', 'Georgian Lari', '₾'),
  c('AMD', 'Armenian Dram', '֏'),
  c('AZN', 'Azerbaijani Manat', '₼'),
  c('KZT', 'Kazakhstani Tenge', '₸'),
  c('UZS', 'Uzbekistani Som', "so'm"),
  c('KGS', 'Kyrgystani Som', 'с'),
  c('MNT', 'Mongolian Tugrik', '₮'),
  c('TWD', 'New Taiwan Dollar', 'NT$'),
  c('MOP', 'Macanese Pataca', 'MOP$'),
  c('BND', 'Brunei Dollar', 'B$'),
  c('KHR', 'Cambodian Riel', '៛'),
  c('LAK', 'Lao Kip', '₭'),
  c('MMK', 'Myanmar Kyat', 'K'),
  c('MVR', 'Maldivian Rufiyaa', 'Rf'),
  c('AFN', 'Afghan Afghani', '؋'),
  c('IQD', 'Iraqi Dinar', 'ع.د', 3),
  c('LBP', 'Lebanese Pound', 'ل.ل'),
  c('FJD', 'Fijian Dollar', 'FJ$'),
  c('PGK', 'Papua New Guinean Kina', 'K'),
  c('XPF', 'CFP Franc', '₣', 0),
  c('BBD', 'Barbadian Dollar', 'Bds$'),
  c('BSD', 'Bahamian Dollar', 'B$'),
  c('BZD', 'Belize Dollar', 'BZ$'),
  c('XCD', 'East Caribbean Dollar', 'EC$'),
  c('SRD', 'Surinamese Dollar', '$'),
  c('GYD', 'Guyanese Dollar', 'G$'),
  c('AWG', 'Aruban Florin', 'ƒ'),
  c('ANG', 'Netherlands Antillean Guilder', 'ƒ'),
  c('MZN', 'Mozambican Metical', 'MT'),
  c('AOA', 'Angolan Kwanza', 'Kz'),
  c('NAD', 'Namibian Dollar', 'N$'),
  c('SZL', 'Swazi Lilangeni', 'E'),
  c('LSL', 'Lesotho Loti', 'L'),
  c('MWK', 'Malawian Kwacha', 'MK'),
  c('SLE', 'Sierra Leonean Leone', 'Le'),
  c('GMD', 'Gambian Dalasi', 'D'),
  c('LRD', 'Liberian Dollar', 'L$'),
  c('CDF', 'Congolese Franc', 'FC'),
  c('MGA', 'Malagasy Ariary', 'Ar', 0),
];

const BY_CODE = new Map(FIAT_CURRENCIES.map((f) => [f.code, f]));

export function fiat(code: string): FiatCurrency | undefined {
  return BY_CODE.get(code.toUpperCase());
}

export function enabledFiat(): FiatCurrency[] {
  return FIAT_CURRENCIES.filter((f) => f.enabled);
}

export function isSupportedFiat(code: string): boolean {
  return BY_CODE.get(code.toUpperCase())?.enabled === true;
}

const DECIMAL_AMOUNT = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Display formatting for a fiat amount given as a decimal string.
 * Digits are copied from that string. A blank amount throws. A fraction
 * longer than the currency's minorUnits throws and is not rounded.
 * Never used for maths.
 */
export function formatFiat(amount: string, code: string, locale = 'en-US'): string {
  if (typeof amount !== 'string') throw new Error('fiat amount must be a decimal string');
  if (amount.trim() === '') throw new Error('fiat amount is blank');
  const text = amount.trim();
  const match = DECIMAL_AMOUNT.exec(text);
  if (!match) throw new Error('fiat amount must be a decimal string');
  const negative = match[1] === '-';
  const whole = (match[2] ?? '0').replace(/^0+(?=\d)/, '');
  const frac = match[3] ?? '';
  const cur = fiat(code);
  if (!cur) return `${text} ${code}`;
  if (frac.length > cur.minorUnits) {
    throw new Error('fiat amount has more fraction digits than minor units');
  }
  const padded = frac.padEnd(cur.minorUnits, '0');
  return placeFiatDigits(whole, padded, negative, cur.minorUnits, cur.code, locale);
}

/** Currency affix from a ±1 sample. The amount string is not passed to Intl. */
function placeFiatDigits(
  whole: string,
  frac: string,
  negative: boolean,
  minorUnits: 0 | 2 | 3,
  code: string,
  locale: string,
): string {
  const parts = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: code,
    minimumFractionDigits: minorUnits,
    maximumFractionDigits: minorUnits,
    useGrouping: false,
  }).formatToParts(negative ? -1 : 1);
  let prefix = '';
  let suffix = '';
  let decimal = '.';
  let seenWhole = false;
  let afterNumber = false;
  for (const part of parts) {
    if (part.type === 'integer') {
      seenWhole = true;
      afterNumber = true;
      continue;
    }
    if (part.type === 'group' || part.type === 'fraction') continue;
    if (part.type === 'decimal') {
      decimal = part.value;
      afterNumber = true;
      continue;
    }
    if (afterNumber) suffix += part.value;
    else prefix += part.value;
  }
  if (!seenWhole) throw new Error('fiat display could not place the amount');
  const body = minorUnits === 0 ? whole : `${whole}${decimal}${frac}`;
  return `${prefix}${body}${suffix}`;
}
