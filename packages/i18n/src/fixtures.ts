/**
 * Test fixtures for layout under other languages: never a locale, never shipped copy.
 *
 * Two tools for the screenshot and review harnesses (kit gallery, templates,
 * the look gate):
 *
 *   - `pseudoLocalize` makes English copy about 30% longer, accented and
 *     bracketed, so a label that clips, wraps badly or was never keyed shows
 *     at a glance. German and Finnish labels run 30% or more past English.
 *   - `RTL_SAMPLES` holds short Arabic and Hebrew interface strings and
 *     bidi traps (an amount, a ticker, an address inside right-to-left text),
 *     to render a screen in `dir="rtl"` with real script instead of mirrored
 *     English.
 *
 * The samples are fixture text written for layout tests, not reviewed
 * translations. Nothing here may reach a user: no catalog, no locale file,
 * no screen imports this module outside tests and harnesses.
 */
import { en, isPluralMessage, type Catalog, type Message, type PluralMessage } from './catalog.js';

// ── Pseudo-locale ────────────────────────────────────────────────────────────

const ACCENTED: Readonly<Record<string, string>> = {
  a: 'á',
  b: 'ƀ',
  c: 'ç',
  d: 'ð',
  e: 'é',
  g: 'ĝ',
  h: 'ĥ',
  i: 'í',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ó',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'ú',
  w: 'ŵ',
  y: 'ý',
  z: 'ž',
  A: 'Å',
  C: 'Ç',
  E: 'É',
  I: 'Î',
  N: 'Ñ',
  O: 'Ö',
  S: 'Š',
  U: 'Ü',
  Y: 'Ý',
};

/** Characters added to reach the target length. Wide-ish, so the growth is honest. */
const PADDING = '~·ẅ';

export interface PseudoOptions {
  /** Target length as a multiple of the original. Defaults to 1.3. */
  readonly expansion?: number;
  /** Wrap in ⟦ ⟧ so a clipped end is visible. Defaults to true. */
  readonly brackets?: boolean;
}

/**
 * English → pseudo-English: "Send money" → "⟦Šéñð ɱóñéý ~·ẅ⟧".
 *
 * `{placeholders}` are kept exactly, so an interpolated message still
 * interpolates. Digits and punctuation are left alone.
 */
export function pseudoLocalize(text: string, options: PseudoOptions = {}): string {
  const expansion = options.expansion ?? 1.3;
  const brackets = options.brackets ?? true;

  let out = '';
  let visible = 0;
  // Same placeholder shape as `t.ts`. A capturing split puts placeholders at odd indices.
  const pieces = text.split(/(\{\w+\})/);
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index] ?? '';
    if (index % 2 === 1) {
      out += piece;
      continue;
    }
    for (const ch of piece) {
      out += ACCENTED[ch] ?? ch;
      visible += 1;
    }
  }

  const target = Math.ceil(visible * expansion);
  let pad = '';
  for (let i = 0; visible + pad.length < target; i++) pad += PADDING.charAt(i % PADDING.length);
  if (pad) out += ` ${pad}`;
  return brackets ? `⟦${out}⟧` : out;
}

function pseudoMessage(message: Message, options: PseudoOptions): Message {
  if (!isPluralMessage(message)) return pseudoLocalize(message, options);
  const out: Record<string, string> = {};
  for (const [category, text] of Object.entries(message)) {
    if (typeof text === 'string') out[category] = pseudoLocalize(text, options);
  }
  return out as PluralMessage;
}

/**
 * The whole English catalog in pseudo-English, for `createTranslator(locale,
 * pseudoCatalog())` in a harness. Every key is present, so nothing falls
 * back to plain English and hides.
 */
export function pseudoCatalog(options: PseudoOptions = {}): Catalog {
  const out: Record<string, Message> = {};
  for (const [key, message] of Object.entries(en)) out[key] = pseudoMessage(message as Message, options);
  return out as Catalog;
}

// ── Right-to-left samples ───────────────────────────────────────────────────

export interface RtlSample {
  /** BCP-47 tag to put on `lang`. */
  readonly lang: 'ar' | 'he';
  readonly balanceLabel: string;
  readonly send: string;
  readonly receive: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly settings: string;
  /** A sentence of body copy, long enough to wrap on a phone. */
  readonly paragraph: string;
  /** A person's name, for payee rows. */
  readonly name: string;
}

/**
 * Short interface strings in real script, for `dir="rtl"` layout shots. Fixture
 * text written for layout tests, not reviewed copy.
 */
export const RTL_SAMPLES: Readonly<Record<'ar' | 'he', RtlSample>> = {
  ar: {
    lang: 'ar',
    balanceLabel: 'الرصيد المتاح',
    send: 'إرسال',
    receive: 'استلام',
    confirm: 'تأكيد',
    cancel: 'إلغاء',
    settings: 'الإعدادات',
    paragraph: 'تظهر هنا جميع المعاملات التي أجريتها خلال الشهر الماضي، مرتبة من الأحدث إلى الأقدم.',
    name: 'محمد عبد الرحمن',
  },
  he: {
    lang: 'he',
    balanceLabel: 'יתרה זמינה',
    send: 'שליחה',
    receive: 'קבלה',
    confirm: 'אישור',
    cancel: 'ביטול',
    settings: 'הגדרות',
    paragraph: 'כאן מופיעות כל הפעולות שביצעת בחודש האחרון, מהחדשה ביותר לישנה ביותר.',
    name: 'נועה לוי',
  },
};

/** Shown beside every fixture figure in a shot: illustrative numbers carry TEST (AGENTS.md product law). */
export const FIXTURE_LABEL = 'TEST';

/**
 * TEST values that must stay left-to-right inside right-to-left text, with the
 * neighbours that make them jump when they are not isolated: a minus sign, a
 * ticker after a number, an address next to a word. Render each inside
 * `RTL_SAMPLES.*.paragraph`-style copy and check the shot reads in order.
 * None is a real account: the IBAN is the ISO 13616 documentation example and
 * the address is the EIP-55 test vector. A harness shows `FIXTURE_LABEL`
 * beside them.
 */
export const BIDI_TRAPS = {
  address: '0x52908400098527886E0F7030069857D2E4169EE7',
  iban: 'GB33 BUKB 2020 1555 5555 55',
  txHash: '0x9f3c4be1a07d2e6c5b18f0d3a2e4c7b6d5f8e9a0b1c2d3e4f5a6b7c8d9e0f1a2',
  negativeAmount: '-1,234.50',
  amountWithTicker: '0.5 USDC',
  pair: 'BTC/USDT',
  sortCode: '20-20-15',
} as const;
