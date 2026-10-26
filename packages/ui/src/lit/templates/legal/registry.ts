/**
 * The legal slot registry, keyed by moment and market. Rooms say which moments they carry; this file alone says
 * the words. A FIXED text is copied character for character from the rule (each wording names its rule; checked against the rules' texts 26 Oct 2026). A moment whose words a lawyer must choose, or a market
 * that is not decided yet, renders a designed "wording missing" refusal: never invented text.
 */
import type { LegalMomentId, Market } from '../types.js';

/** Kinds of legal slot. */
export type LegalSlotType =
  'risk-band' | 'popup' | 'disclosure' | 'legal-link' | 'equal-choice' | 'timer' | 'gate' | 'consent' | 'result' | 'button';

/** A run of fixed text and how the rule marks it. */
export interface TextRun {
  text: string;
  bold?: boolean;
  underline?: boolean;
  /** The run is the link the rule fixes ("Take 2 mins to learn more"). */
  link?: boolean;
}

export type Wording =
  | { status: 'fixed'; runs: readonly TextRun[]; rule: string; from?: string; until?: string }
  | { status: 'lawyer'; rule: string }
  | { status: 'not-applicable' };

export interface LegalMoment {
  id: LegalMomentId;
  type: LegalSlotType;
  /** Where it sits; the templates place it, rooms don't. */
  placement: 'frame-top' | 'overlay' | 'inline' | 'step' | 'card' | 'footer';
  uk: Wording;
  eu: Wording;
}

const lawyer = (rule: string): Wording => ({ status: 'lawyer', rule });
const na: Wording = { status: 'not-applicable' };

/**
 * COBS 4.12A.11R(1)(d) and 11R(3)(a)(i), 8 Oct 2025. From 25 Oct 2027 a qualifying stablecoin not issued by a
 * UK-permitted issuer takes a longer fixed text (PS26/13); that variant joins here when stablecoin rooms need it.
 */
const CRYPTO_BAND: Wording = {
  status: 'fixed',
  rule: 'COBS 4.12A.11R',
  runs: [
    {
      text: 'Don’t invest unless you’re prepared to lose all the money you invest. This is a high-risk investment and you should not expect to be protected if something goes wrong.',
      bold: true,
    },
    { text: ' ' },
    { text: 'Take 2 mins to learn more', underline: true, link: true },
  ],
};

export const LEGAL_MOMENTS: Readonly<Record<LegalMomentId, LegalMoment>> = {
  'crypto-risk-band': {
    id: 'crypto-risk-band',
    type: 'risk-band',
    placement: 'frame-top',
    uk: CRYPTO_BAND,
    // MiCA Art 66(3) requires a warning but fixes no text.
    eu: lawyer('MiCA Art 66(3)'),
  },
  'crypto-risk-summary': {
    id: 'crypto-risk-summary',
    type: 'popup',
    placement: 'overlay',
    // COBS 4 Annex 1R item 8, copied verbatim by a lawyer (its FOS sentence has two alternatives).
    uk: lawyer('COBS 4 Annex 1R item 8'),
    eu: na,
  },
  'first-buy-warning': {
    id: 'first-buy-warning',
    type: 'popup',
    placement: 'overlay',
    uk: {
      status: 'fixed',
      rule: 'COBS 4.12A.20R',
      runs: [
        { text: '{name}, this is a high-risk investment. How would you feel if you lost the money you’re about to invest?' },
        { text: ' ' },
        { text: 'Take 2 mins to learn more.', underline: true, link: true },
      ],
    },
    eu: na,
  },
  'cooling-off': { id: 'cooling-off', type: 'timer', placement: 'step', uk: lawyer('COBS 4.12A.18R'), eu: na },
  appropriateness: { id: 'appropriateness', type: 'gate', placement: 'step', uk: lawyer('COBS 4.12A.28R'), eu: na },
  'credit-warning': {
    id: 'credit-warning',
    type: 'risk-band',
    placement: 'frame-top',
    uk: lawyer('CONC 3'),
    eu: {
      status: 'fixed',
      rule: 'Directive (EU) 2023/2225 Art 8(1)',
      from: '2026-11-20',
      runs: [{ text: 'Caution! Borrowing money costs money', bold: true }],
    },
  },
  'cfd-warning': {
    id: 'cfd-warning',
    type: 'risk-band',
    placement: 'frame-top',
    // The percentage is a live magnitude: `{percent}` must be filled from configuration or the slot refuses.
    uk: {
      status: 'fixed',
      rule: 'COBS 22.5.7R(1A)',
      runs: [
        {
          text: 'CFDs are complex instruments and come with a high risk of losing money rapidly due to leverage. {percent}% of retail investor accounts lose money when trading CFDs with this provider. You should consider whether you understand how CFDs work and whether you can afford to take the high risk of losing your money.',
        },
      ],
    },
    eu: lawyer('ESMA Decision (EU) 2018/796, national translation'),
  },
  'derivatives-uk-parked': {
    id: 'derivatives-uk-parked',
    type: 'disclosure',
    placement: 'inline',
    uk: { status: 'fixed', rule: 'COBS 22.6.5R', runs: [{ text: 'Not available to UK retail clients (FCA COBS 22.6)' }] },
    eu: na,
  },
  'mica-marketing': {
    id: 'mica-marketing',
    type: 'disclosure',
    placement: 'card',
    uk: na,
    eu: {
      status: 'fixed',
      rule: 'MiCA Art 7(1)(e)',
      runs: [
        {
          text: 'This crypto-asset marketing communication has not been reviewed or approved by any competent authority in any Member State of the European Union. The offeror of the crypto-asset is solely responsible for the content of this crypto-asset marketing communication.',
        },
      ],
    },
  },
  'marketing-label': { id: 'marketing-label', type: 'disclosure', placement: 'card', uk: lawyer('FG23/3'), eu: lawyer('MiCA Art 66(2)') },
  'regulated-status': {
    id: 'regulated-status',
    type: 'disclosure',
    placement: 'footer',
    uk: lawyer('FG23/3 2.79'),
    eu: lawyer('ESMA 11 Jul 2025'),
  },
  'payee-check': { id: 'payee-check', type: 'result', placement: 'step', uk: lawyer('PSR SD17a'), eu: lawyer('Reg (EU) 2024/886 Art 5c') },
  'scam-stop': { id: 'scam-stop', type: 'equal-choice', placement: 'step', uk: lawyer('PSR PS25/5 3.41'), eu: na },
  'withdraw-from-contract': {
    id: 'withdraw-from-contract',
    type: 'button',
    placement: 'inline',
    uk: na,
    eu: { status: 'fixed', rule: 'Directive 2011/83/EU Art 11a', from: '2026-06-19', runs: [{ text: 'withdraw from contract here' }] },
  },
  'confirm-withdrawal': {
    id: 'confirm-withdrawal',
    type: 'button',
    placement: 'inline',
    uk: na,
    eu: { status: 'fixed', rule: 'Directive 2011/83/EU Art 11a', from: '2026-06-19', runs: [{ text: 'confirm withdrawal' }] },
  },
  'talk-to-a-person': {
    id: 'talk-to-a-person',
    type: 'button',
    placement: 'inline',
    uk: lawyer('PRIN 2A.6'),
    eu: lawyer('Directive 2023/2673 Art 16d'),
  },
  'asset-documents': {
    id: 'asset-documents',
    type: 'legal-link',
    placement: 'inline',
    uk: lawyer('CRYPTO 3.12'),
    eu: lawyer('MiCA Art 66(3), 66(5)'),
  },
};

export type Resolved =
  | { status: 'fixed'; runs: readonly TextRun[]; rule: string }
  | { status: 'missing'; rule: string | null; reason: 'market-unset' | 'lawyer' | 'value-unset' }
  | { status: 'not-applicable' };

/**
 * The words for one moment in the market in force, on a date. With the market unset, a moment that has the same
 * fixed text in every market it applies to still can't be shown: which rule applies is the open question.
 * `values` fills placeholders ({name}, {percent}); a placeholder left unfilled refuses rather than shows a blank.
 */
export function resolveLegal(
  id: LegalMomentId,
  market: Market,
  on: string,
  values: Readonly<Record<string, string | undefined>> = {},
): Resolved {
  const moment = LEGAL_MOMENTS[id];
  if (market === 'unset') {
    // A moment no market carries needs nothing, decided market or not.
    if (moment.uk.status === 'not-applicable' && moment.eu.status === 'not-applicable') return { status: 'not-applicable' };
    return { status: 'missing', rule: null, reason: 'market-unset' };
  }
  const wording = market === 'uk' ? moment.uk : moment.eu;
  if (wording.status === 'not-applicable') return { status: 'not-applicable' };
  if (wording.status === 'lawyer') return { status: 'missing', rule: wording.rule, reason: 'lawyer' };
  // Outside its dates the rule isn't in force, so the slot carries nothing (not a wording gap).
  if ((wording.from && on < wording.from) || (wording.until && on >= wording.until)) return { status: 'not-applicable' };
  let unfilled = false;
  const runs = wording.runs.map((run) => ({
    ...run,
    text: run.text.replace(/\{(\w+)\}/g, (_, key: string) => {
      const v = values[key];
      if (v === undefined || v.trim() === '') unfilled = true;
      return v ?? '';
    }),
  }));
  if (unfilled) return { status: 'missing', rule: wording.rule, reason: 'value-unset' };
  return { status: 'fixed', runs, rule: wording.rule };
}
